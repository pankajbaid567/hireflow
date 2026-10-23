from datetime import datetime, timedelta, timezone
from pathlib import Path

from src.agents.report_generator import ReportGenerator
from src.config.settings import get_settings
from src.models import Application, ApplicationStatus, Job, WeeklyReport
from src.utils.dates import week_start
from tests.helpers import seed_application, authenticate_client


def test_report_current_week_insights_study_plan_and_actions(db_session, tmp_path):
    application = seed_application(db_session, ApplicationStatus.applied)
    application.cycle_start = week_start()
    application.resume_path = str(tmp_path / "resume.pdf")
    for title, status, score in [
        ("Backend Engineer", ApplicationStatus.failed, 0.7),
        ("Platform Intern", ApplicationStatus.needs_action, 0.5),
    ]:
        job = Job(
            title=title,
            company="Other",
            url=f"https://example.com/{title.replace(' ', '-')}",
            description="Python Docker TypeScript RAG",
        )
        db_session.add(
            Application(
                user=application.user,
                job=job,
                status=status,
                match_score=score,
                cycle_start=week_start(),
                failure_reason=(
                    "CAPTCHA detected"
                    if status == ApplicationStatus.needs_action
                    else "HTTP 404"
                ),
                manual_action_url=(
                    job.url if status == ApplicationStatus.needs_action else None
                ),
            )
        )
    old_job = Job(
        title="Old", company="Past", url="https://example.com/past", description="Java"
    )
    db_session.add(
        Application(
            user=application.user,
            job=old_job,
            status=ApplicationStatus.applied,
            cycle_start=week_start() - timedelta(days=7),
            created_at=datetime.now(timezone.utc) - timedelta(days=8),
        )
    )
    db_session.commit()
    generated = ReportGenerator(db_session, tmp_path).generate(application.user_id)
    content = generated["content"]
    assert len(content["applications"]) == 3
    assert generated["applied_count"] == 1
    assert generated["avg_match_score"] == 0.6667
    assert content["top_skills"][0] == {"skill": "Docker", "frequency": 3}
    assert [item["skill"] for item in content["study_plan"]] == [
        "Docker",
        "RAG",
        "TypeScript",
    ]
    assert content["strongest_match_type"] == "AI Engineer Intern"
    assert content["weakest_match_type"] == "Platform Intern"
    for app in content["applications"]:
        if app["status"] in {"failed", "needs_action"}:
            assert (
                app["instructions"]
                and app["failure_reason"]
                and app["manual_action_url"]
            )
    row = db_session.get(WeeklyReport, generated["id"])
    assert row.metrics["failed_count"] == 1
    assert row.metrics["needs_action_count"] == 1
    assert Path(row.html_path).is_file()
    assert "Resume PDF" in Path(row.html_path).read_text()


def test_report_idempotent_upsert_preserves_delivery_timestamp(db_session, tmp_path):
    application = seed_application(db_session, ApplicationStatus.applied)
    generator = ReportGenerator(db_session, tmp_path)
    first = generator.generate(application.user_id)
    row = db_session.get(WeeklyReport, first["id"])
    row.email_sent_at = datetime.now(timezone.utc)
    db_session.commit()
    second = generator.generate(application.user_id)
    assert first["id"] == second["id"]
    assert second["email_sent_at"] is not None
    assert db_session.query(WeeklyReport).count() == 1


def test_report_empty_user_and_missing_profile(db_session, tmp_path):
    import pytest

    application = seed_application(db_session)
    user_id = application.user_id
    db_session.delete(application)
    db_session.commit()
    report = ReportGenerator(db_session, tmp_path).generate(user_id)
    assert report["content"]["applications"] == []
    assert report["metrics"]["avg_match_score"] == 0
    with pytest.raises(ValueError, match="Profile not found"):
        ReportGenerator(db_session, tmp_path).generate(9999)


def test_report_html_escapes_profile_company_and_unsafe_links(db_session, tmp_path):
    application = seed_application(db_session, ApplicationStatus.needs_action)
    application.user.name = '<script>alert("x")</script>'
    application.job.company = "<img src=x onerror=alert(1)>"
    application.manual_action_url = "javascript:alert(1)"
    application.failure_reason = "<b>Human review</b>"
    db_session.commit()
    report = ReportGenerator(db_session, tmp_path).generate(application.user_id)
    html = Path(db_session.get(WeeklyReport, report["id"]).html_path).read_text()
    assert (
        "<script>" not in html
        and "<img" not in html
        and 'href="javascript:' not in html
    )
    assert "&lt;script&gt;" in html and "&lt;b&gt;" in html


def test_report_latest_and_html_api(api_client, db_session, tmp_path, monkeypatch):
    application = seed_application(db_session)
    authenticate_client(api_client, db_session, application.user_id)
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    assert api_client.get(f"/report/{application.user_id}/latest").status_code == 404
    response = api_client.post(f"/report/{application.user_id}/generate")
    assert response.status_code == 200
    latest = api_client.get(f"/report/{application.user_id}/latest")
    assert latest.json()["id"] == response.json()["id"]
    html = api_client.get(latest.json()["html_url"])
    assert html.status_code == 200 and "text/html" in html.headers["content-type"]
    assert "HireFlow weekly report" in html.text
    assert api_client.post("/report/9999/generate").status_code == 404


def test_week_start_uses_monday_and_iso_year_boundary():
    from datetime import date

    assert week_start(date(2027, 1, 1)) == date(2026, 12, 28)
