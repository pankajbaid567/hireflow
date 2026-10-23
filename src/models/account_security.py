from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from src.config.database import Base


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token_hash = Column(String(64), primary_key=True)
    id = Column(String(36), nullable=False, unique=True)
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at = Column(DateTime(timezone=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    label = Column(String(80), nullable=False)


class AccountRecoveryKey(Base):
    __tablename__ = "account_recovery_keys"
    token_hash = Column(String(64), primary_key=True)
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at = Column(DateTime(timezone=True), nullable=False)
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)
    used_at = Column(DateTime(timezone=True))


class AccountAttempt(Base):
    __tablename__ = "account_attempts"
    key = Column(String(100), primary_key=True)
    attempts = Column(Integer, nullable=False)
    window_start = Column(DateTime(timezone=True), nullable=False)
