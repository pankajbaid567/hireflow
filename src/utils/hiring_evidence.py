"""Bounded, allowlisted applicant declarations; no inferred proficiency."""
import csv
import io
import json
import math
from html import escape
from src.utils.skills import normalize_skill


def text(value, field, limit=2000, required=False):
    if value is None or value == "":
        if not required:
            return ""
        raise ValueError(f"{field} is required")
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 and c not in "\n\r\t" for c in value):
        raise ValueError(f"Invalid {field}")
    if required and not value.strip():
        raise ValueError(f"{field} is required")
    return value.strip()


def strings(value, field, limit=40):
    if value is None or value == "":
        return []
    if not isinstance(value, list) or len(value) > limit:
        raise ValueError(f"{field} must be a bounded list")
    return list(dict.fromkeys(text(v, field, 120, True) for v in value))


def facts(value, field):
    if value is None or value == "":
        return []
    if field == "education" and isinstance(value, str):
        return [{"degree": text(value, field)}]
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError(f"{field} must have at most eight objects")
    allowed = {"projects": ["name", "description", "url"], "experience": ["role", "company", "description", "start_date", "end_date"], "education": ["degree", "institution", "field", "graduation_year"]}[field]
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError(f"Invalid {field} fact")
        fact = {key: text(str(item[key]) if key == "graduation_year" else item[key], field) for key in allowed if item.get(key) is not None}
        if field != "education":
            fact["technologies"] = strings(item.get("technologies", item.get("skills")), field, 30)
        if not any(isinstance(v, str) and v for v in fact.values()):
            raise ValueError(f"Empty {field} fact")
        result.append(fact)
    return result


def normalize_applicants(value):
    if len(json.dumps(value, ensure_ascii=False).encode()) > 128 * 1024:
        raise ValueError("Applicant pool exceeds128KiB; split into smaller batches")
    if isinstance(value, str):
        reader = csv.DictReader(io.StringIO(value), strict=True)
        if not reader.fieldnames or "name" not in reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames):
            raise ValueError("CSV needs unique headers including name")
        try:
            value = list(reader)
        except csv.Error as error:
            raise ValueError("Malformed CSV") from error
        for item in value:
            if None in item or any(v is None for v in item.values()):
                raise ValueError("CSV row width differs from its header")
            item["skills"] = [s.strip() for s in item.get("skills", "").replace("|", ";").replace(",", ";").split(";") if s.strip()]
            for field in ["projects", "experience", "education", "target_roles", "preferred_locations"]:
                if item.get(field):
                    try:
                        item[field] = json.loads(item[field])
                    except ValueError as error:
                        raise ValueError(f"CSV {field} must contain JSON") from error
            if item.get("experience_years"):
                try:
                    item["experience_years"] = float(item["experience_years"])
                except ValueError as error:
                    raise ValueError("Invalid experience_years") from error
            else:
                item.pop("experience_years", None)
    if not isinstance(value, list) or len(value) > 200:
        raise ValueError("Provide at most200 applicants")
    result = []
    for item in value:
        if not isinstance(item, dict):
            raise ValueError("Each applicant must be an object")
        profile = {"name": text(item.get("name"), "name", 200, True), "skills": strings(item.get("skills"), "skills"), **{field: facts(item.get(field), field) for field in ["projects", "experience", "education"]}, "target_roles": strings(item.get("target_roles"), "target_roles", 10), "preferred_locations": strings(item.get("preferred_locations"), "preferred_locations", 10)}
        years = item.get("experience_years")
        if years is not None and years != "":
            if isinstance(years, bool) or not isinstance(years, (int, float)) or not math.isfinite(years) or not 0 <= years <= 60:
                raise ValueError("experience_years must be a number from0to60")
            profile["experience_years"] = years
        result.append(profile)
    return result


def skill_evidence(profile, index):
    evidence = [{"skill": s, "kind": "declared_skill", "source_path": f"applicants[{index}].skills[{n}]", "quote": s} for n, s in enumerate(profile["skills"])]
    for field in ["projects", "experience"]:
        for n, fact in enumerate(profile[field]):
            evidence += [{"skill": s, "kind": "explicit_technology", "source_path": f"applicants[{index}].{field}[{n}].technologies[{i}]", "quote": s} for i, s in enumerate(fact["technologies"])]
    return evidence


def match_evidence(skills, evidence):
    return [{"skill": s, "sources": [e for e in evidence if normalize_skill(e["skill"]) == normalize_skill(s)]} for s in skills]


def render_hiring_report(result):
    selected = {x["applicant_index"] for x in result.get("shortlist", [])}
    sections = []
    for item in result.get("candidates", result.get("shortlist", [])):
        sections.append(f"<article><h2>{escape(item['name'])} — {item['score']:.1%}</h2><p>{'Shortlisted for human review' if item['applicant_index'] in selected else 'Outside requested shortlist'}</p><p>Matches: {escape(', '.join(item['skill_matches']))}. Gaps: {escape(', '.join(item['skill_gaps']))}.</p><h3>Factors</h3><pre>{escape(json.dumps(item['factor_scores'], indent=2))}</pre><h3>Applicant facts</h3><pre>{escape(json.dumps(item.get('facts', {}), ensure_ascii=False, indent=2))}</pre><h3>Skill evidence</h3><pre>{escape(json.dumps(item.get('evidence', []), ensure_ascii=False, indent=2))}</pre><p>Applicant declarations do not verify proficiency or credentials.</p></article>")
    return "<!doctype html><html lang='en'><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>HireFlow hiring report</title><style>body{font:16px/1.6 system-ui;max-width:980px;margin:32px auto;padding:0 20px;color:#173d34}article{border-top:1px solid #cad8d0;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style><h1>Hiring shortlist</h1>" + f"<p>{escape(result['summary'])}</p><p>{escape(result.get('decision_policy', 'Legacy report: verify all facts.'))}</p><p>Generated {escape(result.get('created_at', 'not recorded'))}.</p>" + "".join(sections) + "</html>"
