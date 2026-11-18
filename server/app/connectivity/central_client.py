"""
Centralized Gateway Client for Desktop Rie Server.
Maintains persistent outbound WebSocket connection to the central SaaS backend,
registers local device identity, listens for incoming peer tasks,
and handles outbound peer ask / friend management requests.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx
import websockets

from app.config import settings
from app.database import (
    get_or_create_device_identity,
    get_friend_by_id,
    upsert_friend,
    delete_friend,
    save_message,
    upsert_friend_thread,
    append_peer_query_event,
)
from app.peer_access import (
    compute_effective_tool_ids,
    friend_row_peer_policy,
    merge_peer_access_policy,
)

logger = logging.getLogger(__name__)


def _serialize_stream_chunk(chunk: Any) -> Optional[Dict[str, Any]]:
    """Convert raw LangGraph / LangChain stream chunks to JSON-serializable payloads."""
    if not isinstance(chunk, dict):
        return None

    if "__lg_messages__" in chunk:
        pair = chunk["__lg_messages__"]
        msg = pair[0] if isinstance(pair, tuple) and len(pair) >= 1 else pair
        content = getattr(msg, "content", "")
        if isinstance(content, list):
            parts = [p.get("text", "") if isinstance(p, dict) else str(p) for p in content]
            content = "".join(parts)
        elif not isinstance(content, str):
            content = str(content) if content is not None else ""
        if content:
            return {"message": {"content": content, "type": "ai"}}
        return None

    if "agent" in chunk and isinstance(chunk["agent"], dict):
        messages = chunk["agent"].get("messages", [])
        if messages:
            last = messages[-1]
            content = getattr(last, "content", "") if hasattr(last, "content") else str(last)
            if content:
                return {"message": {"content": content, "type": "ai"}}

    try:
        json.dumps(chunk)
        return chunk
    except (TypeError, ValueError):
        return None


class CentralGatewayClient:
    """Manages communication with the central Rie-AI Cloud backend."""

    def __init__(self) -> None:
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self._ws: Optional[Any] = None
        self._connected = False
        self._reconnect_delay = 3.0

    @property
    def is_connected(self) -> bool:
        return self._connected

    def get_auth_headers(self) -> Dict[str, str]:
        token = settings.RIE_ACCESS_TOKEN
        if not token:
            raise RuntimeError("Not signed in to Rie Cloud. Open Settings and connect your account.")
        return {"Authorization": f"Bearer {token}"}

    # ── Startup & Shutdown ──────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._gateway_loop())
        logger.info("CentralGatewayClient started background worker.")

    async def stop(self) -> None:
        self._running = False
        if self._ws:
            try:
                await self._ws.close()
            except Exception:
                pass
            self._ws = None
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._connected = False
        logger.info("CentralGatewayClient stopped.")

    # ── Cloud Device Registration ──────────────────────────────────────────────────

    async def register_device(self) -> bool:
        """Register local device identity with central cloud backend."""
        token = settings.RIE_ACCESS_TOKEN
        if not token:
            return False
        identity = get_or_create_device_identity()
        payload = {
            "device_id": identity["device_id"],
            "device_name": identity.get("name", "My Rie"),
            "public_key": identity.get("public_key", ""),
            "fingerprint": identity.get("fingerprint", ""),
        }
        url = f"{settings.RIE_API_URL}/connections/device/register"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.post(url, json=payload, headers=self.get_auth_headers())
                if res.status_code == 200:
                    logger.info("Device registered with Rie Cloud: %s", identity["device_id"])
                    return True
                else:
                    logger.warning("Device registration failed (%s): %s", res.status_code, res.text)
                    return False
        except Exception as exc:
            logger.debug("Could not register device with cloud backend: %s", exc)
            return False

    # ── WebSocket Gateway Background Loop ──────────────────────────────────────────

    async def _gateway_loop(self) -> None:
        """Perpetual worker maintaining outbound connection to Central Gateway."""
        while self._running:
            token = settings.RIE_ACCESS_TOKEN
            if not token:
                self._connected = False
                await asyncio.sleep(5.0)
                continue

            try:
                await self.register_device()
                ws_url = f"{settings.RIE_WS_URL}/connections/gateway/ws?token={token}"
                logger.info("Connecting to Central Gateway WebSocket: %s", ws_url)
                async with websockets.connect(
                    ws_url,
                    ping_interval=45.0,
                    ping_timeout=20.0,
                    close_timeout=10.0,
                ) as ws:
                    self._ws = ws
                    self._connected = True
                    self._reconnect_delay = 3.0
                    logger.info("Connected to Central Gateway successfully.")

                    async for message_text in ws:
                        if not self._running:
                            break
                        try:
                            msg = json.loads(message_text)
                            asyncio.create_task(self._dispatch_inbound_message(msg))
                        except Exception as e:
                            logger.warning("Error parsing gateway message: %s", e)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._connected = False
                self._ws = None
                logger.info("Gateway connection dropped (%s). Reconnecting in %.1fs...", exc, self._reconnect_delay)
                await asyncio.sleep(self._reconnect_delay)
                self._reconnect_delay = min(self._reconnect_delay * 1.5, 30.0)

    # ── Inbound Dispatchers ────────────────────────────────────────────────────────

    async def _dispatch_inbound_message(self, msg: Dict[str, Any]) -> None:
        msg_type = msg.get("type")
        if msg_type == "peer_query":
            await self._handle_inbound_query(msg)
        elif msg_type == "peer_query_stream":
            await self._handle_inbound_stream(msg)
        elif msg_type == "connection_request_accepted":
            logger.info("Connection request was accepted by peer: %s", msg.get("connection_email"))
            try:
                await self.list_connections()
            except Exception as e:
                logger.warning("Failed to refresh connections after acceptance: %s", e)
        elif msg_type == "connection_removed":
            user_id = msg.get("user_id")
            if user_id:
                try:
                    delete_friend(user_id)
                except Exception:
                    pass

    async def _handle_inbound_query(self, msg: Dict[str, Any]) -> None:
        """Handle incoming query forwarded from central server."""
        from app.agent import agent_manager, _get_runtime_tool_catalog_ids, _extract_peer_assistant_text

        req_id = msg.get("request_id")
        from_user = msg.get("from_user_id", "unknown")
        from_email = msg.get("from_email", "Friend")
        query = (msg.get("query") or "").strip() or "Hello"
        thread_id = msg.get("thread_id") or f"cloud-peer:{from_user}"

        # Resolve local access policy
        friend = get_friend_by_id(from_user)
        policy = friend_row_peer_policy(friend) if friend else merge_peer_access_policy(None)
        full_catalog = _get_runtime_tool_catalog_ids()
        effective_ids = compute_effective_tool_ids(policy, full_catalog)
        memory_user_id = f"peer:{from_user}" if policy.memory_enabled else "default_user"

        identity = get_or_create_device_identity()

        try:
            # Save inbound message locally
            await asyncio.to_thread(upsert_friend_thread, thread_id, from_user, from_email)
            await asyncio.to_thread(save_message, thread_id, "user", query)

            agent_result = await agent_manager.invoke_peer_inbound(
                messages=[{"role": "user", "content": query}],
                thread_id=thread_id,
                receive_profile=policy.receive_profile,
                effective_tool_ids=effective_ids,
                memory_user_id=memory_user_id,
            )
            reply_text = _extract_peer_assistant_text(agent_result) or "Message received."
            await asyncio.to_thread(save_message, thread_id, "assistant", reply_text)
            await asyncio.to_thread(
                append_peer_query_event,
                "inbound",
                from_user,
                from_email,
                query,
                "ok",
                reply_text,
                None,
            )

            reply_payload = {
                "type": "peer_reply",
                "request_id": req_id,
                "status": "online",
                "message": reply_text,
                "thread_id": thread_id,
                "responder_device_id": identity["device_id"],
            }
        except Exception as exc:
            logger.exception("Error executing inbound peer query: %s", exc)
            reply_payload = {
                "type": "peer_reply",
                "request_id": req_id,
                "status": "error",
                "message": f"Error running task on friend's machine: {exc}",
                "thread_id": thread_id,
                "responder_device_id": identity["device_id"],
            }

        if self._ws:
            try:
                await self._ws.send(json.dumps(reply_payload))
            except Exception as e:
                logger.warning("Could not send peer_reply over WebSocket: %s", e)

    async def _handle_inbound_stream(self, msg: Dict[str, Any]) -> None:
        """Handle incoming streaming query forwarded from central server."""
        from app.agent import agent_manager, _get_runtime_tool_catalog_ids

        req_id = msg.get("request_id")
        from_user = msg.get("from_user_id", "unknown")
        from_email = msg.get("from_email", "Friend")
        query = (msg.get("query") or "").strip() or "Hello"
        thread_id = msg.get("thread_id") or f"cloud-peer:{from_user}"

        friend = get_friend_by_id(from_user)
        policy = friend_row_peer_policy(friend) if friend else merge_peer_access_policy(None)
        full_catalog = _get_runtime_tool_catalog_ids()
        effective_ids = compute_effective_tool_ids(policy, full_catalog)
        memory_user_id = f"peer:{from_user}" if policy.memory_enabled else "default_user"

        try:
            await asyncio.to_thread(upsert_friend_thread, thread_id, from_user, from_email)
            await asyncio.to_thread(save_message, thread_id, "user", query)

            stream_gen = agent_manager.stream_peer_inbound(
                messages=[{"role": "user", "content": query}],
                thread_id=thread_id,
                receive_profile=policy.receive_profile,
                effective_tool_ids=effective_ids,
                memory_user_id=memory_user_id,
            )

            accumulated_response = []
            async for chunk in stream_gen:
                serialized = _serialize_stream_chunk(chunk)
                if serialized:
                    msg_content = serialized.get("message", {}).get("content", "")
                    if msg_content:
                        accumulated_response.append(msg_content)
                    if self._ws:
                        await self._ws.send(json.dumps({
                            "type": "peer_stream_chunk",
                            "request_id": req_id,
                            "data": serialized,
                        }))

            final_reply = "".join(accumulated_response).strip() or "Task completed."
            await asyncio.to_thread(save_message, thread_id, "assistant", final_reply)
            await asyncio.to_thread(
                append_peer_query_event,
                "inbound",
                from_user,
                from_email,
                query,
                "ok",
                final_reply,
                None,
            )

            if self._ws:
                await self._ws.send(json.dumps({
                    "type": "peer_stream_end",
                    "request_id": req_id,
                }))

        except Exception as exc:
            logger.exception("Error in peer inbound stream: %s", exc)
            if self._ws:
                await self._ws.send(json.dumps({
                    "type": "peer_stream_error",
                    "request_id": req_id,
                    "error": str(exc),
                }))

    # ── Outbound HTTP Cloud API Helpers ──────────────────────────────────────────

    async def list_connections(self) -> List[Dict[str, Any]]:
        """Fetch connections list from central server and sync with local friends table."""
        url = f"{settings.RIE_API_URL}/connections"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url, headers=self.get_auth_headers())
            if res.status_code != 200:
                raise RuntimeError(f"Failed to fetch connections from cloud: {res.text}")
            connections = res.json()

        # Sync into local SQLite DB for thread approvals and access policies
        for f in connections:
            upsert_friend(
                name=f.get("email") or "Connection",
                device_id=f.get("device_id") or f["user_id"],
                fingerprint=f.get("fingerprint") or "SHA256:cloud",
                public_key=f.get("public_key") or "cloud-pubkey",
                public_url=None,
                friend_id=f["user_id"],
            )
        return connections

    list_friends = list_connections

    async def send_connection_request(self, target_email: str) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/requests"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(url, json={"target_email": target_email}, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if res.headers.get("content-type") == "application/json" else res.text
                raise RuntimeError(detail)
            return res.json()

    send_friend_request = send_connection_request

    async def list_connection_requests(self) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/requests"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url, headers=self.get_auth_headers())
            if res.status_code != 200:
                raise RuntimeError(f"Failed to fetch connection requests: {res.text}")
            return res.json()

    list_friend_requests = list_connection_requests

    async def accept_connection_request(self, request_id: str) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/requests/{request_id}/accept"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(url, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if res.headers.get("content-type") == "application/json" else res.text
                raise RuntimeError(detail)
            return res.json()

    accept_friend_request = accept_connection_request

    async def decline_connection_request(self, request_id: str) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/requests/{request_id}/decline"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(url, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if res.headers.get("content-type") == "application/json" else res.text
                raise RuntimeError(detail)
            return res.json()

    decline_friend_request = decline_connection_request

    async def cancel_connection_request(self, request_id: str) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/requests/{request_id}/cancel"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.post(url, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if res.headers.get("content-type") == "application/json" else res.text
                raise RuntimeError(detail)
            return res.json()

    cancel_friend_request = cancel_connection_request

    async def remove_connection(self, connection_user_id: str) -> Dict[str, Any]:
        url = f"{settings.RIE_API_URL}/connections/{connection_user_id}"
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.delete(url, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if res.headers.get("content-type") == "application/json" else res.text
                raise RuntimeError(detail)
            return res.json()

    remove_friend = remove_connection

    async def ask_connection(self, connection_user_id: str, query: str, thread_id: Optional[str] = None) -> Dict[str, Any]:
        """Relay a query to a connection through the central server."""
        url = f"{settings.RIE_API_URL}/connections/{connection_user_id}/ask"
        payload = {"query": query, "thread_id": thread_id}
        async with httpx.AsyncClient(timeout=130.0) as client:
            res = await client.post(url, json=payload, headers=self.get_auth_headers())
            if res.status_code >= 400:
                detail = res.json().get("detail", res.text) if "application/json" in res.headers.get("content-type", "") else res.text
                raise RuntimeError(detail)
            return res.json()

    ask_friend = ask_connection


gateway_client = CentralGatewayClient()
