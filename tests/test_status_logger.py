"""State changes and audit events are committed together with precise reasons."""

import pytest

from src.models import Application, ApplicationStatus, ApplicationStatusEvent, Job, User
from src.utils.status_logger import StatusLogger
from tests.helpers import seed_application


def test_status_trail_has_all_lifecycle_states_reasons_and_timestamps(db_session):
    application = seed_application(db_session, ApplicationStatus.pending)
    logger = StatusLogger(db_session)
    states = ["planned", "confirmed", "applying", "applied", "failed", "needs_action"]
    for state in states:
        reason = (
            "Navigation timed out"
            if state == "failed"
            else "CAPTCHA detected" if state == "needs_action" else None
        )
        logger.log(application, state, reason)
    db_session.expire_all()
    assert [event.status for event in application.status_history] == states
    assert all(event.created_at is not None for event in application.status_history)
    assert [event.reason for event in application.status_history][-2:] == [
        "Navigation timed out",
        "CAPTCHA detected",
    ]
    assert application.status == ApplicationStatus.needs_action
    assert application.failure_reason == "CAPTCHA detected"
    assert application.manual_action_url == application.job.url
    assert application.applied_at is not None


def test_status_needs_action_preserves_specific_manual_url(db_session):
    application = seed_application(db_session)
    StatusLogger(db_session).log(
        application.id,
        "needs_action",
        "Answer work authorization question",
        "https://careers.example.com/manual/1",
    )
    db_session.refresh(application)
    assert application.failure_reason == "Answer work authorization question"
    assert application.manual_action_url == "https://careers.example.com/manual/1"
    assert application.status_history[-1].reason == application.failure_reason


def test_status_success_clears_failure_and_manual_action_fields(db_session):
    application = seed_application(db_session)
    logger = StatusLogger(db_session)
    logger.log(application, "needs_action", "CAPTCHA detected")
    logger.log(application, "confirmed")
    logger.log(application, "applied")
    assert application.status == ApplicationStatus.applied
    assert application.failure_reason is None
    assert application.manual_action_url is None
    assert application.applied_at is not None


def test_status_idempotent_does_not_duplicate_events(db_session):
    application = seed_application(db_session)
    logger = StatusLogger(db_session)
    logger.log(application, "applying")
    logger.log(application, "applying")
    assert (
        db_session.query(ApplicationStatusEvent)
        .filter_by(application_id=application.id)
        .count()
        == 1
    )


@pytest.mark.parametrize("status", ["failed", "needs_action"])
def test_status_failure_requires_reason_before_changing_state(db_session, status):
    application = seed_application(db_session)
    with pytest.raises(ValueError, match="requires a reason"):
        StatusLogger(db_session).log(application, status)
    assert application.status == ApplicationStatus.confirmed
    assert db_session.query(ApplicationStatusEvent).count() == 0


def test_status_uncommitted_event_and_state_roll_back_together(db_session):
    application = seed_application(db_session)
    StatusLogger(db_session).log(application, "applying", commit=False)
    db_session.flush()
    assert db_session.query(ApplicationStatusEvent).count() == 1
    db_session.rollback()
    db_session.refresh(application)
    assert application.status == ApplicationStatus.confirmed
    assert db_session.query(ApplicationStatusEvent).count() == 0


def test_status_unknown_application_and_invalid_status_rejected(db_session):
    logger = StatusLogger(db_session)
    with pytest.raises(ValueError, match="Application not found"):
        logger.log(9999, "confirmed")
    application = seed_application(db_session)
    with pytest.raises(ValueError):
        logger.log(application, "unrecognized")
    assert application.status == ApplicationStatus.confirmed


def test_tracker_api_paginated_status_reasons_and_resume_links(api_client, db_session):
    application = seed_application(db_session, ApplicationStatus.planned)
    application.resume_path = "data/resumes/1/1_resume_v1.pdf"
    application.resume_version = 1
    StatusLogger(db_session).log(
        application,
        "needs_action",
        "CAPTCHA detected",
        "https://careers.example.com/manual",
    )
    other_job = Job(
        title="Backend Intern",
        company="Other Company",
        url="https://careers.example.com/other",
    )
    failed = Application(
        user=application.user, job=other_job, status=ApplicationStatus.confirmed
    )
    db_session.add(failed)
    db_session.commit()
    StatusLogger(db_session).log(failed, "failed", "Career page returned HTTP 404")
    outsider = User(name="Another User", email="another@example.com")
    db_session.add(outsider)
    db_session.commit()
    db_session.add(
        Application(user=outsider, job=other_job, status=ApplicationStatus.applied)
    )
    db_session.commit()

    page = api_client.get(
        f"/applications/{application.user_id}", params={"page_size": 1}
    )
    assert page.status_code == 200
    assert page.json()["total"] == 2
    assert len(page.json()["items"]) == 1
    assert page.json()["page"] == 1 and page.json()["page_size"] == 1
    second = api_client.get(
        f"/applications/{application.user_id}", params={"page": 2, "page_size": 1}
    ).json()
    assert second["items"][0]["id"] != page.json()["items"][0]["id"]

    filtered = api_client.get(
        f"/applications/{application.user_id}", params={"status": "needs_action"}
    ).json()
    assert filtered["total"] == 1
    item = filtered["items"][0]
    assert item["company"] == "AIBridge" and item["role"] == "AI Engineer Intern"
    assert item["failure_reason"] == "CAPTCHA detected"
    assert item["manual_action_url"] == "https://careers.example.com/manual"
    assert (
        item["resume_url"]
        == f"/resumes/{application.user_id}/{application.id}/download"
    )
    assert item["resume_version"] == 1
    assert item["status_history"][-1]["reason"] == "CAPTCHA detected"
    assert item["status_history"][-1]["timestamp"]
    failures = api_client.get(
        f"/applications/{application.user_id}", params={"status": "failed"}
    ).json()
    assert failures["items"][0]["failure_reason"] == "Career page returned HTTP 404"


@pytest.mark.parametrize(
    "params", [{"page": 0}, {"page_size": 0}, {"page_size": 101}, {"status": "invalid"}]
)
def test_tracker_api_rejects_invalid_filters(api_client, db_session, params):
    application = seed_application(db_session)
    assert (
        api_client.get(
            f"/applications/{application.user_id}", params=params
        ).status_code
        == 422
    )


def test_tracker_api_unknown_user_and_empty_page(api_client, db_session):
    application = seed_application(db_session)
    assert api_client.get("/applications/9999").status_code == 404
    response = api_client.get(
        f"/applications/{application.user_id}", params={"page": 9}
    )
    assert response.status_code == 200
    assert response.json()["items"] == []
    assert response.json()["total"] == 1
