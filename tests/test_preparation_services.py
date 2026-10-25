"""Exercise optional generation through normal API and confirmed-pipeline paths."""
from io import BytesIO
from unittest.mock import Mock

from pypdf import PdfReader
import pytest

from src.config.settings import Settings
from src.models import Application, ApplicationStatus, Job, ListingType, User, UserMode
from src.pipelines import preparation_services, application_pipeline
from src.utils.llm_client import LLMClientError
from tests.helpers import authenticate_client


@pytest.fixture
def preparation_settings(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, local_storage_path=str(tmp_path), semantic_matching_enabled=False,
                        python_llm_tailoring_enabled=False, python_llm_prep_enabled=False)
    monkeypatch.setattr(preparation_services, "get_settings", lambda: settings)
    monkeypatch.setattr(application_pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr("src.api.routes.resumes.get_settings", lambda: settings)
    return settings


@pytest.fixture
def candidate(db_session, api_client):
    user = User(name="Synthetic Preparation Student", email="preparation@example.com", mode=UserMode.internship, weekly_quota=1,
                master_profile={"skills": ["Python"], "summary": "Built a Python API. Wrote regression tests.", "projects": [{"name": "Source Project", "description": "Built a Python API.", "tech": ["Python"]}]})
    job = Job(title="Python Engineering Intern", company="Synthetic Company", listing_type=ListingType.internship,
              description="Build Python APIs with SQL queries. Debug failed HTTP requests. Write regression tests. Document interfaces. Two rounds: technical and HR.", url="https://example.com/jobs/preparation")
    application = Application(user=user, job=job, status=ApplicationStatus.pending, match_score=0.8)
    db_session.add(application); db_session.commit(); authenticate_client(api_client, db_session, user.id)
    return application


def test_factory_does_not_construct_models_merely_because_keys_exist(preparation_settings, monkeypatch):
    preparation_settings.groq_api_key = "synthetic-configured-key"
    provider = Mock(side_effect=AssertionError("No opt-in means no provider construction"))
    monkeypatch.setattr(preparation_services, "get_llm_client", provider)
    resume = preparation_services.build_resume_service()
    prep = preparation_services.build_prep_guide_agent(search_client=Mock())
    assert resume.llm_client is None and prep.llm_client is None
    provider.assert_not_called()


def test_normal_plan_route_uses_opted_in_provider_once_and_keeps_the_existing_pdf(
    api_client, db_session, candidate, preparation_settings, monkeypatch
):
    preparation_settings.python_llm_tailoring_enabled = True
    model = Mock(extract=Mock(return_value={"summary": "Built a Python API."}))
    monkeypatch.setattr(preparation_services, "get_llm_client", lambda settings: model)
    response = api_client.get(f"/weekly-plan/{candidate.user_id}")
    assert response.status_code == 200, response.text
    item = response.json()["plan"][0]
    assert item["resume_preparation"]["method"] == "llm_source_sentence_selection"
    assert candidate.job.description in model.extract.call_args.args[0]
    pdf = api_client.get(item["resume_url"])
    assert pdf.status_code == 200, pdf.text
    text = " ".join(page.extract_text() for page in PdfReader(BytesIO(pdf.content)).pages)
    assert "Synthetic Preparation Student" in text and "Built a Python API." in text
    assert "AWS" not in text and model.extract.call_count == 1
    repeated = api_client.get(f"/weekly-plan/{candidate.user_id}").json()["plan"][0]
    assert repeated["resume_version"] == item["resume_version"]
    assert repeated["resume_preparation"]["method"] == "existing_pdf"
    assert model.extract.call_count == 1


def test_default_normal_plan_is_grounded_without_model_calls(
    api_client, candidate, preparation_settings, monkeypatch
):
    monkeypatch.setattr(preparation_services, "get_llm_client", Mock(side_effect=AssertionError("disabled")))
    response = api_client.get(f"/weekly-plan/{candidate.user_id}")
    assert response.status_code == 200
    assert response.json()["plan"][0]["resume_preparation"]["method"] == "source_fact_ordering"


def test_missing_opted_in_provider_falls_back_with_visible_plan_and_guide_warnings(
    api_client, db_session, candidate, preparation_settings, monkeypatch
):
    preparation_settings.python_llm_tailoring_enabled = True
    preparation_settings.python_llm_prep_enabled = True
    monkeypatch.setattr(preparation_services, "get_llm_client", Mock(side_effect=LLMClientError("missing provider configuration")))
    response = api_client.get(f"/weekly-plan/{candidate.user_id}")
    assert response.status_code == 200 and "configured provider" in " ".join(response.json()["warnings"])
    agent = preparation_services.build_prep_guide_agent(search_client=Mock())
    guide = agent.generate(candidate, db_session, company_intel={}, discover_resources=False)
    assert "configured provider" in " ".join(guide.structured_data["warnings"])


def test_model_failure_does_not_log_private_prompt_or_return_invented_facts(
    api_client, candidate, preparation_settings, monkeypatch, caplog
):
    preparation_settings.python_llm_tailoring_enabled = True
    model = Mock(extract=Mock(side_effect=RuntimeError("synthetic-secret-and-private-prompt")))
    monkeypatch.setattr(preparation_services, "get_llm_client", lambda settings: model)
    response = api_client.get(f"/weekly-plan/{candidate.user_id}")
    assert response.status_code == 200
    assert "using source facts" in " ".join(response.json()["warnings"])
    assert "synthetic-secret-and-private-prompt" not in caplog.text
    assert "synthetic-secret-and-private-prompt" not in response.text


def test_normal_confirmation_pipeline_uses_opted_in_prep_factory(
    api_client, db_session, candidate, preparation_settings, monkeypatch
):
    preparation_settings.python_llm_prep_enabled = True
    model = Mock(extract=Mock(return_value=[]))
    monkeypatch.setattr(preparation_services, "get_llm_client", lambda settings: model)
    search = Mock(); search.search.return_value = []
    monkeypatch.setattr(application_pipeline, "WebSearch", Mock(return_value=search))
    monkeypatch.setattr(application_pipeline, "CompanyIntelAgent", Mock(return_value=Mock(research=Mock(return_value={"stage": "unknown"}))))
    browser = Mock(); monkeypatch.setattr(application_pipeline, "ApplicationAgent", Mock(return_value=browser))
    monkeypatch.setattr(application_pipeline, "ReportGenerator", Mock())
    preview = api_client.get(f"/weekly-plan/{candidate.user_id}")
    assert preview.status_code == 200
    response = api_client.post(f"/weekly-plan/{candidate.user_id}/confirm", json={"confirmed_job_ids": [candidate.job_id]})
    assert response.status_code == 200, response.text
    model.extract.assert_called_once()
    assert "Generate 5" in model.extract.call_args.args[0]
    assert candidate.job.description in model.extract.call_args.args[0]
    db_session.expire_all(); assert candidate.prep_guide is not None
    assert "JD-based guidance" in " ".join(candidate.prep_guide.structured_data["warnings"])
    browser.apply.assert_called_once(); search.close.assert_called_once()
