"""
Realtime WebSocket hub: topic subscriptions and push events for scheduler notifications,
scheduled task list changes, log tail, connectivity/friends, and chat history.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Dict, List, Optional, Set, Tuple

from fastapi import WebSocket, WebSocketDisconnect

from app.config import settings

logger = logging.getLogger(__name__)

TOPICS = frozenset(
    {"scheduler_notifications", "scheduler_tasks", "logs", "connectivity", "history"}
)

API_TOKEN = os.environ.get("RIE_APP_TOKEN")


class RealtimeHub:
    """Single-process hub; all connections share one event loop."""

    def __init__(self) -> None:
        self._connections: List[Tuple[WebSocket, Set[str]]] = []
        self._lock = asyncio.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._log_tail_task: Optional[asyncio.Task] = None
        self._log_read_offset: int = 0

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def emit_fire_and_forget(self, topic: str, payload: Dict[str, Any]) -> None:
        """Schedule emit from sync code (e.g. database thread)."""
        loop = self._loop
        if not loop:
            return
        try:
            asyncio.run_coroutine_threadsafe(self.emit(topic, payload), loop)
        except RuntimeError:
            logger.debug("Realtime emit skipped (no running loop)")

    async def emit(self, topic: str, payload: Dict[str, Any]) -> None:
        if topic not in TOPICS:
            return
        msg = json.dumps({"type": "event", "topic": topic, "payload": payload})
        async with self._lock:
            snapshot = list(self._connections)
        dead: List[WebSocket] = []
        for ws, topics in snapshot:
            if topic not in topics:
                continue
            try:
                await ws.send_text(msg)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                self._connections = [(w, t) for w, t in self._connections if w not in dead]
            await self._maybe_stop_log_tail()

    def _logs_subscribers(self) -> int:
        n = 0
        for _, topics in self._connections:
            if "logs" in topics:
                n += 1
        return n

    async def _maybe_stop_log_tail(self) -> None:
        if self._logs_subscribers() > 0:
            return
        if self._log_tail_task and not self._log_tail_task.done():
            self._log_tail_task.cancel()
            try:
                await self._log_tail_task
            except asyncio.CancelledError:
                pass
            self._log_tail_task = None

    async def _maybe_start_log_tail(self) -> None:
        if self._logs_subscribers() == 0:
            return
        if self._log_tail_task and not self._log_tail_task.done():
            return

        async def tail_loop() -> None:
            log_path = settings.LOG_FILE
            while self._logs_subscribers() > 0:
                try:
                    if not log_path.exists():
                        await asyncio.sleep(1.0)
                        continue
                    size = log_path.stat().st_size
                    if size < self._log_read_offset:
                        self._log_read_offset = 0
                    if size > self._log_read_offset:
                        def read_chunk() -> str:
                            with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                                f.seek(self._log_read_offset)
                                chunk = f.read()
                                self._log_read_offset = f.tell()
                                return chunk

                        text = await asyncio.to_thread(read_chunk)
                        if text:
                            await self.emit(
                                "logs",
                                {"action": "append", "text": text},
                            )
                    await asyncio.sleep(0.75)
                except asyncio.CancelledError:
                    break
                except Exception:
                    logger.exception("Log tail loop error")
                    await asyncio.sleep(1.5)

        self._log_tail_task = asyncio.create_task(tail_loop())

    async def _send_log_snapshot(self, websocket: WebSocket) -> None:
        log_file = settings.LOG_FILE
        if not log_file.exists():
            await self.emit_to_socket(
                websocket,
                "logs",
                {"action": "snapshot", "text": "Log file not found."},
            )
            self._log_read_offset = 0
            return

        def read_snapshot() -> Tuple[str, int]:
            with open(log_file, "r", encoding="utf-8", errors="replace") as f:
                lines = f.readlines()
                last_lines = lines[-1000:] if len(lines) > 1000 else lines
                body = "".join(last_lines)
                pos = f.tell()
                return body, pos

        try:
            text, end_pos = await asyncio.to_thread(read_snapshot)
        except Exception as e:
            await self.emit_to_socket(
                websocket,
                "logs",
                {"action": "snapshot", "text": f"Error reading log file: {e}"},
            )
            self._log_read_offset = 0
            return

        self._log_read_offset = end_pos
        await self.emit_to_socket(websocket, "logs", {"action": "snapshot", "text": text})

    async def emit_to_socket(self, websocket: WebSocket, topic: str, payload: Dict[str, Any]) -> None:
        msg = json.dumps({"type": "event", "topic": topic, "payload": payload})
        await websocket.send_text(msg)

    async def handle_connection(self, websocket: WebSocket) -> None:
        await websocket.accept()
        topics: Set[str] = set()
        try:
            async with self._lock:
                self._connections.append((websocket, topics))
            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                msg_type = data.get("type")
                if msg_type == "subscribe":
                    new_topics = [t for t in data.get("topics", []) if t in TOPICS]
                    before_logs = "logs" in topics
                    for t in new_topics:
                        topics.add(t)
                    await websocket.send_text(
                        json.dumps({"type": "subscribed", "topics": list(topics)})
                    )
                    if "logs" in new_topics and not before_logs:
                        await self._send_log_snapshot(websocket)
                        await self._maybe_start_log_tail()
                    continue
                if msg_type == "unsubscribe":
                    rem = [t for t in data.get("topics", []) if t in TOPICS]
                    before_logs = "logs" in topics
                    for t in rem:
                        topics.discard(t)
                    await websocket.send_text(
                        json.dumps({"type": "subscribed", "topics": list(topics)})
                    )
                    if "logs" in rem and before_logs and "logs" not in topics:
                        await self._maybe_stop_log_tail()
                    continue
        except WebSocketDisconnect:
            pass
        finally:
            async with self._lock:
                self._connections = [(w, t) for w, t in self._connections if w != websocket]
            await self._maybe_stop_log_tail()


hub = RealtimeHub()


def notify_scheduler_tasks_changed() -> None:
    """Call from sync code when pending scheduled jobs change (add/cancel/finish)."""
    hub.emit_fire_and_forget("scheduler_tasks", {"action": "changed"})


def verify_ws_token(token: Optional[str]) -> bool:
    if not API_TOKEN:
        return True
    return token == API_TOKEN


async def websocket_endpoint(websocket: WebSocket) -> None:
    token = websocket.query_params.get("token")
    if not verify_ws_token(token):
        await websocket.close(code=1008)
        return
    await hub.handle_connection(websocket)
