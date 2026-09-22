"""Exercise the real bridge with in-memory sockets; no API key or desktop actions."""
import asyncio
import base64
import importlib.util
import json
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

from fastapi import WebSocketDisconnect
from app.live_voice_protocol import VoiceTranscripts, tool_result_status


class FakeSocket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.outgoing = asyncio.Queue()
        self.sent = []

    async def accept(self):
        pass

    async def close(self, **kwargs):
        self.incoming.put_nowait(None)

    async def receive_text(self):
        item = await self.incoming.get()
        if item is None:
            raise WebSocketDisconnect()
        return json.dumps(item)

    async def recv(self):
        return await self.receive_text()

    async def send_json(self, item):
        self.sent.append(item)
        self.outgoing.put_nowait(item)

    async def send(self, text):
        await self.send_json(json.loads(text))

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.incoming.get()
        if item is None:
            raise StopAsyncIteration
        return json.dumps(item)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def event(self, kind):
        async with asyncio.timeout(3):
            while True:
                event = await self.outgoing.get()
                if event.get("type") == kind or kind in event:
                    return event


class TestVoiceProtocol(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client, self.upstream = FakeSocket(), FakeSocket()
        self.save = Mock()
        self.dispatcher = SimpleNamespace(get_tool_declarations=lambda: [], dispatch=AsyncMock(return_value="Opened"))
        modules = {}
        for name, attrs in {
            "app.config": {"settings": SimpleNamespace(GOOGLE_API_KEY="test-key")},
            "app.database": {"save_message": self.save},
            "app.live_tool_dispatcher": {"live_tool_dispatcher": self.dispatcher},
        }.items():
            module = ModuleType(name)
            module.__dict__.update(attrs)
            modules[name] = module
        # Load the real route with just its external dependencies replaced.
        spec = importlib.util.spec_from_file_location("voice_bridge_test", Path(__file__).parents[1] / "app/live_voice.py")
        self.bridge = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(self.bridge)
        self.connection_patch = patch.object(self.bridge.websockets, "connect", return_value=self.upstream)
        self.connection_patch.start()
        self.token_patch = patch.object(self.bridge, "_verify_ws_token", return_value=True)
        self.token_patch.start()
        self.task = asyncio.create_task(self.bridge.gemini_live_voice_websocket(self.client, "thread-one", "Aoede", None))
        self.setup = (await self.upstream.event("setup"))["setup"]

    async def asyncTearDown(self):
        self.client.incoming.put_nowait(None)
        if not self.task.done():
            # Also release tests that end before setup has completed.
            self.upstream.incoming.put_nowait({"setupComplete": {}})
        await asyncio.wait_for(self.task, timeout=3)
        self.connection_patch.stop()
        self.token_patch.stop()

    async def ready(self):
        self.upstream.incoming.put_nowait({"setupComplete": {}})
        await self.client.event("ready")

    def content(self, **content):
        self.upstream.incoming.put_nowait({"serverContent": content})

    async def test_setup_schema_and_readiness(self):
        self.assertIn("inputAudioTranscription", self.setup)
        self.assertIn("outputAudioTranscription", self.setup)
        self.assertNotIn("inputAudioTranscription", self.setup["generationConfig"])
        self.assertNotIn("outputAudioTranscription", self.setup["generationConfig"])
        self.assertEqual(self.client.sent, [])
        await self.ready()

    async def test_speech_detection_tolerates_natural_pauses(self):
        detection = self.setup["realtimeInputConfig"]["automaticActivityDetection"]
        self.assertFalse(detection["disabled"])
        self.assertEqual(detection.get("startOfSpeechSensitivity"), "START_SENSITIVITY_HIGH")
        self.assertEqual(detection.get("endOfSpeechSensitivity"), "END_SENSITIVITY_LOW")
        self.assertEqual(detection["prefixPaddingMs"], 100)
        self.assertEqual(detection["silenceDurationMs"], 700)

    async def test_quiet_audio_and_silence_reach_upstream_unchanged(self):
        await self.ready()
        # +/-32 is approximately 0.001 full scale: real speech can be this quiet.
        for samples in [b"\x20\x00\xe0\xff" * 256, b"\x00\x00" * 256]:
            data = base64.b64encode(samples).decode("ascii")
            self.client.incoming.put_nowait({"type": "audio", "data": data})
            event = await self.upstream.event("realtimeInput")
            self.assertEqual(event["realtimeInput"], {
                "audio": {"mimeType": "audio/pcm;rate=16000", "data": data},
            })

    async def test_transcripts_accumulate_finalize_and_persist_once(self):
        await self.ready()
        self.content(inputTranscription={"text": "Open "})
        self.content(inputTranscription={"text": "the browser"})
        self.content(outputTranscription={"text": "Opening "}, modelTurn={"parts": [{"text": "private thought", "thought": True}]})
        self.content(outputTranscription={"text": "it now."}, turnComplete=True)
        await self.client.event("turn_complete")
        events = [event for event in self.client.sent if event["type"] == "transcript"]
        self.assertEqual(len({event["id"] for event in events}), 2)
        finals = [event for event in events if not event["isPartial"]]
        self.assertEqual([event["text"] for event in finals], ["Open the browser", "Opening it now."])
        self.assertEqual(self.save.call_count, 2)
        self.save.assert_any_call("thread-one", "user", "Open the browser")
        self.save.assert_any_call("thread-one", "assistant", "Opening it now.")

    async def test_tool_result_has_correlated_id_arguments_and_failure(self):
        self.dispatcher.dispatch.return_value = "Error: Browser unavailable"
        await self.ready()
        self.upstream.incoming.put_nowait({"toolCall": {"functionCalls": [{"id": "t1", "name": "browser_open", "args": {"url": "https://example.com"}}]}})
        result = await self.client.event("tool_result")
        self.assertEqual((result["id"], result["status"]), ("t1", "failed"))
        self.dispatcher.dispatch.assert_awaited_once_with("browser_open", {"url": "https://example.com"})
        response = await self.upstream.event("toolResponse")
        self.assertEqual(response["toolResponse"]["functionResponses"][0]["id"], "t1")

    async def test_slow_tool_does_not_block_interruption_or_cancellation(self):
        started = asyncio.Event()
        async def slow(*args):
            started.set()
            await asyncio.Future()
        self.dispatcher.dispatch.side_effect = slow
        await self.ready()
        self.content(outputTranscription={"text": "I will open it."})
        self.upstream.incoming.put_nowait({"toolCall": {"functionCalls": [{"id": "slow", "name": "browser_open", "args": {}}]}})
        await asyncio.wait_for(started.wait(), 3)
        self.content(interrupted=True, inputTranscription={"text": "Stop"})
        await self.client.event("interrupted")
        self.upstream.incoming.put_nowait({"toolCallCancellation": {"ids": ["slow"]}})
        result = await self.client.event("tool_result")
        self.assertEqual(result["status"], "cancelled")
        self.content(turnComplete=True)
        await self.client.event("turn_complete")
        self.assertTrue(any(event.get("interrupted") for event in self.client.sent))
        self.save.assert_any_call("thread-one", "user", "Stop")
        self.assertFalse(any("toolResponse" in event for event in self.upstream.sent))

    async def test_disconnect_flushes_unfinished_transcripts(self):
        await self.ready()
        self.content(inputTranscription={"text": "Remember this"})
        await self.client.event("transcript")
        self.client.incoming.put_nowait(None)
        await asyncio.wait_for(self.task, 3)
        self.save.assert_called_once_with("thread-one", "user", "Remember this")

    async def test_muting_ends_upstream_audio(self):
        await self.ready()
        self.client.incoming.put_nowait({"type": "audio_end"})
        event = await self.upstream.event("realtimeInput")
        self.assertTrue(event["realtimeInput"]["audioStreamEnd"])

    async def test_search_content_reaches_model_and_answer_reaches_muted_client(self):
        # Exercise the real search adapter too, with only the provider mocked.
        from tests.test_live_tool_dispatcher import TestLiveToolDispatcher
        adapter = TestLiveToolDispatcher()
        adapter.setUp()
        adapter.search.return_value = {"results": [{
            "title": "Museum hours", "content": "Example Museum opens at 9:30 AM.",
            "url": "https://example.com/museum",
        }]}
        self.dispatcher.dispatch.side_effect = adapter.dispatch
        await self.ready()
        self.client.incoming.put_nowait({"type": "audio_end"})
        await self.upstream.event("realtimeInput")
        self.content(outputTranscription={"text": "Searching now."}, turnComplete=True)
        await self.client.event("turn_complete")
        self.upstream.incoming.put_nowait({"toolCall": {"functionCalls": [{
            "id": "search", "name": "internet_search", "args": {"query": "museum hours"},
        }]}})
        await self.client.event("tool_result")
        response = await self.upstream.event("toolResponse")
        output = response["toolResponse"]["functionResponses"][0]["response"]["output"]
        self.assertIn("Example Museum opens at 9:30 AM.", output)
        self.assertIn("https://example.com/museum", output)
        # No new microphone packet or user prompt is needed to relay the answer.
        self.content(modelTurn={"parts": [{"inlineData": {"data": "AAAA"}}]},
                     outputTranscription={"text": "It opens at 9:30 AM."})
        self.content(turnComplete=True)
        self.assertEqual((await self.client.event("audio"))["data"], "AAAA")
        await self.client.event("turn_complete")
        self.save.assert_any_call("thread-one", "assistant", "It opens at 9:30 AM.")
        self.dispatcher.dispatch.assert_awaited_once()

    async def test_done_waits_until_tool_result_is_delivered_upstream(self):
        entered, release = asyncio.Event(), asyncio.Event()
        send = self.upstream.send
        async def delayed_send(text):
            if "toolResponse" in json.loads(text):
                entered.set()
                await release.wait()
            await send(text)
        self.upstream.send = delayed_send
        await self.ready()
        self.upstream.incoming.put_nowait({"toolCall": {"functionCalls": [{"id": "t1", "name": "internet_search", "args": {}}]}})
        await asyncio.wait_for(entered.wait(), 3)
        self.assertFalse(any(event.get("type") == "tool_result" for event in self.client.sent))
        release.set()
        self.assertEqual((await self.client.event("tool_result"))["status"], "completed")
        self.assertTrue(any("toolResponse" in event for event in self.upstream.sent))

    async def test_failed_delivery_is_not_marked_done(self):
        send = self.upstream.send
        async def fail_response(text):
            if "toolResponse" in json.loads(text):
                raise RuntimeError("Simulated connection failure")
            await send(text)
        self.upstream.send = fail_response
        await self.ready()
        self.upstream.incoming.put_nowait({"toolCall": {"functionCalls": [{"id": "t1", "name": "internet_search", "args": {}}]}})
        await asyncio.wait_for(self.task, 3)
        self.assertFalse(any(event.get("status") == "completed" for event in self.client.sent))


class TestVoiceHelpers(unittest.TestCase):
    def test_new_turn_gets_new_id(self):
        transcripts = VoiceTranscripts()
        first = transcripts.append("user", "Hello")
        transcripts.finish("user")
        second = transcripts.append("user", "Hello")
        self.assertNotEqual(first["id"], second["id"])

    def test_dispatcher_error_formats(self):
        for result in ["Error executing browser", "Could not click", "Failed typing", '{"success": false}', {"error": "offline"}]:
            self.assertEqual(tool_result_status(result), "failed")
        self.assertEqual(tool_result_status("Opened browser"), "completed")


if __name__ == "__main__":
    unittest.main()
