"""Private owner sessions. Numeric IDs and email addresses are never credentials."""

from datetime import datetime, timedelta, timezone
import hashlib
import re
import secrets
from uuid import uuid4

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import delete, select, case
from sqlalchemy.orm import Session

from src.config.database import get_db
from src.config.settings import get_settings
from src.models import (
    Application,
    AuthSession,
    AccountRecoveryKey,
    AccountAttempt,
    User,
)

COOKIE = "hireflow_session"


def now():
    return datetime.now(timezone.utc)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def cookie_hash(request):
    token = request.cookies.get(COOKIE, "")
    return digest(token) if re.fullmatch(r"[a-f0-9]{64}", token) else None


def authenticated_session(request: Request, db: Session):
    value = cookie_hash(request)
    return (
        db.scalar(
            select(AuthSession).where(
                AuthSession.token_hash == value, AuthSession.expires_at > now()
            )
        )
        if value
        else None
    )


def require_session(request: Request, db: Session):
    session = authenticated_session(request, db)
    if session is None:
        raise HTTPException(
            401,
            "Your session is unavailable. Recover your workspace or create a profile.",
        )
    return session


def check_origin(request: Request):
    origin = request.headers.get("origin")
    allowed = {value.strip() for value in get_settings().allowed_origins.split(",")}
    allowed.add(f"{request.url.scheme}://{request.url.netloc}")
    if origin and origin not in allowed:
        raise HTTPException(403, "Origin is not allowed.")


def issue_session(response: Response, request: Request, db: Session, user_id: int):
    token = secrets.token_hex(32)
    created = now()
    agent = request.headers.get("user-agent", "")
    label = next(
        (name for name in ("Firefox", "Edge", "Chrome", "Safari") if name in agent),
        "Browser session",
    )
    db.add(
        AuthSession(
            token_hash=digest(token),
            id=str(uuid4()),
            user_id=user_id,
            created_at=created,
            expires_at=created + timedelta(days=30),
            label=label,
        )
    )
    db.commit()
    response.set_cookie(
        COOKIE,
        token,
        max_age=30 * 86400,
        httponly=True,
        secure=request.url.scheme == "https" or get_settings().app_env == "production",
        samesite="lax",
        path="/",
    )


def clear_cookie(response: Response, request: Request):
    response.delete_cookie(
        COOKIE,
        path="/",
        httponly=True,
        secure=request.url.scheme == "https" or get_settings().app_env == "production",
        samesite="lax",
    )


def enforce_ownership(request: Request, db: Session = Depends(get_db)):
    check_origin(request)
    path = request.url.path.rstrip("/") or "/"
    if (
        request.method == "OPTIONS"
        or path in {"/", "/health", "/docs", "/redoc", "/openapi.json", "/session"}
        or request.method == "POST"
        and path in {"/profile", "/account/recover", "/session/logout"}
    ):
        return
    session = require_session(request, db)
    request.state.owner_id = session.user_id
    # Use matched route parameters, not a second URL regex: FastAPI accepts
    # integer spellings such as +2 and whitespace that a digits-only guard
    # would miss even though the endpoint resolves them to another user.
    parameters = request.path_params
    if path.startswith("/applications/") and "application_id" in parameters:
        try:
            application_id = int(parameters["application_id"])
        except (TypeError, ValueError) as error:
            raise HTTPException(422, "Invalid application ID.") from error
        app = db.get(Application, application_id)
        if app is None or app.user_id != session.user_id:
            raise HTTPException(404, "Resource not found.")
        return
    if "user_id" in parameters:
        try:
            target = int(parameters["user_id"])
        except (TypeError, ValueError) as error:
            raise HTTPException(422, "Invalid profile ID.") from error
        if target != session.user_id:
            raise HTTPException(404, "Resource not found.")


def rotate_recovery_keys(db: Session, user_id: int):
    if db.get(User, user_id) is None:
        raise ValueError("Profile not found")
    keys = [f"hf-recovery-{secrets.token_hex(32)}" for _ in range(8)]
    created, expires = now(), now() + timedelta(days=365)
    db.execute(delete(AccountRecoveryKey).where(AccountRecoveryKey.user_id == user_id))
    db.add_all(
        [
            AccountRecoveryKey(
                token_hash=digest(key),
                user_id=user_id,
                created_at=created,
                expires_at=expires,
            )
            for key in keys
        ]
    )
    db.commit()
    return {"recovery_keys": keys, "expires_at": expires}


def reserve_recovery_attempt(request: Request, db: Session):
    # The direct client address is trusted; forwarded headers are not credentials.
    key = "recovery:" + digest(request.client.host if request.client else "local")
    created, cutoff = now(), now() - timedelta(minutes=10)
    dialect = db.bind.dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    statement = insert(AccountAttempt).values(key=key, attempts=1, window_start=created)
    statement = statement.on_conflict_do_update(
        index_elements=[AccountAttempt.key],
        set_={
            "attempts": case(
                (AccountAttempt.window_start <= cutoff, 1),
                else_=AccountAttempt.attempts + 1,
            ),
            "window_start": case(
                (AccountAttempt.window_start <= cutoff, created),
                else_=AccountAttempt.window_start,
            ),
        },
        where=(AccountAttempt.window_start <= cutoff) | (AccountAttempt.attempts < 10),
    ).returning(AccountAttempt.key)
    accepted = db.execute(statement).first()
    db.commit()
    if accepted is None:
        raise HTTPException(
            429, "Too many recovery attempts. Please try again in 10 minutes."
        )


if __name__ == "__main__":
    # Offline recovery requires the operator's existing filesystem/database access.
    # It never accepts an unauthenticated HTTP email or numeric ID as proof.
    import argparse
    from src.config.database import SessionLocal

    parser = argparse.ArgumentParser(
        description="Create new single-use recovery keys for a local database owner"
    )
    parser.add_argument("--user-id", required=True, type=int)
    args = parser.parse_args()
    with SessionLocal() as database:
        result = rotate_recovery_keys(database, args.user_id)
        print("Save these recovery keys privately; each works once:")
        print("\n".join(result["recovery_keys"]))
