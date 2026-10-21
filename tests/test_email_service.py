import base64

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
