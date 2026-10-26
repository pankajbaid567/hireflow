"""Bounded report submission; provider acceptance never establishes inbox receipt."""

import base64
import re
import smtplib
import sqlite3
import ssl
from datetime import datetime, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formatdate, make_msgid
from html import escape
from pathlib import Path
from urllib.parse import quote

import httpx
from sqlalchemy import or_, update

from src.config.settings import get_settings
from src.models import WeeklyReport
from src.utils.llm_client import _is_placeholder_or_empty

_GMAIL_UNCERTAIN = (
    "Gmail submission outcome is uncertain. Check the sender Sent folder and the "
    "intended recipient before requesting another report; automatic resend is disabled."
)


class _GmailFailure(Exception):
    def __init__(self, reason, *, uncertain=False):
        super().__init__(reason)
        self.reason = reason
        self.uncertain = uncertain


def _mailbox(value):
    return (
        isinstance(value, str)
        and len(value) <= 254
        and re.fullmatch(
            r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}",
            value,
        )
        is not None
    )


class EmailService:
    def __init__(
        self,
        provider=None,
        *,
        settings=None,
        client=None,
        max_message_bytes=20 * 1024 * 1024,
        smtp_factory=None,
    ):
        self.settings = settings or get_settings()
        self.provider = (provider or self.settings.email_provider).lower()
        self.client = client or httpx.Client(timeout=30)
        self.max_message_bytes = max_message_bytes
        self.smtp_factory = smtp_factory or smtplib.SMTP_SSL

    def _gmail_configuration(self, recipient):
        user = (self.settings.gmail_user or "").strip()
        password = re.sub(r"\s", "", self.settings.gmail_app_password or "")
        extra = self.settings.gmail_allowed_recipients.strip()
        allowed = [value.strip() for value in extra.split(",")] if extra else []
        if (
            not _mailbox(user)
            or re.fullmatch(r"[A-Za-z0-9]{16}", password) is None
            or len(extra) > 2600
            or len(allowed) > 10
            or any(not _mailbox(value) for value in allowed)
        ):
            raise _GmailFailure(
                "Configure GMAIL_USER and its 16-character GMAIL_APP_PASSWORD privately. "
                "The private Gmail allowlist must contain exact email addresses."
            )
        if not _mailbox(recipient) or recipient.lower() not in {
            user.lower(),
            *(value.lower() for value in allowed),
        }:
            raise _GmailFailure(
                "Gmail delivery is restricted to the sender or an operator-configured "
                "private recipient allowlist."
            )
        return user, password

    def _reserve_gmail_attempt(self):
        """A local private atomic allowance, separate from deployed D1 counters."""
        limit = max(1, min(20, self.settings.gmail_daily_attempt_limit))
        directory = Path(self.settings.local_storage_path) / ".gmail_delivery"
        try:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = directory / "usage.sqlite3"
            with sqlite3.connect(path, timeout=5) as connection:
                path.chmod(0o600)
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS gmail_daily_usage "
                    "(day TEXT PRIMARY KEY,attempts INTEGER NOT NULL)"
                )
                connection.execute("BEGIN IMMEDIATE")
                day = datetime.now(timezone.utc).date().isoformat()
                row = connection.execute(
                    "SELECT attempts FROM gmail_daily_usage WHERE day=?", (day,)
                ).fetchone()
                if row and row[0] >= limit:
                    raise _GmailFailure(
                        "The local daily Gmail attempt allowance is exhausted. "
                        "No SMTP connection was opened; wait until the next UTC day."
                    )
                connection.execute(
                    "INSERT INTO gmail_daily_usage(day,attempts) VALUES(?,1) "
                    "ON CONFLICT(day) DO UPDATE SET attempts=attempts+1",
                    (day,),
                )
        except _GmailFailure:
            raise
        except Exception:
            raise _GmailFailure(
                "The local Gmail allowance could not be recorded. No SMTP connection was opened."
            ) from None

    def _send_gmail(self, user, password, recipient, html, attachments):
        message = EmailMessage(policy=SMTP)
        message["From"] = user
        message["To"] = recipient
        message["Subject"] = "Your HireFlow weekly report"
        message["Message-ID"] = make_msgid(domain="hireflow.invalid")
        message["Date"] = formatdate(localtime=False, usegmt=True)
        message.set_content("Your private HireFlow report is included as HTML.")
        message.add_alternative(html, subtype="html")
        for attachment in attachments:
            message.add_attachment(
                base64.b64decode(attachment["content"], validate=True),
                maintype="application",
                subtype="pdf",
                filename=attachment["filename"],
            )
        if len(message.as_bytes()) > self.max_message_bytes:
            raise _GmailFailure(
                "The Gmail MIME message exceeds the configured email size limit."
            )
        self._reserve_gmail_attempt()
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        client = None
        try:
            client = self.smtp_factory(
                "smtp.gmail.com", 465, timeout=20, context=context
            )
            client.login(user, password)
            refused = client.send_message(message, from_addr=user, to_addrs=[recipient])
            if refused:
                raise _GmailFailure(
                    "Gmail rejected the intended recipient; no delivery was established."
                )
            # send_message returns only after the DATA reply accepts the message.
            return str(message["Message-ID"])
        except _GmailFailure:
            raise
        except (smtplib.SMTPResponseException, smtplib.SMTPRecipientsRefused):
            raise _GmailFailure(
                "Gmail rejected the SMTP transaction. Check the App Password, sender "
                "account, recipient and Gmail sending limits before requesting another report."
            ) from None
        except Exception:
            raise _GmailFailure(_GMAIL_UNCERTAIN, uncertain=True) from None
        finally:
            if client is not None:
                # A failed QUIT cannot erase an already observed final DATA ACK.
                try:
                    client.quit()
                except Exception:
                    pass
                try:
                    client.close()
                except Exception:
                    pass

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
            "delivered_at": None,
            "delivery_evidence": "none",
        }
        gmail_started = False
        try:
            if db is not None and report is None:
                raise ValueError("A valid report_id is required to log email delivery")
            if self.provider not in {"sendgrid", "resend", "gmail"}:
                raise ValueError("EMAIL_PROVIDER must be sendgrid, resend or gmail")
            if self.provider == "gmail":
                gmail_user, gmail_password = self._gmail_configuration(to_email)
                if report is not None and report.email_sent_at is not None:
                    # This compatibility column does not identify the earlier
                    # provider or recipient; never relabel it as a Gmail ACK.
                    return {
                        **result,
                        "status": "accepted",
                        "accepted_at": report.email_sent_at.isoformat(),
                        "delivery_evidence": "previous_provider_acceptance",
                        "reused": True,
                    }
                if (
                    report is not None
                    and report.email_failure_reason == _GMAIL_UNCERTAIN
                ):
                    return {
                        **result,
                        "status": "needs_action",
                        "failure_reason": _GMAIL_UNCERTAIN,
                    }
            key = (
                self.settings.sendgrid_api_key
                if self.provider == "sendgrid"
                else self.settings.resend_api_key
            )
            if self.provider != "gmail" and _is_placeholder_or_empty(key):
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
            if self.provider == "gmail":
                # Write the uncertain-send guard before external I/O. An abrupt
                # local process exit cannot turn into a blind replay on retry.
                if report is not None:
                    claimed = db.execute(
                        update(WeeklyReport)
                        .where(
                            WeeklyReport.id == report.id,
                            WeeklyReport.email_sent_at.is_(None),
                            or_(
                                WeeklyReport.email_failure_reason.is_(None),
                                WeeklyReport.email_failure_reason != _GMAIL_UNCERTAIN,
                            ),
                        )
                        .values(email_failure_reason=_GMAIL_UNCERTAIN)
                        .returning(WeeklyReport.id)
                        .execution_options(synchronize_session="fetch")
                    ).scalar_one_or_none()
                    db.commit()
                    if claimed is None:
                        db.refresh(report)
                        if report.email_sent_at is not None:
                            return {
                                **result,
                                "status": "accepted",
                                "accepted_at": report.email_sent_at.isoformat(),
                                "delivery_evidence": "previous_provider_acceptance",
                                "reused": True,
                            }
                        raise _GmailFailure(_GMAIL_UNCERTAIN, uncertain=True)
                gmail_started = True
                message_id = self._send_gmail(
                    gmail_user, gmail_password, to_email, report_html, attachments
                )
                accepted = datetime.now(timezone.utc)
                result.update(
                    status="accepted",
                    attached_count=len(attachments),
                    linked_count=len(links),
                    warnings=warnings,
                    accepted_at=accepted.isoformat(),
                    delivery_evidence="smtp_server_acceptance",
                    provider_message_id=message_id,
                )
                if report is not None:
                    report.email_sent_at = accepted
                    report.email_failure_reason = None
                    db.commit()
                return result
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
                delivery_evidence="provider_api_acceptance",
            )
            if report is not None:
                report.email_sent_at = datetime.now(timezone.utc)
                report.email_failure_reason = None
                db.commit()
        except Exception as exc:
            if self.provider == "gmail":
                uncertain = (
                    exc.uncertain if isinstance(exc, _GmailFailure) else gmail_started
                )
                reason = (
                    exc.reason
                    if isinstance(exc, _GmailFailure)
                    else (
                        _GMAIL_UNCERTAIN
                        if uncertain
                        else "The Gmail message could not be prepared or logged safely; inspect the report before another attempt."
                    )
                )
                result["status"] = "needs_action" if uncertain else "failed"
            else:
                reason = str(exc)
            result["failure_reason"] = reason
            if report is not None:
                try:
                    db.rollback()
                    report.email_failure_reason = reason
                    db.commit()
                except Exception:
                    db.rollback()
                    if self.provider != "gmail":
                        raise
        return result
