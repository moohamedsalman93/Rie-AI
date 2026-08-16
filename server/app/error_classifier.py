"""
Error Classifier & Retry Policy module for Rie Agent Runtime.

Categorizes runtime failures into:
1. TRANSIENT: Timeouts, connection resets, device busy/locked -> Limited automated retry.
2. RECOVERABLE: Invalid arguments, non-zero return codes, syntax errors -> Pass output back to LLM for reasoned correction.
3. FATAL: Permission denied, authentication failures, unsupported OS ops -> Immediately halt and report.
"""
from enum import Enum
from dataclasses import dataclass
from typing import Optional, Any
import subprocess
import httpx


class ErrorCategory(str, Enum):
    TRANSIENT = "transient"      # Retryable automatically
    RECOVERABLE = "recoverable"  # Inform model to adjust approach
    FATAL = "fatal"              # Abort execution immediately


@dataclass
class ErrorClassification:
    category: ErrorCategory
    reason: str
    retry_recommended: bool
    max_retries: int = 2
    backoff_seconds: float = 1.0


# Keyword / Exception heuristics for classification
TRANSIENT_KEYWORDS = (
    "timeout",
    "timed out",
    "connection reset",
    "connection refused",
    "connection error",
    "temporarily unavailable",
    "resource busy",
    "device busy",
    "screen grab failed",
    "network is unreachable",
    "try again later",
    "rate limit exceeded",
    "429",
    "503",
    "504",
)

FATAL_KEYWORDS = (
    "permission denied",
    "access is denied",
    "unauthorized",
    "forbidden",
    "401",
    "403",
    "winerror 5",
    "privilege not held",
    "operation not permitted",
    "invalid credentials",
    "account suspended",
    "authentication failed",
)


def classify_tool_error(
    tool_name: str,
    error: Optional[Any] = None,
    output: Optional[Any] = None
) -> ErrorClassification:
    """
    Classifies a tool exception or error output string into TRANSIENT, RECOVERABLE, or FATAL.
    """
    err_str = ""
    if error is not None:
        if isinstance(error, Exception):
            err_str += f"{type(error).__name__}: {str(error)} "
        else:
            err_str += str(error) + " "

    if output is not None:
        if isinstance(output, str):
            err_str += output
        elif isinstance(output, dict):
            err_str += f"{output.get('error', '')} {output.get('stderr', '')} {output.get('message', '')}"

    err_lower = err_str.lower()

    # 1. Check FATAL keywords first
    for kw in FATAL_KEYWORDS:
        if kw in err_lower:
            return ErrorClassification(
                category=ErrorCategory.FATAL,
                reason=f"Fatal access/permission error detected: '{kw}'",
                retry_recommended=False,
                max_retries=0
            )

    # 2. Check TRANSIENT exceptions & keywords
    if error is not None:
        if isinstance(error, (subprocess.TimeoutExpired, TimeoutError, httpx.TimeoutException, ConnectionError)):
            return ErrorClassification(
                category=ErrorCategory.TRANSIENT,
                reason=f"Transient timeout or network interruption: {type(error).__name__}",
                retry_recommended=True,
                max_retries=2,
                backoff_seconds=1.5
            )

    for kw in TRANSIENT_KEYWORDS:
        if kw in err_lower:
            return ErrorClassification(
                category=ErrorCategory.TRANSIENT,
                reason=f"Transient system/network failure detected: '{kw}'",
                retry_recommended=True,
                max_retries=2,
                backoff_seconds=1.0
            )

    # 3. Default to RECOVERABLE (tool execution error that model can observe & self-correct)
    return ErrorClassification(
        category=ErrorCategory.RECOVERABLE,
        reason="Recoverable execution/argument failure. Passing diagnostic output to LLM for reasoned recovery.",
        retry_recommended=False,
        max_retries=0
    )
