"""
Tests for multi-factor match scorer.
All tests are deterministic and require no DB or network.
"""

import pytest
from unittest.mock import MagicMock

from src.models.job import Job, ListingType
from src.pipelines.match_scorer import (
    WEIGHTS,
    compute_match_score,
    _skill_match_score,
    _role_fit_score,
    _experience_fit_score,
    _location_match_score,
    _compensation_fit_score,
    _company_signal_score,
)

# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _make_job(
    title="Software Engineer",
    company="TestCo",
    location="Remote",
    description="Looking for Python and FastAPI skills.",
    listing_type=ListingType.job,
) -> MagicMock:
    job = MagicMock(spec=Job)
    job.title = title
    job.company = company
    job.location = location
    job.description = description
    job.listing_type = listing_type
    return job


# ---------------------------------------------------------------------------
# Weights sanity
# ---------------------------------------------------------------------------


class TestWeights:
    def test_weights_sum_to_one(self):
        assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# Skill Match
# ---------------------------------------------------------------------------


class TestSkillMatchScore:
    def test_all_skills_matched(self):
        profile = {"skills": ["python", "fastapi"]}
        score, matched, gaps = _skill_match_score(
            profile, "We use Python and FastAPI for our backend."
        )
        assert score == 1.0
        assert "python" in matched
        assert "fastapi" in matched

    def test_no_skills_matched(self):
        profile = {"skills": ["kotlin", "swift"]}
        score, matched, gaps = _skill_match_score(profile, "We use Python and FastAPI.")
        assert score == 0.0
        assert matched == []

    def test_partial_skill_match(self):
        profile = {"skills": ["python", "java", "go"]}
        score, matched, _ = _skill_match_score(
            profile, "Looking for Python and Docker experience."
        )
        assert 0.0 < score < 1.0
        assert "python" in matched
        assert "java" not in matched

    def test_empty_user_skills(self):
        profile = {"skills": []}
        score, matched, gaps = _skill_match_score(
            profile, "Python and FastAPI required."
        )
        assert score == 0.0
        assert matched == []


# ---------------------------------------------------------------------------
# Role Fit
# ---------------------------------------------------------------------------


class TestRoleFitScore:
    def test_exact_role_match(self):
        profile = {"target_roles": ["software engineer"]}
        score = _role_fit_score(profile, "Software Engineer")
        assert score > 0.8

    def test_no_role_match(self):
        profile = {"target_roles": ["data scientist"]}
        score = _role_fit_score(profile, "Frontend Designer")
        assert score == 0.0

    def test_no_target_roles_neutral(self):
        profile = {"target_roles": []}
        score = _role_fit_score(profile, "Anything")
        assert score == 0.5


# ---------------------------------------------------------------------------
# Experience Fit
# ---------------------------------------------------------------------------


class TestExperienceFitScore:
    def test_intern_profile_matches_intern_role(self):
        profile = {"mode": "internship", "experience": []}
        score = _experience_fit_score(
            profile, "Internship opportunity for students", "Software Intern"
        )
        assert score == 1.0

    def test_intern_profile_penalised_for_senior_role(self):
        profile = {"mode": "internship", "experience": []}
        score = _experience_fit_score(
            profile, "5+ years required", "Senior Software Engineer"
        )
        assert score <= 0.2

    def test_experienced_profile_matches_senior_role(self):
        profile = {"mode": "job", "experience_years": 8, "experience": ["job1", "job2", "job3", "job4"]}
        score = _experience_fit_score(
            profile, "8 years experience preferred", "Senior Backend Engineer"
        )
        assert score >= 0.8


# ---------------------------------------------------------------------------
# Location Match
# ---------------------------------------------------------------------------


class TestLocationMatchScore:
    def test_remote_matches_remote(self):
        profile = {"preferred_locations": ["remote"]}
        score = _location_match_score(profile, "Remote, USA")
        assert score == 1.0

    def test_city_match(self):
        profile = {"preferred_locations": ["bangalore"]}
        score = _location_match_score(profile, "Bangalore, India")
        assert score == 1.0

    def test_city_mismatch(self):
        profile = {"preferred_locations": ["bangalore"]}
        score = _location_match_score(profile, "New York, USA")
        assert score < 0.5

    def test_no_location_preference_neutral(self):
        profile = {"preferred_locations": []}
        score = _location_match_score(profile, "San Francisco")
        assert score == 0.5


# ---------------------------------------------------------------------------
# Compensation Fit
# ---------------------------------------------------------------------------


class TestCompensationFitScore:
    def test_internship_above_min_stipend(self):
        profile = {"min_stipend": 10000}
        score = _compensation_fit_score(
            profile, "Stipend: INR 15000 per month", ListingType.internship
        )
        assert score == 1.0

    def test_internship_below_min_stipend(self):
        profile = {"min_stipend": 50000}
        score = _compensation_fit_score(
            profile, "Stipend: INR 5000 per month", ListingType.internship
        )
        assert score <= 0.2

    def test_job_with_salary_mention(self):
        profile = {}
        score = _compensation_fit_score(
            profile, "Competitive salary offered, CTC 20 LPA", ListingType.job
        )
        # Without a candidate minimum, a pay mention is neutral rather than a
        # quality/fit bonus. Explicit compensation parsing is tested separately.
        assert score == 0.5


# ---------------------------------------------------------------------------
# Company Signal
# ---------------------------------------------------------------------------


class TestCompanySignalScore:
    def test_named_company_positive(self):
        score = _company_signal_score({}, "Google")
        assert score > 0.0

    def test_empty_company_zero(self):
        score = _company_signal_score({}, "")
        assert score == 0.0


# ---------------------------------------------------------------------------
# compute_match_score (end-to-end)
# ---------------------------------------------------------------------------


class TestComputeMatchScore:
    def test_score_is_between_0_and_1(self):
        profile = {
            "skills": ["python", "fastapi"],
            "target_roles": ["software engineer"],
            "mode": "job",
            "experience": ["job1"],
            "preferred_locations": ["remote"],
            "min_stipend": None,
        }
        job = _make_job()
        result = compute_match_score(profile, job)
        assert 0.0 <= result["total_score"] <= 1.0

    def test_score_is_deterministic(self):
        profile = {
            "skills": ["python"],
            "target_roles": ["backend engineer"],
            "mode": "job",
            "experience": ["job1", "job2"],
            "preferred_locations": ["bangalore"],
            "min_stipend": None,
        }
        job = _make_job(
            description="Python developer for backend services in Bangalore."
        )
        result1 = compute_match_score(profile, job)
        result2 = compute_match_score(profile, job)
        assert result1["total_score"] == result2["total_score"]

    def test_skill_gaps_are_populated(self):
        profile = {
            "skills": ["python", "kubernetes"],
            "target_roles": ["devops engineer"],
            "mode": "job",
            "experience": [],
            "preferred_locations": [],
            "min_stipend": None,
        }
        job = _make_job(
            description="We use Python, Docker, and Terraform for infrastructure."
        )
        result = compute_match_score(profile, job)
        # skill_matches: user skills found in JD (python)
        assert "python" in result["skill_matches"]
        # Gaps are JD requirements absent from the profile.
        assert "docker" in result["skill_gaps"]
        assert "terraform" in result["skill_gaps"]
        assert "kubernetes" not in result["skill_gaps"]

    def test_intern_profile_scores_high_on_intern_job(self):
        profile = {
            "skills": ["python"],
            "target_roles": ["software intern"],
            "mode": "internship",
            "experience": [],
            "preferred_locations": ["remote"],
            "min_stipend": 5000,
        }
        job = _make_job(
            title="Software Engineering Intern",
            description="Python intern role. Stipend: 10000 per month. Remote.",
            listing_type=ListingType.internship,
        )
        result = compute_match_score(profile, job)
        assert result["total_score"] >= 0.6

    def test_result_has_required_keys(self):
        result = compute_match_score({}, _make_job())
        assert "total_score" in result
        assert "factor_scores" in result
        assert "skill_matches" in result
        assert "skill_gaps" in result
        assert set(result["factor_scores"].keys()) == set(WEIGHTS.keys())
