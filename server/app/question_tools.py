"""
Interactive question tool for Rie-AI.
Allows the agent to ask clarifying questions, present selectable options,
and request structured user input via interactive UI components.
"""
from typing import Any, Dict, List, Optional
import json


def normalize_question_payload(
    questions: Optional[List[Dict[str, Any]]] = None,
    question: Optional[str] = None,
    options: Optional[List[str]] = None,
    is_multi_select: bool = False,
    allow_custom: bool = True,
    placeholder: Optional[str] = None,
    header: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Normalizes any question inputs (single or multi-question) into the canonical payload shape:
    {
        "status": "asked",
        "header": Optional[str],
        "questions": [
            {
                "id": str,
                "question": str,
                "header": Optional[str],
                "options": List[str],
                "is_multi_select": bool,
                "allow_custom": bool,
                "placeholder": Optional[str]
            }
        ]
    }
    """
    normalized_questions: List[Dict[str, Any]] = []

    # 1. If questions list is passed, iterate and normalize each item
    if questions and isinstance(questions, list):
        for idx, item in enumerate(questions):
            if not isinstance(item, dict):
                # Fallback for string items
                if isinstance(item, str) and item.strip():
                    item = {"question": item.strip()}
                else:
                    continue

            q_text = str(item.get("question") or item.get("title") or item.get("text") or "").strip()
            if not q_text:
                continue

            q_header = item.get("header")
            if q_header is not None:
                q_header = str(q_header).strip() or None
            elif header:
                q_header = str(header).strip() or None

            # Normalize options
            raw_options = item.get("options") or item.get("choices") or []
            cleaned_options: List[str] = []
            if isinstance(raw_options, list):
                for opt in raw_options:
                    if opt is not None:
                        opt_str = str(opt).strip()
                        if opt_str:
                            cleaned_options.append(opt_str)
            elif isinstance(raw_options, str) and raw_options.strip():
                cleaned_options = [raw_options.strip()]

            q_multi = bool(item.get("is_multi_select", item.get("multi_select", False)))
            q_allow_custom = bool(item.get("allow_custom", item.get("allowCustom", True)))
            q_placeholder = item.get("placeholder") or item.get("input_placeholder")
            if q_placeholder is not None:
                q_placeholder = str(q_placeholder).strip() or None

            q_id = str(item.get("id") or f"q_{idx}")

            normalized_questions.append({
                "id": q_id,
                "question": q_text,
                "header": q_header,
                "options": cleaned_options,
                "is_multi_select": q_multi,
                "allow_custom": q_allow_custom,
                "placeholder": q_placeholder or ("Type custom response..." if q_allow_custom else None),
            })

    # 2. If single question is passed directly
    if not normalized_questions and question and str(question).strip():
        cleaned_options: List[str] = []
        if options and isinstance(options, list):
            for opt in options:
                if opt is not None:
                    opt_str = str(opt).strip()
                    if opt_str:
                        cleaned_options.append(opt_str)
        elif isinstance(options, str) and str(options).strip():
            cleaned_options = [str(options).strip()]

        normalized_questions.append({
            "id": "q_0",
            "question": str(question).strip(),
            "header": str(header).strip() if header else None,
            "options": cleaned_options,
            "is_multi_select": bool(is_multi_select),
            "allow_custom": bool(allow_custom),
            "placeholder": str(placeholder).strip() if placeholder else ("Type custom response..." if allow_custom else None),
        })

    # 3. Fallback if empty/malformed
    if not normalized_questions:
        fallback_text = str(question or "").strip() or "Please clarify your preference:"
        normalized_questions.append({
            "id": "q_0",
            "question": fallback_text,
            "header": str(header).strip() if header else None,
            "options": [],
            "is_multi_select": False,
            "allow_custom": True,
            "placeholder": "Type your response...",
        })

    return {
        "status": "asked",
        "header": str(header).strip() if header else None,
        "questions": normalized_questions,
    }


def ask_question(
    questions: Optional[List[Dict[str, Any]]] = None,
    question: Optional[str] = None,
    options: Optional[List[str]] = None,
    is_multi_select: bool = False,
    allow_custom: bool = True,
    placeholder: Optional[str] = None,
    header: Optional[str] = None,
) -> Dict[str, Any]:
    """Ask the user one or more interactive multiple-choice or input-based questions.
    
    Use this tool whenever you need clarification, user preferences, configuration options,
    or next-step decisions before proceeding with a task.

    Parameters:
    - question: The question or prompt text (e.g. 'What would you like me to do with your resume?').
    - options: List of selectable options (e.g. ['Review & give feedback', 'Tailor it for a specific job', 'Check ATS-friendliness']).
    - is_multi_select: Set to True if user can select multiple options simultaneously (checkboxes).
    - allow_custom: Set to True to allow write-in/custom input (default True).
    - placeholder: Placeholder text for the write-in input box.
    - header: Optional category or header text (e.g. 'Resume Tailoring').
    - questions: For multiple questions, a list of question objects each with { question, options, is_multi_select, allow_custom, placeholder, header }.
    """
    return normalize_question_payload(
        questions=questions,
        question=question,
        options=options,
        is_multi_select=is_multi_select,
        allow_custom=allow_custom,
        placeholder=placeholder,
        header=header,
    )
