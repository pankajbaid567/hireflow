"""A real API -> database -> PDF -> Chromium -> prep/report local cycle."""

from pathlib import Path

from pypdf import PdfReader

from src.config.settings import get_settings
from src.models import Application, ApplicationStatus, Job, ListingType, WeeklyReport
from tests.helpers import FIXTURES


def test_profile_plan_preview_swap_confirmation_application_and_report(
    api_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    monkeypatch.setattr(get_settings(), "application_timeout_ms", 2000)
    # Provider traffic is mocked; the form submission and generated PDF are real.
    monkeypatch.setattr(
        "src.utils.web_search.WebSearch.search", lambda self, *args, **kwargs: []
    )
    created = api_client.post(
        "/profile",
        json={
            "name": "Test User",
            "email": "e2e@example.com",
            "mode": "internship",
            "weekly_quota": 1,
            "phone": "9999999999",
            "education": "BTech",
            "experience_years": 0,
            "skills": ["Python", "FastAPI", "LangChain"],
            "answers": {"why": "I want to build reliable Python agents."},
        },
    )
    assert created.status_code == 201
    user_id = created.json()["id"]
    jobs = [
        Job(
            title="AI Engineer Intern",
            company="Local Demo",
            description="Python, FastAPI, LangChain and Docker. Two rounds: technical and HR.",
            url=(FIXTURES / "sample_form.html").as_uri(),
            listing_type=ListingType.internship,
        ),
        Job(
            title="Platform Intern",
            company="Alternative",
            description="Python and SQL internship",
            url=(FIXTURES / "captcha_form.html").as_uri(),
            listing_type=ListingType.internship,
        ),
    ]
    db_session.add_all(jobs)
    db_session.commit()
    plan_response = api_client.get(f"/weekly-plan/{user_id}")
    assert plan_response.status_code == 200, plan_response.text
    plan = plan_response.json()
    assert len(plan["plan"]) == 1 and plan["alternatives"]
    selected = plan["plan"][0]
    assert selected["job_id"] == jobs[0].id
    preview = api_client.get(selected["resume_url"])
    assert preview.status_code == 200 and preview.content.startswith(b"%PDF")
    from io import BytesIO

    text = " ".join(
        page.extract_text() for page in PdfReader(BytesIO(preview.content)).pages
    )
    assert "Test User" in text and "Python" in text and "Docker" not in text
    replacement = plan["alternatives"][0]
    swap = api_client.post(
        f"/weekly-plan/{user_id}/swap",
        json={"remove_job_id": selected["job_id"], "add_job_id": replacement["job_id"]},
    )
    assert swap.status_code == 200
    assert swap.json()["plan"][0]["job_id"] == replacement["job_id"]
    swap_back = api_client.post(
        f"/weekly-plan/{user_id}/swap",
        json={"remove_job_id": replacement["job_id"], "add_job_id": selected["job_id"]},
    )
    assert swap_back.status_code == 200
    confirmed = api_client.post(
        f"/weekly-plan/{user_id}/confirm",
        json={"confirmed_job_ids": [selected["job_id"]]},
    )
    assert confirmed.status_code == 200, confirmed.text
    db_session.expire_all()
    application = db_session.get(Application, selected["application_id"])
    assert application.status == ApplicationStatus.applied
    assert [event.status for event in application.status_history][-3:] == [
        "confirmed",
        "applying",
        "applied",
    ]
    assert application.prep_guide and application.applied_at
    guide = api_client.get(f"/applications/{application.id}/prep-guide")
    assert guide.status_code == 200
    assert guide.json()["round_count"] == 2
    assert "Docker" in guide.json()["topics"]["gaps"]
    tracked = api_client.get(f"/applications/{user_id}?status=applied")
    assert tracked.json()["total"] == 1
    report = api_client.get(f"/report/{user_id}/latest")
    assert report.status_code == 200 and report.json()["applied_count"] == 1
    assert api_client.get(report.json()["html_url"]).status_code == 200
    library = api_client.get(f"/resumes/{user_id}").json()
    assert (
        library["items"]
        and api_client.get(library["items"][0]["download_url"]).status_code == 200
    )
    # Repeated confirmation cannot submit an already applied application again.
    assert (
        api_client.post(
            f"/weekly-plan/{user_id}/confirm",
            json={"confirmed_job_ids": [selected["job_id"]]},
        ).status_code
        == 400
    )
    assert api_client.get(f"/weekly-plan/{user_id}").json()["plan"] == []


def test_profile_edit_manual_pdf_overrides_and_validation(
    api_client, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    from reportlab.pdfgen import canvas

    path = tmp_path / "original.pdf"
    pdf = canvas.Canvas(str(path))
    pdf.drawString(72, 750, "Candidate with Python and FastAPI")
    pdf.save()
    created = api_client.post(
        "/profile",
        data={
            "name": "Manual User",
            "email": "manual@example.com",
            "mode": "internship",
            "skills": '["Python"]',
            "weekly_quota": "2",
            "education": "BTech, NST Engineering, 2027",
        },
        files={"resume": ("resume.pdf", path.read_bytes(), "application/pdf")},
    )
    assert created.status_code == 201, created.text
    assert (
        created.json()["mode"] == "internship" and created.json()["weekly_quota"] == 2
    )
    assert Path(created.json()["master_profile"]["master_resume_path"]).is_file()
    assert (
        created.json()["master_profile"]["education"] == "BTech, NST Engineering, 2027"
    )
    user_id = created.json()["id"]
    edited = api_client.patch(
        f"/profile/{user_id}",
        json={"mode": "job", "weekly_quota": 3, "skills": ["Python", "SQL"]},
    )
    assert edited.status_code == 200 and edited.json()["name"] == "Manual User"
    assert edited.json()["master_profile"]["skills"] == ["Python", "SQL"]
    assert (
        api_client.post(
            "/profile", json={"name": "   ", "email": "invalid", "mode": "job"}
        ).status_code
        == 422
    )
    assert (
        api_client.patch(f"/profile/{user_id}", json={"weekly_quota": 101}).status_code
        == 422
    )


def test_captcha_application_does_not_block_next_listing(
    api_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    monkeypatch.setattr(get_settings(), "application_timeout_ms", 1000)
    monkeypatch.setattr(
        "src.utils.web_search.WebSearch.search", lambda self, *args, **kwargs: []
    )
    response = api_client.post(
        "/profile",
        json={
            "name": "Test User",
            "email": "captcha-e2e@example.com",
            "mode": "internship",
            "weekly_quota": 2,
            "skills": ["Python"],
            "phone": "9999999999",
            "education": "BTech",
            "experience_years": 0,
            "answers": {"why": "I enjoy Python."},
        },
    )
    user_id = response.json()["id"]
    db_session.add_all(
        [
            Job(
                title="Intern",
                company="Challenge",
                description="Python",
                listing_type=ListingType.internship,
                url=(FIXTURES / "captcha_form.html").as_uri(),
            ),
            Job(
                title="Intern",
                company="Success",
                description="Python",
                listing_type=ListingType.internship,
                url=(FIXTURES / "sample_form.html").as_uri(),
            ),
        ]
    )
    db_session.commit()
    plan = api_client.get(f"/weekly-plan/{user_id}").json()
    response = api_client.post(
        f"/weekly-plan/{user_id}/confirm",
        json={"confirmed_job_ids": [item["job_id"] for item in plan["plan"]]},
    )
    assert response.status_code == 200
    db_session.expire_all()
    apps = (
        db_session.query(Application)
        .filter_by(user_id=user_id)
        .order_by(Application.id)
        .all()
    )
    assert [app.status for app in apps] == [
        ApplicationStatus.needs_action,
        ApplicationStatus.applied,
    ]
    assert apps[0].failure_reason == "CAPTCHA detected" and apps[0].manual_action_url
    assert (
        db_session.query(WeeklyReport).filter_by(user_id=user_id).one().applied_count
        == 1
    )


def test_changed_form_fails_once_and_pipeline_applies_next_listing(
    api_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    monkeypatch.setattr(get_settings(), "application_timeout_ms", 15000)
    monkeypatch.setattr("src.utils.web_search.WebSearch.search", lambda *_a, **_kw: [])
    missing_form = tmp_path / "application_moved.html"
    missing_form.write_text(
        "<html><body><h1>The application form moved</h1></body></html>",
        encoding="utf-8",
    )
    created = api_client.post(
        "/profile",
        json={
            "name": "Recovery User",
            "email": "recovery-e2e@example.com",
            "mode": "internship",
            "weekly_quota": 2,
            "skills": ["Python"],
            "phone": "9999999999",
            "education": "BTech",
            "experience_years": 0,
            "answers": {"why": "I enjoy building reliable Python software."},
        },
    )
    assert created.status_code == 201
    user_id = created.json()["id"]
    for company, url in (
        ("Changed Form", missing_form.as_uri()),
        ("Successful Form", (FIXTURES / "sample_form.html").as_uri()),
    ):
        db_session.add(
            Job(
                title="Python Intern",
                company=company,
                description="Python internship",
                listing_type=ListingType.internship,
                url=url,
            )
        )
    db_session.commit()
    plan = api_client.get(f"/weekly-plan/{user_id}")
    assert plan.status_code == 200 and len(plan.json()["plan"]) == 2
    confirmed = api_client.post(
        f"/weekly-plan/{user_id}/confirm",
        json={"confirmed_job_ids": [item["job_id"] for item in plan.json()["plan"]]},
    )
    assert confirmed.status_code == 200
    db_session.expire_all()
    applications = (
        db_session.query(Application)
        .filter_by(user_id=user_id)
        .order_by(Application.id)
        .all()
    )
    failed, applied = applications
    assert failed.status == ApplicationStatus.failed and failed.attempts == 1
    assert "selector not found" in failed.failure_reason
    assert failed.status_history[-1].reason == failed.failure_reason
    assert applied.status == ApplicationStatus.applied and applied.attempts == 1
    assert all(application.prep_guide is not None for application in applications)
    report = api_client.get(f"/report/{user_id}/latest").json()
    assert report["metrics"]["failed_count"] == 1 and report["applied_count"] == 1
    failed_item = next(
        item for item in report["content"]["applications"] if item["status"] == "failed"
    )
    assert failed_item["failure_reason"] == failed.failure_reason
    assert "apply manually" in failed_item["instructions"]
    assert api_client.get(f"/applications/{user_id}?status=failed").json()["total"] == 1
