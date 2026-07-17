"""
Fetch Open Graph / meta previews for URLs in chat messages.
"""
from __future__ import annotations

import html
import re
from typing import Any, Optional
from urllib.parse import urljoin, urlparse

import httpx

URL_PATTERN = re.compile(
    r"https?://[^\s<>\"')\]]+",
    re.IGNORECASE,
)

_META_TAG_RE = re.compile(
    r'<meta\s+[^>]*(?:property|name)\s*=\s*["\']([^"\']+)["\'][^>]*content\s*=\s*["\']([^"\']*)["\']'
    r'|<meta\s+[^>]*content\s*=\s*["\']([^"\']*)["\'][^>]*(?:property|name)\s*=\s*["\']([^"\']+)["\']',
    re.IGNORECASE | re.DOTALL,
)

_TITLE_RE = re.compile(r"<title[^>]*>([^<]+)</title>", re.IGNORECASE | re.DOTALL)

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

_PREVIEW_TIMEOUT = 10.0
_MAX_HTML_BYTES = 512_000
_MAX_URLS = 3


def extract_urls(text: str, max_urls: int = _MAX_URLS) -> list[str]:
    if not text:
        return []
    seen: set[str] = set()
    urls: list[str] = []
    for match in URL_PATTERN.finditer(text):
        raw = match.group(0).rstrip(".,;:!?)\"']")
        if raw in seen:
            continue
        seen.add(raw)
        urls.append(raw)
        if len(urls) >= max_urls:
            break
    return urls


def _parse_meta_tags(html_text: str) -> dict[str, str]:
    meta: dict[str, str] = {}
    for m in _META_TAG_RE.finditer(html_text):
        if m.group(1) and m.group(2) is not None:
            key, value = m.group(1).lower(), m.group(2)
        elif m.group(3) is not None and m.group(4):
            value, key = m.group(3), m.group(4).lower()
        else:
            continue
        value = html.unescape(value.strip())
        if value and key not in meta:
            meta[key] = value
    return meta


def _pick_meta(meta: dict[str, str], *keys: str) -> Optional[str]:
    for key in keys:
        val = meta.get(key)
        if val:
            return val
    return None


def _resolve_image(base_url: str, image: Optional[str]) -> Optional[str]:
    if not image:
        return None
    image = image.strip()
    if image.startswith("//"):
        parsed = urlparse(base_url)
        scheme = parsed.scheme or "https"
        return f"{scheme}:{image}"
    if image.startswith(("http://", "https://")):
        return image
    return urljoin(base_url, image)


async def fetch_url_preview(url: str) -> dict[str, Any]:
    """Return preview metadata for a single URL."""
    result: dict[str, Any] = {"url": url}
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            result["error"] = "Invalid URL"
            return result

        async with httpx.AsyncClient(
            timeout=_PREVIEW_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT, "Accept": "text/html,application/xhtml+xml"},
        ) as client:
            response = await client.get(url)
            response.raise_for_status()
            content_type = (response.headers.get("content-type") or "").lower()
            if "text/html" not in content_type and "application/xhtml" not in content_type:
                result["error"] = "Not an HTML page"
                return result

            raw = response.content[:_MAX_HTML_BYTES]
            encoding = response.encoding or "utf-8"
            html_text = raw.decode(encoding, errors="replace")

        meta = _parse_meta_tags(html_text)
        title = _pick_meta(
            meta,
            "og:title",
            "twitter:title",
            "title",
        )
        if not title:
            title_m = _TITLE_RE.search(html_text)
            if title_m:
                title = html.unescape(title_m.group(1).strip())

        description = _pick_meta(
            meta,
            "og:description",
            "twitter:description",
            "description",
        )
        image = _resolve_image(
            str(response.url),
            _pick_meta(meta, "og:image", "twitter:image", "twitter:image:src"),
        )
        site_name = _pick_meta(meta, "og:site_name")

        if title:
            result["title"] = title[:300]
        if description:
            result["description"] = description[:500]
        if image:
            result["image"] = image
        if site_name:
            result["site_name"] = site_name[:120]
        if not any(k in result for k in ("title", "description", "image")):
            result["error"] = "No preview metadata found"
    except httpx.TimeoutException:
        result["error"] = "Request timed out"
    except httpx.HTTPStatusError as exc:
        result["error"] = f"HTTP {exc.response.status_code}"
    except Exception as exc:
        result["error"] = str(exc)[:200]

    return result


async def fetch_url_previews(urls: list[str]) -> list[dict[str, Any]]:
    if not urls:
        return []
    import asyncio

    tasks = [fetch_url_preview(u) for u in urls[:_MAX_URLS]]
    return list(await asyncio.gather(*tasks))


def format_previews_for_agent(previews: list[dict[str, Any]]) -> str:
    """Append URL context so the model can reason about linked pages."""
    parts: list[str] = []
    for p in previews:
        url = p.get("url", "")
        if not url:
            continue
        lines = [f"URL: {url}"]
        if p.get("title"):
            lines.append(f"Title: {p['title']}")
        if p.get("description"):
            lines.append(f"Description: {p['description']}")
        if p.get("site_name"):
            lines.append(f"Site: {p['site_name']}")
        if p.get("error"):
            lines.append(f"Preview note: {p['error']}")
        parts.append("\n".join(lines))
    if not parts:
        return ""
    return "\n\n[URL Previews]:\n" + "\n\n---\n".join(parts)
