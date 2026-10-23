"""
PDF Generator Pipeline — Issue 13
==================================
Converts a tailored resume content dict into an ATS-parseable PDF using LaTeX
(XeLaTeX), saves it with a versioned path, and optionally updates the
Application record in the database.

Output path pattern:
    data/resumes/{user_id}/{job_id}_resume_v{N}.pdf

Dependencies:
    - xelatex (part of MacTeX / TeX Live — brew install --cask mactex-no-gui)
    - Standard library only: subprocess, pathlib, string, shutil, tempfile, re, os

Usage:
    gen = PDFGenerator()
    path = gen.generate(
        user_id="u42",
        job_id="job_101",
        resume_content={
            "name": "Alice Smith",
            "email": "alice@example.com",
            "summary": "...",
            "skills": ["Python", "FastAPI"],
            "experience": [...],
            "projects": [...],
            "education": {...},
        },
        db=db_session,            # optional — supply to update Application record
        application_id=15,        # required when db is supplied
    )
"""

from __future__ import annotations

import logging
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from string import Template

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# Root of the project (two levels above this file: src/pipelines -> src -> .)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATE_PATH = _PROJECT_ROOT / "src" / "templates" / "resume_latex" / "base_template.tex"
_RESUMES_DIR = _PROJECT_ROOT / "data" / "resumes"


# ---------------------------------------------------------------------------
# LaTeX helpers
# ---------------------------------------------------------------------------

def _escape_latex(text: str) -> str:
    """
    Escape special LaTeX characters in plain text.
    Called on every user-supplied string before insertion into the template.
    """
    replacements = {
        "\\": r"\textbackslash{}", "&": r"\&", "%": r"\%", "$": r"\$",
        "#": r"\#", "_": r"\_", "{": r"\{", "}": r"\}",
        "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
        "<": r"\textless{}", ">": r"\textgreater{}",
    }
    # One pass: inserted braces/backslashes are never escaped a second time.
    return "".join(replacements.get(char, char) for char in text)



def _e(value: object) -> str:
    """Escape and stringify a value; return empty string for None/empty."""
    if value is None:
        return ""
    return _escape_latex(str(value))


# ---------------------------------------------------------------------------
# Block builders
# ---------------------------------------------------------------------------

def _build_skills_line(skills: list[str] | None) -> str:
    if not skills:
        return ""
    return r"\textbf{" + ", ".join(_e(s) for s in skills) + "}"


def _build_experience_block(experience: list[dict] | None) -> str:
    if not experience:
        return ""
    lines: list[str] = [r"\section{Work Experience}"]
    for job in experience:
        title    = _e(job.get("title", ""))
        company  = _e(job.get("company", ""))
        dates    = _e(job.get("dates", ""))
        bullets  = job.get("bullets", [])

        lines.append(
            r"\noindent\textbf{" + title + r"} \hfill \textit{" + dates + r"}\\"
            r"\textit{" + company + r"}\\"
        )
        if bullets:
            lines.append(r"\begin{itemize}")
            for b in bullets:
                lines.append(r"  \item " + _e(b))
            lines.append(r"\end{itemize}")
        lines.append(r"\vspace{2pt}")
    return "\n".join(lines)


def _build_projects_block(projects: list[dict] | None) -> str:
    if not projects:
        return ""
    lines: list[str] = [r"\section{Projects}"]
    for proj in projects:
        name  = _e(proj.get("name", ""))
        desc  = _e(proj.get("description", ""))
        tech  = proj.get("tech", [])
        tech_str = ", ".join(_e(t) for t in tech) if tech else ""

        lines.append(r"\noindent\textbf{" + name + r"}")
        if tech_str:
            lines[-1] += r" \hfill \textit{\small " + tech_str + r"}"
        lines.append(r"\\")
        if desc:
            lines.append(desc + r"\\")
        lines.append(r"\vspace{2pt}")
    return "\n".join(lines)


def _build_education_block(education: dict | None) -> str:
    if not education:
        return ""
    degree  = _e(education.get("degree", ""))
    college = _e(education.get("college", ""))
    year    = _e(education.get("year", ""))
    gpa     = _e(education.get("gpa", ""))

    lines = [r"\section{Education}"]
    lines.append(
        r"\noindent\textbf{" + degree + r"} \hfill " + year + r"\\"
        r"\textit{" + college + r"}"
    )
    if gpa:
        lines.append(r" \hfill GPA: " + gpa)
    return "\n".join(lines)


def _build_certifications_block(certifications: list[str] | None) -> str:
    if not certifications:
        return ""
    lines = [r"\section{Certifications}"]
    lines.append(r"\begin{itemize}")
    for cert in certifications:
        lines.append(r"  \item " + _e(cert))
    lines.append(r"\end{itemize}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Versioning helper
# ---------------------------------------------------------------------------

def _identifier(value: str | int) -> str:
    value = str(value)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,120}", value):
        raise ValueError("Resume identifiers must be short file-safe identifiers")
    return value


def _next_version(resumes_dir: Path, user_id: str, job_id: str) -> int:
    """
    Returns the next version number for a given (user_id, job_id) pair.
    Scans for files matching '{job_id}_resume_v*.pdf' in the user directory.
    """
    user_id, job_id = _identifier(user_id), _identifier(job_id)
    user_dir = resumes_dir / user_id
    user_dir.mkdir(parents=True, exist_ok=True)

    pattern = re.compile(
        r"^" + re.escape(str(job_id)) + r"_resume_v(\d+)\.pdf$"
    )
    max_version = 0
    for f in user_dir.iterdir():
        m = pattern.match(f.name)
        if m:
            max_version = max(max_version, int(m.group(1)))
    return max_version + 1


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------

class PDFGenerator:
    """
    Generates an ATS-parseable PDF résumé from a content dictionary.

    Parameters
    ----------
    resumes_dir : Path | str, optional
        Root directory where PDFs are stored.  Defaults to
        ``<project_root>/data/resumes``.
    template_path : Path | str, optional
        Path to the LaTeX base template.  Defaults to the bundled template.
    xelatex_bin : str, optional
        Path or name of the xelatex binary.  Auto-detected from PATH if omitted.
    """

    def __init__(
        self,
        resumes_dir: Path | str | None = None,
        template_path: Path | str | None = None,
        xelatex_bin: str | None = None,
    ) -> None:
        self.resumes_dir   = Path(resumes_dir)   if resumes_dir   else _RESUMES_DIR
        self.template_path = Path(template_path) if template_path else _TEMPLATE_PATH
        self.xelatex_bin   = xelatex_bin or shutil.which("xelatex") or "xelatex"

        if not self.template_path.exists():
            raise FileNotFoundError(
                f"LaTeX template not found: {self.template_path}"
            )

    # ------------------------------------------------------------------

    def _render_latex(self, resume_content: dict) -> str:
        """Fill the LaTeX template with content from *resume_content*."""
        raw = self.template_path.read_text(encoding="utf-8")
        tmpl = Template(raw)

        from .resume_fonts import safe_link
        substitutions = {
            "name":        _e(resume_content.get("name", "Candidate")),
            "email":       _e(resume_content.get("email", "")),
            "phone":       _e(resume_content.get("phone", "")),
            "location":    _e(resume_content.get("location", "")),
            "linkedin":    _e(safe_link(resume_content.get("linkedin", "")) or ""),
            "github":      _e(safe_link(resume_content.get("github", "")) or ""),
            "summary":     _e(resume_content.get("summary", "")),
            "skills_line": _build_skills_line(resume_content.get("skills")),
            "experience_block":     _build_experience_block(resume_content.get("experience")),
            "projects_block":       _build_projects_block(resume_content.get("projects")),
            "education_block":      _build_education_block(resume_content.get("education")),
            "certifications_block": _build_certifications_block(resume_content.get("certifications")),
        }
        return tmpl.safe_substitute(substitutions)

    # ------------------------------------------------------------------

    def _compile_latex(self, tex_source: str, output_dir: Path) -> Path:
        """
        Write *tex_source* to a temp directory, run xelatex twice, and return
        the path of the produced PDF.

        Raises
        ------
        RuntimeError
            If xelatex exits with a non-zero return code or the PDF is not
            produced.
        """
        tex_file = output_dir / "resume.tex"
        tex_file.write_text(tex_source, encoding="utf-8")

        cmd = [
            self.xelatex_bin,
            "-no-shell-escape",
            "-interaction=nonstopmode",
            "-halt-on-error",
            str(tex_file),
        ]

        for pass_num in (1, 2):
            result = subprocess.run(
                cmd,
                cwd=str(output_dir),
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                log_snippet = (result.stdout + result.stderr)[-2000:]
                raise RuntimeError(
                    f"xelatex failed on pass {pass_num} "
                    f"(exit code {result.returncode}):\n{log_snippet}"
                )

        pdf_path = output_dir / "resume.pdf"
        if not pdf_path.exists():
            raise RuntimeError(
                "xelatex reported success but no PDF was produced. "
                "Check the .log file for details."
            )
        return pdf_path

    # ------------------------------------------------------------------

    def generate(
        self,
        user_id: str | int,
        job_id: str | int,
        resume_content: dict,
        db: Session | None = None,
        application_id: int | None = None,
    ) -> str:
        """
        Generate a versioned PDF résumé and optionally update the DB record.

        Parameters
        ----------
        user_id : str | int
            Identifies the candidate; used in the output directory path.
        job_id : str | int
            Identifies the target job; used in the output filename.
        resume_content : dict
            Tailored résumé data.  Recognised keys:

            * ``name`` (str)
            * ``email`` (str)
            * ``phone`` (str, optional)
            * ``location`` (str, optional)
            * ``linkedin`` (str, optional — URL)
            * ``github`` (str, optional — URL)
            * ``summary`` (str)
            * ``skills`` (list[str])
            * ``experience`` (list[dict] with keys title, company, dates, bullets)
            * ``projects`` (list[dict] with keys name, description, tech)
            * ``education`` (dict with keys degree, college, year, gpa)
            * ``certifications`` (list[str], optional)

        db : sqlalchemy.orm.Session, optional
            If provided, the corresponding Application record is updated.
        application_id : int, optional
            Primary key of the Application to update when *db* is supplied.

        Returns
        -------
        str
            Absolute path to the generated PDF file.

        Raises
        ------
        RuntimeError
            If xelatex fails or produces no PDF.
        FileNotFoundError
            If the LaTeX template is missing.
        """
        user_id, job_id = _identifier(user_id), _identifier(job_id)

        version    = _next_version(self.resumes_dir, user_id, job_id)
        filename   = f"{job_id}_resume_v{version}.pdf"
        user_dir   = self.resumes_dir / user_id
        user_dir.mkdir(parents=True, exist_ok=True)
        final_path = user_dir / filename

        logger.info(
            "Generating PDF for user=%s job=%s version=%d", user_id, job_id, version
        )

        # The optional legacy LaTeX template is ASCII-only. Unicode and richer
        # profile schemas use the same reviewed text renderer as normal plans,
        # rather than losing characters or fields in that older template.
        rich = any(resume_content.get(key) for key in ["links", "website", "portfolio", "achievements", "languages", "resume_text"])
        rich = rich or bool(resume_content.get("education") and not isinstance(resume_content["education"], dict))
        rich = rich or any(not isinstance(item, dict) or set(item) - {"title", "company", "dates", "bullets"} for item in resume_content.get("experience", []))
        rich = rich or any(not isinstance(item, dict) or set(item) - {"name", "description", "tech"} for item in resume_content.get("projects", []))
        encoded = json.dumps(resume_content, ensure_ascii=False)
        if rich or not encoded.isascii():
            from .resume_service import ResumeService
            ResumeService._render(final_path, resume_content)
        else:
            tex_source = self._render_latex(resume_content)
            with tempfile.TemporaryDirectory(prefix="hireflow_pdf_") as tmp:
                tmp_path = Path(tmp)
                pdf_tmp = self._compile_latex(tex_source, tmp_path)
                shutil.copy2(str(pdf_tmp), str(final_path))

        logger.info("PDF saved to %s", final_path)

        # ---- Update DB record ----
        if db is not None and application_id is not None:
            self._update_application(
                db           = db,
                application_id = application_id,
                resume_path  = str(final_path),
                resume_version = version,
            )

        return str(final_path)

    # ------------------------------------------------------------------

    @staticmethod
    def _update_application(
        db: Session,
        application_id: int,
        resume_path: str,
        resume_version: int,
    ) -> None:
        """Persist *resume_path* and *resume_version* on the Application row."""
        from src.models.application import Application  # local import to avoid circular

        app = db.query(Application).filter(Application.id == application_id).first()
        if app is None:
            logger.warning(
                "Application id=%d not found; skipping DB update.", application_id
            )
            return

        app.resume_path    = resume_path
        app.resume_version = resume_version
        db.commit()
        logger.info(
            "Updated Application id=%d: resume_path=%s version=%d",
            application_id, resume_path, resume_version,
        )
