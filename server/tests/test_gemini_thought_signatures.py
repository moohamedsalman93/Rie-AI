import pytest
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from app.agent import _get_safe_chat_google_generative_ai_cls, _ensure_gemini_thought_signatures


def test_ensure_gemini_thought_signatures_fallback():
    """Verify that function calls without a thought_signature receive the skip sentinel."""
    SafeCls = _get_safe_chat_google_generative_ai_cls()
    llm = SafeCls(model="gemini-3.8-flash", google_api_key="mock_key")

    msgs = [
        HumanMessage(content="whats on my screen"),
        AIMessage(content="", tool_calls=[{"name": "default_api:get_desktop_state", "args": {}, "id": "tc-1"}]),
        ToolMessage(content="Screen active", tool_call_id="tc-1"),
    ]

    req = llm._prepare_request(msgs)
    assert hasattr(req, "contents")
    # Verify the model turn contains thought_signature = b'skip_thought_signature_validator'
    model_turn = [c for c in req.contents if c.role == "model"][0]
    assert model_turn.parts[0].thought_signature == b"skip_thought_signature_validator"


def test_ensure_gemini_thought_signatures_preserved():
    """Verify that a preserved thought_signature in additional_kwargs is passed through."""
    SafeCls = _get_safe_chat_google_generative_ai_cls()
    llm = SafeCls(model="gemini-3.8-flash", google_api_key="mock_key")

    preserved_sig = b"existing_cryptographic_thought_signature"
    msgs = [
        HumanMessage(content="whats on my screen"),
        AIMessage(
            content="",
            additional_kwargs={"thought_signature": preserved_sig},
            tool_calls=[{"name": "get_desktop_state", "args": {}, "id": "tc-2"}],
        ),
        ToolMessage(content="Screen active", tool_call_id="tc-2"),
    ]

    req = llm._prepare_request(msgs)
    model_turn = [c for c in req.contents if c.role == "model"][0]
    assert model_turn.parts[0].thought_signature == preserved_sig


def test_ensure_gemini_thought_signatures_parallel_tools():
    """Verify that multiple parallel function call parts all receive thought signatures."""
    SafeCls = _get_safe_chat_google_generative_ai_cls()
    llm = SafeCls(model="gemini-3.8-flash", google_api_key="mock_key")

    msgs = [
        HumanMessage(content="inspect screen and run search"),
        AIMessage(
            content="",
            tool_calls=[
                {"name": "get_desktop_state", "args": {}, "id": "tc-1"},
                {"name": "internet_search", "args": {"query": "test"}, "id": "tc-2"},
            ],
        ),
        ToolMessage(content="Screen active", tool_call_id="tc-1"),
        ToolMessage(content="Results found", tool_call_id="tc-2"),
    ]

    req = llm._prepare_request(msgs)
    model_turn = [c for c in req.contents if c.role == "model"][0]
    assert len(model_turn.parts) == 2
    for part in model_turn.parts:
        assert part.thought_signature == b"skip_thought_signature_validator"
