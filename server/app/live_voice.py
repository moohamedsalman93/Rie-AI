"""
Gemini Live WebSocket bridge for audio, transcription, and tool activity.
"""
import os
import json
import asyncio
import logging
import secrets
from typing import Optional
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query, status
import websockets
from app.config import settings
from app.database import save_message
from app.job_manager import job_manager
from app.live_tool_dispatcher import live_tool_dispatcher
from app.live_voice_protocol import VoiceTranscripts, tool_result_status

logger = logging.getLogger("live_voice")

router = APIRouter(tags=["live_voice"])

GEMINI_LIVE_WS_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

AVAILABLE_LIVE_VOICES = [
    {"id": "Aoede", "name": "Aoede", "gender": "Female", "description": "Warm, engaging, and conversational (Default)"},
    {"id": "Kore", "name": "Kore", "gender": "Female", "description": "Calm, soothing, and thoughtful"},
    {"id": "Puck", "name": "Puck", "gender": "Male", "description": "Playful, friendly, and energetic"},
    {"id": "Charon", "name": "Charon", "gender": "Male", "description": "Deep, confident, and steady"},
    {"id": "Fenrir", "name": "Fenrir", "gender": "Male", "description": "Clear, direct, and authoritative"},
]


@router.get("/audio/live-voices")
async def get_live_voices():
    """Returns available Gemini Multimodal Live voice personas."""
    return {"voices": AVAILABLE_LIVE_VOICES}


def _verify_ws_token(token: Optional[str]) -> bool:
    """Validate internal desktop app token if configured in environment."""
    expected_token = os.environ.get("RIE_APP_TOKEN")
    if not expected_token:
        return True
    if token and secrets.compare_digest(token, expected_token):
        return True
    return False


def build_live_system_instruction(
    client_timezone: Optional[str] = None,
    client_local_datetime_iso: Optional[str] = None,
    client_latitude: Optional[float] = None,
    client_longitude: Optional[float] = None,
    client_location_accuracy_m: Optional[float] = None,
) -> str:
    """Builds the comprehensive system instruction for Gemini Live, including location if enabled."""
    from app.agent import _client_device_system_content

    device_context = _client_device_system_content(
        client_timezone=client_timezone,
        client_local_datetime_iso=client_local_datetime_iso,
        client_latitude=client_latitude,
        client_longitude=client_longitude,
        client_location_accuracy_m=client_location_accuracy_m,
    )

    base_prompt = (
        "You are Rie, an ultra-fast, helpful, warm, concise, and highly capable desktop AI companion. "
        "You are interacting with the user via real-time spoken voice conversation.\n\n"
        "## CORE ARCHITECTURAL PRINCIPLES:\n"
        "1. CONVERSATIONAL BRAIN: You are the voice and intent coordinator. Fast tools are your reflexes, and the autonomous subagent is your hands.\n"
        "2. ROUTING FIRST: Never independently decide that an executable capability is unavailable. When the user asks for an action, file operation, coding, terminal command, or technical task, route the request to the appropriate fast tool or to `spawn_subagent`.\n"
        "3. FAST REFLEXES: For instant actions (launching an app like Spotify, media controls, web search, opening a URL, saving memory, scheduling reminders), invoke your dedicated fast tools immediately without hesitation.\n"
        "4. BACKGROUND AGENT (HANDS): For all deep technical work, programming, terminal commands, file edits, test execution, or multi-step research, invoke `spawn_subagent(task=..., mode='background')`. It will return a job ID immediately.\n"
        "5. PROMPT ACKNOWLEDGMENT: When launching a background subagent, immediately speak a brief natural confirmation (e.g. 'I've started the agent on that. I'll let you know as soon as it's finished!'). You can continue conversing with the user while the agent works.\n"
        "6. NOTIFICATION SUMMARIES: When the background agent finishes, you will receive a notification event. Naturally speak a concise 1-2 sentence update summarizing the completed outcome.\n"
        "7. CANCEL SUBAGENT: If the user asks to cancel, stop, or abort the agent or task, immediately invoke `cancel_subagent()` to stop the background subagent.\n"
        "8. SPOKEN STYLE: Keep spoken answers short, punchy, and natural (1 to 2 sentences max) so it feels like a snappy back-and-forth chat. Avoid reading raw markdown or code aloud."
    )

    if device_context:
        return f"{base_prompt}\n\n## USER CONTEXT & ENVIRONMENT:\n{device_context}"
    return base_prompt


@router.websocket("/ws/voice-live")
async def gemini_live_voice_websocket(
    websocket: WebSocket,
    thread_id: Optional[str] = None,
    voice: Optional[str] = "Aoede",
    token: Optional[str] = None,
    greet: Optional[bool] = True,
    client_latitude: Optional[float] = None,
    client_longitude: Optional[float] = None,
    client_location_accuracy_m: Optional[float] = None,
    client_timezone: Optional[str] = None,
    client_local_datetime_iso: Optional[str] = None,
):
    """
    Bidirectional WebSocket proxy between Rie client and Gemini Live API.
    Streams 16kHz PCM audio upstream, streams 24kHz PCM audio downstream, and handles barge-in.
    """
    await websocket.accept()

    # 1. Authenticate token
    if not _verify_ws_token(token):
        logger.warning("[LiveVoice] Unauthorized WebSocket connection attempt.")
        await websocket.send_json({"type": "error", "message": "Unauthorized: invalid app token"})
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Verify Google API Key
    google_api_key = settings.GOOGLE_API_KEY
    if not google_api_key or google_api_key == "your_gemini_api_key_here":
        logger.error("[LiveVoice] Google API Key is not configured.")
        await websocket.send_json({
            "type": "error",
            "message": "Google API key is not configured. Please add your Gemini API key in Rie Settings → API Keys."
        })
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Normalize voice
    valid_voice_names = {v["id"] for v in AVAILABLE_LIVE_VOICES}
    selected_voice = voice if voice in valid_voice_names else "Aoede"

    target_url = f"{GEMINI_LIVE_WS_URL}?key={google_api_key}"
    logger.info(f"[LiveVoice] Connecting to Gemini Live API with voice '{selected_voice}', thread='{thread_id}'...")

    try:
        async with websockets.connect(target_url, ping_interval=20, ping_timeout=20) as gemini_ws:
            # 3. Send Gemini Setup configuration
            setup_message = {
                "setup": {
                    "model": "models/gemini-2.5-flash-native-audio-latest",
                    "realtimeInputConfig": {
                        "automaticActivityDetection": {
                            "disabled": False,
                            "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                            "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                            "prefixPaddingMs": 100,
                            # 450ms silence allows natural pauses/breaths without
                            # delaying the response or causing turn overlaps.
                            "silenceDurationMs": 450,
                        }
                    },
                    "contextWindowCompression": {
                        "slidingWindow": {
                            "targetTokens": 16000
                        }
                    },
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "thinkingConfig": {
                            "thinkingBudget": 0
                        },
                        "speechConfig": {
                            "voiceConfig": {
                                "prebuiltVoiceConfig": {
                                    "voiceName": selected_voice
                                }
                            }
                        }
                    },
                    "outputAudioTranscription": {},
                    "inputAudioTranscription": {},
                    "systemInstruction": {
                        "parts": [
                            {
                                "text": build_live_system_instruction(
                                    client_timezone=client_timezone,
                                    client_local_datetime_iso=client_local_datetime_iso,
                                    client_latitude=client_latitude,
                                    client_longitude=client_longitude,
                                    client_location_accuracy_m=client_location_accuracy_m,
                                )
                            }
                        ]
                    },
                    "tools": [
                        {
                            "functionDeclarations": live_tool_dispatcher.get_tool_declarations()
                        }
                    ]
                }
            }

            await gemini_ws.send(json.dumps(setup_message))
            logger.info("[LiveVoice] Setup frame sent to Gemini upstream.")

            # Do not accept audio until upstream has acknowledged the configuration.
            async with asyncio.timeout(20):
                while True:
                    response = json.loads(await gemini_ws.recv())
                    if "error" in response:
                        raise RuntimeError(response["error"].get("message", "Voice setup failed"))
                    if "setupComplete" in response:
                        break
            await websocket.send_json({"type": "ready"})
            logger.info("[LiveVoice] Gemini setup acknowledged; ready for input.")

            # Trigger an immediate natural spoken greeting from Rie
            if greet:
                greeting_message = {
                    "clientContent": {
                        "turns": [
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "text": (
                                            "The user just started this live voice session with you. "
                                            "Greet the user immediately with a warm, natural, friendly, 1-sentence hello "
                                            "(e.g., 'Hey there! How can I help you today?' or 'Hi! What's on your mind?')."
                                        )
                                    }
                                ]
                            }
                        ],
                        "turnComplete": True
                    }
                }
                await gemini_ws.send(json.dumps(greeting_message))
                logger.info("[LiveVoice] Automatic greeting trigger sent to Gemini.")

            transcripts = VoiceTranscripts()
            tool_tasks = {}
            tool_lock = asyncio.Lock()

            async def notify_gemini(task_desc: str, result_summary: str):
                try:
                    if not gemini_ws.closed:
                        clean_summary = result_summary[:600]
                        notification = {
                            "clientContent": {
                                "turns": [
                                    {
                                        "role": "user",
                                        "parts": [
                                            {
                                                "text": (
                                                    f"[SYSTEM NOTIFICATION: Background subagent has finished the task: '{task_desc}']\n"
                                                    f"Task Result:\n{clean_summary}\n\n"
                                                    "Please naturally speak a concise 1-2 sentence update to the user right now, "
                                                    "summarizing that their task has completed and the outcome."
                                                )
                                            }
                                        ]
                                    }
                                ],
                                "turnComplete": True
                            }
                        }
                        await gemini_ws.send(json.dumps(notification))
                        logger.info("[LiveVoice] Delivered subagent completion notification to Gemini Live.")
                except Exception as notif_err:
                    logger.warning(f"[LiveVoice] Failed sending subagent completion to Gemini: {notif_err}")

            if hasattr(live_tool_dispatcher, "set_context"):
                live_tool_dispatcher.set_context({
                    "thread_id": thread_id,
                    "websocket": websocket,
                    "notify_callback": notify_gemini,
                    "client_latitude": client_latitude,
                    "client_longitude": client_longitude,
                    "client_location_accuracy_m": client_location_accuracy_m,
                    "client_timezone": client_timezone,
                    "client_local_datetime_iso": client_local_datetime_iso,
                })

            async def finish_transcript(role, interrupted=False, notify=True):
                item = transcripts.finish(role, interrupted)
                if not item:
                    return
                if thread_id and item["text"].strip():
                    try:
                        await asyncio.to_thread(save_message, thread_id, role, item["text"].strip())
                    except Exception:
                        logger.exception("[LiveVoice] Failed saving transcript")
                if notify:
                    await websocket.send_json(item)

            async def run_tool(call):
                call_id, name, args = call["id"], call["name"], call.get("args", {})
                try:
                    # Keep desktop actions ordered while the receiver remains free
                    # to handle audio, transcripts, and cancellation messages.
                    async with tool_lock:
                        await websocket.send_json({
                            "type": "tool_call", "id": call_id, "name": name,
                            "args": args, "status": "running",
                        })
                        try:
                            result = await asyncio.wait_for(
                                live_tool_dispatcher.dispatch(name, args),
                                timeout=90,
                            )
                        except TimeoutError:
                            result = "Error: Tool timed out. The action may still finish on the desktop."
                        except Exception as exc:
                            result = f"Error: {exc}"
                        await gemini_ws.send(json.dumps({"toolResponse": {"functionResponses": [{
                            "id": call_id, "name": name, "response": {"output": result},
                        }]}}))
                        logger.info("[LiveVoice] Tool result delivered upstream: name=%s id=%s status=%s chars=%d",
                                    name, call_id, tool_result_status(result), len(str(result)))
                        # Done means the result was also handed back to the model,
                        # not just that the local search/action finished.
                        await websocket.send_json({
                            "type": "tool_result", "id": call_id, "name": name,
                            "result": result, "status": tool_result_status(result),
                        })
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("[LiveVoice] Tool response delivery failed")
                    await gemini_ws.close()
                finally:
                    tool_tasks.pop(call_id, None)

            # 4. Client to Gemini forwarder task
            async def client_to_gemini():
                try:
                    while True:
                        raw_msg = await websocket.receive_text()
                        msg = json.loads(raw_msg)
                        msg_type = msg.get("type")

                        if msg_type == "audio":
                            # PCM 16kHz audio chunk (base64)
                            data = msg.get("data")
                            if data:
                                realtime_input = {
                                    "realtimeInput": {
                                        "audio": {"mimeType": "audio/pcm;rate=16000", "data": data}
                                    }
                                }
                                await gemini_ws.send(json.dumps(realtime_input))

                        elif msg_type == "text":
                            # User sent a text message in live voice mode
                            user_text = msg.get("text", "").strip()
                            if user_text:
                                if thread_id:
                                    try:
                                        await asyncio.to_thread(save_message, thread_id, "user", user_text)
                                    except Exception as db_err:
                                        logger.warning(f"[LiveVoice] Failed saving user message to db: {db_err}")

                                client_content = {
                                    "clientContent": {
                                        "turns": [
                                            {
                                                "role": "user",
                                                "parts": [{"text": user_text}]
                                            }
                                        ],
                                        "turnComplete": True
                                    }
                                }
                                await gemini_ws.send(json.dumps(client_content))

                        elif msg_type == "audio_end":
                            await gemini_ws.send(json.dumps({"realtimeInput": {"audioStreamEnd": True}}))

                        elif msg_type == "cancel_job":
                            job_id = str(msg.get("job_id") or "").strip()
                            if not job_id:
                                running_jobs = [j for j in job_manager.list_jobs(limit=5) if j.status == "running"]
                                if running_jobs:
                                    job_id = running_jobs[0].job_id
                            if job_id:
                                success = job_manager.cancel_job(job_id)
                                logger.info(f"[LiveVoice] UI cancelled subagent job '{job_id}': success={success}")
                                await websocket.send_json({
                                    "type": "job_status",
                                    "job_id": job_id,
                                    "status": "cancelled",
                                    "result": "Subagent execution was cancelled by user.",
                                })

                        elif msg_type == "ping":
                            await websocket.send_json({"type": "pong"})

                except WebSocketDisconnect:
                    logger.info("[LiveVoice] Client disconnected.")
                except asyncio.CancelledError:
                    pass
                except Exception as e:
                    logger.error(f"[LiveVoice] Error in client_to_gemini: {e}", exc_info=True)

            # 5. Gemini to Client forwarder task
            async def gemini_to_client():
                try:
                    async for upstream_msg in gemini_ws:
                        if isinstance(upstream_msg, bytes):
                            upstream_msg = upstream_msg.decode("utf-8")
                        try:
                            resp = json.loads(upstream_msg)
                        except Exception:
                            continue

                        if "error" in resp:
                            raise RuntimeError(resp["error"].get("message", "Voice service error"))

                        cancellation = resp.get("toolCallCancellation")
                        if cancellation:
                            for call_id in cancellation.get("ids", []):
                                task = tool_tasks.get(call_id)
                                if task:
                                    task.cancel()
                                    await websocket.send_json({
                                        "type": "tool_result", "id": call_id, "status": "cancelled",
                                        "result": "Cancelled. Actions already started may still complete.",
                                    })
                            continue

                        # Tool / Function Call from Gemini Live
                        tool_call = resp.get("toolCall")
                        if tool_call:
                            function_calls = tool_call.get("functionCalls", [])
                            for call in function_calls:
                                call_id = call["id"]
                                if call_id in tool_tasks:
                                    continue
                                await websocket.send_json({
                                    "type": "tool_call", "id": call_id, "name": call["name"],
                                    "args": call.get("args", {}), "status": "queued",
                                })
                                tool_tasks[call_id] = asyncio.create_task(run_tool(call))
                            continue

                        server_content = resp.get("serverContent")
                        if not server_content:
                            continue

                        # Interruption / barge-in event from Gemini
                        if server_content.get("interrupted"):
                            await websocket.send_json({"type": "interrupted"})
                            await finish_transcript("user")

                        for field, role in (("inputTranscription", "user"), ("outputTranscription", "assistant")):
                            transcription = server_content.get(field, {})
                            item = transcripts.append(role, transcription.get("text", ""))
                            if item:
                                await websocket.send_json(item)
                            if transcription.get("finished"):
                                await finish_transcript(role)

                        if server_content.get("interrupted"):
                            await finish_transcript("assistant", interrupted=True)

                        model_turn = server_content.get("modelTurn")
                        if model_turn and not server_content.get("interrupted"):
                            for part in model_turn.get("parts", []):
                                # Audio chunk (PCM 24kHz base64)
                                inline_data = part.get("inlineData")
                                if inline_data and inline_data.get("data"):
                                    await websocket.send_json({
                                        "type": "audio",
                                        "data": inline_data["data"],
                                        "sampleRate": 24000
                                    })

                                # Native audio captions come from outputTranscription.
                                # modelTurn.text can contain thoughts, not spoken words.

                        # Turn completed
                        if server_content.get("turnComplete"):
                            await finish_transcript("user")
                            await finish_transcript("assistant")
                            await websocket.send_json({"type": "turn_complete"})

                except asyncio.CancelledError:
                    pass
                except websockets.exceptions.ConnectionClosed as cc:
                    logger.info(f"[LiveVoice] Gemini upstream closed: {cc}")
                    await websocket.send_json({"type": "closed", "reason": str(cc)})
                except Exception as e:
                    logger.error(f"[LiveVoice] Error in gemini_to_client: {e}", exc_info=True)
                    await websocket.send_json({"type": "error", "message": str(e)})

            # Run both loops concurrently
            c2g_task = asyncio.create_task(client_to_gemini())
            g2c_task = asyncio.create_task(gemini_to_client())

            try:
                await asyncio.wait([c2g_task, g2c_task], return_when=asyncio.FIRST_COMPLETED)
            finally:
                tasks = [c2g_task, g2c_task, *tool_tasks.values()]
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                # Preserve the last captions even if the user ends mid-sentence.
                await finish_transcript("user", notify=False)
                await finish_transcript("assistant", interrupted=True, notify=False)
                try:
                    await websocket.close()
                except RuntimeError:
                    pass
                if hasattr(live_tool_dispatcher, "clear_context"):
                    live_tool_dispatcher.clear_context()

    except websockets.exceptions.InvalidStatusCode as isc:
        logger.error(f"[LiveVoice] Failed connecting to Gemini Live API: {isc}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"Gemini Live connection error: {isc}. Please verify your Gemini API key and Live API access."
            })
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:
            pass
    except Exception as e:
        logger.error(f"[LiveVoice] Exception in Live Voice session: {e}", exc_info=True)
        try:
            await websocket.send_json({"type": "error", "message": f"Live Voice error: {str(e)}"})
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:
            pass
