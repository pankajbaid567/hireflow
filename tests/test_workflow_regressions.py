from src.config.settings import get_settings
from src.models import Application, ApplicationStatus, Job, ListingType
from src.pipelines.match_scorer import score_jobs_for_user
from tests.helpers import seed_application, authenticate_client


def test_profile_null_optional_fields_are_normalized_and_bad_projects_rejected(
    api_client,
):
    response = api_client.post(
        "/profile",
        json={
            "name": "Nullable",
            "email": "nullable@example.com",
            "mode": "internship",
            "skills": None,
            "projects": None,
            "experience": None,
            "experience_years": None,
        },
    )
    assert response.status_code == 201
    profile = response.json()["master_profile"]
    assert profile["skills"] == profile["projects"] == profile["experience"] == []
    assert profile["experience_years"] == 0
    invalid = api_client.patch(
        f"/profile/{response.json()['id']}",
        json={"projects": ["invalid project shape"]},
    )
    assert invalid.status_code == 422


def test_matching_only_selects_the_users_listing_mode(db_session):
    app = seed_application(db_session, ApplicationStatus.pending)
    app.user.mode = "internship"
    other_job = Job(
        title="Python Engineer",
        company="Full Time",
        description="Python FastAPI",
        url="https://example.com/full-time",
        listing_type=ListingType.job,
    )
    db_session.add(other_job)
    db_session.commit()
    scores = score_jobs_for_user(app.user_id, db=db_session)
    assert [score["job_id"] for score in scores] == [app.job_id]
    assert (
        db_session.query(Application)
        .filter_by(user_id=app.user_id, job_id=other_job.id)
        .count()
        == 0
    )


def test_profile_changes_require_review_and_keep_all_resume_versions(
    api_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    app = seed_application(db_session, ApplicationStatus.pending)
    authenticate_client(api_client, db_session, app.user_id)
    app.user.mode = "internship"
    app.user.weekly_quota = 1
    db_session.commit()
    first = api_client.get(f"/weekly-plan/{app.user_id}")
    assert first.status_code == 200, first.text
    assert first.json()["plan"][0]["resume_version"] == 1
    assert (
        api_client.patch(
            f"/profile/{app.user_id}", json={"skills": ["Python", "FastAPI", "SQL"]}
        ).status_code
        == 200
    )
    stale = api_client.post(
        f"/weekly-plan/{app.user_id}/confirm", json={"confirmed_job_ids": [app.job_id]}
    )
    assert stale.status_code == 400 and "review" in stale.json()["detail"]
    # The original generated document remains in the resume library.
    library = api_client.get(f"/resumes/{app.user_id}").json()["items"]
    assert [item["version"] for item in library] == [1]
    assert api_client.get(library[0]["download_url"]).status_code == 200
    refreshed = api_client.get(f"/weekly-plan/{app.user_id}")
    assert refreshed.status_code == 200
    assert refreshed.json()["plan"][0]["resume_version"] == 2
    versions = api_client.get(f"/resumes/{app.user_id}").json()["items"]
    assert [item["version"] for item in versions] == [2, 1]
    assert (
        api_client.get(f"/resumes/9999/{app.id}/download?version=1").status_code == 404
    )


def test_latest_report_email_is_explicit_and_uses_profile_recipient(
    api_client, db_session, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "local_storage_path", str(tmp_path))
    application = seed_application(db_session, ApplicationStatus.applied)
    authenticate_client(api_client, db_session, application.user_id)
    from src.agents.report_generator import ReportGenerator

    report = ReportGenerator(db_session).generate(application.user_id)
    sent = []

    def send(self, to_email, report_html, resume_paths, **kwargs):
        sent.append((to_email, report_html, kwargs["report_id"]))
        return {"status": "sent"}

    monkeypatch.setattr("src.utils.email_service.EmailService.send_weekly_report", send)
    assert not sent
    response = api_client.post(f"/report/{application.user_id}/latest/email")
    assert response.status_code == 200 and response.json()["status"] == "sent"
    assert sent[0][0] == application.user.email and sent[0][2] == report["id"]
