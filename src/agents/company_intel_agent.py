"""Attributed company evidence; estimates and dated/undated reports stay distinct."""
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse, urljoin
from src.utils.skills import extract_skills
from src.utils.web_search import WebSearch, public_url
from src.utils.prep_quality import UNSAFE, words


def _matches(company, source):
    parts = words(company) - {"limited", "private", "technologies", "technology", "pvt", "ltd", "inc", "company"}
    source_words = words(source)
    return bool(parts) and parts <= source_words


def _date(value):
    if not isinstance(value, str) or not re.match(r"^\d{4}-\d{2}-\d{2}(T|$|\s)", value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        parsed = parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        return parsed if parsed <= datetime.now(timezone.utc) else None
    except ValueError:
        return None


class CompanyIntelAgent:
    def __init__(self, search_client=None):
        self.search = search_client or WebSearch()

    def research(self, company_name, company_url=None, *, db=None, application_id=None):
        now = datetime.now(timezone.utc)
        warnings, sources, news, patterns, careers = [], [], [], [], []
        claim_evidence = {"stage": [], "team_size": [], "tech_stack": []}
        result = {"company_name": company_name, "stage": "Unknown", "team_size": "Unknown", "estimated_team_size": "Unknown", "tech_stack": [], "recent_news": news, "interview_patterns": patterns, "sources": sources, "claim_evidence": claim_evidence, "career_sources": careers}
        cache = {}

        def search(query, **kwargs):
            try:
                values = self.search.search(query, max_results=6, **kwargs)
                return values[:6] if isinstance(values, list) else []
            except Exception:
                warnings.append("Company research source unavailable; missing evidence was not invented.")
                return []

        def page(url):
            if not public_url(url):
                return None
            if url in cache:
                return cache[url]
            try:
                reader = getattr(self.search, "read_page", None)
                value = reader(url) if callable(reader) else None
                if not isinstance(value, dict):
                    # Explicit injectable adapters may expose only accessibility.
                    value = {"url": url, "text": "", "body": ""} if self.search.accessible(url) is True else None
            except Exception:
                value = None
            cache[url] = value
            return value

        def source_record(source, content, kind):
            record = {"title": source.get("title", ""), "url": content["url"], "kind": kind, "checked_at": now.isoformat()}
            if not any(item["url"] == record["url"] and item["kind"] == kind for item in sources):
                sources.append(record)

        def facts(source, content, official=False):
            text = content.get("text", "").strip()
            snippet = source.get("content", "")[:2000]
            data, kind = (text, "public_page") if text else (snippet, "accessible_search_excerpt")
            if not _matches(company_name, text or source.get("title", "") + " " + snippet):
                return
            paragraphs, context = [], ""
            for line in re.split(r"\n+|(?<=[.!?])\s+", data):
                if _matches(company_name, line) or official and re.search(r"\b(we|our)\b", line, re.I):
                    paragraphs.append(line)
                    context = line
                elif context and re.match(r"^(it|we|our)\b", line.strip(), re.I):
                    context = context + " " + line
                    paragraphs.append(context)
                elif line.strip():
                    context = ""
            if not paragraphs and not text:
                paragraphs = [snippet]
            source_record(source, content, "company_page" if official else "company_report")
            for quote in paragraphs:
                if UNSAFE.search(quote) or re.search(r"\b(not|never|no longer|isn't|wasn't)\b", quote, re.I) or re.search(r"\b(customers?|clients?|supports?|serves?)\b[^.]{0,60}\b(series|employees|startup)", quote, re.I):
                    continue
                stage = re.search(r"\b(pre-seed|seed(?:[- ]stage)?|series [a-f]|bootstrapped|public(?:ly traded| company)|startup|enterprise)\b", quote, re.I)
                team = re.search(r"\b(?:has|with|employs|team of)\s+([\d,]+(?:\s*[-–]\s*[\d,]+)?\+?)\s+(?:employees|team members|people)\b", quote, re.I)
                def evidence(value):
                    return {"value": value, "url": content["url"], "quote": quote[:900], "kind": kind, "checked_at": now.isoformat()}
                if stage:
                    result["stage"] = stage.group()
                    claim_evidence["stage"].append(evidence(stage.group()))
                if team:
                    result["team_size"] = result["estimated_team_size"] = team.group(1)
                    claim_evidence["team_size"].append({**evidence(team.group(1)), "note": "Source-reported approximate headcount; not a current headcount guarantee."})
                if re.search(r"\b(uses?|builds?|building|built|stack|engineering|develops?)\b", quote, re.I):
                    for skill in extract_skills(quote):
                        if skill not in result["tech_stack"]:
                            result["tech_stack"].append(skill)
                        claim_evidence["tech_stack"].append(evidence(skill))
            if official and re.search(r"\b(interview|hiring process|selection process)\b", data, re.I):
                careers.append({"url": content["url"], "title": source.get("title", ""), "text": data[:10000], "kind": "accessible_career_evidence"})

        domain = urlparse(company_url).hostname if company_url and public_url(company_url) else None
        if domain:
            content = page(company_url)
            if content:
                facts({"title": company_name}, content, urlparse(content["url"]).hostname == domain)
            else:
                warnings.append("The supplied company page is inaccessible; its claims were not inferred.")
        for source in search(f'{company_name} {"site:" + domain if domain else ""} company funding stage employees engineering technology')[:2]:
            content = page(source.get("url", ""))
            if content:
                host = urlparse(content["url"]).hostname or ""
                official = bool(domain and (host == domain or host.endswith("." + domain)))
                facts(source, content, official)
                if official:
                    for link, label in re.findall(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>([^<]{1,100})</a>', content.get("body", ""), re.I):
                        if not re.search(r"careers?|hiring|interview", label, re.I):
                            continue
                        destination = urljoin(content["url"], link)
                        if public_url(destination) and urlparse(destination).hostname == host:
                            career = page(destination)
                            if career and _matches(company_name, career.get("text", "")):
                                facts({"title": f"{company_name} careers"}, career, True)
                        break
        for source in search(f"{company_name} company recent news", news=True)[:3]:
            published = _date(source.get("published_date") or source.get("date"))
            content = page(source.get("url", ""))
            if not content or not _matches(company_name, (content.get("text") or source.get("title", "") + " " + source.get("content", ""))):
                continue
            body_date = re.search(r'(?:datePublished|article:published_time)["\']?\s*(?:content=["\']|:\s*["\'])\s*([^"\'<>\s]+)', content.get("body", ""), re.I)
            actual_date = _date(body_date.group(1)) if body_date else None
            if body_date and actual_date is None:
                continue
            published = actual_date or published
            if published is None or published < now - timedelta(days=90):
                continue
            source_record(source, content, "dated_news")
            news.append({"title": source.get("title", ""), "url": content["url"], "summary": (source.get("content", "") if not content.get("text") or source.get("content", "").casefold() in content["text"].casefold() else content["text"])[:600], "published_at": published.isoformat(), "date_source": "source_page" if actual_date else "search_provider", "checked_at": now.isoformat()})
        for site in ("glassdoor.com", "ambitionbox.com"):
            for source in search(f'site:{site} "{company_name}" interview experience rounds')[:2]:
                url, host = source.get("url", ""), urlparse(source.get("url", "")).hostname or ""
                if not (host == site or host.endswith("." + site)):
                    continue
                content = page(url)
                if not content or not _matches(company_name, (content.get("text") or source.get("title", "") + " " + source.get("content", ""))):
                    continue
                snippet = source.get("content", "")
                summary = (snippet if not content.get("text") or snippet.casefold() in content["text"].casefold() else content["text"])[:600]
                if not summary or UNSAFE.search(summary):
                    continue
                published = _date(source.get("published_date") or source.get("date"))
                source_record(source, content, "candidate_report")
                patterns.append({"summary": summary, "url": content["url"], "source": site, "published_at": published.isoformat() if published else None, "date_status": "unknown" if published is None else "historical" if published < now - timedelta(days=90) else "within_90_days", "checked_at": now.isoformat(), "note": "Candidate-reported experience; role and process may differ. This does not confirm the current interview stages."})
        result.update({"interview_summary": "Candidate-reported interview experiences found" if patterns else "No interview reviews found", "interview_review_status": "Source-backed candidate reports; dates and role scope may be unknown" if patterns else "No interview reviews found", "fallback_guidance": "Confirm interview stages with the recruiter; practice JD skills and prepare project examples.", "researched_at": now.isoformat(), "warnings": list(dict.fromkeys(warnings))})
        if not sources:
            result["warnings"].append("No accessible company evidence found; unknown fields were not guessed.")
        if db is not None:
            from src.models.prep_guide import PrepGuide
            guide = db.query(PrepGuide).filter_by(application_id=application_id).first()
            if guide is None:
                guide = PrepGuide(application_id=application_id)
                db.add(guide)
            guide.company_intel = result
            guide.structured_data = {**(guide.structured_data or {}), "company_intel": result}
            db.commit()
        return result
