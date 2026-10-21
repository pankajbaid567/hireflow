"""Rank applicants with the same weighted scorer used for candidate matching."""

import csv
import io

from src.models.job import Job, ListingType
from src.models.shortlist import Shortlist
from src.pipelines.match_scorer import compute_match_score


class HiringShortlistAgent:
    def shortlist(self, jd_text, applicants, shortlist_size=20, *, db=None):
        if (
            not jd_text.strip()
            or not isinstance(shortlist_size, int)
            or shortlist_size < 1
        ):
            raise ValueError("Supply JD text and a positive shortlist_size")
        if isinstance(applicants, str):
            applicants = list(csv.DictReader(io.StringIO(applicants)))
            for applicant in applicants:
                applicant["skills"] = [
                    s.strip()
                    for s in applicant.get("skills", "").replace(";", ",").split(",")
                    if s.strip()
                ]
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
            score = compute_match_score(applicant, job)
            ranked.append(
                {
                    "name": applicant["name"],
                    "applicant_index": index,
                    "score": score["total_score"],
                    "skill_matches": score["skill_matches"],
                    "skill_gaps": score["skill_gaps"],
                    "factor_scores": score["factor_scores"],
                }
            )
        ranked.sort(key=lambda r: (-r["score"], r["applicant_index"]))
        selected = [r for r in ranked if r["skill_matches"]][:shortlist_size]
        result = {
            "shortlist": selected,
            "applicant_count": len(ranked),
            "shortlisted_count": len(selected),
            "summary": f"{len(selected)} matching candidates shortlisted from {len(ranked)} applicants",
        }
        if db is not None:
            row = Shortlist(
                jd_text=jd_text, candidates=result, applicant_count=len(ranked)
            )
            db.add(row)
            db.commit()
            result["id"] = row.id
        return result
