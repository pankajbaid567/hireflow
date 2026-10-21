"""Opt-in provider -> API -> PDF -> local browser -> prep/report verification.

Run with RUN_LIVE_E2E_TESTS=1 pytest tests/test_live_e2e.py -v. Each provider
makes two LLM requests. Career pages are local fixtures and email is disabled.
"""

import logging
import os
import re
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfReader
from reportlab.pdfgen import canvas

from src.automation.form_filler import FormFiller
from src.config.settings import Settings, get_settings
from src.models import Application, ApplicationStatus, Job, ListingType, WeeklyReport
from src.utils.llm_client import BaseLLMClient, LLMClientError, _is_placeholder_or_empty
from tests.helpers import FIXTURES


def _live_enabled():
    return any(
        os.environ.get(flag, "").strip().lower() in {"1", "true", "yes"}
        for flag in ("RUN_LIVE_E2E_TESTS", "RUN_LIVE_LLM_TESTS")
    )


pytestmark = pytest.mark.skipif(
    not _live_enabled(), reason="Set RUN_LIVE_E2E_TESTS=1 to call real LLM providers"
)


class TrackedLiveClient(BaseLLMClient):
    """Record actual answer text while keeping provider errors out of test logs."""

    def __init__(self, client, provider):
        self._client = client
        self.provider = provider
        self.model = client.model
        self.request_count = 0
        self.responses = []
        self.failure_category = None

    def chat(self, prompt):
        self.request_count += 1
        try:
            response = self._client.chat(prompt)
        except Exception as exc:
            # Expose only a fixed category, never an SDK error body or URL.
            message = str(exc).casefold()
            code = re.search(r"\b(401|403|429|500|502|503|504)\b", message)
            self.failure_category = (
                f"http_{code.group(1)}"
                if code
                else (
                    "timeout"
                    if any(
                        word in message for word in ("timeout", "timed out", "deadline")
                    )
                    else "provider_error"
                )
            )
            raise LLMClientError(f"{self.provider} live request failed") from None
        self.responses.append(response)
        return response


@pytest.fixture(params=["groq", "gemini"], ids=["groq", "gemini"])
def live_client(request, caplog):
    # Avoid the application's cached Settings: credentials may have been updated
    # in .env after an earlier test imported the app.
    from src.utils.llm_client import get_llm_client

    caplog.set_level(logging.CRITICAL)
    settings = Settings()
    provider = request.param
    key = (
        settings.groq_api_key
        if provider == "groq"
        else (getattr(settings, "gemini_api_key", None) or settings.google_api_key)
    )
    if _is_placeholder_or_empty(key):
        pytest.skip(f"No {provider} credentials configured")
    settings.llm_provider = provider
    try:
        client = get_llm_client(settings)
    except Exception:
        pytest.fail(f"{provider} client configuration failed", pytrace=False)
    return TrackedLiveClient(client, provider)


def test_live_pdf_profile_and_local_application_cycle(
    api_client, db_session, tmp_path, monkeypatch, live_client, record_property
):
    record_property("live_provider", live_client.provider)
    record_property("live_model", live_client.model)
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    monkeypatch.setattr(get_settings(), "application_timeout_ms", 15000)
    monkeypatch.setattr("src.api.routes.profile.get_llm_client", lambda: live_client)
    monkeypatch.setattr(
        "src.automation.form_filler.get_llm_client", lambda: live_client
    )
    monkeypatch.setattr("src.utils.web_search.WebSearch.search", lambda *_a, **_kw: [])

    def forbid_email(*_args, **_kwargs):
        pytest.fail("Live E2E verification must never send email")

    monkeypatch.setattr(
        "src.utils.email_service.EmailService.send_weekly_report", forbid_email
    )
    submitted = {}
    original_submit = FormFiller.submit

    def capture_actual_submission(self, page, form):
        original_submit(self, page, form)
        submitted.update(page.evaluate("window.submitted"))
        submitted["submission_count"] = page.evaluate("window.submissionCount")

    monkeypatch.setattr(FormFiller, "submit", capture_actual_submission)
    original = BytesIO()
    pdf = canvas.Canvas(original)
    for index, line in enumerate(
        [
            "Name: Taylor HireFlow",
            "Email: live-e2e@example.com",
            "Seeking an AI Engineer internship. Mode: internship.",
            "Skills: Python, FastAPI, LangChain",
            "Education: BTech",
            "Project: A Python application using FastAPI and LangChain.",
        ]
    ):
        pdf.drawString(72, 750 - index * 24, line)
    pdf.save()

    # No manual name/email fields are sent: this must use live extraction.
    created = api_client.post(
        "/profile",
        files={"resume": ("original.pdf", original.getvalue(), "application/pdf")},
    )
    validation_locations = []
    if created.status_code == 422:
        validation_locations = [
            {"location": error.get("loc"), "type": error.get("type")}
            for error in created.json().get("detail", [])
            if isinstance(error, dict)
        ]
    assert created.status_code == 201, {
        "provider_failure": live_client.failure_category,
        "validation_locations": validation_locations,
    }
    profile = created.json()
    assert profile["name"] == "Taylor HireFlow"
    assert profile["email"] == "live-e2e@example.com"
    assert "python" in {skill.lower() for skill in profile["master_profile"]["skills"]}
    assert live_client.request_count == 1
    user_id = profile["id"]
    assert Path(profile["master_profile"]["master_resume_path"]).is_file()
    # Fixture selectors use a specific education option; keep the required
    # answer empty so the agent must call the live provider again.
    updated = api_client.patch(
        f"/profile/{user_id}",
        json={
            "phone": "9999999999",
            "education": "BTech",
            "experience_years": 0,
            "mode": "internship",
            "weekly_quota": 1,
            "answers": {},
        },
    )
    assert updated.status_code == 200
    job = Job(
        title="AI Engineer Intern",
        company="Local Provider Verification",
        description="Build Python agents using FastAPI and LangChain. Two interview rounds: technical and HR.",
        listing_type=ListingType.internship,
        url=(FIXTURES / "sample_form.html").as_uri(),
    )
    db_session.add(job)
    db_session.commit()
    plan = api_client.get(f"/weekly-plan/{user_id}")
    assert plan.status_code == 200
    selected = plan.json()["plan"][0]
    preview = api_client.get(selected["resume_url"])
    assert preview.status_code == 200 and preview.content.startswith(b"%PDF")
    resume_text = " ".join(
        page.extract_text() or "" for page in PdfReader(BytesIO(preview.content)).pages
    )
    assert "Taylor HireFlow" in resume_text and "Python" in resume_text

    confirmed = api_client.post(
        f"/weekly-plan/{user_id}/confirm", json={"confirmed_job_ids": [job.id]}
    )
    assert confirmed.status_code == 200
    db_session.expire_all()
    application = db_session.get(Application, selected["application_id"])
    assert application.status == ApplicationStatus.applied, live_client.failure_category
    assert application.attempts == 1 and application.applied_at is not None
    assert live_client.request_count == 2
    assert submitted["motivation"] == live_client.responses[-1]
    assert len(submitted["motivation"].strip()) >= 20
    assert any(
        skill in submitted["motivation"].lower()
        for skill in ("python", "fastapi", "langchain")
    )
    assert submitted["resume"]["name"] == Path(application.resume_path).name
    assert submitted["resume"]["size"] == Path(application.resume_path).stat().st_size
    assert submitted["submission_count"] == 1
    assert [event.status for event in application.status_history][-3:] == [
        "confirmed",
        "applying",
        "applied",
    ]
    assert application.prep_guide is not None
    guide = api_client.get(f"/applications/{application.id}/prep-guide")
    assert guide.status_code == 200
    assert guide.json()["round_count"] == 2 and guide.json()["questions"]
    report = api_client.get(f"/report/{user_id}/latest")
    assert report.status_code == 200 and report.json()["applied_count"] == 1
    assert api_client.get(report.json()["html_url"]).status_code == 200
    row = db_session.query(WeeklyReport).filter_by(user_id=user_id).one()
    assert row.email_sent_at is None
    record_property("live_requests", live_client.request_count)
    record_property("application_status", application.status.value)
