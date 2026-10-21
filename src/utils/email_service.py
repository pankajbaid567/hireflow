"""Send HTML reports through SendGrid or Resend, with bounded PDF attachments."""

import base64
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from urllib.parse import quote

import httpx

from src.config.settings import get_settings
from src.models import WeeklyReport
from src.utils.llm_client import _is_placeholder_or_empty


class EmailService:
    def __init__(
        self,
        provider=None,
        *,
        settings=None,
        client=None,
        max_message_bytes=20 * 1024 * 1024,
    ):
        self.settings = settings or get_settings()
        self.provider = (provider or self.settings.email_provider).lower()
        self.client = client or httpx.Client(timeout=30)
        self.max_message_bytes = max_message_bytes

    def send_weekly_report(
        self,
        to_email,
        report_html,
        resume_paths=None,
        *,
        db=None,
        report_id=None,
        resume_urls=None,
    ):
        report = (
            db.get(WeeklyReport, report_id)
            if db is not None and report_id is not None
            else None
        )
        result = {
            "status": "failed",
            "provider": self.provider,
            "attached_count": 0,
            "linked_count": 0,
            "failure_reason": None,
        }
        try:
            if db is not None and report is None:
                raise ValueError("A valid report_id is required to log email delivery")
            if self.provider not in {"sendgrid", "resend"}:
                raise ValueError("EMAIL_PROVIDER must be sendgrid or resend")
            key = (
                self.settings.sendgrid_api_key
                if self.provider == "sendgrid"
                else self.settings.resend_api_key
            )
            if _is_placeholder_or_empty(key):
                raise ValueError(
                    f"Configure {self.provider.upper()}_API_KEY before sending reports"
                )
            if "@" not in to_email or any(char in to_email for char in "\r\n"):
                raise ValueError("Invalid recipient email")
            attachments, links, warnings = [], [], []
            used = len(report_html.encode("utf-8")) + 2048
            for index, raw_path in enumerate(resume_paths or []):
                path = Path(raw_path)
                url = (resume_urls or {}).get(str(raw_path))
                if not url and len(path.parts) >= 2:
                    url = (
                        self.settings.public_base_url.rstrip("/")
                        + "/resumes/"
                        + quote(path.parent.name)
                        + "/files/"
                        + quote(path.name)
                    )
                if not path.is_file() or path.suffix.lower() != ".pdf":
                    warnings.append(f"Resume unavailable: {path.name}")
                    if url:
                        links.append((path.name, url))
                    continue
                size = 4 * ((path.stat().st_size + 2) // 3) + 256
                if index >= 10 or used + size > self.max_message_bytes:
                    links.append((path.name, url))
                    continue
                attachments.append(
                    {
                        "filename": path.name,
                        "content": base64.b64encode(path.read_bytes()).decode("ascii"),
                        "type": "application/pdf",
                        "disposition": "attachment",
                    }
                )
                used += size
            from urllib.parse import urlparse

            if links:
                report_html += (
                    "<h2>Resume downloads</h2><ul>"
                    + "".join(
                        f'<li><a href="{escape(url, quote=True)}">{escape(name)}</a></li>'
                        for name, url in links
                        if url and urlparse(url).scheme in {"http", "https"}
                    )
                    + "</ul>"
                )
            if (
                len(report_html.encode("utf-8"))
                + sum(len(a["content"]) + 256 for a in attachments)
                + 2048
                > self.max_message_bytes
            ):
                raise ValueError("Report HTML exceeds the email size limit")
            if self.provider == "sendgrid":
                payload = {
                    "personalizations": [{"to": [{"email": to_email}]}],
                    "from": {"email": self.settings.from_email},
                    "subject": "Your HireFlow weekly report",
                    "content": [{"type": "text/html", "value": report_html}],
                    "attachments": attachments,
                }
                endpoint = "https://api.sendgrid.com/v3/mail/send"
            else:
                payload = {
                    "from": self.settings.from_email,
                    "to": [to_email],
                    "subject": "Your HireFlow weekly report",
                    "html": report_html,
                    "attachments": [
                        {"filename": a["filename"], "content": a["content"]}
                        for a in attachments
                    ],
                }
                endpoint = "https://api.resend.com/emails"
            response = self.client.post(
                endpoint, headers={"Authorization": f"Bearer {key}"}, json=payload
            )
            response.raise_for_status()
            result.update(
                status="sent",
                attached_count=len(attachments),
                linked_count=len(links),
                warnings=warnings,
                sent_at=datetime.now(timezone.utc).isoformat(),
            )
            if report is not None:
                report.email_sent_at = datetime.now(timezone.utc)
                report.email_failure_reason = None
                db.commit()
        except Exception as exc:
            result["failure_reason"] = str(exc)
            if report is not None:
                db.rollback()
                report.email_failure_reason = str(exc)
                db.commit()
        return result
