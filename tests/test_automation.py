"""Browser tests use only local forms; providers and network failures are injected."""

from unittest.mock import Mock

import pytest
from playwright.sync_api import (
    Error as PlaywrightError,
    TimeoutError as PlaywrightTimeout,
)

from src.agents.application_agent import ApplicationAgent
from src.automation.captcha_handler import CaptchaHandler, normalize_url
from src.automation.form_filler import (
    FormFiller,
    FormStructureError,
    ManualActionRequired,
    SubmissionUncertain,
)
from src.models import ApplicationStatus
from tests.helpers import FIXTURES, seed_application

PROFILE = {
    "name": "Test User",
    "email": "test@example.com",
    "phone": "9999999999",
    "education": "BTech",
    "experience_years": 0,
    "skills": ["Python", "FastAPI", "LangChain"],
}
JD = "Build Python agents using LangChain and FastAPI at AIBridge."


def test_local_form_fields_pdf_upload_and_jd_answer(browser_page, resume_pdf):
    llm = Mock()
    llm.chat.return_value = "I want to build Python agents with LangChain and FastAPI."
    browser_page.goto((FIXTURES / "sample_form.html").as_uri())
    filler = FormFiller(llm, timeout_ms=1500)

    fields, form = filler.fill(browser_page, PROFILE, str(resume_pdf), JD)
    filler.submit(browser_page, form)

    submitted = browser_page.evaluate("window.submitted")
    assert submitted["full_name"] == "Test User"
    assert submitted["email"] == "test@example.com"
    assert submitted["phone"] == "9999999999"
    assert submitted["education"] == "BTech"
    assert submitted["experience_years"] == "0"
    assert submitted["skills"] == "Python; FastAPI; LangChain"
    assert submitted["motivation"] == llm.chat.return_value
    assert submitted["resume"] == {
        "name": resume_pdf.name,
        "size": resume_pdf.stat().st_size,
        "type": "application/pdf",
    }
    assert set(fields) == {
        "name",
        "email",
        "phone",
        "education",
        "experience_years",
        "skills",
        "free_text",
        "resume",
    }
    assert browser_page.evaluate("window.submissionCount") == 1
    prompt = llm.chat.call_args.args[0]
    assert JD in prompt and "Test User" in prompt


def test_application_agent_applies_to_local_form_and_persists(db_session, resume_pdf):
    application = seed_application(db_session)
    llm = Mock(chat=Mock(return_value="I am interested in Python agent development."))
    result = ApplicationAgent(llm_client=llm, timeout_ms=5000).apply(
        (FIXTURES / "sample_form.html").as_uri(),
        str(resume_pdf),
        PROFILE,
        JD,
        db=db_session,
        application_id=application.id,
    )

    db_session.refresh(application)
    assert result["status"] == "applied"
    assert result["attempts"] == 1
    assert "resume" in result["fields_filled"]
    assert application.status == ApplicationStatus.applied
    assert application.applied_at is not None
    assert [event.status for event in application.status_history] == [
        "applying",
        "applied",
    ]


def test_captcha_local_fixture_stops_before_form_submission(db_session, resume_pdf):
    application = seed_application(db_session)
    url = (FIXTURES / "captcha_form.html").as_uri()
    assert CaptchaHandler().detect(url) is True
    result = ApplicationAgent(timeout_ms=5000).apply(
        url,
        str(resume_pdf),
        PROFILE,
        db=db_session,
        application_id=application.id,
    )
    db_session.refresh(application)
    assert result["status"] == "needs_action"
    assert result["failure_reason"] == "CAPTCHA detected"
    assert result["fields_filled"] == []
    assert result["attempts"] == 1
    assert application.status == ApplicationStatus.needs_action
    assert application.failure_reason == "CAPTCHA detected"
    assert application.manual_action_url == url


@pytest.mark.parametrize(
    "challenge",
    [
        '<iframe title="reCAPTCHA" src="about:blank?recaptcha"></iframe>',
        '<div class="h-captcha"></div>',
        '<img alt="CAPTCHA image" src="data:image/png;base64,AA==">',
        '<div class="cf-turnstile"></div>',
        "<p>Enter the characters shown</p>",
    ],
)
def test_captcha_common_challenges(browser_page, challenge):
    browser_page.set_content(challenge)
    assert CaptchaHandler().detect(browser_page) is True


def test_no_captcha_on_ordinary_local_form(browser_page):
    browser_page.goto((FIXTURES / "sample_form.html").as_uri())
    assert CaptchaHandler().detect(browser_page) is False


def test_unknown_required_fields_need_action_without_guessing(browser_page, resume_pdf):
    browser_page.goto((FIXTURES / "manual_action_form.html").as_uri())
    with pytest.raises(
        ManualActionRequired, match="Required fields need answers"
    ) as error:
        FormFiller(timeout_ms=1000).fill(browser_page, PROFILE, str(resume_pdf))
    assert "authorized" in str(error.value)
    assert "consent" in str(error.value)
    assert browser_page.evaluate("window.submissionCount") == 0
    assert browser_page.locator('[name="consent"]').is_checked() is False


def test_explicit_required_answers_can_be_submitted(browser_page, resume_pdf):
    browser_page.goto((FIXTURES / "manual_action_form.html").as_uri())
    profile = {**PROFILE, "answers": {"work authorization": "Yes", "consent": True}}
    filler = FormFiller(timeout_ms=1000)
    _, form = filler.fill(browser_page, profile, str(resume_pdf))
    filler.submit(browser_page, form)
    assert browser_page.locator('[name="work_authorization"]').input_value() == "Yes"
    assert browser_page.locator('[name="consent"]').is_checked() is True
    assert browser_page.evaluate("window.submissionCount") == 1


def test_flaky_local_confirmation_is_never_submitted_twice(browser_page, resume_pdf):
    browser_page.goto((FIXTURES / "flaky_form.html").as_uri())
    filler = FormFiller(timeout_ms=250)
    _, form = filler.fill(browser_page, PROFILE, str(resume_pdf))
    with pytest.raises(SubmissionUncertain, match="Check the application"):
        filler.submit(browser_page, form)
    assert browser_page.evaluate("window.submissionCount") == 1


def test_recovery_ambiguous_submission_needs_manual_action(resume_pdf):
    sleep = Mock()
    agent = ApplicationAgent(max_retries=3, retry_delay=1, timeout_ms=5000, sleep=sleep)
    agent.filler.timeout_ms = 250
    result = agent.apply(
        (FIXTURES / "flaky_form.html").as_uri(),
        str(resume_pdf),
        PROFILE,
    )
    assert result["status"] == "needs_action"
    assert result["attempts"] == 1
    assert "could not be confirmed" in result["failure_reason"]
    sleep.assert_not_called()


def test_recovery_preexisting_confirmation_copy_is_not_submission_proof(
    browser_page, resume_pdf
):
    browser_page.set_content("""
        <form><label>Email <input name="email" type="email" required></label>
        <button type="submit">Apply</button></form>
        <p>After applying you should see: Thank you for applying.</p>
        <script>
          window.submissionCount = 0;
          document.querySelector('form').addEventListener('submit', event => {
            event.preventDefault(); window.submissionCount += 1;
          });
        </script>
    """)
    filler = FormFiller(timeout_ms=250)
    _, form = filler.fill(browser_page, PROFILE, str(resume_pdf))
    with pytest.raises(SubmissionUncertain):
        filler.submit(browser_page, form)
    assert browser_page.evaluate("window.submissionCount") == 1


@pytest.mark.parametrize(
    "error",
    [
        PlaywrightTimeout("Navigation timed out"),
        ConnectionError("Career server unavailable"),
        OSError("Connection reset"),
    ],
)
def test_retry_temporary_navigation_failure_uses_exponential_backoff(
    monkeypatch, error
):
    sleep = Mock()
    agent = ApplicationAgent(max_retries=3, retry_delay=2, sleep=sleep)
    attempt = Mock(side_effect=[error, error, ["name", "email", "resume"]])
    monkeypatch.setattr(agent, "_attempt", attempt)

    result = agent.apply("https://careers.example.com/apply", "resume.pdf", PROFILE)

    assert result["status"] == "applied"
    assert result["attempts"] == 3
    assert result["failure_reason"] is None
    assert attempt.call_count == 3
    assert [call.args[0] for call in sleep.call_args_list] == [2, 4]


def test_retry_exhaustion_is_saved_with_failure_reason(monkeypatch, db_session):
    application = seed_application(db_session)
    agent = ApplicationAgent(max_retries=3, retry_delay=0, sleep=Mock())
    monkeypatch.setattr(
        agent, "_attempt", Mock(side_effect=PlaywrightTimeout("offline"))
    )
    result = agent.apply(
        application.job.url,
        "resume.pdf",
        PROFILE,
        db=db_session,
        application_id=application.id,
    )
    db_session.refresh(application)
    assert result["status"] == "failed"
    assert result["attempts"] == 3
    assert "Temporary network failure" in result["failure_reason"]
    assert application.failure_reason == result["failure_reason"]
    assert application.attempts == 3
    assert [(event.status, event.reason) for event in application.status_history][
        -1
    ] == ("failed", result["failure_reason"])


@pytest.mark.parametrize(
    "error, reason",
    [
        (FormStructureError("Submit selector not found"), "Submit selector not found"),
        (PlaywrightError("Browser closed"), "Browser failure"),
        (RuntimeError("Unexpected form response"), "Application error"),
    ],
)
def test_recovery_permanent_failures_attempted_once(monkeypatch, error, reason):
    sleep = Mock()
    agent = ApplicationAgent(max_retries=3, sleep=sleep)
    attempt = Mock(side_effect=error)
    monkeypatch.setattr(agent, "_attempt", attempt)
    result = agent.apply("https://careers.example.com/apply", "resume.pdf", PROFILE)
    assert result["status"] == "failed"
    assert result["attempts"] == 1
    assert reason in result["failure_reason"]
    assert attempt.call_count == 1
    sleep.assert_not_called()


def test_invalid_resume_and_changed_form_fail_cleanly(browser_page, tmp_path):
    browser_page.set_content(
        '<form><label>Resume <input name="resume" type="file" required></label></form>'
    )
    with pytest.raises(FormStructureError, match="Resume PDF not found"):
        FormFiller().fill(browser_page, PROFILE, str(tmp_path / "missing.pdf"))
    browser_page.set_content("<main>Career application moved to another system</main>")
    with pytest.raises(FormStructureError, match="selector not found"):
        FormFiller().fill(browser_page, PROFILE, "missing.pdf")


def test_recovery_unavailable_llm_requires_review_without_submission(
    browser_page, resume_pdf
):
    browser_page.goto((FIXTURES / "sample_form.html").as_uri())
    llm = Mock(chat=Mock(side_effect=ConnectionError("LLM unavailable")))
    with pytest.raises(ManualActionRequired, match="written answer needs review"):
        FormFiller(llm).fill(browser_page, PROFILE, str(resume_pdf), JD)
    assert browser_page.evaluate("window.submissionCount") == 0


def test_application_must_be_confirmed_and_applied_is_idempotent(
    monkeypatch, db_session
):
    application = seed_application(db_session, ApplicationStatus.planned)
    agent = ApplicationAgent()
    attempt = Mock(return_value=["email"])
    monkeypatch.setattr(agent, "_attempt", attempt)
    result = agent.apply(
        application.job.url,
        "resume.pdf",
        PROFILE,
        db=db_session,
        application_id=application.id,
    )
    assert result["status"] == "failed"
    assert "must be confirmed" in result["failure_reason"]
    attempt.assert_not_called()

    application.status = ApplicationStatus.applied
    application.attempts = 1
    db_session.commit()
    result = agent.apply(
        application.job.url,
        "resume.pdf",
        PROFILE,
        db=db_session,
        application_id=application.id,
    )
    assert result["status"] == "applied"
    assert result["attempts"] == 1
    attempt.assert_not_called()


@pytest.mark.parametrize("kwargs", [{"max_retries": 0}, {"retry_delay": -1}])
def test_invalid_retry_configuration_is_rejected(kwargs):
    with pytest.raises(ValueError):
        ApplicationAgent(**kwargs)


def test_relative_fixture_url_is_normalized():
    assert (
        normalize_url("file://tests/fixtures/sample_form.html")
        == (FIXTURES / "sample_form.html").resolve().as_uri()
    )
