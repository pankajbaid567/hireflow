"""Deterministic interview prompts grounded in actual JD/profile evidence."""
import re
from src.utils.skills import extract_skills, normalize_skill, has_skill

PREP_VERSION = "prep-evidence-v2"
STOP = set("a an the to of and or for with in on at by as is are be we our you your this that using use must know required requirement role work job company intern internship engineer developer".split())
UNSAFE = re.compile(r"\b(ignore (all |the |any )?(previous|prior|system)|system prompt|api[_ -]?key|reveal (the |your )?secret)\b", re.I)
RELATED = {
    "fastapi": {"python", "flask", "django"}, "django": {"python", "flask", "fastapi"}, "flask": {"python", "fastapi", "django"},
    "typescript": {"javascript"}, "javascript": {"typescript"}, "node.js": {"javascript", "typescript"},
    "kubernetes": {"docker"}, "docker": {"kubernetes"}, "langgraph": {"langchain"}, "multi-agent systems": {"langgraph", "langchain"},
    "rag": {"langchain"}, "langchain": {"langgraph", "rag"}, "postgresql": {"sql"}, "sql": {"postgresql"},
    "react": {"javascript", "typescript", "vue", "angular"}, "next.js": {"react"}, "pytorch": {"tensorflow"}, "tensorflow": {"pytorch"},
}

def words(value):
    return {token for token in re.findall(r"\w+", str(value).casefold()) if len(token) > 2 and token not in STOP}

def requirements(jd, title=""):
    parts = [re.sub(r"^[-*•\s]+", "", line).strip() for line in re.split(r"(?<=[.!?])\s+|[\r\n]+", jd or "")]
    parts = [line[:600] for line in parts if line and words(line) and not UNSAFE.search(line) and not (re.search(r"\brounds?\b", line, re.I) and re.search(r"\b(technical|hr|founder|interview)\b", line, re.I))]
    return list(dict.fromkeys(parts))[:8] or ([title[:300]] if title else [])

def goal(requirement):
    return re.sub(r"^.{0,150}?\b(required to|responsible for|you will|you would|responsibilities:)\s+", "", requirement, flags=re.I).rstrip(".!? ")

def topic_analysis(profile, jd_skills, explicit_gaps=()):
    declared = {normalize_skill(skill) for skill in profile.get("skills", []) if isinstance(skill, str)}
    gaps = {normalize_skill(skill) for skill in explicit_gaps}
    evidence = str({"projects": profile.get("projects", []), "experience": profile.get("experience", [])})[:50000]
    topics, details, seen = {"strong": [], "moderate": [], "gaps": []}, [], set()
    for skill in jd_skills:
        name = normalize_skill(skill)
        if name in seen:
            continue
        seen.add(name)
        near = sorted(declared & RELATED.get(name, set()))
        direct = has_skill(evidence, skill) and not re.search(r"\b(?:not|never|no experience|plan to|want to)\b[^.!?;]{0,60}" + re.escape(skill), evidence, re.I)
        level = "strong" if name in declared else "moderate" if name not in gaps and (direct or near) else "gaps"
        topics[level].append(skill)
        basis = "profile_declared" if name in declared else "explicit_gap" if name in gaps else "profile_project_or_experience" if direct else "related_profile_skill" if near else "not_in_profile"
        details.append({"topic": skill, "level": level, "basis": basis, "related_skills": near,
                        "explanation": "Listed in your profile; proficiency is self-reported." if level == "strong" else "Profile project or related-skill evidence supports partial familiarity, not proficiency." if level == "moderate" else "No supporting skill or project evidence was found, or this skill was explicitly marked as a gap."})
    return topics, details

RISKS = [
    (r"bookings?|appointments?|reservations?|slots?|itinerar", "conflicting or duplicate reservations", "how to resolve a conflict between two requests", "two requests competing for the same slot"),
    (r"stock|inventory|reconcil|orders?", "disagreeing counts or repeated updates", "which source of a conflicting count to trust", "a repeated or out-of-order stock update"),
    (r"fraud|bank|payments?", "false positives and sensitive records", "when to escalate a suspicious result instead of acting automatically", "a legitimate transaction that looks unusual"),
    (r"recommend|relevan|discover|search|index|catalog", "irrelevant or missing results", "how to handle feedback that a result is irrelevant", "a query whose useful result is missing"),
    (r"forecast|weather|rainfall|soil|moisture|irrigation|readings?", "missing or uncertain observations", "how to communicate uncertainty before choosing a threshold", "a missing or implausible observation"),
    (r"captions?|accessib|transcrib|speech", "incorrect or inaccessible output", "how to respond when a user cannot rely on the output", "an incomplete or incorrectly transcribed input"),
    (r"learn|student|quiz|education", "misleading progress feedback", "how to interpret feedback when a learner is struggling", "an incomplete or repeated learner response"),
    (r"deliver|routes?|dispatch", "a disrupted route or delayed update", "when to communicate a delay rather than silently change a plan", "an unavailable stop or delayed update"),
]
def risk_for(requirement):
    for pattern, risk, decision, test in RISKS:
        if re.search(pattern, requirement, re.I):
            return risk, decision, test
    return "an invalid input or an unclear requirement", "which missing requirement to clarify before implementing", "an invalid or incomplete input"

def local_questions(jd, company, listing_type="job", profile=None, title="", required_skills=()):
    profile = profile or {}
    reqs, skills = requirements(jd, title), extract_skills(f"{title} {jd}", [*required_skills, *profile.get("skills", [])])[:4]
    intern, output = listing_type == "internship", []
    if not reqs:
        return output
    req, stack = reqs[0], ", ".join(skills)
    task, (risk, decision, edge) = goal(req), risk_for(req)
    def add(category, question, evidence, focus):
        output.append({"category": category, "question": question, "evidence": {"kind": "jd", "quote": evidence}, "focus": focus, "level": listing_type})
    for index, skill in enumerate(skills[:3]):
        span = reqs[index % len(reqs)]
        domain_risk = risk_for(span)
        if re.search(r"sql|postgres", skill, re.I):
            probe = "Explain the data model and a query; include missing and repeated records."
        elif re.search(r"react|javascript|typescript|next.js|vue|angular", skill, re.I):
            probe = "Explain the input/state boundary, invalid data and one observable UI or API test."
        elif re.search(r"rag|langchain|langgraph|agent", skill, re.I):
            probe = "Explain the retrieval or tool boundary, how you would check an answer, and when the system should abstain."
        elif re.search(r"docker|kubernetes|aws|gcp|azure", skill, re.I):
            probe = "Explain configuration, a reproducible run and one failure you would detect."
        else:
            probe = f"Explain the main input/output contract and test {domain_risk[2]}."
        intro = f"show a small {skill} example" if intern else f"describe a production {skill} implementation"
        add("technical", f"For {company}'s task to {goal(span)}, {intro}. {probe}" + ("" if intern else " What would you measure before changing it?"), span, f"{skill}: implementation and validation")
    rich = len(words(task) - set().union(*(words(skill) for skill in skills))) >= 3
    if rich:
        if not skills:
            add("technical", f"For the JD task to {task}, walk through the inputs, expected output and {edge}. Which assumption would you verify before implementation?", req, "task fundamentals and validation")
        projects = [p for p in profile.get("projects", []) if isinstance(p, dict) and p.get("name")]
        projects.sort(key=lambda p: len(words(p) & words(req)), reverse=True)
        example = f'your project "{str(projects[0]["name"])[:160]}"' if projects else f'a {"course or personal" if intern else "past"} project you actually worked on'
        add("behavioral", f"The JD asks you to {task}. Using {example}, explain {decision}. What evidence would you show {'a mentor' if intern else 'a stakeholder'}, and what would make you revise your decision?", req, "evidence, ambiguity and communication")
        second = reqs[1] if len(reqs) > 1 else req
        second_risk = risk_for(second)[0]
        question = f"While learning to {goal(second)}, suppose feedback points out {second_risk}. What small experiment would you run, what help would you ask for, and how would you explain the result?" if intern else f"For work to {goal(second)}, describe how you would handle a disagreement about {second_risk}. Which observable result would settle the tradeoff, and how would you communicate an unresolved risk?"
        add("behavioral", question, second, "feedback and a role-specific tradeoff")
        design = "Sketch a small prototype and its data flow" if intern else "Design a scalable service and discuss production boundaries"
        ending = "one test before expanding it" if intern else "how recovery, monitoring and access controls affect your design"
        add("design", f"{design} using {stack or 'a toolset you would justify from the JD'} to {task}. Show where you would detect {risk}, and {ending}.", req, "system boundaries and failure handling")
        if len(output) < 5 and skills:
            add("technical", f"For the task to {task}, how would you use {skills[0]} to test {edge}? Give the expected result and explain which implementation mistake the test would catch.", req, f"{skills[0]}: a concrete edge-case test")
    elif skills:
        add("behavioral", f"The available JD only establishes {stack}. Describe how you would verify your current {skills[0]} knowledge with {'a mentor' if intern else 'the hiring team'}, and which missing task details you would request before choosing what to practise.", req, "scope clarification for a sparse JD")
        add("design", f"Using {stack}, {'sketch a small prototype' if intern else 'outline a service boundary'} only after stating which inputs, users and success criteria are missing from this JD. How would those answers change the design?", req, "explicit unknowns")
    return output[:10]

def validate_questions(value, jd, listing_type="job"):
    if not isinstance(value, list) or not 5 <= len(value) <= 10:
        return None
    reqs, skills = requirements(jd), extract_skills(jd)
    domain = set().union(*(words(req) for req in reqs)) - set().union(*(words(skill) for skill in skills))
    output, seen = [], set()
    for item in value:
        if not isinstance(item, dict) or item.get("category") not in {"technical", "behavioral", "design"} or not isinstance(item.get("question"), str):
            return None
        question = item["question"].strip()[:1500]
        key = re.sub(r"\W+", " ", question.casefold())
        hits = len(words(question) & domain)
        if (listing_type == "internship" and re.search(r"\b(production|billion|multi-region|scalable)\b", question, re.I)) or len(question) < 25 or UNSAFE.search(question) or key in seen or (not any(has_skill(question, skill) for skill in skills) and hits < 2) or (len(domain) >= 3 and hits < 2) or re.search(r"you have \d|you led|our company is|guaranteed (offer|round)", question, re.I):
            return None
        shape = words(key)
        if any(len(shape & words(prior)) / len(shape | words(prior)) > .85 for prior in seen):
            return None
        seen.add(key)
        span = max(reqs, key=lambda req: len(words(req) & words(question)), default="")
        output.append({"category": item["category"], "question": question, "evidence": {"kind": "jd", "quote": span}, "level": listing_type, "focus": "model-generated, JD-validated practice"})
    return output if {q["category"] for q in output} >= {"technical", "behavioral", "design"} else None
