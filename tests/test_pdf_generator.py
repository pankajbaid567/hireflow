"""
Tests for PDFGenerator — Issue 13
===================================
All xelatex subprocess calls are mocked so the tests run without LaTeX installed.
Four test cases are provided:
  1. Normal PDF generation — correct path + version 1
  2. Version increment     — second call produces v2
  3. DB record updated     — Application.resume_path / resume_version persisted
  4. xelatex failure       — RuntimeError raised with exit-code details
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from unittest.mock import MagicMock, patch, call

import pytest

from src.pipelines.pdf_generator import PDFGenerator, _next_version, _escape_latex


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SAMPLE_RESUME = {
    "name":     "Alice Smith",
    "email":    "alice@example.com",
    "phone":    "+91-9999999999",
    "location": "Bangalore, India",
    "summary":  "AI engineer intern with Python and LangChain experience.",
    "skills":   ["Python", "LangChain", "FastAPI", "FAISS"],
    "experience": [
        {
            "title":   "ML Intern",
            "company": "TechCorp",
            "dates":   "Jun 2025 - Aug 2025",
            "bullets": ["Built an NLP pipeline.", "Reduced inference latency by 30%."],
        }
    ],
    "projects": [
        {
            "name":        "HireFlow",
            "description": "Agentic job application system using LangGraph.",
            "tech":        ["Python", "LangGraph", "FastAPI"],
        }
    ],
    "education": {
        "degree":  "B.Tech CS",
        "college": "NST",
        "year":    2026,
        "gpa":     "8.5",
    },
    "certifications": ["AWS Certified ML Specialty", "DeepLearning.AI TensorFlow Developer"],
}


def _make_generator(tmp_path: Path) -> PDFGenerator:
    """Return a PDFGenerator pointing at tmp_path for output."""
    template_path = Path(__file__).resolve().parents[1] / "src" / "templates" / "resume_latex" / "base_template.tex"
    return PDFGenerator(
        resumes_dir=tmp_path / "resumes",
        template_path=template_path,
        xelatex_bin="xelatex",
    )


def _mock_xelatex_success(output_dir_arg):
    """
    Side-effect for subprocess.run: creates a fake resume.pdf in the cwd.
    Called for each xelatex invocation.
    """
    def _side_effect(cmd, cwd, capture_output, text):
        # Simulate xelatex writing a PDF
        pdf = Path(cwd) / "resume.pdf"
        pdf.write_bytes(b"%PDF-1.4 fake pdf content for testing")
        result = MagicMock()
        result.returncode = 0
        result.stdout = ""
        result.stderr = ""
        return result
    return _side_effect


# ---------------------------------------------------------------------------
# Test 1 — Normal generation: correct path returned, version is 1
# ---------------------------------------------------------------------------

class TestGenerateCreatesPDF:
    def test_generate_creates_pdf_v1(self, tmp_path):
        gen = _make_generator(tmp_path)

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            path = gen.generate(
                user_id="user_001",
                job_id="job_abc",
                resume_content=SAMPLE_RESUME,
            )

        assert path.endswith("job_abc_resume_v1.pdf"), f"Unexpected path: {path}"
        assert Path(path).exists(), "PDF file should exist on disk"

    def test_generated_path_matches_pattern(self, tmp_path):
        gen = _make_generator(tmp_path)

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            path = gen.generate(
                user_id="user_001",
                job_id="job_xyz",
                resume_content=SAMPLE_RESUME,
            )

        # Pattern: data/resumes/{user_id}/{job_id}_resume_v{N}.pdf
        pattern = re.compile(r".*user_001[/\\]job_xyz_resume_v\d+\.pdf$")
        assert pattern.match(path), f"Path '{path}' does not match expected pattern"


# ---------------------------------------------------------------------------
# Test 2 — Version increment: second call produces v2
# ---------------------------------------------------------------------------

class TestVersionIncrement:
    def test_version_increments_on_second_call(self, tmp_path):
        gen = _make_generator(tmp_path)

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            path_v1 = gen.generate(
                user_id="user_002",
                job_id="job_def",
                resume_content=SAMPLE_RESUME,
            )
            path_v2 = gen.generate(
                user_id="user_002",
                job_id="job_def",
                resume_content=SAMPLE_RESUME,
            )

        assert path_v1.endswith("_v1.pdf"), f"First call should be v1, got: {path_v1}"
        assert path_v2.endswith("_v2.pdf"), f"Second call should be v2, got: {path_v2}"
        assert Path(path_v1).exists()
        assert Path(path_v2).exists()
        assert path_v1 != path_v2

    def test_version_scans_existing_files(self, tmp_path):
        """Pre-seeding v1 and v2 should make the next call produce v3."""
        resumes_dir = tmp_path / "resumes"
        user_dir = resumes_dir / "user_003"
        user_dir.mkdir(parents=True)

        # Pre-create v1 and v2
        (user_dir / "job_ghi_resume_v1.pdf").write_bytes(b"%PDF")
        (user_dir / "job_ghi_resume_v2.pdf").write_bytes(b"%PDF")

        gen = PDFGenerator(
            resumes_dir=resumes_dir,
            template_path=Path(__file__).resolve().parents[1]
                / "src" / "templates" / "resume_latex" / "base_template.tex",
            xelatex_bin="xelatex",
        )

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            path_v3 = gen.generate(
                user_id="user_003",
                job_id="job_ghi",
                resume_content=SAMPLE_RESUME,
            )

        assert path_v3.endswith("_v3.pdf"), f"Expected v3, got: {path_v3}"


# ---------------------------------------------------------------------------
# Test 3 — DB record updated
# ---------------------------------------------------------------------------

class TestDBRecordUpdated:
    def test_resume_path_and_version_persisted(self, tmp_path):
        gen = _make_generator(tmp_path)

        # Build a fake Application ORM object
        mock_app = MagicMock()
        mock_app.id = 77
        mock_app.resume_path = None
        mock_app.resume_version = None

        # Build a fake Session
        mock_db = MagicMock()
        mock_db.query.return_value.filter.return_value.first.return_value = mock_app

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            path = gen.generate(
                user_id="user_004",
                job_id="job_jkl",
                resume_content=SAMPLE_RESUME,
                db=mock_db,
                application_id=77,
            )

        # The ORM object attributes should have been set
        assert mock_app.resume_path == path, (
            f"Expected resume_path={path}, got {mock_app.resume_path}"
        )
        assert mock_app.resume_version == 1, (
            f"Expected resume_version=1, got {mock_app.resume_version}"
        )
        mock_db.commit.assert_called_once()

    def test_missing_application_id_skips_db_update(self, tmp_path):
        """If application_id is not supplied, DB should not be touched."""
        gen = _make_generator(tmp_path)
        mock_db = MagicMock()

        with patch("subprocess.run", side_effect=_mock_xelatex_success(tmp_path)):
            gen.generate(
                user_id="user_005",
                job_id="job_mno",
                resume_content=SAMPLE_RESUME,
                db=mock_db,
                # application_id deliberately omitted
            )

        mock_db.query.assert_not_called()
        mock_db.commit.assert_not_called()


# ---------------------------------------------------------------------------
# Test 4 — xelatex failure → RuntimeError
# ---------------------------------------------------------------------------

class TestXelatexFailure:
    def test_xelatex_nonzero_exit_raises_runtime_error(self, tmp_path):
        gen = _make_generator(tmp_path)

        def _fail_xelatex(cmd, cwd, capture_output, text):
            result = MagicMock()
            result.returncode = 1
            result.stdout = "! Undefined control sequence."
            result.stderr = ""
            return result

        with patch("subprocess.run", side_effect=_fail_xelatex):
            with pytest.raises(RuntimeError, match="xelatex failed"):
                gen.generate(
                    user_id="user_err",
                    job_id="job_err",
                    resume_content=SAMPLE_RESUME,
                )

    def test_xelatex_success_but_no_pdf_raises_runtime_error(self, tmp_path):
        """xelatex returns 0 but somehow doesn't write a PDF."""
        gen = _make_generator(tmp_path)

        def _no_pdf_xelatex(cmd, cwd, capture_output, text):
            # Does NOT create resume.pdf
            result = MagicMock()
            result.returncode = 0
            result.stdout = ""
            result.stderr = ""
            return result

        with patch("subprocess.run", side_effect=_no_pdf_xelatex):
            with pytest.raises(RuntimeError, match="no PDF was produced"):
                gen.generate(
                    user_id="user_err2",
                    job_id="job_err2",
                    resume_content=SAMPLE_RESUME,
                )


# ---------------------------------------------------------------------------
# Unit tests for helpers
# ---------------------------------------------------------------------------

class TestEscapeLatex:
    @pytest.mark.parametrize("raw,expected_contains", [
        ("hello & world",  r"\&"),
        ("50% off",        r"\%"),
        ("price: $100",    r"\$"),
        ("file#1",         r"\#"),
        ("my_var",         r"\_"),
        ("<tag>",          r"\textless{}"),
    ])
    def test_special_chars_escaped(self, raw, expected_contains):
        result = _escape_latex(raw)
        assert expected_contains in result, (
            f"Expected '{expected_contains}' in escaped output of '{raw}', got: '{result}'"
        )


class TestNextVersion:
    def test_empty_dir_returns_1(self, tmp_path):
        v = _next_version(tmp_path, "user_a", "job_a")
        assert v == 1

    def test_existing_v1_returns_2(self, tmp_path):
        user_dir = tmp_path / "user_b"
        user_dir.mkdir()
        (user_dir / "job_b_resume_v1.pdf").write_bytes(b"%PDF")
        v = _next_version(tmp_path, "user_b", "job_b")
        assert v == 2

    def test_different_job_does_not_interfere(self, tmp_path):
        user_dir = tmp_path / "user_c"
        user_dir.mkdir()
        # Pre-seed a DIFFERENT job's pdf
        (user_dir / "other_job_resume_v5.pdf").write_bytes(b"%PDF")
        v = _next_version(tmp_path, "user_c", "job_c")
        assert v == 1, "Different job's files should not affect version count"
