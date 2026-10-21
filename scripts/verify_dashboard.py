"""Verify the real dashboard against an isolated, local Docker Compose stack.

See docs/workflow.md for startup commands. This creates synthetic profiles/jobs,
submits only local HTML fixtures, and never sends email. With --live-llm, the
configured provider answers one required free-text question on the local form.
"""

from __future__ import annotations

import argparse
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import httpx
from playwright.sync_api import expect, sync_playwright
from pypdf import PdfReader
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parents[1]


def compose(project, *arguments):
    return subprocess.run(
        ["docker", "compose", "-p", project, *arguments],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
    ).stdout


def local_url(value):
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"}:
        raise ValueError("Dashboard verification accepts local HTTP URLs only")
    return value.rstrip("/")


def request_json(response, status=200):
    if response.status != status:
        raise AssertionError(f"Unexpected API status: HTTP {response.status}")
    return response.json()


def setup_fixtures(project, port):
    compose(
        project,
        "cp",
        str(ROOT / "tests" / "fixtures"),
        "api:/tmp/hireflow-e2e-fixtures",
    )
    compose(
        project,
        "exec",
        "-d",
        "api",
        "python",
        "-m",
        "http.server",
        str(port),
        "--bind",
        "0.0.0.0",
        "--directory",
        "/tmp/hireflow-e2e-fixtures",
    )
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            if httpx.get(f"{url}/sample_form.html", timeout=1).status_code == 200:
                return url
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise RuntimeError(
        f"Publish the API fixture port on 127.0.0.1:{port} before verification"
    )


def seed_jobs(project, fixture_url, run_id):
    definitions = [
        (
            "primary",
            f"Verify{run_id} AI Engineer Intern",
            "Studio",
            "sample_form.html",
            "Python, FastAPI, LangChain and Docker. Two rounds: technical and HR.",
        ),
        (
            "alternative",
            f"Verify{run_id} Python Engineer Intern",
            "Alternative",
            "sample_form.html",
            "Python, FastAPI and LangChain internship. Two interview rounds.",
        ),
        (
            "captcha",
            f"Verify{run_id} Platform Intern",
            "Manual review",
            "captcha_form.html",
            "Python internship. One technical discussion.",
        ),
    ]
    payload = [
        {
            "key": key,
            "title": title,
            "company": f"E2E {run_id} {company}",
            "description": description,
            "url": f"{fixture_url}/{fixture}?run={run_id}&job={key}",
        }
        for key, title, company, fixture, description in definitions
    ]
    source = f"""
import json
from src.config.database import SessionLocal
from src.models import Job, ListingType
definitions = json.loads({json.dumps(json.dumps(payload))})
with SessionLocal() as db:
    result = {{}}
    for definition in definitions:
        key = definition.pop('key')
        row = Job(**definition, location='Remote', listing_type=ListingType.internship)
        db.add(row)
        db.flush()
        result[key] = {{'id': row.id, 'title': row.title, 'company': row.company}}
    db.commit()
    print(json.dumps(result))
"""
    return json.loads(compose(project, "exec", "-T", "api", "python", "-c", source))


def provider_details(project):
    source = """
import json
from src.config.settings import get_settings
s = get_settings()
print(json.dumps({'provider': s.llm_provider, 'model': getattr(s, s.llm_provider + '_model', None)}))
"""
    return json.loads(compose(project, "exec", "-T", "api", "python", "-c", source))


def assert_pdf(response, candidate):
    assert response.status == 200, f"PDF download returned HTTP {response.status}"
    raw = response.body()
    assert raw.startswith(b"%PDF"), "Download is not a PDF"
    text = " ".join(page.extract_text() or "" for page in PdfReader(BytesIO(raw)).pages)
    assert candidate in text and "Python" in text, "Resume content did not round-trip"


def no_overflow(page):
    assert page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth + 1"
    ), "Page overflows its viewport"


def navigate(page, name):
    page.get_by_role("navigation", name="Main navigation").get_by_role(
        "link", name=name, exact=True
    ).click()


def verify(args):
    base, api = local_url(args.base_url), local_url(args.api_url)
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    run_id = uuid4().hex[:8]
    candidate = "E2E Candidate"
    fixture_url = setup_fixtures(args.compose_project, args.fixture_port)
    resume = output / "synthetic-resume.pdf"
    pdf = canvas.Canvas(str(resume))
    for index, line in enumerate(
        [
            candidate,
            "Python, FastAPI, LangChain",
            "BTech",
            "Built a Python API project.",
        ]
    ):
        pdf.drawString(72, 750 - 24 * index, line)
    pdf.save()
    runtime_errors = []
    screenshots = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        page = context.new_page()
        page.on("pageerror", lambda _: runtime_errors.append("pageerror"))
        page.set_default_timeout(20000)
        page.goto(f"{base}/profile")
        for name, value in {
            "name": candidate,
            "email": f"dashboard-{run_id}@example.test",
            "phone": "9999999999",
            "experience_years": "0",
            "education": "BTech",
            "skills": "Python, FastAPI, LangChain",
            "weekly_quota": "2",
            "target_roles": f"Verify{run_id} AI Engineer, Verify{run_id} Python Engineer",
            "preferred_locations": "Remote",
        }.items():
            page.locator(f'input[name="{name}"]').fill(value)
        page.get_by_role("radio", name="Job").click()
        expect(page.get_by_role("radio", name="Job")).to_have_attribute(
            "aria-checked", "true"
        )
        page.get_by_role("radio", name="Internship").click()
        page.get_by_label("Resume PDF", exact=True).set_input_files(resume)
        with page.expect_response(
            lambda r: r.request.method == "POST" and r.url.endswith("/profile")
        ) as saving:
            page.get_by_role("button", name="Save profile", exact=True).click()
        profile = request_json(saving.value, 201)
        user_id = profile["id"]
        assert profile["mode"] == "internship" and profile["weekly_quota"] == 2
        assert profile["master_profile"]["master_resume_path"]
        expect(page.get_by_role("status")).to_contain_text("Profile saved")
        if not args.live_llm:
            request_json(
                page.request.patch(
                    f"{api}/profile/{user_id}",
                    data={
                        "answers": {
                            "why": "I enjoy building reliable Python agents and APIs."
                        }
                    },
                )
            )
        else:
            assert not profile["master_profile"].get(
                "answers"
            ), "Live form answer must come from the provider"
        jobs = seed_jobs(args.compose_project, fixture_url, run_id)
        with page.expect_response(
            lambda r: r.request.method == "GET"
            and r.url.endswith(f"/weekly-plan/{user_id}")
        ) as planning:
            navigate(page, "Weekly plan")
        plan = request_json(planning.value)
        assert {job["job_id"] for job in plan["plan"]} == {
            jobs["primary"]["id"],
            jobs["alternative"]["id"],
        }, "Use an isolated Compose database for this verification"
        expect(page.locator(".job-card")).to_have_count(2)
        primary = page.locator(".job-card").filter(has_text=jobs["primary"]["company"])
        primary.get_by_role("button", name="Preview resume").click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        assert_pdf(
            page.request.get(
                urljoin(base, dialog.locator("iframe").get_attribute("src"))
            ),
            candidate,
        )
        page.screenshot(path=str(output / "desktop-resume-preview.png"))
        screenshots.append("desktop-resume-preview.png")
        page.get_by_role("button", name="Close resume preview").click()
        with page.expect_response(
            lambda r: r.request.method == "POST"
            and r.url.endswith(f"/weekly-plan/{user_id}/swap")
        ) as swapping:
            page.locator(".job-card").filter(
                has_text=jobs["alternative"]["company"]
            ).get_by_role("combobox").select_option(str(jobs["captcha"]["id"]))
        assert {job["job_id"] for job in request_json(swapping.value)["plan"]} == {
            jobs["primary"]["id"],
            jobs["captcha"]["id"],
        }
        expect(
            page.locator(".job-card").filter(has_text=jobs["captcha"]["company"])
        ).to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(output / "desktop-weekly-plan.png"), full_page=True)
        screenshots.append("desktop-weekly-plan.png")
        with page.expect_response(
            lambda r: r.request.method == "POST"
            and r.url.endswith(f"/weekly-plan/{user_id}/confirm")
        ) as confirming:
            page.get_by_role("button", name="Confirm and Apply", exact=True).click()
        request_json(confirming.value)
        page.get_by_role("link", name="View applications", exact=True).first.click()
        deadline = time.monotonic() + 180
        while True:
            applications = request_json(
                page.request.get(f"{api}/applications/{user_id}")
            )["items"]
            states = {item["job_id"]: item["status"] for item in applications}
            if (
                states.get(jobs["primary"]["id"]) == "applied"
                and states.get(jobs["captcha"]["id"]) == "needs_action"
            ):
                break
            if states.get(jobs["primary"]["id"]) in {"failed", "needs_action"}:
                raise AssertionError(f"Local sample form did not apply: {states}")
            assert (
                time.monotonic() < deadline
            ), f"Application pipeline timed out: {states}"
            page.wait_for_timeout(500)
        applied = next(
            item for item in applications if item["job_id"] == jobs["primary"]["id"]
        )
        assert [event["status"] for event in applied["status_history"]][-3:] == [
            "confirmed",
            "applying",
            "applied",
        ]
        assert applied["applied_at"] and applied["attempts"] == 1
        page.get_by_role("button", name="Refresh", exact=True).click()
        expect(page.locator(".status-applied")).to_be_visible()
        expect(page.locator(".status-needs_action")).to_be_visible()
        expect(page.get_by_text("CAPTCHA detected", exact=True)).to_be_visible()
        manual = page.get_by_role("link", name="Complete manually")
        assert page.request.get(manual.get_attribute("href")).status == 200
        no_overflow(page)
        page.screenshot(path=str(output / "desktop-tracker.png"), full_page=True)
        screenshots.append("desktop-tracker.png")
        page.get_by_label("Filter by status").select_option("applied")
        expect(page.locator("tbody tr")).to_have_count(1)
        page.get_by_role("link", name="Prep guide", exact=True).click()
        expect(page.locator(".round-list li")).to_have_count(2)
        expect(page.locator("#topics")).to_contain_text("Docker")
        expect(page.locator("#resources")).to_be_visible()
        assert page.locator("#questions details").count() >= 3
        page.locator("#questions summary").first.click()
        expect(page.locator("#questions details").first).to_have_attribute("open", "")
        no_overflow(page)
        page.screenshot(path=str(output / "desktop-prep-guide.png"), full_page=True)
        screenshots.append("desktop-prep-guide.png")
        navigate(page, "Weekly report")
        with page.expect_response(
            lambda r: r.request.method == "POST"
            and r.url.endswith(f"/report/{user_id}/generate")
        ) as reporting:
            page.get_by_role("button", name="Generate this week").click()
        assert request_json(reporting.value)["applied_count"] == 1
        report_link = page.get_by_role("link", name="Open weekly report")
        expect(report_link).to_be_visible()
        report_html = page.request.get(urljoin(base, report_link.get_attribute("href")))
        assert report_html.status == 200 and "CAPTCHA detected" in report_html.text()
        no_overflow(page)
        page.screenshot(path=str(output / "desktop-report.png"), full_page=True)
        screenshots.append("desktop-report.png")
        navigate(page, "Resume library")
        expect(page.locator(".resume-card").first).to_be_visible()
        downloads = page.get_by_role("link", name="Download PDF")
        assert downloads.count() >= 2
        for index in range(downloads.count()):
            assert_pdf(
                page.request.get(
                    urljoin(base, downloads.nth(index).get_attribute("href"))
                ),
                candidate,
            )
        no_overflow(page)
        page.screenshot(path=str(output / "desktop-resume-library.png"), full_page=True)
        screenshots.append("desktop-resume-library.png")
        mobile = browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            storage_state=context.storage_state(),
        )
        mobile_page = mobile.new_page()
        mobile_page.on("pageerror", lambda _: runtime_errors.append("pageerror"))
        mobile_page.goto(f"{base}/applications")
        expect(mobile_page.locator(".status-applied")).to_be_visible()
        no_overflow(mobile_page)
        mobile_page.screenshot(path=str(output / "mobile-tracker.png"), full_page=True)
        screenshots.append("mobile-tracker.png")
        mobile_page.get_by_role("button", name="Open navigation").click()
        expect(mobile_page.locator(".sidebar.mobile-open")).to_be_visible()
        mobile_page.screenshot(path=str(output / "mobile-navigation.png"))
        screenshots.append("mobile-navigation.png")
        navigate(mobile_page, "Resume library")
        expect(mobile_page.locator(".resume-card").first).to_be_visible()
        expect(mobile_page.locator(".sidebar.mobile-open")).to_have_count(0)
        no_overflow(mobile_page)
        mobile_page.screenshot(
            path=str(output / "mobile-resume-library.png"), full_page=True
        )
        screenshots.append("mobile-resume-library.png")
        assert (
            not runtime_errors
        ), f"Browser raised {len(runtime_errors)} JavaScript runtime errors"
        result = {
            "status": "passed",
            "profile_id": user_id,
            "live_llm": args.live_llm,
            **provider_details(args.compose_project),
            "application_statuses": ["applied", "needs_action"],
            "browser_runtime_errors": 0,
            "desktop_mobile_overflow": False,
            "pdf_downloads_checked": downloads.count(),
            "screenshots": screenshots,
        }
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        browser.close()
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--compose-project", required=True, help="Name of an isolated local test stack"
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--api-url", default="http://127.0.0.1:8000")
    parser.add_argument("--fixture-port", type=int, default=8899)
    parser.add_argument(
        "--output-dir",
        default=str(Path(tempfile.gettempdir()) / "hireflow-dashboard-proof"),
    )
    parser.add_argument(
        "--live-llm",
        action="store_true",
        help="Use the configured provider for the local form's written answer",
    )
    verify(parser.parse_args())
