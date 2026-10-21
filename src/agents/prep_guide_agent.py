"""JD-specific interview preparation with source-backed learning resources."""

import json
import re

from src.utils.skills import extract_skills, normalize_skill
from src.utils.web_search import WebSearch


class PrepGuideAgent:
    def __init__(self, llm_client=None, search_client=None):
        self.llm_client = llm_client
        self.search = search_client or WebSearch()
        self.warnings = []

    def predict_rounds(
        self, jd_text, company_stage="unknown", listing_type="job", career_page_text=""
    ):
        text = jd_text + "\n" + career_page_text
        mention = re.search(
            r"\b(\d{1,2}|one|two|three|four|five|six)\s*(?:interview\s+)?rounds?\b",
            text,
            re.I,
        )
        numbers = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
        # Only process context supplies round types, rather than arbitrary mentions of e.g. HR.
        process = " ".join(
            s
            for s in re.split(r"[.\n]", text)
            if re.search(r"round|interview|hiring process", s, re.I)
        )
        types = []
        for match in re.finditer(
            r"\b(technical|coding|hr|behavioral|founder|system design|manager|assessment)\b",
            process,
            re.I,
        ):
            name = {"hr": "HR", "coding": "technical"}.get(
                match.group().lower(), match.group().lower()
            )
            if name not in types:
                types.append(name)
        internship = listing_type == "internship"
        default_types = [
            "technical",
            (
                "founder"
                if company_stage.lower() in {"startup", "seed", "early-stage"}
                else "HR"
            ),
        ]
        count = (
            (
                int(mention.group(1))
                if mention.group(1).isdigit()
                else numbers[mention.group(1).lower()]
            )
            if mention
            else (len(types) or (2 if internship else 3))
        )
        count = max(1, min(count, 12))
        stack = extract_skills(jd_text)
        technical_focus = (
            ", ".join(stack[:5]) or "role fundamentals and problem solving"
        )
        if not internship:
            technical_focus += "; production tradeoffs and architecture"
        focus = {
            "technical": technical_focus,
            "assessment": technical_focus,
            "founder": "product understanding, ownership, and motivation",
            "HR": "motivation, teamwork, availability, and role expectations",
            "behavioral": "collaboration and examples from past projects",
            "system design": "service boundaries, scalability, and reliability",
            "manager": "project decisions, impact, and communication",
        }
        rounds = []
        for i in range(count):
            kind = (
                types[i]
                if i < len(types)
                else (default_types[i] if i < 2 else "system design")
            )
            rounds.append({"number": i + 1, "type": kind, "focus": focus[kind]})
        return {
            "round_count": count,
            "rounds": rounds,
            "source": "explicit" if mention or types else "estimated",
            "note": "Estimated preparation guidance; confirm the process with your recruiter.",
        }

    def analyze_topics(self, user_skills, jd_skills, skill_gaps=None):
        user = {normalize_skill(s) for s in user_skills}
        explicit_gaps = {normalize_skill(s) for s in (skill_gaps or [])}
        groups = [
            {"python", "fastapi", "django", "flask"},
            {"javascript", "typescript", "node.js"},
            {"docker", "kubernetes"},
            {"langchain", "langgraph", "rag", "multi-agent systems"},
            {"sql", "postgresql"},
        ]
        result = {"strong": [], "moderate": [], "gaps": []}
        seen = set()
        for skill in jd_skills:
            normalized = normalize_skill(skill)
            if normalized in seen:
                continue
            seen.add(normalized)
            if normalized in user:
                result["strong"].append(skill)
            elif normalized not in explicit_gaps and any(
                normalized in g and user & g for g in groups
            ):
                result["moderate"].append(skill)
            else:
                result["gaps"].append(skill)
        return result

    def find_resources(self, topics):
        resources = {}
        for topic in dict.fromkeys(topics):
            links, seen = [], set()
            for query in (
                f"{topic} official documentation tutorial beginner",
                f"{topic} tutorial course video learn",
            ):
                try:
                    results = self.search.search(query, max_results=8)
                except Exception as exc:
                    self.warnings.append(str(exc))
                    break
                for result in results:
                    url = result.get("url", "")
                    if url and url not in seen and self.search.accessible(url):
                        links.append(
                            {"title": result.get("title") or topic, "url": url}
                        )
                        seen.add(url)
                    if len(links) == 3:
                        break
                if len(links) == 3:
                    break
            if len(links) < 2:
                self.warnings.append(
                    f"Fewer than two accessible resources found for {topic}"
                )
            resources[topic] = links
        return resources

    def generate_questions(self, jd_text, company_name, listing_type="job"):
        internship = listing_type == "internship"
        skills = extract_skills(jd_text)[:5]
        context = ", ".join(skills) or jd_text[:160]
        requirement = re.sub(r"\s+", " ", jd_text).strip()[:320]
        if self.llm_client:
            try:
                result = self.llm_client.extract(
                    f"Generate a JSON list of 6 interview questions for {company_name}. "
                    f"JD: {jd_text}. Level: {'internship fundamentals' if internship else 'experienced production tradeoffs'}. "
                    "Each item has category (technical, behavioral, design) and question. Include all three categories."
                )
                if (
                    isinstance(result, list)
                    and result
                    and {q.get("category") for q in result if isinstance(q, dict)}
                    >= {"technical", "behavioral", "design"}
                    and all(
                        isinstance(q, dict)
                        and isinstance(q.get("question"), str)
                        and q["question"].strip()
                        and q.get("category") in {"technical", "behavioral", "design"}
                        for q in result
                    )
                ):
                    return result
            except Exception as exc:
                self.warnings.append(f"Question generation used local guidance: {exc}")
        questions = [
            {
                "category": "technical",
                "question": (
                    f"{company_name}'s JD says: '{requirement}'. Using {skill}, show a small example that addresses this requirement and explain how you would test it."
                    if internship
                    else f"{company_name}'s JD says: '{requirement}'. How would you use {skill} to meet this requirement in production and investigate performance or reliability failures?"
                ),
            }
            for skill in (skills or [context])
        ]
        questions += [
            {
                "category": "behavioral",
                "question": f"Describe a {'course or personal' if internship else 'production'} project using {context}. How did you handle feedback, and how does it prepare you for {company_name}?",
            },
            {
                "category": "design",
                "question": (
                    f"Sketch a small prototype using {context} for {company_name}'s requirement: '{requirement}'. Explain the data flow and one test."
                    if internship
                    else f"Design a scalable service at {company_name} using {context} for this JD requirement: '{requirement}'. Discuss failure recovery, monitoring, cost, and security tradeoffs."
                ),
            },
        ]
        return questions

    def generate(
        self,
        application,
        db,
        *,
        company_stage="unknown",
        company_intel=None,
        discover_resources=True,
    ):
        from src.models.prep_guide import PrepGuide

        user, job = application.user, application.job
        profile = user.master_profile or {}
        required = extract_skills(job.description or "", profile.get("skills", []))
        topics = self.analyze_topics(profile.get("skills", []), required)
        data = {
            **self.predict_rounds(
                job.description or "", company_stage, job.listing_type.value
            ),
            "topics": topics,
            "resources": (
                self.find_resources(topics["gaps"] + topics["moderate"])
                if discover_resources
                else {}
            ),
            "questions": self.generate_questions(
                job.description or "", job.company, job.listing_type.value
            ),
            "company_intel": company_intel or {},
            "warnings": list(dict.fromkeys(self.warnings)),
        }
        guide = application.prep_guide or PrepGuide(application_id=application.id)
        guide.structured_data, guide.company_intel = data, data["company_intel"]
        guide.content = json.dumps(data, ensure_ascii=False)
        db.add(guide)
        db.commit()
        return guide
