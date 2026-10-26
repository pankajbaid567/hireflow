"""Rank applicants with the same weighted scorer used for candidate matching."""

from datetime import datetime, timezone

from src.models.job import Job, ListingType
from src.models.shortlist import Shortlist
from src.pipelines.match_scorer import compute_match_score
from src.utils.hiring_evidence import normalize_applicants, skill_evidence, match_evidence


class HiringShortlistAgent:
    def shortlist(self, jd_text, applicants, shortlist_size=20, *, db=None, owner_id=None):
        if (
            not isinstance(jd_text, str) or not jd_text.strip() or len(jd_text)>30000
            or not isinstance(shortlist_size, int)
            or isinstance(shortlist_size, bool) or not 1 <= shortlist_size <= 200
        ):
            raise ValueError("Supply JD text and a positive shortlist_size")
        applicants = normalize_applicants(applicants)
        job = Job(
            title="",
            company="",
            description=jd_text,
            listing_type=(
                ListingType.internship
                if "intern" in jd_text.lower()
                else ListingType.job
            ),
        )
        ranked = []
        for index, applicant in enumerate(applicants):
            if (
                not isinstance(applicant, dict)
                or not isinstance(applicant.get("name"), str)
                or not applicant["name"].strip()
                or not isinstance(applicant.get("skills", []), list)
                or not all(isinstance(s, str) for s in applicant.get("skills", []))
            ):
                raise ValueError("Each applicant needs a name and a list of skills")
            evidence = skill_evidence(applicant, index)
            score = compute_match_score({**applicant, "skills": list(dict.fromkeys(item["skill"] for item in evidence))}, job)
            ranked.append(
                {
                    "name": applicant["name"],
                    "applicant_index": index,
                    "score": score["total_score"],
                    "skill_matches": score["skill_matches"],
                    "skill_gaps": score["skill_gaps"],
                    "factor_scores": score["factor_scores"],
                    "evidence": match_evidence(score["skill_matches"], evidence),
                    "facts": {"experience_years": applicant.get("experience_years"), **{field: applicant[field] for field in ["projects", "experience", "education"]}},
                    "review_notes": ["Applicant declarations do not verify proficiency or credentials."] + ([] if "experience_years" in applicant else ["Experience years were not supplied; verify before making a hiring decision."]),
                }
            )
        ranked.sort(key=lambda r: (-r["score"], r["applicant_index"]))
        selected = [r for r in ranked if r["skill_matches"]][:shortlist_size]
        result = {
            "shortlist": selected,
            "candidates": ranked,
            "schema_version": "hiring-evidence-v1",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "state": "completed",
            "decision_policy": "Decision support only. Scores are not hiring probabilities; a human must verify declarations before making a hiring decision. Protected and unrelated fields are excluded from scoring and storage; names are for display only.",
            "applicant_count": len(ranked),
            "shortlisted_count": len(selected),
            "summary": f"{len(selected)} matching candidates shortlisted from {len(ranked)} applicants",
        }
        if db is not None:
            row = Shortlist(
                user_id=owner_id, jd_text=jd_text, candidates=result, applicant_count=len(ranked)
            )
            db.add(row)
            db.commit()
            result["id"] = row.id
        return result
