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
from typing import Any

from src.config.database import SessionLocal
from src.models.application import Application, ApplicationStatus
from src.models.job import Job, ListingType
from src.models.user import User
from src.utils.skills import extract_skills, normalize_skill

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
    profile: dict, jd_text: str
) -> tuple[float, list[str], list[str]]:
    """
    Returns (score 0-1, matched_skills, skill_gaps).
    Compares user skills against the JD text (case-insensitive substring match).
    """
    user_skills = {normalize_skill(s) for s in (profile.get("skills") or [])}
    required = list(
        dict.fromkeys(
            normalize_skill(s)
            for s in extract_skills(jd_text, profile.get("skills") or [])
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

    for role in target_roles:
        # Exact substring match
        role_words = set(role.split())
        title_words = set(title_lower.split())
        overlap = role_words & title_words
        if overlap:
            return min(len(overlap) / len(role_words), 1.0)
    return 0.0


def _experience_fit_score(profile: dict, jd_text: str, job_title: str) -> float:
    """
    Estimates experience fit.
    Freshers/interns score highly for junior/intern roles; poorly for senior roles.
    """
    mode = profile.get("mode", "job")
    experience = profile.get("experience") or []
    years_exp = profile.get("experience_years") or len(experience)

    title_lower = job_title.lower()
    jd_lower = jd_text.lower()

    is_senior_role = any(k in title_lower or k in jd_lower for k in SENIOR_KEYWORDS)
    is_junior_role = any(k in title_lower or k in jd_lower for k in JUNIOR_KEYWORDS)

    if mode == "internship" or years_exp == 0:
        if is_junior_role:
            return 1.0
        if is_senior_role:
            return 0.1
        return 0.6  # neutral roles are acceptable for freshers

    # job mode with some experience
    if is_senior_role and years_exp >= 3:
        return 0.9
    if is_senior_role and years_exp < 2:
        return 0.3
    if is_junior_role and years_exp > 3:
        return 0.4  # overqualified
    return 0.7


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
    """Score compensation fit based on min_stipend (internship) or salary mention."""
    if listing_type == ListingType.internship:
        min_stipend = profile.get("min_stipend")
        if min_stipend is None:
            return 0.7  # no minimum set

        # Try to find stipend number in JD
        matches = STIPEND_PATTERN.findall(jd_text)
        amounts = [int(m[0].replace(",", "")) for m in matches if m[0]]
        if not amounts:
            return 0.5  # can't determine
        max_mentioned = max(amounts)
        if max_mentioned >= min_stipend:
            return 1.0
        elif max_mentioned >= min_stipend * 0.7:
            return 0.5
        return 0.1
    else:
        # For full jobs, a mention of salary/compensation is a positive signal
        comp_keywords = [
            "salary",
            "compensation",
            "ctc",
            "lpa",
            "per annum",
            "usd",
            "inr",
        ]
        if any(k in jd_text.lower() for k in comp_keywords):
            return 0.8
        return 0.5


def _company_signal_score(profile: dict, company_name: str) -> float:
    """
    Simple heuristic: well-known companies get a small boost.
    In production this would be a lookup against a company tier list.
    For now: non-empty company name = 0.7, empty = 0.0.
    """
    if not company_name or not company_name.strip():
        return 0.0
    return 0.7


# ---------------------------------------------------------------------------
# Main scorer
# ---------------------------------------------------------------------------


def compute_match_score(profile: dict, job: "Job") -> dict[str, Any]:
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

    skill_score, skill_matches, skill_gaps = _skill_match_score(profile, jd_text)
    role_score = _role_fit_score(profile, job_title)
    exp_score = _experience_fit_score(profile, jd_text, job_title)
    loc_score = _location_match_score(profile, job.location)
    comp_score = _compensation_fit_score(profile, jd_text, job.listing_type)
    company_score = _company_signal_score(profile, job.company)

    factor_scores = {
        "skill_match": round(skill_score, 4),
        "role_fit": round(role_score, 4),
        "experience_fit": round(exp_score, 4),
        "location_match": round(loc_score, 4),
        "compensation_fit": round(comp_score, 4),
        "company_signal": round(company_score, 4),
    }

    total = sum(WEIGHTS[k] * v for k, v in factor_scores.items())

    return {
        "total_score": round(total, 4),
        "factor_scores": factor_scores,
        "skill_matches": skill_matches,
        "skill_gaps": skill_gaps,
    }


# ---------------------------------------------------------------------------
# Database runner
# ---------------------------------------------------------------------------


def score_jobs_for_user(user_id: int, dry_run: bool = False, db=None) -> list[dict]:
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

        results = []
        for job in jobs:
            score_data = compute_match_score(profile, job)
            results.append(
                {
                    "job_id": job.id,
                    "job_title": job.title,
                    "company": job.company,
                    **score_data,
                }
            )

        # Sort by total_score descending and assign rank
        results.sort(key=lambda r: r["total_score"], reverse=True)
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

                app.match_score = result["total_score"]
                app.skill_gaps = {
                    "skill_matches": result["skill_matches"],
                    "skill_gaps": result["skill_gaps"],
                    "factor_scores": result["factor_scores"],
                    "rank": result["rank"],
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
