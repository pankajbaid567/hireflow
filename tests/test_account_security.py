from datetime import timedelta

from src.api.security import now, digest
from src.models import AuthSession, AccountRecoveryKey, User, ApplicationStatus
from tests.helpers import authenticate_client, seed_application


def signup(client, email="secure@example.com"):
    response = client.post(
        "/profile",
        json={
            "name": "Secure Owner",
            "email": email,
            "mode": "internship",
            "skills": ["Python"],
        },
    )
    assert response.status_code == 201
    return response.json()


def test_profile_creation_issues_private_session_and_numeric_ids_cannot_authenticate(
    api_client, db_session
):
    owner = signup(api_client)
    assert api_client.get(f"/profile/{owner['id']}").status_code == 200
    cookie = api_client.cookies.get("hireflow_session")
    row = db_session.query(AuthSession).one()
    assert row.token_hash == digest(cookie) and row.token_hash != cookie
    assert api_client.get("/session").json() == {
        "authenticated": True,
        "user_id": owner["id"],
    }
    api_client.cookies.clear()
    for path in [
        f"/profile/{owner['id']}",
        f"/weekly-plan/{owner['id']}",
        f"/applications/{owner['id']}",
        f"/resumes/{owner['id']}",
        f"/report/{owner['id']}/latest",
        "/applications/1/prep-guide",
    ]:
        assert api_client.get(path).status_code == 401
    assert (
        api_client.patch(
            f"/profile/{owner['id']}", json={"name": "Hijacked"}
        ).status_code
        == 401
    )
    assert (
        api_client.post(
            f"/weekly-plan/{owner['id']}/confirm", json={"confirmed_job_ids": [1]}
        ).status_code
        == 401
    )


def test_cross_user_reads_writes_and_files_are_denied(api_client, db_session):
    owner = signup(api_client)
    foreign = seed_application(db_session, ApplicationStatus.planned)
    for path in [
        f"/profile/{foreign.user_id}",
        f"/applications/{foreign.user_id}",
        f"/resumes/{foreign.user_id}/{foreign.id}/download",
        f"/applications/{foreign.id}/prep-guide",
    ]:
        assert api_client.get(path).status_code == 404
    for spelling in [f"+{foreign.user_id}", f"%20{foreign.user_id}%20"]:
        for prefix in ["profile", "applications", "weekly-plan", "resumes", "report"]:
            suffix = "/latest" if prefix == "report" else ""
            assert api_client.get(f"/{prefix}/{spelling}{suffix}").status_code == 404
    assert api_client.get(f"/applications/+{foreign.id}/prep-guide").status_code == 404
    assert (
        api_client.patch(
            f"/profile/{foreign.user_id}", json={"name": "Hijacked"}
        ).status_code
        == 404
    )
    assert db_session.get(User, owner["id"]).name == "Secure Owner"


def test_single_use_recovery_rotates_keys_revokes_sessions_and_never_accepts_email_or_id(
    api_client, db_session
):
    owner = signup(api_client)
    first = api_client.post("/account/recovery-keys/rotate").json()
    keys = api_client.post("/account/recovery-keys/rotate").json()
    assert len(keys["recovery_keys"]) == 8
    assert db_session.query(AccountRecoveryKey).count() == 8
    assert all(
        row.token_hash not in keys["recovery_keys"]
        for row in db_session.query(AccountRecoveryKey)
    )
    old_cookie = api_client.cookies.get("hireflow_session")
    api_client.cookies.clear()
    assert (
        api_client.post(
            "/account/recover", json={"recovery_key": first["recovery_keys"][0]}
        ).status_code
        == 401
    )
    assert (
        api_client.post(
            "/account/recover", json={"email": owner["email"], "user_id": owner["id"]}
        ).status_code
        == 422
    )
    result = api_client.post(
        "/account/recover", json={"recovery_key": keys["recovery_keys"][0]}
    )
    assert result.status_code == 200 and result.json()["user_id"] == owner["id"]
    assert (
        api_client.post(
            "/account/recover", json={"recovery_key": keys["recovery_keys"][0]}
        ).status_code
        == 401
    )
    assert (
        db_session.query(AuthSession).filter_by(token_hash=digest(old_cookie)).first()
        is None
    )
    assert api_client.get(f"/profile/{owner['id']}").status_code == 200


def test_expiry_logout_revoke_all_and_foreign_origin(api_client, db_session):
    owner = signup(api_client)
    response = api_client.get("/account/security")
    assert response.headers["Cache-Control"] == "private, no-store"
    security = response.json()
    assert (
        security["capabilities"]["passkeys"] is False
        and security["sessions"][0]["current"] is True
    )
    assert "token_hash" not in str(security)
    assert (
        api_client.post(
            "/account/recovery-keys/rotate",
            headers={"Origin": "https://attacker.example"},
        ).status_code
        == 403
    )
    keys = api_client.post("/account/recovery-keys/rotate").json()
    db_session.query(AccountRecoveryKey).update(
        {"expires_at": now() - timedelta(days=1)}
    )
    db_session.commit()
    assert (
        api_client.post(
            "/account/recover", json={"recovery_key": keys["recovery_keys"][0]}
        ).status_code
        == 401
    )
    assert api_client.post("/account/sessions/revoke-all").status_code == 200
    assert api_client.get(f"/profile/{owner['id']}").status_code == 401
    authenticate_client(api_client, db_session, owner["id"])
    db_session.query(AuthSession).update({"expires_at": now() - timedelta(seconds=1)})
    db_session.commit()
    assert api_client.get(f"/profile/{owner['id']}").status_code == 401
    assert api_client.post("/session/logout").status_code == 200


def test_recovery_attempts_are_bounded_and_cannot_revoke_foreign_session(
    api_client, db_session
):
    owner = signup(api_client)
    foreign = User(name="Foreign", email="foreign@example.com")
    db_session.add(foreign)
    db_session.commit()
    authenticate_client(api_client, db_session, foreign.id)
    foreign_session = (
        db_session.query(AuthSession).filter_by(user_id=foreign.id).one().id
    )
    authenticate_client(api_client, db_session, owner["id"])
    assert api_client.delete(f"/account/sessions/{foreign_session}").status_code == 404
    for _ in range(10):
        assert (
            api_client.post(
                "/account/recover", json={"recovery_key": "invalid"}
            ).status_code
            == 401
        )
    assert (
        api_client.post(
            "/account/recover", json={"recovery_key": "invalid"}
        ).status_code
        == 429
    )
