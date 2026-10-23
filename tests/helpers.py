"""Isolated database and browser fixtures shared by the new workflow tests."""

from pathlib import Path

import pytest
from playwright.sync_api import sync_playwright
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.models import Application, ApplicationStatus, Base, Job, ListingType, User

FIXTURES = Path(__file__).parent / "fixtures"


def authenticate_client(client, db, user_id):
    """Give an explicitly chosen, fixture-owned user a real persisted session."""
    from datetime import datetime, timedelta, timezone
    import secrets
    from uuid import uuid4
    from src.api.security import digest
    from src.models import AuthSession

    token = secrets.token_hex(32)
    created = datetime.now(timezone.utc)
    db.add(
        AuthSession(
            token_hash=digest(token),
            id=str(uuid4()),
            user_id=user_id,
            created_at=created,
            expires_at=created + timedelta(days=30),
            label="Test browser",
        )
    )
    db.commit()
    client.cookies.set("hireflow_session", token)


@pytest.fixture
def db_session(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'workflow.sqlite'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session
    engine.dispose()


@pytest.fixture
def api_client(db_session):
    from fastapi.testclient import TestClient
    from src.api.main import app
    from src.config.database import get_db

    def override_get_db():
        yield db_session

    previous = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            yield client
    finally:
        if previous is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = previous


@pytest.fixture
def browser_page():
    # These tests intentionally run Chromium against local HTML; no external
    # career page is opened and no real application can be submitted.
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_default_timeout(15000)
        page.set_default_navigation_timeout(15000)
        yield page
        browser.close()


@pytest.fixture
def resume_pdf(tmp_path):
    from reportlab.pdfgen import canvas

    path = tmp_path / "test_resume.pdf"
    pdf = canvas.Canvas(str(path))
    pdf.drawString(72, 750, "Test User - Python, FastAPI, LangChain")
    pdf.save()
    return path


def seed_application(db, status=ApplicationStatus.confirmed):
    user = User(
        name="Test User",
        email="test@example.com",
        master_profile={"skills": ["Python", "FastAPI"], "experience_years": 0},
    )
    job = Job(
        title="AI Engineer Intern",
        company="AIBridge",
        description="Python, FastAPI, Docker and RAG. Two interview rounds: technical and HR.",
        url="https://careers.example.com/apply/1",
        listing_type=ListingType.internship,
    )
    application = Application(user=user, job=job, status=status, match_score=0.8)
    db.add(application)
    db.commit()
    return application
