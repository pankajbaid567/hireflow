"""Actual FAISS/cache/normal scorer integration, with deterministic fixture vectors."""
from types import SimpleNamespace
from unittest.mock import Mock
import json
import numpy as np
import pytest

from src.models import User, Job, ListingType, Application, ApplicationStatus
from src.pipelines.embedding_pipeline import EmbeddingPipeline, profile_embedding_text
from src.pipelines.match_scorer import compute_match_score, score_jobs_for_user, WEIGHTS


def jobs():
    return [SimpleNamespace(id=1, title="Python Engineer", company="Synthetic A", location="Remote", description="Python indexing for a college library", listing_type=ListingType.job),
            SimpleNamespace(id=2, title="Python Engineer", company="Synthetic B", location="Remote", description="Python experiments for crop research", listing_type=ListingType.job)]


def fixture_model():
    model = Mock()
    model.encode.side_effect = lambda texts, **kwargs: np.array([[1, 0], [1, 0], [0, 1]][:len(texts)], dtype=np.float32)
    return model


def test_private_versioned_cache_and_real_faiss(tmp_path):
    model = fixture_model(); pipeline = EmbeddingPipeline(model=model)
    profile = {"skills": ["Python"], "summary": "Built a college library indexer."}
    result = pipeline.semantic_scores(profile, jobs(), user_id=7, profile_version="1", cache_root=tmp_path)
    assert result == {1: 1.0, 2: 0.0}
    assert pipeline.semantic_scores(profile, jobs(), user_id=7, profile_version="1", cache_root=tmp_path) == result
    assert model.encode.call_count == 1
    pipeline.semantic_scores(profile, jobs(), user_id=7, profile_version="2", cache_root=tmp_path)
    assert model.encode.call_count == 2
    changed = jobs(); changed[1].description += " Changed requirement."
    pipeline.semantic_scores(profile, changed, user_id=7, profile_version="2", cache_root=tmp_path)
    assert model.encode.call_count == 3
    pipeline.semantic_scores(profile, jobs(), user_id=8, profile_version="1", cache_root=tmp_path)
    assert model.encode.call_count == 4
    manifests = list(tmp_path.glob("owners/*/*.json"))
    assert len(manifests) == 4
    assert all((path.stat().st_mode & 0o777) == 0o600 for path in manifests)
    assert all("profile" not in json.loads(path.read_text()) for path in manifests)


def test_hybrid_keeps_six_weights_and_exact_skill_explanations():
    profile = {"skills": ["Python"], "target_roles": ["Python Engineer"]}
    lexical = compute_match_score(profile, jobs()[0])
    hybrid = compute_match_score(profile, jobs()[0], semantic_score=.5)
    assert set(hybrid["factor_scores"]) == set(WEIGHTS)
    assert abs(sum(WEIGHTS.values()) - 1) < 1e-9
    assert hybrid["skill_matches"] == lexical["skill_matches"]
    assert hybrid["skill_gaps"] == lexical["skill_gaps"]
    assert hybrid["total_score"] == pytest.approx(lexical["total_score"] - .04)


def test_normal_scorer_calls_real_faiss_helper_and_persists_provenance(db_session, tmp_path, monkeypatch):
    profile = {"skills": ["Python"], "summary": "Built a library indexer."}
    owner = User(name="Synthetic", email="semantic-integration@example.com", master_profile=profile, mode="job")
    db_session.add(owner); db_session.flush()
    for row in jobs():
        db_session.add(Job(id=row.id, title=row.title, company=row.company, location=row.location, description=row.description, url=f"https://example.com/jobs/{row.id}", listing_type=row.listing_type))
    db_session.commit()
    from src.config.settings import Settings
    settings = Settings(semantic_matching_enabled=True, faiss_index_path=str(tmp_path), _env_file=None)
    monkeypatch.setattr("src.pipelines.match_scorer.get_settings", lambda: settings)
    model = fixture_model(); pipeline = EmbeddingPipeline(model=model); pipeline.settings = settings
    results = score_jobs_for_user(owner.id, db=db_session, semantic_pipeline=pipeline)
    assert [item["job_id"] for item in results] == [1, 2]
    assert all(item["matching_method"] == "hybrid" for item in results)
    assert model.encode.call_count == 1
    stored = db_session.query(Application).filter_by(user_id=owner.id, job_id=1).one()
    assert stored.skill_gaps["matching_method"] == "hybrid"
    assert stored.skill_gaps["semantic_score"] == 1
    stored.status = ApplicationStatus.applied; stored.match_score = .123; db_session.commit()
    score_jobs_for_user(owner.id, db=db_session, semantic_pipeline=pipeline)
    db_session.refresh(stored)
    assert stored.match_score == .123


def test_outage_stays_lexical_without_claiming_ai(db_session, monkeypatch):
    owner = User(name="Synthetic", email="semantic-outage@example.com", master_profile={"skills": ["Python"]}, mode="job")
    db_session.add(owner); db_session.add(Job(title="Python Engineer", company="Synthetic", description="Python", url="https://example.com/jobs/outage", listing_type=ListingType.job)); db_session.commit()
    settings = SimpleNamespace(semantic_matching_enabled=True, embedding_model="fixture-model")
    monkeypatch.setattr("src.pipelines.match_scorer.get_settings", lambda: settings)
    pipeline = Mock(); pipeline.semantic_scores.side_effect = RuntimeError("private provider message")
    result = score_jobs_for_user(owner.id, db=db_session, semantic_pipeline=pipeline)
    assert result[0]["matching_method"] == "lexical"
    assert result[0]["matching_state"] == "unavailable"
    assert result[0]["embedding_model"] is None


def test_embedding_text_excludes_contact_identity():
    text = profile_embedding_text({"name": "Private", "email": "secret@example.com", "skills": ["Python"], "summary": "Built APIs. secret@example.com +91 9999999999 https://example.com/private"})
    assert "Python" in text
    assert "secret@" not in text and "9999999999" not in text and "https://" not in text


def test_missing_currency_and_job_count_do_not_turn_into_factual_fit():
    from src.pipelines.match_scorer import _compensation_fit_score, _experience_fit_score
    assert _compensation_fit_score({"min_stipend": 10000}, "Stipend: 15000 per month", ListingType.internship) == .5
    assert _experience_fit_score({"experience": ["one", "two", "three"]}, "3 years experience required", "Backend Engineer") <= .1


def test_invalid_semantic_values_keep_lexical_evidence():
    profile = {"skills": ["Python"]}
    assert compute_match_score(profile, jobs()[0], semantic_score=float("nan")) == compute_match_score(profile, jobs()[0])


def test_explicit_required_skills_remain_gaps_even_when_not_in_the_small_vocabulary():
    row = jobs()[0]; row.required_skills = ["Python", "A Synthetic Framework"]
    result = compute_match_score({"skills": ["Python"]}, row, semantic_score=1)
    assert "a synthetic framework" in result["skill_gaps"]
    assert "a synthetic framework" not in result["skill_matches"]
