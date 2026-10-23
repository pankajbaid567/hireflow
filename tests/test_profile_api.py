import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.api.main import app
from src.config.database import get_db
from src.models import Base


class StubLLMClient:
    def extract_profile(self, resume_text: str) -> dict:
        assert "Test Student" in resume_text
        return {
            "name": "Test Student",
            "email": "pdf@example.com",
            "skills": ["Python", "FastAPI"],
            "mode": "internship",
            "weekly_quota": 5,
            "target_roles": ["AI Engineer Intern"],
            "preferred_locations": ["Remote"],
            "min_stipend": 15000,
        }


@pytest.fixture()
def client(tmp_path, monkeypatch):
    database_url = f"sqlite:///{tmp_path / 'test.db'}"
    engine = create_engine(database_url, connect_args={"check_same_thread": False})
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    Base.metadata.create_all(bind=engine)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    monkeypatch.setattr(
        "src.api.routes.profile.get_llm_client", lambda: StubLLMClient()
    )
    monkeypatch.setattr(
        "src.api.routes.profile._extract_pdf_text",
        lambda _: "Test Student\nPython and FastAPI developer",
    )

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()


def test_create_profile_from_json(client):
    response = client.post(
        "/profile",
        json={
            "name": "Test Student",
            "email": "test@example.com",
            "skills": ["Python", "FastAPI"],
            "mode": "internship",
            "weekly_quota": 5,
            "target_roles": ["AI Engineer Intern"],
            "preferred_locations": ["Remote"],
            "min_stipend": 15000,
        },
    )

    assert response.status_code == 201
    data = response.json()
    assert data["id"] == 1
    assert data["name"] == "Test Student"
    assert data["mode"] == "internship"
    assert data["weekly_quota"] == 5
    assert data["confirmation_mode"] == "batch"
    assert data["master_profile"]["skills"] == ["Python", "FastAPI"]
    assert data["master_profile"]["target_roles"] == ["AI Engineer Intern"]


def test_get_profile_by_id(client):
    created = client.post(
        "/profile",
        json={
            "name": "Test Student",
            "email": "get@example.com",
            "skills": ["Python"],
            "mode": "job",
        },
    ).json()

    response = client.get(f"/profile/{created['id']}")

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == created["id"]
    assert data["email"] == "get@example.com"
    assert data["confirmation_mode"] == "batch"


def test_get_profile_not_found(client):
    response = client.get("/profile/999")

    assert response.status_code == 401
    assert "session is unavailable" in response.json()["detail"]


def test_invalid_mode_is_rejected(client):
    response = client.post(
        "/profile",
        json={
            "name": "Test Student",
            "email": "invalid@example.com",
            "skills": ["Python"],
            "mode": "freelance",
        },
    )

    assert response.status_code == 422


def test_create_profile_from_pdf(client):
    response = client.post(
        "/profile",
        files={"resume": ("resume.pdf", b"%PDF-1.4", "application/pdf")},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test Student"
    assert data["email"] == "pdf@example.com"
    assert data["master_profile"]["skills"] == ["Python", "FastAPI"]


def test_extended_profile_preferences_survive_multipart_resume_save(client):
    import json

    fields = {
        "name": "Test Student",
        "email": "details@example.com",
        "mode": "job",
        "summary": "Built a project.",
        "min_salary": "1200000",
        "min_stipend": "",
        "confirmation_mode": "individual",
        "links": json.dumps([{"label": "GitHub", "url": "https://github.com/example"}]),
        "certifications": json.dumps(["Example certification"]),
        "achievements": json.dumps(["Hackathon finalist"]),
        "languages": json.dumps(["English"]),
        "blacklist_companies": json.dumps(["Excluded Company"]),
        "projects": json.dumps(
            [{"name": "Actual project", "description": "Actual work"}]
        ),
    }
    response = client.post(
        "/profile",
        data=fields,
        files={"resume": ("resume.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert response.status_code == 201
    profile = response.json()["master_profile"]
    assert profile["links"][0]["url"] == "https://github.com/example"
    assert profile["blacklist_companies"] == ["Excluded Company"]
    assert profile["languages"] == ["English"]
    assert profile["min_salary"] == 1200000
    assert profile["min_stipend"] is None
    assert response.json()["confirmation_mode"] == "individual"
