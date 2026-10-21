"""Generate previewable, versioned PDFs without requiring a LaTeX installation."""

import json
import logging
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

    def prepare(self, application, db):
        if application.resume_path and Path(application.resume_path).is_file():
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
                    content["summary"] = result["summary"]
            except Exception:
                logger.warning(
                    "Resume summary unavailable; using profile facts", exc_info=True
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
        styles = getSampleStyleSheet()
        styles.add(
            ParagraphStyle(
                name="ResumeName",
                fontSize=22,
                leading=27,
                spaceAfter=8,
                textColor=colors.HexColor("#132f39"),
            )
        )
        styles.add(
            ParagraphStyle(
                name="ResumeSection",
                fontSize=11,
                leading=15,
                spaceBefore=14,
                spaceAfter=6,
                textColor=colors.HexColor("#176b62"),
            )
        )
        styles["BodyText"].leading = 15
        story = []

        def paragraph(value, style="BodyText"):
            story.append(
                Paragraph(escape(str(value)).replace("\n", "<br/>"), styles[style])
            )

        paragraph(content.get("name", "Candidate"), "ResumeName")
        paragraph(
            " | ".join(
                str(content[k])
                for k in ("email", "phone", "location")
                if content.get(k)
            )
        )
        if content.get("summary"):
            paragraph(content["summary"])
        if content.get("skills"):
            paragraph("Skills", "ResumeSection")
            paragraph(", ".join(content["skills"]))
        for key, heading in (
            ("experience", "Experience"),
            ("projects", "Projects"),
            ("education", "Education"),
        ):
            entries = content.get(key) or []
            if isinstance(entries, (dict, str)):
                entries = [entries]
            if entries:
                paragraph(heading, "ResumeSection")
            for item in entries:
                if isinstance(item, str):
                    paragraph(item)
                elif isinstance(item, dict):
                    label = " - ".join(
                        str(item[k])
                        for k in (
                            "title",
                            "name",
                            "degree",
                            "company",
                            "college",
                            "institution",
                            "dates",
                            "year",
                        )
                        if item.get(k)
                    )
                    if label:
                        paragraph(label)
                    if item.get("description"):
                        paragraph(item["description"])
                    for bullet in item.get("bullets", []):
                        paragraph("- " + str(bullet))
                    if item.get("tech"):
                        paragraph(", ".join(item["tech"]))
                story.append(Spacer(1, 5))
        if content.get("resume_text") and not (
            content.get("experience") or content.get("projects")
        ):
            paragraph("Background from your original resume", "ResumeSection")
            # Retain the candidate's supplied history even when external resume
            # extraction is unavailable and only manual profile fields exist.
            paragraph(content["resume_text"])
        SimpleDocTemplate(
            str(path),
            pagesize=(8.5 * inch, 11 * inch),
            rightMargin=48,
            leftMargin=48,
            topMargin=42,
            bottomMargin=42,
            title=f"{content.get('name', 'Candidate')} - Resume",
        ).build(story)
