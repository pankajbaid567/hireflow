"""
Multi-Factor Match Scorer and Skill Gap Extractor

Scores non-spam job listings against a user profile using a weighted
combination of:
  - Skill Match:       40%
  - Role Fit:          20%
  - Experience Fit:    15%
  - Location Match:    10%
  - Stipend/Salary:    10%
  - Company Signal:     5%

Results are written to the applications table.
"""

import argparse
import json
import logging
import re
import math
from typing import Any

from src.config.database import SessionLocal
from src.models.application import Application, ApplicationStatus
from src.models.job import Job, ListingType
from src.models.user import User
from src.utils.skills import extract_skills, normalize_skill
from src.config.settings import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Weights (must sum to 1.0)
# ---------------------------------------------------------------------------
WEIGHTS = {
    "skill_match": 0.40,
    "role_fit": 0.20,
    "experience_fit": 0.15,
    "location_match": 0.10,
    "compensation_fit": 0.10,
    "company_signal": 0.05,
}

# Common experience-level keywords
SENIOR_KEYWORDS = {
    "senior",
    "lead",
    "principal",
    "staff",
    "architect",
    "director",
    "vp",
    "head",
}
JUNIOR_KEYWORDS = {
    "junior",
    "entry",
    "graduate",
    "fresher",
    "trainee",
    "intern",
    "apprentice",
    "associate",
}

# Internship-related compensation keywords
STIPEND_PATTERN = re.compile(
    r"(\d[\d,]*)\s*(k|lpa|lakh|lakhs|usd|inr|\/month|per month|monthly)?", re.IGNORECASE
)


# ---------------------------------------------------------------------------
# Sub-scorers
# ---------------------------------------------------------------------------


def _skill_match_score(
    profile: dict, jd_text: str, required_skills: list[str] | None = None
) -> tuple[float, list[str], list[str]]:
    """
    Returns (score 0-1, matched_skills, skill_gaps).
    Compares user skills against the JD text (case-insensitive substring match).
    """
    user_skills = {normalize_skill(s) for s in (profile.get("skills") or [])}
    required = list(
        dict.fromkeys(
            normalize_skill(s)
            for s in [*extract_skills(jd_text, profile.get("skills") or []),
                      *(value for value in (required_skills or []) if isinstance(value, str) and value.strip())]
        )
    )
    matched = [s for s in required if s in user_skills]
    gaps = [s for s in required if s not in user_skills]
    return len(matched) / len(required) if required else 0.0, matched, gaps


def _role_fit_score(profile: dict, job_title: str) -> float:
    """Score based on how well the job title aligns with user's target roles."""
    target_roles = [r.lower() for r in (profile.get("target_roles") or [])]
    title_lower = job_title.lower()

    if not target_roles:
        return 0.5  # neutral if no preference set

    title_words = set(re.findall(r"[\w+#]+", title_lower))
    return max((len(set(re.findall(r"[\w+#]+", role)) & title_words) / max(1, len(set(re.findall(r"[\w+#]+", role)))) for role in target_roles), default=0.)


def _experience_fit_score(profile: dict, jd_text: str, job_title: str) -> float:
    """
    Estimates experience fit.
    Freshers/interns score highly for junior/intern roles; poorly for senior roles.
    """
    from src.utils.listings import parse_experience, experience_fit
    years = max(0, float(profile.get("experience_years") or 0))
    required = parse_experience(jd_text)
    if required:
        return experience_fit(required, years)
    words = set(re.findall(r"\w+", job_title.lower()))
    if words & JUNIOR_KEYWORDS and years <= 2:
        return 1.
    return .2 if words & SENIOR_KEYWORDS and years < 2 else .5


def _location_match_score(profile: dict, job_location: str | None) -> float:
    """Score based on preferred locations."""
    preferred = [loc.lower() for loc in (profile.get("preferred_locations") or [])]
    job_loc = (job_location or "").lower()

    if not preferred or not job_loc:
        return 0.5  # neutral

    if "remote" in preferred and "remote" in job_loc:
        return 1.0
    if "remote" in job_loc:
        return 0.8  # remote is always acceptable even if not listed
    for loc in preferred:
        if loc in job_loc or job_loc in loc:
            return 1.0
    return 0.2


def _compensation_fit_score(
    profile: dict, jd_text: str, listing_type: ListingType
) -> float:
    """Compare only disclosed, compatible currency/period compensation."""
    from src.utils.listings import parse_compensation, compensation_fit
    kind = listing_type.value if hasattr(listing_type, "value") else listing_type
    return compensation_fit(parse_compensation(jd_text), profile, kind)


def _company_signal_score(profile: dict, company_name: str) -> float:
    """
    Neutral employer-name completeness only, never prestige or legitimacy.
    """
    if not company_name or not company_name.strip():
        return 0.0
    return 0.5


# ---------------------------------------------------------------------------
# Main scorer
# ---------------------------------------------------------------------------


def compute_match_score(profile: dict, job: "Job", *, semantic_score: float | None = None) -> dict[str, Any]:
    """
    Compute the weighted multi-factor match score between a profile and a job.

    Returns a dict with:
        - total_score (float 0-1)
        - factor_scores (dict)
        - skill_matches (list[str])
        - skill_gaps (list[str])
    """
    jd_text = job.description or ""
    job_title = job.title or ""

    required_skills = getattr(job, "required_skills", None)
    skill_score, skill_matches, skill_gaps = _skill_match_score(profile, f"{job_title} {jd_text}",
        required_skills if isinstance(required_skills, list) else None)
    role_score = _role_fit_score(profile, job_title)
    exp_score = _experience_fit_score(profile, jd_text, job_title)
    loc_score = _location_match_score(profile, job.location)
    comp_score = _compensation_fit_score(profile, jd_text, job.listing_type)
    required_experience = getattr(job, "required_experience", None)
    compensation = getattr(job, "compensation", None)
    if isinstance(required_experience, dict):
        from src.utils.listings import experience_fit
        exp_score = experience_fit(required_experience, max(0, float(profile.get("experience_years") or 0)))
    if isinstance(compensation, dict):
        from src.utils.listings import compensation_fit
        comp_score = compensation_fit(compensation, profile, getattr(job.listing_type, "value", job.listing_type))
    company_score = _company_signal_score(profile, job.company)

    lexical_technical = skill_score
    if semantic_score is not None and not math.isfinite(semantic_score):
        semantic_score = None
    if semantic_score is not None:
        # Six factor weights stay unchanged. Semantic context contributes only
        # 20% of the existing 40% technical factor, never new claimed skills.
        skill_score = 0.8 * skill_score + 0.2 * max(0.0, min(1.0, semantic_score))
    factor_scores = {
        "skill_match": round(skill_score, 4),
        "role_fit": round(role_score, 4),
        "experience_fit": round(exp_score, 4),
        "location_match": round(loc_score, 4),
        "compensation_fit": round(comp_score, 4),
        "company_signal": round(company_score, 4),
    }

    total = sum(WEIGHTS[k] * v for k, v in factor_scores.items())
    lexical_factors = {**factor_scores, "skill_match": round(lexical_technical, 4)}

    return {
        "total_score": round(total, 4),
        "lexical_score": round(sum(WEIGHTS[key] * value for key, value in lexical_factors.items()), 4),
        "semantic_score": round(semantic_score, 4) if semantic_score is not None else None,
        "matching_method": "hybrid" if semantic_score is not None else "lexical",
        "factor_scores": factor_scores,
        "skill_matches": skill_matches,
        "skill_gaps": skill_gaps,
    }


# ---------------------------------------------------------------------------
# Database runner
# ---------------------------------------------------------------------------


def score_jobs_for_user(user_id: int, dry_run: bool = False, db=None, semantic_pipeline=None) -> list[dict]:
    """
    Score all non-spam jobs for the given user and (optionally) persist results.

    Args:
        user_id: Database ID of the user.
        dry_run: If True, compute scores but do not write to DB.

    Returns:
        Sorted list of result dicts (highest score first).
    """
    owns_session = db is None
    db = db if db is not None else SessionLocal()
    try:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError(f"User {user_id} not found")

        profile = {**(user.master_profile or {}), "mode": user.mode.value}
        jobs = (
            db.query(Job)
            .filter(Job.is_spam.is_(False), Job.listing_type == user.mode.value)
            .all()
        )
        logger.info(f"Scoring {len(jobs)} non-spam jobs for user {user_id}")

        settings = get_settings()
        semantic, matching_state = {}, "disabled"
        if settings.semantic_matching_enabled and jobs:
            try:
                from src.pipelines.embedding_pipeline import EmbeddingPipeline, _fingerprint
                pipeline = semantic_pipeline or EmbeddingPipeline()
                # Bounded lexical candidate retrieval, then genuine FAISS
                # similarity. Empty/outage results do not pretend to be AI.
                pool = sorted(jobs, key=lambda job: (-compute_match_score(profile, job)["total_score"], job.id))[:200]
                semantic = pipeline.semantic_scores(profile, pool, user_id=user_id,
                    profile_version=_fingerprint(profile))
                matching_state = "ready" if semantic else "unavailable"
            except Exception:
                logger.warning("Semantic matching unavailable; retaining lexical scores")
                matching_state = "unavailable"
        results = []
        for job in jobs:
            score_data = compute_match_score(profile, job, semantic_score=semantic.get(job.id))
            results.append(
                {
                    "job_id": job.id,
                    "job_title": job.title,
                    "company": job.company,
                    "matching_state": matching_state,
                    "embedding_model": settings.embedding_model if job.id in semantic else None,
                    **score_data,
                }
            )

        # Sort by total_score descending and assign rank
        results.sort(key=lambda r: (-r["total_score"], r["job_id"]))
        for rank, result in enumerate(results, start=1):
            result["rank"] = rank

        if not dry_run:
            for result in results:
                # Upsert application record
                app = (
                    db.query(Application)
                    .filter(
                        Application.user_id == user_id,
                        Application.job_id == result["job_id"],
                    )
                    .first()
                )
                if app is None:
                    app = Application(
                        user_id=user_id,
                        job_id=result["job_id"],
                        status=ApplicationStatus.pending,
                    )
                    db.add(app)

                if app.status not in (ApplicationStatus.pending, ApplicationStatus.planned):
                    # Do not rewrite historical/submitted matching evidence.
                    continue

                app.match_score = result["total_score"]
                app.skill_gaps = {
                    "skill_matches": result["skill_matches"],
                    "skill_gaps": result["skill_gaps"],
                    "factor_scores": result["factor_scores"],
                    "rank": result["rank"],
                    "matching_method": result["matching_method"],
                    "matching_state": result["matching_state"],
                    "lexical_score": result["lexical_score"],
                    "semantic_score": result["semantic_score"],
                    "embedding_model": result["embedding_model"],
                }
            db.commit()
            logger.info(f"Saved {len(results)} application records for user {user_id}")

        return results
    finally:
        if owns_session:
            db.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description="HireFlow Multi-Factor Match Scorer")
    parser.add_argument(
        "--user-id", type=int, required=True, help="User ID to score jobs for"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Compute scores without writing to DB"
    )
    args = parser.parse_args()

    results = score_jobs_for_user(args.user_id, dry_run=args.dry_run)

    print(json.dumps(results, indent=2, default=str))
    print(
        f"\nScored {len(results)} jobs. Top match: {results[0]['job_title']} @ {results[0]['company']} "
        f"(score: {results[0]['total_score']})"
        if results
        else "\nNo jobs found."
    )


if __name__ == "__main__":
    main()
