"""Helpers for capturing PowerShell output without CLIXML progress noise."""

import re

# When stdout/stderr are pipes, PowerShell serializes progress to stderr as CLIXML.
# These preferences suppress that stream so tools and the UI see plain text.
POWERSHELL_CAPTURE_PREFIX = (
    "$ProgressPreference='SilentlyContinue'; "
    "$VerbosePreference='SilentlyContinue'; "
    "$InformationPreference='SilentlyContinue'; "
    "$WarningPreference='SilentlyContinue'\n"
)

_CLIXML_SEGMENT = re.compile(
    r"#< CLIXML\s*\r?\n<Objs\b[\s\S]*?</Objs>",
    re.MULTILINE,
)


def wrap_for_capture(command: str) -> str:
    """Prepend stream preferences before the user/script command."""
    return POWERSHELL_CAPTURE_PREFIX + command


def strip_clixml_noise(text: str) -> str:
    """Remove any CLIXML blobs left in captured output (defense in depth)."""
    if not text or "#< CLIXML" not in text:
        return text
    cleaned = _CLIXML_SEGMENT.sub("", text)
    return cleaned.strip()
