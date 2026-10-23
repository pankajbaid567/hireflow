"""Listing facts with explicit evidence; no implicit currencies or years-as-pay."""
from __future__ import annotations

from datetime import datetime, timezone
import re
import unicodedata
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

from src.utils.skills import extract_skills

SCHEMA_VERSION = "listing-v1"


def company_key(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "").casefold().replace(".", "").replace("&", " and ")
    value = re.sub(r"\bpvtltd\b", "pvt ltd", value)
    value = " ".join(re.sub(r"[^\w]+", " ", value).replace("_", " ").split())
    for _ in range(3):
        value = re.sub(r"(?:\s+|^)(?:(?:private|pvt)\s+(?:limited|ltd)|pvt|limited|ltd|incorporated|inc|llc|llp|corp(?:oration)?|co|company)$", "", value).strip()
    return value


def canonical_url(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("Use a public HTTP(S) listing URL")
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not re.match(r"^(utm_.+|fbclid|gclid|trackingid)$", k, re.I)]
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/") or "/", urlencode(sorted(query)), ""))


def source_name(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    for suffix, name in (("internshala.com", "Internshala"), ("wellfound.com", "Wellfound"), ("linkedin.com", "LinkedIn"), ("naukri.com", "Naukri"), ("greenhouse.io", "Greenhouse"), ("lever.co", "Lever"), ("ashbyhq.com", "Ashby")):
        if host == suffix or host.endswith("." + suffix):
            return name
    return host or "unknown"


def _amount(value):
    try:
        number = float(str(value).replace(",", ""))
        return number if 0 <= number <= 1e10 else None
    except (ValueError, TypeError):
        return None


def _period(value):
    value = str(value or "").lower()
    return "year" if value in {"year", "yearly", "annual", "annum", "p.a."} else "month" if value in {"month", "monthly", "mo"} else "hour" if value in {"hour", "hourly", "hr"} else "day" if value in {"day", "daily"} else None


def _pay(currency, period, minimum, maximum, evidence, source):
    if minimum is not None and maximum is not None and minimum > maximum:
        minimum, maximum = maximum, minimum
    def convert(n, multiplier):
        return None if n is None else round(n * multiplier, 2)
    return dict(currency=currency, period=period, minimum=minimum, maximum=maximum,
                annual_minimum=minimum if period == "year" else convert(minimum, 12) if period == "month" else None,
                annual_maximum=maximum if period == "year" else convert(maximum, 12) if period == "month" else None,
                monthly_minimum=minimum if period == "month" else convert(minimum, 1 / 12) if period == "year" else None,
                monthly_maximum=maximum if period == "month" else convert(maximum, 1 / 12) if period == "year" else None,
                disclosed=minimum is not None or maximum is not None, evidence=evidence, source=source)


_MONEY = re.compile(r"(₹|\bINR\b|\bRs\.?|US\$|\bUSD\b|\$|\bEUR\b|€|\bGBP\b|£)\s*([\d,]+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|crores?|k|million)?(?:\s*(?:-|–|—|to)\s*(?:₹|INR|Rs\.?|US\$|USD|\$|EUR|€|GBP|£)?\s*([\d,]+(?:\.\d+)?)\s*(lpa|lakhs?|lacs?|crores?|k|million)?)?|\b([\d.]+)(?:\s*(?:-|–|to)\s*([\d.]+))?\s*(LPA)\b", re.I)


def parse_compensation(description: str, structured: dict | None = None):
    if isinstance(structured, dict):
        value = structured.get("value") if isinstance(structured.get("value"), dict) else structured
        minimum = _amount(value.get("minValue", value.get("min", value.get("value", structured.get("value")))))
        maximum = _amount(value.get("maxValue", value.get("max", value.get("value", structured.get("value")))))
        if minimum is not None or maximum is not None:
            return _pay(str(structured.get("currency") or value.get("currency") or "").upper() or None, _period(value.get("unitText") or value.get("interval") or structured.get("interval")), minimum, maximum, str(structured)[:500], "structured")
    text = (description or "")[:30000]
    def scale(unit):
        unit = (unit or "").lower()
        return 1e7 if unit.startswith("crore") else 1e5 if unit.startswith(("lpa", "lakh", "lac")) else 1e3 if unit == "k" else 1e6 if unit == "million" else 1
    for match in _MONEY.finditer(text):
        currency, lower, lower_unit, upper, upper_unit, lpa_lower, lpa_upper, lpa = match.groups()
        prefix, tail = text[max(0, match.start() - 100):match.start()], text[match.end():match.end() + 50]
        anchors = list(re.finditer(r"\b(salary|stipend|ctc|compensation|pay|package|remuneration)\b", prefix, re.I))
        costs = list(re.finditer(r"\b(budget|funding|revenue|fees?|deposit|investment)\b", prefix, re.I))
        if (costs and (not anchors or costs[-1].start() > anchors[-1].start())) or (not lpa and not anchors):
            continue
        currency = "INR" if lpa or re.match(r"^(₹|inr|rs\.?)", currency, re.I) else "USD" if re.match(r"^(US\$|usd|\$)$", currency, re.I) else "EUR" if re.match(r"^(eur|€)$", currency, re.I) else "GBP"
        unit = upper_unit or lower_unit or lpa or ""
        minimum, maximum = _amount(lpa_lower or lower), _amount(lpa_upper or upper or lpa_lower or lower)
        period = "year" if unit.lower() == "lpa" or re.match(r"^\s*(?:/|per\s*)?\s*(?:annum|annual(?:ly)?|year(?:ly)?|p\.a\.)", tail, re.I) else "month" if re.match(r"^\s*(?:/|per\s*)?\s*(?:month(?:ly)?|mo\b)", tail, re.I) else "hour" if re.match(r"^\s*(?:/|per\s*)?\s*(?:hour(?:ly)?|hr\b)", tail, re.I) else None
        return _pay(currency, period, None if minimum is None else minimum * scale(lower_unit or unit), None if maximum is None else maximum * scale(unit), text[max(0, match.start() - 35):match.end() + 45].strip(), "jd_text")
    unpaid = re.search(r"\bunpaid\s+(?:internship|role|position)\b|\b(?:stipend|salary|pay)\s*:\s*(?:none|unpaid|0)\b", text, re.I)
    if unpaid and not re.search(r"\b(?:no|not)\s+$", text[max(0, unpaid.start() - 8):unpaid.start()], re.I):
        return _pay(None, None, 0, 0, unpaid[0], "explicit_unpaid")
    return _pay(None, None, None, None, None, "not_disclosed")


def compensation_fit(compensation: dict, profile: dict, listing_type: str) -> float:
    minimum = _amount(profile.get("min_stipend" if listing_type == "internship" else "min_salary"))
    if not minimum:
        return .5
    if compensation.get("source") == "explicit_unpaid":
        return .1
    if compensation.get("currency") != "INR":
        return .5
    lower, upper = (compensation.get("monthly_minimum"), compensation.get("monthly_maximum")) if listing_type == "internship" else (compensation.get("annual_minimum"), compensation.get("annual_maximum"))
    if lower is None and upper is None:
        return .5
    if lower is not None and lower >= minimum:
        return 1.
    if upper is not None and upper >= minimum:
        return .7
    return .4 if (upper if upper is not None else lower) >= minimum * .7 else .1


def parse_experience(description: str):
    text = (description or "")[:30000]
    match = re.search(r"\b(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(\+)?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:(?:relevant|professional|industry|hands[- ]on)\s+)?(?:experience|exp\b)", text, re.I) or re.search(r"\b(?:experience|exp)\s*(?:required)?\s*[:=-]?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(\+)?\s*(?:years?|yrs?)\b", text, re.I)
    if match:
        lower, upper = float(match[1]), float(match[2]) if match[2] else None
        if lower <= 50 and (upper is None or lower <= upper <= 50):
            return dict(minimum_years=lower, maximum_years=upper, evidence=match[0], source="jd_text")
    match = re.search(r"\b(?:freshers?(?:\s+(?:are\s+)?welcome)?|no (?:prior |professional )?experience (?:is )?required)\b", text, re.I)
    return dict(minimum_years=0, maximum_years=None, evidence=match[0], source="jd_text") if match else None


def experience_fit(required: dict | None, years: float) -> float:
    if not required:
        return .5
    if years < required["minimum_years"]:
        return max(.05, years / max(required["minimum_years"], 1))
    maximum = required.get("maximum_years")
    return max(.3, 1 - (years - maximum) * .1) if maximum is not None and years > maximum else 1.


def listing_quality(description: str, company: str, skills: list):
    text = (description or "")[:30000]
    pattern = r"\b(?:pay|deposit|transfer)\b.{0,60}\b(?:registration|processing|training|security)\s*(?:fee|deposit)|\b(?:registration|processing)\s*fee\b.{0,35}\b(?:required|mandatory|payable)\b"
    matches = [m for m in re.finditer(pattern, text, re.I) if not re.search(r"(?:\bno\b|\bnever\b|\bwithout\b|do not|don't)", text[max(0, m.start() - 18):m.start()], re.I)]
    risk = .95 if matches else .8 if not company.strip() else .45 if len(text) < 100 and not skills else .05
    reasons = ["Listing requests an upfront recruitment fee or deposit."] if matches else ["Employer name is missing."] if not company.strip() else ["Description is sparse and has no identifiable role skills."] if risk == .45 else ["No configured fee/sparsity risk rule matched; employer legitimacy is not independently verified."]
    return dict(spam_confidence=risk, is_spam=risk >= .8, quality_reason=" ".join(reasons), quality_method="evidence_rules_v1")


def listing_fields(data: dict, structured: dict | None = None) -> dict:
    description = str(data.get("description") or "")
    try:
        url = canonical_url(data["url"])
    except ValueError:
        url = None  # Local fixture/model rows are not verified public listings.
    structured = structured or {}
    source_text = str(data.get("title") or "") + " " + description
    supplied = data.get("required_skills") or []
    skills = list(dict.fromkeys(extract_skills(source_text) + [item.strip() for item in supplied[:50] if isinstance(item, str) and 0 < len(item.strip()) <= 80 and item.casefold() in source_text.casefold()]))
    expiry = data.get("expires_at") or structured.get("validThrough")
    if isinstance(expiry, str):
        try:
            expiry = datetime.fromisoformat(expiry.replace("Z", "+00:00"))
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data.get("expires_at") or structured.get("validThrough"))):
                expiry = expiry.replace(hour=23, minute=59, second=59, microsecond=999999)
        except ValueError:
            expiry = None
    provenance = dict(data.get("provenance") or {})
    provenance.update(schema_version=SCHEMA_VERSION)
    provenance.setdefault("kind", "provided")
    provenance.setdefault("url", url)
    provenance["fields"] = dict(required_skills="explicit_skill_mentions", required_experience="explicit_experience_text", selection_process="verbatim_jd_sentences", compensation="structured" if structured.get("baseSalary") else "jd_text", posting_date="source_reported" if data.get("posted_date") else "unknown", expiry_date="source_reported" if expiry else "unknown")
    return dict(canonical_url=url, application_url=canonical_url(data.get("application_url") or url) if url else None, source=source_name(url or ""), company_key=company_key(data.get("company") or ""), required_skills=skills, required_experience=parse_experience(description), expires_at=expiry, selection_process=[line.strip()[:500] for line in re.split(r"\n|(?<=[.!?])\s+", description) if re.search(r"\b(interview|selection (?:process|round)|technical round|hr round|coding (?:round|test|assessment))\b", line, re.I)][:8], compensation=data["compensation"] if isinstance(data.get("compensation"), dict) and data["compensation"].get("source") == "structured" else parse_compensation(description, structured.get("baseSalary") or data.get("structured_compensation")), provenance=provenance, **listing_quality(description, data.get("company") or "", skills))


def enrich_job(job, structured: dict | None = None):
    if structured:
        from bs4 import BeautifulSoup
        if not job.description and structured.get("description"):
            job.description = BeautifulSoup(str(structured["description"]), "lxml").get_text("\n", strip=True)[:30000]
        if not job.posted_date and structured.get("datePosted"):
            try:
                job.posted_date = datetime.fromisoformat(str(structured["datePosted"]).replace("Z", "+00:00"))
            except ValueError:
                pass
        declared = structured.get("skills") or []
        if isinstance(declared, str):
            declared = re.split(r"[,;|\n]", declared)
        declared = [value.strip() for value in declared[:50] if isinstance(value, str) and 0 < len(value.strip()) <= 80]
        if declared:
            job.description = (job.description or "") + "\nSkills stated in metadata: " + ", ".join(declared)
            job.required_skills = declared
    data = {key: getattr(job, key, None) for key in ("title", "company", "url", "description", "posted_date", "application_url", "provenance", "expires_at", "required_skills", "compensation")}
    for key, value in listing_fields(data, structured).items():
        if key == "is_spam" and getattr(job, "is_spam", False):
            continue
        setattr(job, key, value)
    return job


def company_aliases(value: str, profile: dict | None = None) -> set[str]:
    target = company_key(value)
    keys = {target} if target else set()
    aliases = (profile or {}).get("company_aliases")
    if isinstance(aliases, dict):
        for name, values in list(aliases.items())[:50]:
            if not isinstance(values, list):
                continue
            group = {company_key(str(name)), *(company_key(item) for item in values[:10] if isinstance(item, str) and len(item) <= 300)}
            if target in group:
                keys.update(group - {""})
    return keys
