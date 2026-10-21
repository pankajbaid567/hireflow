"""Research company claims from attributable public search results."""

import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from src.utils.skills import extract_skills
from src.utils.web_search import WebSearch, public_url


class CompanyIntelAgent:
    def __init__(self, search_client=None):
        self.search = search_client or WebSearch()

    def research(self, company_name, company_url=None, *, db=None, application_id=None):
        warnings, sources, news, patterns = [], [], [], []

        def search(query, **kwargs):
            try:
                return self.search.search(query, **kwargs)
            except Exception as exc:
                warnings.append(str(exc))
                return []

        domain = (
            urlparse(company_url).hostname
            if company_url and public_url(company_url)
            else None
        )
        facts = search(
            f'{company_name} {"site:" + domain if domain else ""} company funding stage employees engineering technology'
        )
        for source in facts:
            if public_url(source.get("url")):
                sources.append(
                    {
                        "title": source.get("title", ""),
                        "url": source["url"],
                        "content": source.get("content", ""),
                    }
                )
        text = " ".join(s["content"] for s in sources)
        stage_match = re.search(
            r"\b(series\s+[a-f]|pre-seed|seed[ -](?:stage|funding)|publicly traded|bootstrapped|startup)\b",
            text,
            re.I,
        )
        team = re.search(
            r"\b([\d,]+(?:\s*[-–]\s*[\d,]+)?\+?)\s+(?:employees|team members|people)\b",
            text,
            re.I,
        )
        now = datetime.now(timezone.utc)
        for source in search(f"{company_name} company recent news", news=True):
            date_text = source.get("published_date") or source.get("date")
            try:
                published = datetime.fromisoformat(
                    str(date_text).replace("Z", "+00:00")
                )
                if published.tzinfo is None:
                    published = published.replace(tzinfo=timezone.utc)
            except (ValueError, TypeError):
                continue
            if now - timedelta(days=90) <= published <= now and public_url(
                source.get("url")
            ):
                news.append(
                    {
                        "title": source.get("title", ""),
                        "url": source["url"],
                        "published_at": published.isoformat(),
                    }
                )
        for site in ("glassdoor.com", "ambitionbox.com"):
            for source in search(
                f'site:{site} "{company_name}" interview experience rounds'
            ):
                host = urlparse(source.get("url", "")).hostname or ""
                if (
                    (host == site or host.endswith("." + site))
                    and source.get("content")
                    and company_name.casefold()
                    in (source.get("title", "") + source["content"]).casefold()
                ):
                    patterns.append(
                        {
                            "summary": source["content"],
                            "url": source["url"],
                            "source": site,
                            "note": "Candidate-reported search excerpt; experiences can differ by role.",
                        }
                    )
        result = {
            "company_name": company_name,
            "stage": stage_match.group() if stage_match else "Unknown",
            "estimated_team_size": team.group(1) if team else "Unknown",
            "tech_stack": extract_skills(text),
            "recent_news": news,
            "interview_patterns": patterns,
            "sources": sources,
            "interview_summary": (
                "Candidate-reported interview experiences found"
                if patterns
                else "No interview reviews found"
            ),
            "fallback_guidance": "Confirm interview stages with the recruiter; practice JD skills and prepare project examples.",
            "researched_at": now.isoformat(),
            "warnings": list(dict.fromkeys(warnings)),
        }
        if db is not None:
            from src.models.prep_guide import PrepGuide

            guide = db.query(PrepGuide).filter_by(application_id=application_id).first()
            if guide is None:
                guide = PrepGuide(application_id=application_id)
                db.add(guide)
            guide.company_intel = result
            guide.structured_data = {
                **(guide.structured_data or {}),
                "company_intel": result,
            }
            db.commit()
        return result
