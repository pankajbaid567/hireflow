import base64
import smtplib
import sqlite3
import ssl
from datetime import datetime, timezone

import httpx
import pytest

from src.config.settings import Settings
from src.models import WeeklyReport
from src.utils.dates import week_start
from src.utils.email_service import EmailService
from tests.helpers import seed_application


def settings():
    return Settings(
        _env_file=None,
        sendgrid_api_key="test-sendgrid",
        resend_api_key="test-resend",
        from_email="hireflow@example.com",
        public_base_url="https://hireflow.example/api",
    )


@pytest.mark.parametrize("provider", ["sendgrid", "resend"])
def test_email_html_and_pdf_payload_and_delivery_log(provider, db_session, tmp_path):
    application = seed_application(db_session)
    report = WeeklyReport(
        user_id=application.user_id, week_start_date=week_start(), metrics={}
    )
    db_session.add(report)
    db_session.commit()
    pdf = tmp_path / "resume.pdf"
    pdf.write_bytes(b"%PDF-1.4 mock resume")
    sent = []

    def handle(request):
        import json

        sent.append((request, json.loads(request.content)))
        return httpx.Response(
            202 if provider == "sendgrid" else 200, json={"id": "mail-test"}
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = EmailService(
            provider, settings=settings(), client=client
        ).send_weekly_report(
            "student@example.com",
            "<h1>Weekly report</h1>",
            [str(pdf)],
            db=db_session,
            report_id=report.id,
        )
    assert result["status"] == "sent" and result["attached_count"] == 1
    request, payload = sent[0]
    assert request.headers["authorization"].startswith("Bearer test-")
    assert (
        payload["content"][0]["value"] == "<h1>Weekly report</h1>"
        if provider == "sendgrid"
        else payload["html"] == "<h1>Weekly report</h1>"
    )
    assert base64.b64decode(payload["attachments"][0]["content"]) == pdf.read_bytes()
    db_session.refresh(report)
    assert report.email_sent_at is not None and report.email_failure_reason is None


def test_email_oversized_and_more_than_ten_pdfs_become_links(tmp_path):
    directory = tmp_path / "42"
    directory.mkdir()
    paths = []
    for i in range(12):
        path = directory / f"{i}_resume_v1.pdf"
        path.write_bytes(b"%PDF-1.4\n" + b"X" * (4096 if i == 0 else 8))
        paths.append(str(path))
    payloads = []

    def handle(request):
        import json

        payloads.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "mock"})

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = EmailService(
            "resend", settings=settings(), client=client, max_message_bytes=5000
        ).send_weekly_report("test@example.com", "<p>Report</p>", paths)
    assert result["status"] == "sent"
    assert result["attached_count"] == 9 and result["linked_count"] == 3
    assert (
        "https://hireflow.example/api/resumes/42/files/0_resume_v1.pdf"
        in payloads[0]["html"]
    )


def test_email_provider_failure_logged_without_marking_sent(db_session):
    app = seed_application(db_session)
    report = WeeklyReport(user_id=app.user_id, week_start_date=week_start(), metrics={})
    db_session.add(report)
    db_session.commit()
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(401, json={"error": "invalid key"})
        )
    ) as client:
        result = EmailService(settings=settings(), client=client).send_weekly_report(
            "test@example.com", "<p>Report</p>", db=db_session, report_id=report.id
        )
    db_session.refresh(report)
    assert result["status"] == "failed" and "401" in result["failure_reason"]
    assert report.email_sent_at is None and report.email_failure_reason


@pytest.mark.parametrize("provider", ["unknown", "resend"])
def test_email_configuration_failure_does_not_call_network(provider):
    def forbidden(request):
        pytest.fail("Configuration failures must not send an email")

    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        result = EmailService(
            provider, settings=Settings(_env_file=None), client=client
        ).send_weekly_report("test@example.com", "Report")
    assert result["status"] == "failed"


def test_email_missing_attachment_gets_link_and_warning(tmp_path):
    with httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(202))
    ) as client:
        result = EmailService(settings=settings(), client=client).send_weekly_report(
            "test@example.com", "Report", [str(tmp_path / "1" / "1_resume_v1.pdf")]
        )
    assert result["status"] == "sent" and result["linked_count"] == 1
    assert result["warnings"]


def gmail_settings(tmp_path, **values):
    return Settings(
        _env_file=None,
        gmail_user="sender@gmail.com",
        gmail_app_password="abcdefghijklmnop",
        from_email="legacy@example.com",
        local_storage_path=str(tmp_path),
        **values,
    )


class GmailFixture:
    def __init__(self, *, failure=None, quit_failure=False):
        self.failure = failure
        self.quit_failure = quit_failure
        self.connections = []
        self.messages = []
        self.auth = []
        self.closed = 0

    def __call__(self, host, port, *, timeout, context):
        self.connections.append((host, port, timeout, context))
        return self

    def login(self, user, password):
        self.auth.append((user, password))
        if self.failure == "auth":
            raise smtplib.SMTPAuthenticationError(
                535, b"private-password-and-email-detail"
            )

    def send_message(self, message, *, from_addr, to_addrs):
        self.messages.append((message, from_addr, to_addrs))
        if self.failure == "uncertain":
            raise smtplib.SMTPServerDisconnected("private-password-connection-detail")
        if self.failure == "rejected":
            raise smtplib.SMTPDataError(552, b"private-size-diagnostic")
        return {}

    def quit(self):
        if self.quit_failure:
            raise smtplib.SMTPServerDisconnected("private-quit-diagnostic")

    def close(self):
        self.closed += 1


def gmail_report(db_session):
    application = seed_application(db_session)
    report = WeeklyReport(
        user_id=application.user_id, week_start_date=week_start(), metrics={}
    )
    db_session.add(report)
    db_session.commit()
    return report


def test_gmail_smtp_ssl_acceptance_exact_pdf_and_safe_reuse(db_session, tmp_path):
    fixture = GmailFixture(quit_failure=True)
    report = gmail_report(db_session)
    path = tmp_path / "resume_v2.pdf"
    path.write_bytes(b"%PDF-1.4 preserved version2")
    service = EmailService(
        "gmail", settings=gmail_settings(tmp_path), smtp_factory=fixture
    )
    result = service.send_weekly_report(
        "sender@gmail.com",
        "<h1>Private weekly guide</h1>",
        [path],
        db=db_session,
        report_id=report.id,
    )
    assert result["status"] == "accepted" and result["delivered_at"] is None
    assert result["delivery_evidence"] == "smtp_server_acceptance"
    assert result["attached_count"] == 1 and result["accepted_at"]
    host, port, timeout, context = fixture.connections[0]
    assert (host, port, timeout) == ("smtp.gmail.com", 465, 20)
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    assert context.minimum_version == ssl.TLSVersion.TLSv1_2
    message, sender, recipients = fixture.messages[0]
    assert sender == "sender@gmail.com" and recipients == ["sender@gmail.com"]
    assert str(message["From"]) == sender
    assert (
        "Private weekly guide"
        in message.get_body(preferencelist=("html",)).get_content()
    )
    assert (
        next(message.iter_attachments()).get_payload(decode=True) == path.read_bytes()
    )
    db_session.refresh(report)
    assert report.email_sent_at is not None and report.email_failure_reason is None
    again = service.send_weekly_report(
        "sender@gmail.com",
        "<h1>Do not duplicate</h1>",
        db=db_session,
        report_id=report.id,
    )
    assert again["status"] == "accepted" and len(fixture.connections) == 1
    assert fixture.closed == 1


def test_gmail_uncertain_outcome_is_private_persisted_and_not_replayed(
    db_session, tmp_path
):
    fixture = GmailFixture(failure="uncertain")
    report = gmail_report(db_session)
    service = EmailService(
        "gmail", settings=gmail_settings(tmp_path), smtp_factory=fixture
    )
    result = service.send_weekly_report(
        "sender@gmail.com", "<h1>Report</h1>", db=db_session, report_id=report.id
    )
    assert result["status"] == "needs_action"
    assert "automatic resend is disabled" in result["failure_reason"]
    assert "private-password" not in str(result) and result["delivered_at"] is None
    db_session.refresh(report)
    assert (
        report.email_sent_at is None
        and report.email_failure_reason == result["failure_reason"]
    )
    again = service.send_weekly_report(
        "sender@gmail.com", "Report", db=db_session, report_id=report.id
    )
    assert again["status"] == "needs_action" and len(fixture.connections) == 1
    with sqlite3.connect(tmp_path / ".gmail_delivery" / "usage.sqlite3") as connection:
        assert (
            connection.execute(
                "SELECT sum(attempts) FROM gmail_daily_usage"
            ).fetchone()[0]
            == 1
        )


@pytest.mark.parametrize("failure", ["auth", "rejected"])
def test_gmail_explicit_rejection_has_no_receipt_or_sensitive_diagnostic(
    failure, tmp_path
):
    fixture = GmailFixture(failure=failure)
    result = EmailService(
        "gmail", settings=gmail_settings(tmp_path), smtp_factory=fixture
    ).send_weekly_report("sender@gmail.com", "Report")
    assert result["status"] == "failed" and result["delivered_at"] is None
    assert "Gmail rejected" in result["failure_reason"]
    assert "private-" not in str(result) and "abcdefghijklmnop" not in str(result)
    assert len(fixture.connections) == 1 and fixture.closed == 1


@pytest.mark.parametrize(
    "recipient",
    [
        "unapproved@example.com",
        "sender@gmail.com\r\nBcc:attacker@example.com",
        "sender@gmail.com,other@example.com",
    ],
)
def test_gmail_default_recipient_policy_fails_before_network_or_reservation(
    recipient, tmp_path
):
    fixture = GmailFixture()
    result = EmailService(
        "gmail", settings=gmail_settings(tmp_path), smtp_factory=fixture
    ).send_weekly_report(recipient, "Report")
    assert result["status"] == "failed" and not fixture.connections
    assert "private recipient allowlist" in result["failure_reason"]
    assert not (tmp_path / ".gmail_delivery").exists()


def test_gmail_exact_allowlist_and_app_password_configuration_are_private(tmp_path):
    fixture = GmailFixture()
    config = gmail_settings(
        tmp_path, gmail_allowed_recipients="owner@example.com,team@example.com"
    )
    service = EmailService("gmail", settings=config, smtp_factory=fixture)
    assert (
        service.send_weekly_report("team@example.com", "Report")["status"] == "accepted"
    )
    assert (
        service.send_weekly_report("team@example.com.attacker.test", "Report")["status"]
        == "failed"
    )
    assert len(fixture.connections) == 1
    invalid = config.model_copy(
        update={"gmail_app_password": "normal-account-password"}
    )
    result = EmailService(
        "gmail", settings=invalid, smtp_factory=fixture
    ).send_weekly_report("sender@gmail.com", "Report")
    assert (
        result["status"] == "failed"
        and "GMAIL_APP_PASSWORD" in result["failure_reason"]
    )
    assert (
        "normal-account-password" not in str(result) and len(fixture.connections) == 1
    )


def test_gmail_local_daily_attempts_are_bounded_and_uncertainty_stays_charged(tmp_path):
    fixture = GmailFixture(failure="uncertain")
    service = EmailService(
        "gmail",
        settings=gmail_settings(tmp_path, gmail_daily_attempt_limit=1),
        smtp_factory=fixture,
    )
    assert (
        service.send_weekly_report("sender@gmail.com", "Report")["status"]
        == "needs_action"
    )
    result = service.send_weekly_report("sender@gmail.com", "Report")
    assert (
        result["status"] == "failed"
        and "daily Gmail attempt allowance" in result["failure_reason"]
    )
    assert len(fixture.connections) == 1


def test_gmail_does_not_relabel_a_prior_unknown_provider_acceptance(
    db_session, tmp_path
):
    fixture = GmailFixture()
    report = gmail_report(db_session)
    report.email_sent_at = datetime.now(timezone.utc)
    db_session.commit()
    result = EmailService(
        "gmail", settings=gmail_settings(tmp_path), smtp_factory=fixture
    ).send_weekly_report(
        "sender@gmail.com", "Report", db=db_session, report_id=report.id
    )
    assert result["status"] == "accepted" and result["reused"]
    assert result["delivery_evidence"] == "previous_provider_acceptance"
    assert not fixture.connections
