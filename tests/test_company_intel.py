"""Company research consumes attributed search results with a strict news window."""

from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

from src.agents.company_intel_agent import CompanyIntelAgent
from src.models import PrepGuide
from tests.helpers import seed_application


def test_company_facts_news_window_and_review_sources():
    now = datetime.now(timezone.utc)
    search = Mock()

    def results(query, **kwargs):
        if kwargs.get("news"):
            return [
                {
                    "title": "Recent launch",
                    "url": "https://news.example.com/recent",
                    "published_date": (now - timedelta(days=3)).isoformat(),
                },
                {
                    "title": "Old funding",
                    "url": "https://news.example.com/old",
                    "published_date": (now - timedelta(days=100)).isoformat(),
                },
                {"title": "Unverified date", "url": "https://news.example.com/undated"},
                {
                    "title": "Future announcement",
                    "url": "https://news.example.com/future",
                    "published_date": (now + timedelta(days=1)).isoformat(),
                },
                {
                    "title": "Private page",
                    "url": "http://127.0.0.1/secret",
                    "published_date": now.isoformat(),
                },
            ]
        if "site:glassdoor.com" in query:
            return [
                {
                    "title": "AIBridge interview",
                    "url": "https://www.glassdoor.com/Interview/aibridge",
                    "content": "AIBridge candidates reported a Python coding round.",
                },
                {
                    "title": "OtherCompany interview",
                    "url": "https://www.glassdoor.com/Interview/other",
                    "content": "OtherCompany had five rounds.",
                },
                {
                    "title": "Spoofed source",
                    "url": "https://glassdoor.com.evil.example/review",
                    "content": "AIBridge interview",
                },
            ]
        if "site:ambitionbox.com" in query:
            return [
                {
                    "title": "AIBridge interview reviews",
                    "url": "https://www.ambitionbox.com/interviews/aibridge",
                    "content": "AIBridge asked about Docker and API design.",
                }
            ]
        assert "site:aibridge.example" in query
        return [
            {
                "title": "About AIBridge",
                "url": "https://aibridge.example/about",
                "content": "AIBridge is a Series A company with 120 employees. We build with Python, FastAPI and Docker.",
            },
            {
                "title": "Unsafe result",
                "url": "http://localhost/admin",
                "content": "Series F 9000 employees",
            },
        ]

    search.search.side_effect = results
    intel = CompanyIntelAgent(search_client=search).research(
        "AIBridge", "https://aibridge.example"
    )

    assert intel["stage"] == "Series A"
    assert intel["estimated_team_size"] == "120"
    assert set(intel["tech_stack"]) >= {"Python", "FastAPI", "Docker"}
    assert [news["title"] for news in intel["recent_news"]] == ["Recent launch"]
    assert {pattern["source"] for pattern in intel["interview_patterns"]} == {
        "glassdoor.com",
        "ambitionbox.com",
    }
    assert len(intel["interview_patterns"]) == 2
    assert all("reported" in pattern["note"] for pattern in intel["interview_patterns"])
    assert len(intel["sources"]) == 1


def test_company_without_reviews_has_clear_fallback():
    search = Mock()
    search.search.return_value = []
    intel = CompanyIntelAgent(search_client=search).research("New Startup")
    assert intel["stage"] == "Unknown"
    assert intel["estimated_team_size"] == "Unknown"
    assert intel["interview_patterns"] == []
    assert intel["interview_summary"] == "No interview reviews found"
    assert "recruiter" in intel["fallback_guidance"]
    assert "JD skills" in intel["fallback_guidance"]


def test_company_search_outage_returns_clean_partial_result():
    search = Mock(search=Mock(side_effect=ConnectionError("Search unavailable")))
    intel = CompanyIntelAgent(search_client=search).research("AIBridge")
    assert intel["stage"] == "Unknown"
    assert intel["recent_news"] == []
    assert intel["interview_summary"] == "No interview reviews found"
    assert intel["warnings"] == ["Search unavailable"]


def test_company_intel_saved_in_existing_prep_guide(db_session):
    application = seed_application(db_session)
    guide = PrepGuide(
        application_id=application.id,
        structured_data={"topics": {"strong": ["Python"]}},
    )
    db_session.add(guide)
    db_session.commit()
    search = Mock(search=Mock(return_value=[]))
    intel = CompanyIntelAgent(search_client=search).research(
        "AIBridge", db=db_session, application_id=application.id
    )
    db_session.refresh(guide)
    assert db_session.query(PrepGuide).count() == 1
    assert guide.company_intel == intel
    assert guide.structured_data["company_intel"] == intel
    assert guide.structured_data["topics"] == {"strong": ["Python"]}


def test_company_intel_creates_missing_prep_guide(db_session):
    application = seed_application(db_session)
    intel = CompanyIntelAgent(
        search_client=Mock(search=Mock(return_value=[]))
    ).research(
        "AIBridge",
        db=db_session,
        application_id=application.id,
    )
    guide = db_session.query(PrepGuide).one()
    assert guide.application_id == application.id
    assert guide.company_intel == intel
