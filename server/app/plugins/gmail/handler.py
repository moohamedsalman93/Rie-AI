"""
Gmail Integration Plugin Handler with extended full-suite automation:
- gmail_search_emails
- gmail_get_email
- gmail_send_email (supports attachments)
- gmail_create_draft (supports attachments)
- gmail_reply_email (supports attachments)
- gmail_archive_email
- gmail_mark_as_read
- gmail_mark_as_unread
- gmail_trash_email
- gmail_list_labels
"""
import base64
import os
import re
import httpx
from typing import Dict, Any, Tuple, Optional, List
from app.plugins.base import BasePluginHandler


def _decode_base64_data(body_data: str) -> str:
    """Decode base64url encoded payload body data safely."""
    if not body_data:
        return ""
    try:
        padded = body_data + "=" * (-len(body_data) % 4)
        raw_bytes = base64.urlsafe_b64decode(padded)
        return raw_bytes.decode("utf-8", errors="replace")
    except Exception:
        return ""


def _strip_html_to_markdown(html_str: str) -> str:
    """Convert HTML content into clean readable plain text / markdown."""
    if not html_str:
        return ""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html_str, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</?(p|div|h[1-6]|li|tr)[^>]*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<td[^>]*>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&quot;", '"')
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#39;", "'")
    )
    lines = [line.strip() for line in text.splitlines()]
    non_empty = []
    prev_blank = False
    for line in lines:
        if line:
            non_empty.append(line)
            prev_blank = False
        elif not prev_blank:
            non_empty.append("")
            prev_blank = True
    return "\n".join(non_empty).strip()


def _extract_mime_content(part: dict) -> Tuple[str, str]:
    """Recursively extract plain text and HTML text from message payload parts."""
    plain_text = ""
    html_text = ""

    mime_type = part.get("mimeType", "").lower()
    body_data = part.get("body", {}).get("data", "")

    if mime_type == "text/plain" and body_data:
        plain_text += _decode_base64_data(body_data)
    elif mime_type == "text/html" and body_data:
        html_text += _decode_base64_data(body_data)

    parts = part.get("parts", [])
    for subpart in parts:
        sub_plain, sub_html = _extract_mime_content(subpart)
        if sub_plain:
            plain_text = (plain_text + "\n" + sub_plain).strip() if plain_text else sub_plain
        if sub_html:
            html_text = (html_text + "\n" + sub_html).strip() if html_text else sub_html

    return plain_text, html_text


def _clean_body_text(text: str) -> str:
    """Clean body text to ensure lines are unindented so markdown does not render them as code blocks."""
    if not text:
        return ""
    lines = text.splitlines()
    cleaned_lines = [line.strip() for line in lines]
    result = "\n".join(cleaned_lines)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def parse_message_details(m_data: dict) -> dict:
    """Parse complete message details including headers, snippet, and decoded full body."""
    m_id = m_data.get("id", "")
    thread_id = m_data.get("threadId", "")
    snippet = m_data.get("snippet", "")
    payload = m_data.get("payload", {})
    headers_list = payload.get("headers", [])

    header_map = {}
    for h in headers_list:
        name = h.get("name", "").lower()
        header_map[name] = h.get("value", "")

    subject = header_map.get("subject", "No Subject")
    sender = header_map.get("from", "Unknown Sender")
    to_recip = header_map.get("to", "")
    date_val = header_map.get("date", "")

    plain_text, html_text = _extract_mime_content(payload)

    full_body = plain_text
    if not full_body and html_text:
        full_body = _strip_html_to_markdown(html_text)
    if not full_body:
        full_body = snippet

    full_body = _clean_body_text(full_body)

    return {
        "id": m_id,
        "thread_id": thread_id,
        "subject": subject,
        "from": sender,
        "to": to_recip,
        "date": date_val,
        "snippet": snippet,
        "body": full_body
    }


def _create_raw_mime_message(
    to: str,
    subject: str,
    body: str,
    in_reply_to: Optional[str] = None,
    attachments: Optional[List[str]] = None
) -> str:
    """Construct RFC 2822 base64url encoded raw email string with optional file attachments."""
    valid_attachments = [f for f in (attachments or []) if f and os.path.isfile(f)]

    try:
        import mimetypes
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart
        from email.mime.base import MIMEBase
        from email import encoders

        if valid_attachments:
            msg = MIMEMultipart()
            msg.attach(MIMEText(body, "plain", "utf-8"))
            for file_path in valid_attachments:
                try:
                    filename = os.path.basename(file_path)
                    ctype, encoding = mimetypes.guess_type(file_path)
                    if ctype is None or encoding is not None:
                        ctype = "application/octet-stream"
                    maintype, subtype = ctype.split("/", 1)

                    with open(file_path, "rb") as fp:
                        part = MIMEBase(maintype, subtype)
                        part.set_payload(fp.read())

                    encoders.encode_base64(part)
                    part.add_header("Content-Disposition", "attachment", filename=filename)
                    msg.attach(part)
                except Exception as e:
                    print(f"Warning: Failed to attach file '{file_path}': {e}")
        else:
            msg = MIMEText(body, "plain", "utf-8")

        msg["To"] = to
        msg["Subject"] = subject
        if in_reply_to:
            msg["In-Reply-To"] = in_reply_to
            msg["References"] = in_reply_to

        raw_bytes = msg.as_bytes()
        return base64.urlsafe_b64encode(raw_bytes).decode("utf-8")
    except Exception as err:
        # Fallback to pure RFC 2822 formatting if email.mime is not bundled
        header_lines = [
            f"To: {to}",
            f"Subject: {subject}",
            "Content-Type: text/plain; charset=utf-8",
            "MIME-Version: 1.0"
        ]
        if in_reply_to:
            header_lines.append(f"In-Reply-To: {in_reply_to}")
            header_lines.append(f"References: {in_reply_to}")
        raw_msg = "\r\n".join(header_lines) + "\r\n\r\n" + body
        return base64.urlsafe_b64encode(raw_msg.encode("utf-8")).decode("utf-8")


class GmailPluginHandler(BasePluginHandler):
    async def execute_tool(self, tool_name: str, args: Dict[str, Any], access_token: str, creds: Dict[str, Any]) -> str:
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": "RIE-AI-Agent"
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            # 1. Search Emails
            if tool_name == "gmail_search_emails":
                q = args.get("query", "")
                max_res = args.get("max_results", 5)
                url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages?q={q}&maxResults={max_res}&includeSpamTrash=true"
                res = await client.get(url, headers=headers)
                if res.status_code != 200:
                    return f"Gmail API Error ({res.status_code}): {res.text}"

                data = res.json()
                messages = data.get("messages", [])
                if not messages:
                    return f"No emails found matching query '{q}'."

                summaries = []
                for msg in messages[:max_res]:
                    m_id = msg["id"]
                    m_res = await client.get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}?format=full", headers=headers)
                    if m_res.status_code == 200:
                        parsed = parse_message_details(m_res.json())
                        summaries.append(
                            f"ID: {parsed['id']}\n"
                            f"From: {parsed['from']}\n"
                            f"Subject: {parsed['subject']}\n"
                            f"Date: {parsed['date']}\n"
                            f"Snippet: {parsed['snippet']}"
                        )

                return "\n---\n".join(summaries)

            # 2. Get Email
            elif tool_name == "gmail_get_email":
                m_id = args.get("message_id")
                if not m_id:
                    return "Error: Missing required parameter 'message_id'."

                m_res = await client.get(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}?format=full", headers=headers)
                if m_res.status_code == 200:
                    parsed = parse_message_details(m_res.json())
                    return (
                        f"Email Details (Message ID: {parsed['id']})\n"
                        f"From: {parsed['from']}\n"
                        f"To: {parsed['to']}\n"
                        f"Subject: {parsed['subject']}\n"
                        f"Date: {parsed['date']}\n"
                        f"---\n"
                        f"Body Content:\n"
                        f"{parsed['body']}"
                    )
                return f"Failed to fetch email {m_id}: {m_res.text}"

            # 3. Send Email
            elif tool_name == "gmail_send_email":
                to = (args.get("to") or "").strip()
                subject = (args.get("subject") or "").strip()
                body = (args.get("body") or "").strip()
                attachments = args.get("attachments") or []
                thread_id = args.get("thread_id") or None

                if not to or not subject or not body:
                    return "Error: Parameters 'to', 'subject', and 'body' are required to send an email."

                raw_b64 = _create_raw_mime_message(to, subject, body, attachments=attachments)
                payload = {"raw": raw_b64}
                if thread_id:
                    payload["threadId"] = thread_id

                res = await client.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", headers=headers, json=payload)
                if res.status_code == 200:
                    resp_json = res.json()
                    sent_id = resp_json.get("id", "unknown")
                    attach_msg = f" with {len(attachments)} attachment(s)" if attachments else ""
                    return f"Successfully sent email to {to}{attach_msg} (Message ID: {sent_id}, Subject: '{subject}')."
                return f"Failed to send email to {to}: {res.status_code} {res.text}"

            # 4. Create Draft
            elif tool_name == "gmail_create_draft":
                to = (args.get("to") or "").strip()
                subject = (args.get("subject") or "").strip()
                body = (args.get("body") or "").strip()
                attachments = args.get("attachments") or []
                thread_id = args.get("thread_id") or None

                if not to or not subject or not body:
                    return "Error: Parameters 'to', 'subject', and 'body' are required to create a draft."

                raw_b64 = _create_raw_mime_message(to, subject, body, attachments=attachments)
                payload = {"message": {"raw": raw_b64}}
                if thread_id:
                    payload["message"]["threadId"] = thread_id

                res = await client.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", headers=headers, json=payload)
                if res.status_code == 200:
                    resp_json = res.json()
                    draft_id = resp_json.get("id", "unknown")
                    attach_msg = f" with {len(attachments)} attachment(s)" if attachments else ""
                    return f"Successfully created Gmail draft for {to}{attach_msg} (Draft ID: {draft_id}, Subject: '{subject}')."
                return f"Failed to create draft: {res.status_code} {res.text}"

            # 5. Reply Email
            elif tool_name == "gmail_reply_email":
                m_id = args.get("message_id") or ""
                to = (args.get("to") or "").strip()
                subject = (args.get("subject") or "").strip()
                body = (args.get("body") or "").strip()
                attachments = args.get("attachments") or []
                thread_id = args.get("thread_id") or None

                if not m_id or not to or not subject or not body:
                    return "Error: Parameters 'message_id', 'to', 'subject', and 'body' are required to reply."

                raw_b64 = _create_raw_mime_message(to, subject, body, in_reply_to=m_id, attachments=attachments)
                payload = {"raw": raw_b64}
                if thread_id:
                    payload["threadId"] = thread_id

                res = await client.post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", headers=headers, json=payload)
                if res.status_code == 200:
                    resp_json = res.json()
                    sent_id = resp_json.get("id", "unknown")
                    attach_msg = f" with {len(attachments)} attachment(s)" if attachments else ""
                    return f"Successfully replied to email {m_id}{attach_msg} (Sent Message ID: {sent_id})."
                return f"Failed to reply to email {m_id}: {res.status_code} {res.text}"

            # 6. Archive Email
            elif tool_name == "gmail_archive_email":
                m_id = args.get("message_id")
                if not m_id:
                    return "Error: Missing required parameter 'message_id'."

                url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}/modify"
                payload = {"removeLabelIds": ["INBOX"]}
                res = await client.post(url, headers=headers, json=payload)
                if res.status_code == 200:
                    return f"Successfully archived email {m_id} (removed from INBOX)."
                return f"Failed to archive email {m_id}: {res.status_code} {res.text}"

            # 7. Mark as Read
            elif tool_name == "gmail_mark_as_read":
                m_id = args.get("message_id")
                if not m_id:
                    return "Error: Missing required parameter 'message_id'."

                url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}/modify"
                payload = {"removeLabelIds": ["UNREAD"]}
                res = await client.post(url, headers=headers, json=payload)
                if res.status_code == 200:
                    return f"Successfully marked email {m_id} as READ."
                return f"Failed to mark email {m_id} as read: {res.status_code} {res.text}"

            # 8. Mark as Unread
            elif tool_name == "gmail_mark_as_unread":
                m_id = args.get("message_id")
                if not m_id:
                    return "Error: Missing required parameter 'message_id'."

                url = f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}/modify"
                payload = {"addLabelIds": ["UNREAD"]}
                res = await client.post(url, headers=headers, json=payload)
                if res.status_code == 200:
                    return f"Successfully marked email {m_id} as UNREAD."
                return f"Failed to mark email {m_id} as unread: {res.status_code} {res.text}"

            # 9. Trash Email
            elif tool_name == "gmail_trash_email":
                m_id = args.get("message_id")
                if not m_id:
                    return "Error: Missing required parameter 'message_id'."

                url = f"https://gmail.googleapis.com/gmail/v1/users/me/trash" if m_id == "all" else f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{m_id}/trash"
                res = await client.post(url, headers=headers)
                if res.status_code == 200:
                    return f"Successfully moved email {m_id} to Trash."
                return f"Failed to trash email {m_id}: {res.status_code} {res.text}"

            # 10. List Labels
            elif tool_name == "gmail_list_labels":
                url = "https://gmail.googleapis.com/gmail/v1/users/me/labels"
                res = await client.get(url, headers=headers)
                if res.status_code == 200:
                    labels = res.json().get("labels", [])
                    label_info = [f"Name: {l.get('name')} (ID: {l.get('id')})" for l in labels]
                    return "Gmail Account Labels & Folders:\n" + "\n".join(label_info)
                return f"Failed to list labels: {res.status_code} {res.text}"

            return f"Unknown tool '{tool_name}' for Gmail plugin."
