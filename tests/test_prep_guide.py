"""Interview guidance stays JD-specific without requiring paid provider calls."""

import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest

from src.agents.prep_guide_agent import PrepGuideAgent
from src.models import PrepGuide
from src.utils.web_search import WebSearch
from tests.helpers import seed_application, authenticate_client


def test_rounds_explicit_jd_count_types_and_focus():
    result = PrepGuideAgent(search_client=Mock()).predict_rounds(
        "AI Engineer Intern. 3 rounds: technical, founder and HR. Python, LangChain and RAG.",
        company_stage="startup",
        listing_type="internship",
    )
    assert result["round_count"] == 3
    assert [r["type"] for r in result["rounds"]] == ["technical", "founder", "HR"]
    assert [r["number"] for r in result["rounds"]] == [1, 2, 3]
    assert "Python" in result["rounds"][0]["focus"]
    assert result["source"] == "explicit"


@pytest.mark.parametrize(
    "stage, expected_second", [("startup", "founder"), ("public", "HR")]
)
def test_rounds_internship_defaults_are_light_and_use_company_stage(
    stage, expected_second
):
    result = PrepGuideAgent(search_client=Mock()).predict_rounds(
        "Python Intern building FastAPI services.",
        company_stage=stage,
        listing_type="internship",
    )
    assert 1 <= result["round_count"] <= 2
    assert result["rounds"][1]["type"] == expected_second
    assert result["source"] == "estimated"
    assert "confirm" in result["note"].lower()


def test_rounds_career_page_process_overrides_default():
    result = PrepGuideAgent(search_client=Mock()).predict_rounds(
        "Python Engineer",
        listing_type="internship",
        career_page_text="Our interview process has four rounds: assessment, technical, manager and HR.",
    )
    assert result["round_count"] == 4
    assert [r["type"] for r in result["rounds"]] == [
        "assessment",
        "technical",
        "manager",
        "HR",
    ]


def test_rounds_job_guidance_has_production_depth():
    agent = PrepGuideAgent(search_client=Mock())
    intern = agent.predict_rounds("Python Docker", listing_type="internship")
    job = agent.predict_rounds("Python Docker", listing_type="job")
    assert job["round_count"] >= intern["round_count"]
    assert "production tradeoffs" in job["rounds"][0]["focus"]
    assert "production tradeoffs" not in intern["rounds"][0]["focus"]


def test_topics_exact_alias_partial_and_explicit_gaps():
    result = PrepGuideAgent(search_client=Mock()).analyze_topics(
        ["Python", "JS", "LangChain"],
        ["Python", "python", "JavaScript", "TypeScript", "RAG", "Docker", "SQL"],
        skill_gaps=["RAG"],
    )
    assert result == {
        "strong": ["Python", "JavaScript"],
        "moderate": ["TypeScript"],
        "gaps": ["RAG", "Docker", "SQL"],
    }


def test_topics_empty_profile_does_not_invent_expertise():
    agent = PrepGuideAgent(search_client=Mock())
    assert agent.analyze_topics([], ["Python", "Docker"]) == {
        "strong": [],
        "moderate": [],
        "gaps": ["Python", "Docker"],
    }
    assert agent.analyze_topics(["Python"], []) == {
        "strong": [],
        "moderate": [],
        "gaps": [],
    }


def test_resources_skip_broken_duplicates_and_search_alternatives():
    search = Mock()
    search.search.side_effect = [
        [
            {"title": "Docker broken tutorial", "url": "https://learn.example.com/broken"},
            {"title": "Docker Official docs", "url": "https://docs.example.com/start"},
            {"title": "Docker Duplicate docs", "url": "https://docs.example.com/start"},
        ],
        [
            {"title": "Docker Guide", "url": "https://learn.example.com/guide"},
            {"title": "Docker Video tutorial", "url": "https://video.example.com/tutorial"},
        ],
    ]
    search.accessible.side_effect = lambda url: not url.endswith("broken")
    agent = PrepGuideAgent(search_client=search)
    result = agent.find_resources(["Docker", "Docker"])
    assert [r["title"] for r in result["Docker"]] == ["Docker Official docs", "Docker Guide", "Docker Video tutorial"]
    assert len({r["url"] for r in result["Docker"]}) == 3
    assert search.search.call_count == 2
    assert all("Docker" in call.args[0] for call in search.search.call_args_list)
    assert agent.warnings == []


def test_resources_missing_search_credentials_return_explicit_warning():
    search = Mock()
    search.search.side_effect = RuntimeError(
        "Configure TAVILY_API_KEY or SERPAPI_API_KEY"
    )
    agent = PrepGuideAgent(search_client=search)
    assert agent.find_resources(["TypeScript"]) == {"TypeScript": []}
    assert any("search provider" in warning for warning in agent.warnings)
    assert any("Fewer than two" in warning for warning in agent.warnings)


def test_resources_search_adapter_tavily_passes_query_and_news_option():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "results": [{"title": "Docker docs", "url": "https://docs.docker.com/"}]
            },
        )

    settings = SimpleNamespace(tavily_api_key="tvly-unit-test", serpapi_api_key=None)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        search = WebSearch(settings=settings, client=client)
        results = search.search(
            "Docker official documentation", max_results=3, news=True
        )
    assert results[0]["url"] == "https://docs.docker.com/"
    assert str(requests[0].url) == "https://api.tavily.com/search"
    payload = json.loads(requests[0].content)
    assert payload["query"] == "Docker official documentation"
    assert payload["max_results"] == 3 and payload["topic"] == "news"


def test_resources_search_adapter_serpapi_normalizes_links_and_snippets():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "organic_results": [
                    {
                        "title": "TypeScript docs",
                        "link": "https://www.typescriptlang.org/docs/",
                        "snippet": "Official TypeScript handbook",
                    }
                ]
            },
        )

    settings = SimpleNamespace(tavily_api_key=None, serpapi_api_key="serp-unit-test")
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        results = WebSearch(settings=settings, client=client).search(
            "TypeScript docs", max_results=3
        )
    assert results[0]["url"] == "https://www.typescriptlang.org/docs/"
    assert results[0]["content"] == "Official TypeScript handbook"
    assert requests[0].url.params["q"] == "TypeScript docs"
    assert requests[0].url.params["num"] == "3"


def test_resources_accessibility_skips_broken_and_private_links():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(404 if request.url.path == "/broken" else 200)

    settings = SimpleNamespace(tavily_api_key=None, serpapi_api_key=None)
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        search = WebSearch(settings=settings, client=client)
        assert search.accessible("https://docs.example.com/broken") is False
        assert search.accessible("https://docs.example.com/guide") is True
        assert search.accessible("http://127.0.0.1/private") is False
        assert search.accessible("file:///etc/passwd") is False
    assert len(requests) == 2


@pytest.mark.parametrize(
    "destination",
    [
        "http://127.0.0.1/private",
        "http://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
    ],
)
def test_resources_redirect_to_private_destination_is_never_requested(destination):
    requests = []

    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(302, headers={"Location": destination})

    settings = SimpleNamespace(tavily_api_key=None, serpapi_api_key=None)
    with httpx.Client(
        transport=httpx.MockTransport(respond), follow_redirects=True
    ) as client:
        assert (
            WebSearch(settings=settings, client=client).accessible(
                "https://docs.example.com/redirect"
            )
            is False
        )
    assert requests == ["https://docs.example.com/redirect"]


def test_resources_public_relative_redirect_is_followed_safely():
    requests = []

    def respond(request):
        requests.append(str(request.url))
        if request.url.path == "/old":
            return httpx.Response(302, headers={"Location": "/new"})
        return httpx.Response(200)

    settings = SimpleNamespace(tavily_api_key=None, serpapi_api_key=None)
    with httpx.Client(
        transport=httpx.MockTransport(respond), follow_redirects=True
    ) as client:
        assert (
            WebSearch(settings=settings, client=client).accessible(
                "https://docs.example.com/old"
            )
            is True
        )
    assert requests == ["https://docs.example.com/old", "https://docs.example.com/new"]


def test_questions_are_jd_specific_and_cover_all_categories():
    questions = PrepGuideAgent(search_client=Mock()).generate_questions(
        "Agentic AI Intern must know LangChain, Python and multi-agent systems",
        "AIBridge",
        "internship",
    )
    assert {q["category"] for q in questions} == {"technical", "behavioral", "design"}
    assert all(q["evidence"]["quote"] for q in questions)
    assert any("AIBridge" in q["question"] for q in questions)
    technical = " ".join(
        q["question"] for q in questions if q["category"] == "technical"
    )
    assert (
        "Python" in technical
        and "LangChain" in technical
        and "multi-agent systems" in technical
    )


def test_questions_internship_is_lighter_than_same_job_stack():
    agent = PrepGuideAgent(search_client=Mock())
    jd = "Python LangChain RAG Docker to retrieve internal training notes and answer student questions."
    internship = agent.generate_questions(jd, "AIBridge", "internship")
    job = agent.generate_questions(jd, "AIBridge", "job")
    assert any("small prototype" in q["question"] for q in internship)
    assert any("scalable service" in q["question"] for q in job)
    assert any("production" in q["question"] for q in job)
    assert all("production" not in q["question"] for q in internship)


def test_questions_llm_receives_jd_company_and_level():
    llm = Mock()
    llm.extract.return_value = [
        {"category": "technical", "question": "How would Python retrieve library documents and validate an empty result?"},
        {"category": "technical", "question": "How would LangChain ground student questions in retrieved library documents?"},
        {"category": "behavioral", "question": "How would you clarify feedback that library documents do not answer student questions?"},
        {"category": "behavioral", "question": "What learning experiment would test how well student questions retrieve library documents?"},
        {"category": "design", "question": "Sketch a small RAG prototype that retrieves library documents for student questions."},
    ]
    agent = PrepGuideAgent(llm_client=llm, search_client=Mock())
    jd = "Intern building Python LangChain RAG to retrieve library documents and answer student questions"
    assert (
        [{"category": q["category"], "question": q["question"]} for q in agent.generate_questions(jd, "AIBridge", "internship")]
        == llm.extract.return_value
    )
    prompt = llm.extract.call_args.args[0]
    assert jd in prompt and "AIBridge" in prompt and "internship fundamentals" in prompt


@pytest.mark.parametrize(
    "response",
    [
        None,
        [],
        [{"category": "technical", "question": "Only one category"}],
        [{"category": "unknown", "question": "Invalid"}],
    ],
)
def test_questions_malformed_llm_falls_back_to_complete_guidance(response):
    llm = Mock(extract=Mock(return_value=response))
    result = PrepGuideAgent(llm_client=llm, search_client=Mock()).generate_questions(
        "Python RAG", "AIBridge", "internship"
    )
    assert {q["category"] for q in result} == {"technical", "behavioral", "design"}
    assert all(q["question"].strip() for q in result)


def test_generate_prep_guide_persists_and_updates_existing_guide(db_session):
    application = seed_application(db_session)
    search = Mock()
    agent = PrepGuideAgent(search_client=search)
    intel = {"stage": "seed", "tech_stack": ["Python"]}
    guide = agent.generate(
        application,
        db_session,
        company_stage="startup",
        company_intel=intel,
        discover_resources=False,
    )
    assert db_session.query(PrepGuide).count() == 1
    assert guide.company_intel == intel
    assert guide.structured_data["topics"]["strong"] == ["Python", "FastAPI"]
    assert "Docker" in guide.structured_data["topics"]["gaps"]
    assert json.loads(guide.content)["company_intel"] == intel
    search.search.assert_not_called()

    updated = agent.generate(application, db_session, discover_resources=False)
    assert updated.id == guide.id
    assert db_session.query(PrepGuide).count() == 1


def test_prep_guide_api_returns_every_section_and_company_context(
    api_client, db_session
):
    application = seed_application(db_session)
    authenticate_client(api_client, db_session, application.user_id)
    agent = PrepGuideAgent(search_client=Mock())
    intel = {"stage": "startup", "interview_summary": "No interview reviews found"}
    guide = agent.generate(
        application, db_session, company_intel=intel, discover_resources=False
    )
    response = api_client.get(f"/applications/{application.id}/prep-guide")
    assert response.status_code == 200
    data = response.json()
    assert set(data) >= {
        "rounds",
        "round_count",
        "topics",
        "resources",
        "questions",
        "company_intel",
        "company",
        "role",
    }
    assert data["company"] == "AIBridge" and data["role"] == "AI Engineer Intern"
    assert data["company_intel"] == intel
    assert data["topics"] == guide.structured_data["topics"]


def test_prep_guide_api_not_ready_or_missing_application(api_client, db_session):
    application = seed_application(db_session)
    authenticate_client(api_client, db_session, application.user_id)
    assert (
        api_client.get(f"/applications/{application.id}/prep-guide").status_code == 404
    )
    assert api_client.get("/applications/9999/prep-guide").status_code == 404
