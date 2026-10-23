from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field

from src.config.database import get_db
from src.models import AuthSession, AccountRecoveryKey
from src.api.security import (
    authenticated_session,
    require_session,
    issue_session,
    clear_cookie,
    cookie_hash,
    now,
    digest,
    rotate_recovery_keys,
    reserve_recovery_attempt,
)

router = APIRouter(tags=["Account security"])


@router.get("/session")
def get_session(request: Request, db: Session = Depends(get_db)):
    session = authenticated_session(request, db)
    return {
        "authenticated": bool(session),
        **({"user_id": session.user_id} if session else {}),
    }


@router.post("/session/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    db.execute(
        delete(AuthSession).where(AuthSession.token_hash == cookie_hash(request))
    )
    db.commit()
    clear_cookie(response, request)
    return {"authenticated": False}


@router.get("/account/security")
def security(request: Request, db: Session = Depends(get_db)):
    owner = require_session(request, db)
    sessions = db.scalars(
        select(AuthSession).where(
            AuthSession.user_id == owner.user_id, AuthSession.expires_at > now()
        )
    ).all()
    keys = db.scalars(
        select(AccountRecoveryKey).where(
            AccountRecoveryKey.user_id == owner.user_id,
            AccountRecoveryKey.used_at.is_(None),
            AccountRecoveryKey.expires_at > now(),
        )
    ).all()
    return {
        "capabilities": {"passkeys": False, "recovery_keys": True},
        "sessions": [
            {
                "id": row.id,
                "label": row.label,
                "created_at": row.created_at,
                "expires_at": row.expires_at,
                "current": row.token_hash == owner.token_hash,
            }
            for row in sessions
        ],
        "passkeys": [],
        "recovery_keys": {
            "remaining": len(keys),
            "expires_at": min((key.expires_at for key in keys), default=None),
        },
    }


@router.post("/account/recovery-keys/rotate")
def rotate(request: Request, db: Session = Depends(get_db)):
    return rotate_recovery_keys(db, require_session(request, db).user_id)


class Recover(BaseModel):
    recovery_key: str = Field(max_length=100)


@router.post("/account/recover")
def recover(
    data: Recover, request: Request, response: Response, db: Session = Depends(get_db)
):
    reserve_recovery_attempt(request, db)
    import re

    key = data.recovery_key.strip()
    if not re.fullmatch(r"hf-recovery-[a-f0-9]{64}", key):
        raise HTTPException(
            401, "This recovery key is invalid, expired or already used."
        )
    owner = db.execute(
        update(AccountRecoveryKey)
        .where(
            AccountRecoveryKey.token_hash == digest(key),
            AccountRecoveryKey.used_at.is_(None),
            AccountRecoveryKey.expires_at > now(),
        )
        .values(used_at=now())
        .returning(AccountRecoveryKey.user_id)
    ).scalar_one_or_none()
    if owner is None:
        db.rollback()
        raise HTTPException(
            401, "This recovery key is invalid, expired or already used."
        )
    db.execute(delete(AuthSession).where(AuthSession.user_id == owner))
    issue_session(response, request, db, owner)
    return {"authenticated": True, "user_id": owner}


@router.delete("/account/sessions/{session_id}")
def revoke(
    session_id: str, request: Request, response: Response, db: Session = Depends(get_db)
):
    owner = require_session(request, db)
    removed = db.execute(
        delete(AuthSession)
        .where(AuthSession.id == session_id, AuthSession.user_id == owner.user_id)
        .returning(AuthSession.token_hash)
    ).scalar_one_or_none()
    if removed is None:
        raise HTTPException(404, "Session not found.")
    db.commit()
    if removed == cookie_hash(request):
        clear_cookie(response, request)
    return {"revoked": True}


@router.post("/account/sessions/revoke-all")
def revoke_all(request: Request, response: Response, db: Session = Depends(get_db)):
    owner = require_session(request, db)
    db.execute(delete(AuthSession).where(AuthSession.user_id == owner.user_id))
    db.commit()
    clear_cookie(response, request)
    return {"authenticated": False}
