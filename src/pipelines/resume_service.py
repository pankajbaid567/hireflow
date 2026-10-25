"""Generate previewable, versioned PDFs without requiring a LaTeX installation."""

import json
import logging
import re
import unicodedata
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer

from src.config.settings import get_settings
from src.utils.skills import has_skill

logger = logging.getLogger(__name__)


class ResumeService:
    def __init__(self, storage_path=None, llm_client=None):
        self.root = Path(storage_path or get_settings().local_storage_path) / "resumes"
        self.llm_client = llm_client
        self.configuration_warnings = []
        self.last_preparation = {"method": "source_fact_ordering", "warnings": []}

    def prepare(self, application, db):
        self.last_preparation = {"method": "source_fact_ordering", "warnings": list(self.configuration_warnings)}
        if application.resume_path and Path(application.resume_path).is_file():
            self.last_preparation["method"] = "existing_pdf"
            return application.resume_path
        profile = {
            **(application.user.master_profile or {}),
            "name": application.user.name,
            "email": application.user.email,
        }
        jd = application.job.description or ""
        content = dict(profile)
        content["skills"] = sorted(
            profile.get("skills", []), key=lambda s: not has_skill(jd, s)
        )
        projects = [p for p in (profile.get("projects") or []) if isinstance(p, dict)]
        content["projects"] = sorted(
            projects, key=lambda p: -sum(has_skill(jd, s) for s in p.get("tech", []))
        )[:3]
        if self.llm_client:
            try:
                result = self.llm_client.extract(
                    f"Tailor a resume for this JD: {jd}. Profile: {json.dumps(profile)}. "
                    "Return JSON with summary only. Use only profile facts; do not invent skills, credentials, experience or results."
                )
                if isinstance(result, dict) and isinstance(result.get("summary"), str):
                    candidate = result["summary"].strip()
                    normalized = lambda value: " ".join(unicodedata.normalize("NFKC", value).split()).casefold()
                    evidence = [profile.get("summary", "")]
                    for section in (profile.get("experience") or [], profile.get("projects") or []):
                        for item in section:
                            if isinstance(item, dict):
                                for key in ("description", "bullets", "details", "achievements"):
                                    raw = item.get(key) or []
                                    evidence.extend([raw] if isinstance(raw, str) else [value for value in raw if isinstance(value, str)])
                    allowed = {normalized(sentence) for value in evidence if isinstance(value, str) for sentence in re.split(r"(?<=[.!?])\s+|\n", value) if sentence.strip()}
                    sentences = [part for part in re.split(r"(?<=[.!?])\s+|\n", candidate) if part.strip()]
                    if 0 < len(candidate) <= 3000 and sentences and all(normalized(part) in allowed for part in sentences):
                        content["summary"] = candidate
                        self.last_preparation["method"] = "llm_source_sentence_selection"
                    else:
                        self.last_preparation["warnings"].append("Unverified model summary rejected; retaining source facts.")
                        logger.warning("Unverified resume summary rejected; retaining source facts")
                else:
                    self.last_preparation["warnings"].append("Invalid model summary ignored; retaining source facts.")
            except Exception:
                self.last_preparation["warnings"].append("Resume summary generation is unavailable; using source facts.")
                logger.warning(
                    "Resume summary unavailable; using profile facts"
                )
        directory = self.root / str(application.user_id)
        directory.mkdir(parents=True, exist_ok=True)
        versions = [
            int(p.stem.rsplit("_v", 1)[1])
            for p in directory.glob(f"{application.job_id}_resume_v*.pdf")
            if p.stem.rsplit("_v", 1)[1].isdigit()
        ]
        version = max(versions, default=0) + 1
        path = directory / f"{application.job_id}_resume_v{version}.pdf"
        self._render(path, content)
        application.resume_path, application.resume_version = (
            str(path.resolve()),
            version,
        )
        db.commit()
        return application.resume_path

    @staticmethod
    def _render(path, content):
        from .resume_fonts import SANS, LogicalTextParagraph, linked_markup, plain, register_resume_fonts
        from reportlab.lib.pagesizes import A4

        register_resume_fonts()
        if len(json.dumps(content, ensure_ascii=False)) > 100_000:
            raise ValueError("Resume is too long to format safely. Keep the original PDF.")
        styles = getSampleStyleSheet()
        styles["BodyText"].fontName = SANS
        styles["BodyText"].fontSize = 10
        styles["BodyText"].leading = 15
        styles["BodyText"].shaping = 1
        styles["BodyText"].splitLongWords = 1
        styles.add(ParagraphStyle(name="ResumeName", parent=styles["BodyText"], fontSize=22, leading=30, spaceAfter=8, textColor=colors.HexColor("#132f39"), keepWithNext=True))
        styles.add(ParagraphStyle(name="ResumeSection", parent=styles["BodyText"], fontName="Helvetica-Bold", fontSize=11, leading=15, spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#176b62"), keepWithNext=True))
        styles.add(ParagraphStyle(name="ResumeEntry", parent=styles["BodyText"], spaceBefore=6, keepWithNext=True))
        story = []

        def text(value):
            if value is None or isinstance(value, bool): return ""
            if isinstance(value, list): return "\n".join(filter(None, (text(item) for item in value)))
            if isinstance(value, dict): return " | ".join(filter(None, (text(item) for item in value.values())))
            return plain(value).strip()

        def paragraph(value, style="BodyText"):
            value = text(value)
            if value:
                story.append(LogicalTextParagraph(linked_markup(value), styles[style], logical_text=value))

        def first(item, keys):
            return next((text(item[key]) for key in keys if text(item.get(key))), "")

        def entries(value):
            return value if isinstance(value, list) else [value] if value else []

        def dates(item):
            return first(item, ["dates", "period", "duration", "year", "graduation_year"]) or " - ".join(filter(None, [first(item, ["start_date", "start_year", "start"]), first(item, ["end_date", "end_year", "end"])]))

        paragraph(content.get("name", "Candidate"), "ResumeName")
        paragraph(" | ".join(str(content[k]) for k in ("email", "phone", "location") if content.get(k)))
        links = [text(content.get(key)) for key in ("linkedin", "github", "website", "portfolio")]
        for link in entries(content.get("links")):
            if isinstance(link, str): links.append(link)
            elif isinstance(link, dict):
                url = first(link, ["url", "href", "link"])
                if url: links.append(": ".join(filter(None, [text(link.get("label")), url])))
        for link in dict.fromkeys(filter(None, links)): paragraph(link)
        if content.get("summary"):
            paragraph("Summary", "ResumeSection")
            paragraph(content["summary"])
        if content.get("skills"):
            paragraph("Skills", "ResumeSection")
            paragraph(", ".join(content["skills"]))
        date_keys = ["dates", "period", "duration", "date", "year", "graduation_year", "start_date", "start_year", "start", "end_date", "end_year", "end"]
        for key, heading in (("experience", "Experience"), ("projects", "Projects"), ("education", "Education")):
            items = entries(content.get(key))
            if items: paragraph(heading, "ResumeSection")
            for item in items:
                if not isinstance(item, dict): paragraph(item); continue
                if key == "experience":
                    title_keys, detail_keys = ["title", "role", "position"], ["company", "employer", "organization", "location"]
                elif key == "projects":
                    title_keys, detail_keys = ["name", "title"], []
                else:
                    title_keys, detail_keys = ["degree", "qualification", "course", "program"], ["institution", "college", "university", "school"]
                paragraph(" | ".join(filter(None, [first(item, title_keys), dates(item)])), "ResumeEntry")
                details = [text(item.get(field)) for field in detail_keys if text(item.get(field))]
                if details: paragraph(" | ".join(details))
                used = set(title_keys + detail_keys + date_keys)
                for field in ["description", "bullets", "details", "achievements", "responsibilities"]:
                    if field not in used:
                        for value in entries(item.get(field)):
                            paragraph(("- " if field != "description" else "") + text(value))
                        used.add(field)
                tech_keys = ["tech", "technologies", "stack", "skills"]
                tech = first(item, tech_keys)
                if tech: paragraph("Technologies: " + tech.replace("\n", ", "))
                used.update(tech_keys)
                for field in ["url", "link", "github", "website", "live", "demo"]:
                    paragraph(item.get(field)); used.add(field)
                for field, value in item.items():
                    if field not in used and field not in ["id", "user_id"] and not field.startswith("_") and text(value):
                        paragraph(field.replace("_", " ").title() + ": " + text(value))
                story.append(Spacer(1, 5))
        for key, heading in (("certifications", "Certifications"), ("achievements", "Achievements"), ("languages", "Languages")):
            items = entries(content.get(key))
            if items:
                paragraph(heading, "ResumeSection")
                for item in items: paragraph(item)
        if content.get("resume_text") and not (content.get("experience") or content.get("projects")):
            paragraph("Background from your original resume", "ResumeSection")
            paragraph(content["resume_text"])

        def footer(canvas, document):
            canvas.saveState();canvas.setFont("Helvetica", 8)
            canvas.setFillColor(colors.HexColor("#647078"))
            canvas.drawRightString(A4[0] - 48, 24, str(document.page));canvas.restoreState()

        SimpleDocTemplate(str(path), pagesize=A4, rightMargin=48, leftMargin=48, topMargin=42, bottomMargin=42, title=f"{content.get('name', 'Candidate')} - Resume").build(story, onFirstPage=footer, onLaterPages=footer)
