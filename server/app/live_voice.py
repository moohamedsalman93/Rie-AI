"""
Gemini Live WebSocket bridge for audio, transcription, and tool activity.
"""
import os
import json
import asyncio
import logging
import secrets
import random
import re
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


def resolve_user_name() -> str:
    """Resolves the user's preferred first name from settings, LTM memory, or default."""
    try:
        from app.config import settings
        custom_name = settings._get("USER_NAME") or settings._get("user_name")
        if custom_name and str(custom_name).strip():
            return str(custom_name).strip()
    except Exception:
        pass

    try:
        from app.memory import memory_store
        store = memory_store.get_store_sync()
        items = list(store.search(("users", "default_user"), query="user name", limit=3))
        for item in items:
            content = str(item.value.get("content", ""))
            m = re.search(r"(?:user(?:'s)? name is|named)\s+([A-Za-z]+)", content, re.IGNORECASE)
            if m:
                return m.group(1).strip()
    except Exception as e:
        logger.debug(f"[LiveVoice] Error reading user name from LTM: {e}")

    return "Salman"


async def get_last_work_topic() -> Optional[str]:
    """Retrieves the most recent work topic from workstream sessions or desktop history."""
    try:
        from app.workstream.tools import get_last_work_session_func
        loop = asyncio.get_running_loop()
        text = await asyncio.wait_for(
            loop.run_in_executor(None, get_last_work_session_func),
            timeout=1.5,
        )
        if not text:
            return None
        m_title = re.search(r"###\s*Last Work Session:\s*(.+)", text)
        if m_title:
            raw_title = m_title.group(1).strip()
            # Clean off boilerplate prefixes
            cleaned = re.sub(
                r"^(?:debugging and resolving issues in|working on|active on|investigating|resolving issues in)\s+",
                "",
                raw_title,
                flags=re.IGNORECASE,
            ).strip().rstrip(".")
            if cleaned and len(cleaned) <= 60:
                return cleaned
        m_proj = re.search(r"\*\*Project\*\*:\s*([^\|\n]+)", text)
        if m_proj:
            proj = m_proj.group(1).strip()
            if proj and proj.lower() not in ("none", "unknown"):
                return proj
    except Exception as e:
        logger.debug(f"[LiveVoice] Could not fetch last work session: {e}")
    return None


async def build_dynamic_greeting_prompt(
    client_local_datetime_iso: Optional[str] = None,
    client_timezone: Optional[str] = None,
) -> str:
    """
    Constructs a spontaneous, highly personalized opening turn prompt for Gemini Live.
    Uses user name, last work topic, time-of-day, and randomly chosen agent persona flavor
    so every greeting sounds fresh, dynamic, and like a true intelligent personal agent.
    """
    user_name = resolve_user_name()
    last_work = await get_last_work_topic()

    hour = None
    time_str = ""
    period = "day"
    if client_local_datetime_iso:
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(client_local_datetime_iso)
            hour = dt.hour
            time_str = dt.strftime("%I:%M %p").lstrip("0")
        except Exception:
            pass

    if hour is None:
        try:
            from datetime import datetime
            dt = datetime.now()
            hour = dt.hour
            time_str = dt.strftime("%I:%M %p").lstrip("0")
        except Exception:
            hour = 12

    is_late_night = (0 <= hour < 5) or (hour >= 23)
    if 5 <= hour < 12:
        period = "morning"
    elif 12 <= hour < 17:
        period = "afternoon"
    elif 17 <= hour < 23:
        period = "evening"
    else:
        period = "tonight"

    available_flavors = ["casual_direct"]
    weights = [25]

    if last_work:
        available_flavors.append("work_continuity")
        weights.append(45)

    if is_late_night or period in ("morning", "afternoon", "evening"):
        available_flavors.append("ambient_time")
        weights.append(25)

    available_flavors.append("bilingual")
    weights.append(10)

    chosen_flavor = random.choices(available_flavors, weights=weights, k=1)[0]

    if chosen_flavor == "work_continuity" and last_work:
        return (
            f"The user {user_name} just connected via live voice. "
            f"His most recent work was: '{last_work}'. "
            f"Greet {user_name} warmly and naturally by name in 1 brief sentence (maximum 15 words), "
            f"asking if he needs any help regarding {last_work} or what he wants to work on right now "
            f"(e.g., 'Hey {user_name}! Need any help regarding {last_work}, or what are we working on?' "
            f"or 'Hey {user_name}, ready to jump back into {last_work}, or what's up?'). "
            "Speak spontaneously as a real AI companion. NEVER use repetitive canned scripts like 'What's on your mind today?'."
        )

    elif chosen_flavor == "ambient_time":
        if is_late_night:
            return (
                f"The user {user_name} just connected via live voice late at night ({time_str}). "
                f"Greet {user_name} warmly by name in 1 brief natural sentence, "
                f"casually acknowledging he's working late or asking how you can help him tonight "
                f"(e.g., 'Working late tonight, {user_name}? What can I help you with?' "
                f"or 'Hey {user_name}, burning the midnight oil! What are we working on?'). "
                "Keep it completely natural, friendly, and brief."
            )
        else:
            return (
                f"The user {user_name} just connected via live voice during the {period}. "
                f"Greet {user_name} warmly by name in 1 brief natural sentence suited to the {period} "
                f"(e.g., 'Good {period} {user_name}! What are we building today?' "
                f"or 'Hey {user_name}, hope your {period} is going well! What's on your desk?'). "
                "Keep it spontaneous, friendly, and varied."
            )

    elif chosen_flavor == "bilingual":
        return (
            f"The user {user_name} just connected via live voice. He speaks English and Tamil. "
            f"Greet {user_name} warmly by name in 1 brief sentence with a friendly bilingual touch "
            f"(e.g., 'ஹே {user_name}! How can I help you today?' "
            f"or 'Hey {user_name}! சொல்லுங்க, what are we working on today?'). "
            "Keep it natural, spontaneous, and warm."
        )

    else:
        # casual_direct
        return (
            f"The user {user_name} just connected via live voice. "
            f"Greet {user_name} warmly, casually, and directly by name in 1 brief snappy sentence "
            f"(e.g., 'Hey {user_name}! Ready when you are, what's on the agenda?' "
            f"or 'Hey {user_name}, good to hear from you! What are we diving into?' "
            f"or 'Hey {user_name}! What can I help you with right now?'). "
            "Vary your phrasing naturally. Never use repetitive robotic lines."
        )


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

    user_name = resolve_user_name()

    base_prompt = (
        f"You are Rie, an ultra-fast, helpful, warm, concise, and highly capable desktop AI companion. "
        f"You are interacting with your owner and friend, {user_name}, via real-time spoken voice conversation.\n\n"
        f"## USER IDENTITY & CONVERSATIONAL NATURALNESS:\n"
        f"- The user's name is {user_name}. Always know {user_name} as your primary user and owner.\n"
        f"- Address him naturally by name (e.g. '{user_name}') when greeting him or when appropriate.\n"
        "- ACT LIKE A REAL, LIVING COMPANION: Never speak like an interactive voice response (IVR) phone tree or canned recording. Avoid cliché, repetitive phrases like 'What's on your mind today?' or 'How can I assist you today?'. Speak with spontaneous human warmth, variation, and personality.\n\n"
        "## STRICT LANGUAGE POLICY (ENGLISH & TAMIL ONLY):\n"
        "- The ONLY supported languages are ENGLISH and TAMIL (தமிழ் / Tanglish).\n"
        "- NEVER converse, respond, output, or transcribe in Telugu (తెలుగు) or Hindi (हिंदी).\n"
        "- You must NEVER output Telugu script or Devanagari script under any circumstances.\n"
        "- The user speaks English and Tamil. Interpret all user speech strictly as English or Tamil, never as Telugu or Hindi.\n"
        "- Seamlessly speak in Tamil (தமிழ்) or English based on the language the user speaks to you.\n\n"
        "## CORE ARCHITECTURAL PRINCIPLES:\n"
        "1. CONVERSATIONAL BRAIN: You are the voice and intent coordinator. Fast tools are your reflexes, and the autonomous subagent is your hands.\n"
        "2. ROUTING FIRST: Never independently decide that an executable capability is unavailable. When the user asks for an action, file operation, coding, terminal command, or technical task, route the request to the appropriate fast tool or to `spawn_subagent`.\n"
        "3. FAST REFLEXES: For instant actions (launching an app like Spotify, media controls, web search, opening a URL, saving memory, scheduling reminders), invoke your dedicated fast tools immediately without hesitation.\n"
        "4. BACKGROUND AGENT (HANDS): For all deep technical work, programming, terminal commands, file edits, test execution, or multi-step research, invoke `spawn_subagent(task=..., mode='background')`. It will return a job ID immediately.\n"
        "5. PROMPT ACKNOWLEDGMENT: When launching a background subagent, immediately speak a brief natural confirmation (e.g. 'I've started the agent on that. I'll let you know as soon as it's finished!'). You can continue conversing with the user while the agent works.\n"
        "6. NOTIFICATION SUMMARIES: When the background agent finishes, you will receive a notification event. Naturally speak a concise 1-2 sentence update summarizing the completed outcome.\n"
        "7. CANCEL SUBAGENT: If the user asks to cancel, stop, or abort the agent or task, immediately invoke `cancel_subagent()` to stop the background subagent.\n"
        "8. SPOKEN STYLE: Keep spoken answers short, punchy, and natural (1 to 2 sentences max) so it feels like a snappy back-and-forth chat. Avoid reading raw markdown or code aloud.\n"
        "9. MULTI-SPEAKER & ROOM AWARENESS: You hear the ambient room audio. The primary enrolled user is your owner. Other people in the room (e.g., nephew, colleagues, guests) may also speak.\n"
        "   - If the user asks about who spoke in the room (e.g. 'was that a single person or two persons?', 'who spoke? / யார் யார்?'), use the conversational history and distinct voices/topics to accurately answer in the user's language.\n"
        "   - When the user explicitly instructs you to answer or talk to someone else (e.g. 'answer him', 'reply to my nephew', 'tell John...', 'அவனுக்கு பதில் சொல்லு'), address that person and answer their question.\n"
        "   - If the user tells you to ignore someone (e.g. 'ignore him', 'don't answer him', 'இக்னோர் பண்ணிடு'), respect that and stay focused exclusively on the primary user.\n"
        "   - Seamlessly converse exclusively in Tamil (தமிழ்) and English based on the language the user speaks.\n"
        "10. FAREWELL & DISCONNECT (GO TO SLEEP): When the user says goodbye, bye, bye-bye, see you later, let's see later, let see later, go to sleep, sleep now, good night, stop listening, disconnect, or indicates that they are done talking (e.g. 'bye', 'see you later', 'let see later', 'go to sleep', 'sleep now', 'good night', 'போய் வா', 'பாய்', 'தூங்கு', 'கிளம்பு'):\n"
        "   - Speak a warm, brief 1-sentence farewell (e.g. 'Goodbye! Talk to you soon!', 'Going to sleep now, bye!', 'சரி, அப்புறம் பார்க்கலாம்!').\n"
        "   - IMMEDIATELY invoke the `disconnect_session` tool. This will cleanly close the live voice call and return you to sleep, where the user can wake you up again anytime by saying 'Hey Rie'."
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
                greeting_prompt = await build_dynamic_greeting_prompt(
                    client_local_datetime_iso=client_local_datetime_iso,
                    client_timezone=client_timezone,
                )
                greeting_message = {
                    "clientContent": {
                        "turns": [
                            {
                                "role": "user",
                                "parts": [
                                    {
                                        "text": greeting_prompt,
                                    }
                                ]
                            }
                        ],
                        "turnComplete": True
                    }
                }
                await gemini_ws.send(json.dumps(greeting_message))
                logger.info(f"[LiveVoice] Spoken dynamic greeting trigger sent: {greeting_prompt[:80]}...")

            transcripts = VoiceTranscripts()
            tool_tasks = {}
            tool_lock = asyncio.Lock()
            turn_state = {
                "speaker": "USER",
                "authorized": True,
                "score": 0.0,
                "user_delegated": False,
                "suppress_assistant": not greet,
                "verifying": False,
            }

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
                if role == "assistant" and turn_state["suppress_assistant"]:
                    # Hard Response Firewall: Drop unauthorized assistant answer from db and stream
                    transcripts.finish("assistant", interrupted=True)
                    return
                item = transcripts.finish(role, interrupted)
                if not item:
                    return
                if role == "user":
                    item["speaker"] = turn_state["speaker"]
                    item["authorized"] = turn_state["authorized"] or turn_state["user_delegated"]
                if thread_id and item["text"].strip():
                    try:
                        label = f"[{turn_state['speaker']}] {item['text'].strip()}" if turn_state["speaker"] == "OTHER" else item['text'].strip()
                        await asyncio.to_thread(save_message, thread_id, role, label)
                    except Exception:
                        logger.exception("[LiveVoice] Failed saving transcript")
                if notify:
                    await websocket.send_json(item)

            async def run_tool(call):
                call_id, name, args = call["id"], call["name"], call.get("args", {})
                try:
                    # Security Firewall: Block tool execution if current speech turn is unauthorized
                    if turn_state.get("verifying", False):
                        logger.info("[LiveVoice Security Firewall] Tool call '%s' arrived while speaker verification in-flight. Waiting for verdict...", name)
                        for _ in range(30):
                            await asyncio.sleep(0.05)
                            if not turn_state.get("verifying", False):
                                break

                    is_authorized = turn_state["authorized"] or turn_state["user_delegated"]
                    if not is_authorized:
                        logger.warning(
                            "[LiveVoice Security Firewall] Blocked tool execution '%s' (id=%s) - unauthorized speaker '%s'",
                            name, call_id, turn_state["speaker"]
                        )
                        # Acknowledge rejection to Gemini Live upstream so it does not hang
                        await gemini_ws.send(json.dumps({"toolResponse": {"functionResponses": [{
                            "id": call_id,
                            "name": name,
                            "response": {"error": "Unauthorized: Speaker is not authorized to invoke tools."}
                        }]}}))
                        # Notify client UI that tool execution was rejected by security policy
                        await websocket.send_json({
                            "type": "tool_result",
                            "id": call_id,
                            "name": name,
                            "result": "Security Error: Tool execution rejected. Speaker is not authorized to invoke tools.",
                            "status": "unauthorized",
                        })
                        return

                    # Keep desktop actions ordered while the receiver remains free
                    # to handle audio, transcripts, and cancellation messages.
                    async with tool_lock:
                        if name in ("disconnect_session", "end_call", "disconnect_call", "go_to_sleep"):
                            try:
                                await websocket.send_json({
                                    "type": "disconnect_session",
                                    "reason": "user_farewell",
                                    "farewell": str(args.get("farewell") or "Goodbye!").strip(),
                                })
                            except Exception:
                                pass
                        else:
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
                        if name not in ("disconnect_session", "end_call", "disconnect_call", "go_to_sleep"):
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
                            logger.info("[LiveVoice] Speech turn concluded (audio_end). Signaling audioStreamEnd to Gemini Live.")
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

                        elif msg_type == "speech_onset":
                            turn_state["speaker"] = "VERIFYING"
                            turn_state["authorized"] = False
                            turn_state["user_delegated"] = False
                            turn_state["suppress_assistant"] = True
                            turn_state["verifying"] = True
                            logger.info("[LiveVoice] Speech onset detected. Locking response authorization pending verification.")

                        elif msg_type == "speaker_tag":
                            speaker = str(msg.get("speaker") or "UNKNOWN")
                            authorized = bool(msg.get("authorized", False))
                            score = float(msg.get("score", 0.0))
                            is_delegated = bool(msg.get("isDelegated") or msg.get("is_delegated", False))

                            turn_state["speaker"] = speaker
                            turn_state["authorized"] = authorized
                            turn_state["score"] = score
                            turn_state["user_delegated"] = is_delegated
                            turn_state["suppress_assistant"] = not (authorized or is_delegated)
                            turn_state["verifying"] = False
                            logger.info(
                                f"[LiveVoice] Speaker Tag: {speaker} (auth={authorized}, delegated={is_delegated}, suppress={turn_state['suppress_assistant']}, score={score:.4f})"
                            )

                        elif msg_type == "abort_response":
                            turn_state["authorized"] = False
                            turn_state["verifying"] = False
                            reason = str(msg.get("reason") or "")
                            if reason in ("transient_noise", "assistant_echo"):
                                turn_state["suppress_assistant"] = False
                                turn_state["speaker"] = "USER"
                                turn_state["authorized"] = True
                            else:
                                turn_state["suppress_assistant"] = True
                            logger.info(f"[LiveVoice Response Firewall] Received abort_response from client (reason={reason}). Suppressing assistant={turn_state['suppress_assistant']}.")

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
                                if call["name"] not in ("disconnect_session", "end_call", "disconnect_call", "go_to_sleep"):
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
                            text = transcription.get("text", "")
                            if role == "assistant" and turn_state["suppress_assistant"]:
                                # Hard Response Firewall: Drop assistant transcription for unauthorized turn
                                logger.debug("[LiveVoice Response Firewall] Suppressed assistant transcription for unauthorized turn: %s", text)
                                continue
                            item = transcripts.append(role, text)
                            if item:
                                await websocket.send_json(item)
                            if transcription.get("finished"):
                                await finish_transcript(role)

                        if server_content.get("interrupted"):
                            await finish_transcript("assistant", interrupted=True)

                        model_turn = server_content.get("modelTurn")
                        if model_turn and not server_content.get("interrupted"):
                            if turn_state["suppress_assistant"]:
                                logger.debug(
                                    "[LiveVoice Response Firewall] Suppressed modelTurn audio for unauthorized speaker: %s",
                                    turn_state["speaker"]
                                )
                            else:
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
                            if not turn_state["suppress_assistant"]:
                                await finish_transcript("assistant")
                            await websocket.send_json({
                                "type": "turn_complete",
                                "suppressed": turn_state["suppress_assistant"],
                            })
                            # Reset turn state when idle between turns
                            turn_state["speaker"] = "USER"
                            turn_state["authorized"] = True
                            turn_state["user_delegated"] = False
                            turn_state["suppress_assistant"] = False
                            turn_state["verifying"] = False

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
