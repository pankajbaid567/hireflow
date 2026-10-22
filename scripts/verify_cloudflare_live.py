#!/usr/bin/env python3
"""Opt-in live QA against HireFlow's controlled form, never an employer site.

Run with venv/bin/python scripts/verify_cloudflare_live.py --run-live after the
frontend fixture is deployed. Credentials are read from ignored .dev.vars and
passed to curl through private files, never through arguments or printed output.
Synthetic records are deliberately retained for scoped inspection and cleanup.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
from typing import Any
from urllib.parse import urlsplit
import uuid

from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parents[1]
WORKER = "https://hireflow-api.baidpankaj567.workers.dev"
FRONTEND = "https://hireflow-dashboard.pages.dev"
LEGACY_FRONTEND = "https://hireflow-blue-seven.vercel.app"
FIXTURE = f"{FRONTEND}/assets/hireflow-qa-form"
FIXTURE_MARKER = "HireFlow deployment QA form"


class VerificationFailure(Exception):
    """A safe diagnostic containing no response body or credentials."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise VerificationFailure(message)


def private_file(path: Path, value: bytes = b"") -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(value)
    path.chmod(0o600)


class CurlSession:
    def __init__(self, base: str, access_code: str, directory: Path):
        self.base = base.rstrip("/")
        self.directory = directory
        self.requests: list[dict[str, Any]] = []
        self.cookie = directory / "cookies"
        self.common = directory / "headers"
        self.auth = directory / "owner-headers"
        private_file(self.cookie)
        common = f"Origin: {FRONTEND}\nContent-Type: application/json\n"
        private_file(self.common, common.encode())
        private_file(
            self.auth,
            (common + f"X-HireFlow-Access-Code: {access_code}\n").encode(),
        )

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        data: dict[str, Any] | None = None,
        owner_code: bool = False,
        absolute: bool = False,
        timeout: float = 65,
    ) -> tuple[int, bytes, dict[str, str]]:
        url = path if absolute else self.base + path
        require(
            not absolute or url == FIXTURE,
            "Only the fixed controlled fixture may be fetched outside the API",
        )
        require(
            absolute or path.startswith("/") and not path.startswith("//"),
            "Invalid API path",
        )
        request_id = len(self.requests)
        response_path = self.directory / f"response-{request_id}"
        header_path = self.directory / f"response-headers-{request_id}"
        private_file(response_path)
        private_file(header_path)
        command = [
            "curl",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--max-time",
            str(max(1, int(timeout))),
            "--request",
            method,
            "--dump-header",
            str(header_path),
            "--output",
            str(response_path),
            "--write-out",
            "%{http_code}",
        ]
        if not absolute:
            command += [
                "--header",
                f"@{self.auth if owner_code else self.common}",
                "--cookie",
                str(self.cookie),
                "--cookie-jar",
                str(self.cookie),
            ]
        if data is not None:
            payload_path = self.directory / f"payload-{request_id}"
            private_file(payload_path, json.dumps(data).encode())
            command += ["--data-binary", f"@{payload_path}"]
        try:
            result = subprocess.run(
                command + [url], capture_output=True, text=True, timeout=timeout + 5
            )
        except subprocess.TimeoutExpired:
            raise VerificationFailure(f"curl timed out at {method} {path}") from None
        require(
            result.returncode == 0,
            f"curl transport failure ({result.returncode}) at {method} {path}",
        )
        status = int(result.stdout)
        body = response_path.read_bytes()
        headers = {}
        for line in header_path.read_text().splitlines():
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.lower()] = value.strip()
        # Preserve status/CPU evidence without retaining response bodies, cookies,
        # provider errors or private files in the shareable proof.
        self.requests.append(
            {
                "method": method,
                "path": urlsplit(url).path,
                "status": status,
                "cf_ray": headers.get("cf-ray"),
                "cpu_limit_exceeded": bool(
                    re.search(rb"\b1102\b|exceeded resource limits", body[:65536], re.I)
                ),
            }
        )
        return status, body, headers

    def json(
        self, path: str, *, expected: int = 200, **kwargs: Any
    ) -> tuple[dict[str, Any], dict[str, str]]:
        status, body, headers = self.request(path, **kwargs)
        require(
            status == expected, f"Expected HTTP {expected}, received {status} at {path}"
        )
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeError):
            raise VerificationFailure(f"Invalid JSON response at {path}") from None
        require(isinstance(payload, dict), f"Expected a JSON object at {path}")
        return payload, headers


def await_pdf(client: CurlSession, path: str, timeout: int = 130) -> bytes:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, body, headers = client.request(
            path, timeout=min(30, deadline - time.monotonic())
        )
        if status == 404:
            time.sleep(4)
            continue
        require(status == 200, f"Private PDF returned HTTP {status}")
        require(
            headers.get("content-type", "").startswith("application/pdf"),
            "Resume content type is not PDF",
        )
        require(
            "no-store" in headers.get("cache-control", ""),
            "Resume must not be cached publicly",
        )
        require(
            body.startswith(b"%PDF-") and len(body) > 300,
            "Generated resume is not a readable PDF",
        )
        require(
            b"Deployment QA" in body,
            "Generated resume is missing synthetic profile facts",
        )
        return body
    raise VerificationFailure(
        "Generated PDF did not become visible during KV grace period"
    )


def verify(client: CurlSession, proof: dict[str, Any]) -> None:
    proof["stage"] = "fixture_preflight"
    status, fixture, _ = client.request(FIXTURE, absolute=True)
    require(
        status == 200,
        f"Controlled fixture is not deployed (HTTP {status}); nothing created",
    )
    html = fixture.decode("utf-8", errors="replace")
    require(
        FIXTURE_MARKER in html and "preventDefault" in html,
        "Controlled fixture marker or DOM-only submission handler missing",
    )

    health, _ = client.json("/health")
    require(
        health.get("status") == "ok" and health.get("runtime") == "cloudflare-workers",
        "Proxy is not connected to the healthy Cloudflare Worker",
    )
    session, _ = client.json("/session")
    require(
        session.get("authenticated") is False,
        "Expected a fresh unauthenticated session",
    )

    run_id = uuid.uuid4().hex[:12]
    company = f"Deployment QA Co {run_id}"
    proof.update(run_id=run_id, company=company, fixture_url=f"{FIXTURE}?qa={run_id}")
    proof["stage"] = "profile"
    profile, headers = client.json(
        "/profile",
        method="POST",
        owner_code=True,
        expected=201,
        data={
            "name": "Deployment QA",
            "email": f"deployment-qa-{run_id}@example.com",
            "phone": "9999999999",
            "mode": "internship",
            "weekly_quota": 1,
            "skills": ["Python", "LangChain"],
            "target_roles": ["AI Engineer Intern"],
            "preferred_locations": [],
            "experience_years": 0,
            "experience": [],
            "education": [
                {
                    "degree": "B.Tech Computer Science",
                    "institution": "Example University",
                    "year": "2026",
                }
            ],
            "projects": [
                {
                    "name": "Deployment fixture",
                    "description": "Synthetic browser verification only",
                    "tech": ["Python", "LangChain"],
                }
            ],
        },
    )
    user_id = profile["id"]
    proof["user_id"] = user_id
    cookie = headers.get("set-cookie", "")
    proof["session_cookie"] = {
        "http_only": "httponly" in cookie.lower(),
        "secure": "secure" in cookie.lower(),
        "same_site_lax": "samesite=lax" in cookie.lower(),
    }
    require(
        all(proof["session_cookie"].values()),
        "Owner session cookie is missing a security attribute",
    )
    session, _ = client.json("/session")
    require(
        session.get("authenticated") and session.get("user_id") == user_id,
        "Owner session was not established",
    )

    proof["stage"] = "job_import"
    imported, _ = client.json(
        f"/jobs/{user_id}",
        method="POST",
        expected=201,
        data={
            "title": "Python LangChain AI Engineer Intern",
            "company": company,
            "url": proof["fixture_url"],
            "listing_type": "internship",
            "description": "Synthetic deployment QA only, not a real vacancy. Use Python and LangChain to build a small assistant. 2 interview rounds: technical and HR.",
        },
    )
    require(imported.get("imported") == 1, "Synthetic opportunity was not imported")
    proof["stage"] = "plan_and_private_pdf"
    plan, _ = client.json(f"/weekly-plan/{user_id}")
    require(
        not plan.get("preparing") and len(plan.get("plan", [])) == 1,
        "Expected one prepared synthetic application",
    )
    application = plan["plan"][0]
    require(
        application.get("company_name") == company,
        "The plan includes an unexpected company",
    )
    app_id, job_id = application["application_id"], application["job_id"]
    proof.update(application_id=app_id, job_id=job_id)
    require(
        application.get("resume_url") == f"/resumes/{user_id}/{app_id}/download",
        "Unexpected private resume URL",
    )
    proof["resume_bytes"] = len(await_pdf(client, application["resume_url"]))

    # The URL was constructed above from the exact owner-controlled fixture.
    # This single confirmation is never retried, including on HTTP failure.
    proof["stage"] = "confirm_controlled_fixture"
    confirmation, _ = client.json(
        f"/weekly-plan/{user_id}/confirm",
        method="POST",
        data={"confirmed_job_ids": [job_id]},
    )
    require(
        confirmation.get("status") == "success", "Synthetic confirmation was rejected"
    )

    proof["stage"] = "queue_and_remote_browser"
    deadline = time.monotonic() + 180
    final: dict[str, Any] = {}
    while time.monotonic() < deadline:
        tracker, _ = client.json(
            f"/applications/{user_id}", timeout=min(30, deadline - time.monotonic())
        )
        matches = [
            item for item in tracker.get("items", []) if item.get("id") == app_id
        ]
        require(len(matches) == 1, "Synthetic tracker item is missing")
        final = matches[0]
        if final.get("status") in {"applied", "failed", "needs_action"}:
            break
        time.sleep(4)
    proof.update(
        application_status=final.get("status"),
        attempts=final.get("attempts"),
        failure_reason=final.get("failure_reason"),
    )
    require(
        final.get("status") == "applied",
        "Controlled fixture did not reach applied; inspect application status and failure reason",
    )
    require(
        final.get("attempts") == 1,
        "Controlled fixture required more than one browser attempt",
    )
    require(final.get("applied_at"), "Applied timestamp was not persisted")
    history = final.get("status_history", [])
    proof["status_history"] = [event.get("status") for event in history]
    require(
        all(
            status in proof["status_history"]
            for status in ["planned", "confirmed", "applying", "applied"]
        ),
        "Application audit trail is incomplete",
    )
    require(
        all(event.get("timestamp") for event in history),
        "Status audit timestamps are missing",
    )

    proof["stage"] = "prep_guide"
    deadline = time.monotonic() + 180
    guide: dict[str, Any] = {}
    while time.monotonic() < deadline:
        status, body, _ = client.request(
            f"/applications/{app_id}/prep-guide",
            timeout=min(30, deadline - time.monotonic()),
        )
        if status == 404:
            time.sleep(4)
            continue
        require(status == 200, f"Prep guide returned HTTP {status}")
        guide = json.loads(body)
        break
    require(
        guide.get("round_count") == 2 and len(guide.get("rounds", [])) == 2,
        "Prep guide did not preserve the explicit two-round process",
    )
    require(
        set(guide.get("topics", {}).get("strong", [])) >= {"Python", "LangChain"},
        "Prep guide topics do not match synthetic skills",
    )
    require(
        {q.get("category") for q in guide.get("questions", [])}
        >= {"technical", "behavioral", "design"},
        "Prep question categories are incomplete",
    )
    require(
        isinstance(guide.get("company_intel"), dict),
        "Company intel fallback is missing",
    )
    proof.update(
        round_count=guide["round_count"],
        question_count=len(guide["questions"]),
        prep_guide_saved=True,
    )

    proof["stage"] = "report"
    report, _ = client.json(f"/report/{user_id}/generate", method="POST", data={})
    require(
        report.get("applied_count") == 1, "Weekly report applied count is incorrect"
    )
    proof["report_id"] = report["id"]
    deadline = time.monotonic() + 130
    while time.monotonic() < deadline:
        status, body, headers = client.request(
            f"/report/{user_id}/latest/html",
            timeout=min(30, deadline - time.monotonic()),
        )
        if status == 404:
            time.sleep(4)
            continue
        require(
            status == 200 and company.encode() in body and b"applied" in body,
            "Private HTML report is incomplete",
        )
        require(
            "no-store" in headers.get("cache-control", ""),
            "Report HTML may be cached publicly",
        )
        require(
            "default-src 'none'" in headers.get("content-security-policy", ""),
            "Report content policy is missing",
        )
        proof["html_report_saved"] = True
        break
    require(
        proof.get("html_report_saved"), "Private HTML report did not become visible"
    )
    library, _ = client.json(f"/resumes/{user_id}")
    require(
        any(item.get("application_id") == app_id for item in library.get("items", [])),
        "Generated PDF is missing from the resume library",
    )

    proof["stage"] = "logout"
    client.json("/session/logout", method="POST", data={})
    session, _ = client.json("/session")
    require(
        session.get("authenticated") is False, "Logout did not revoke the owner session"
    )
    require(
        client.request(f"/profile/{user_id}")[0] == 401,
        "Profile remains accessible after logout",
    )
    require(
        client.request(application["resume_url"])[0] == 401,
        "Private PDF remains accessible after logout",
    )
    proof.update(status="passed", stage="complete")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--run-live",
        action="store_true",
        help="Create synthetic records and submit ONLY the fixed controlled fixture",
    )
    parser.add_argument(
        "--base-url", choices=[WORKER, FRONTEND + "/api", LEGACY_FRONTEND + "/api"], default=FRONTEND + "/api"
    )
    parser.add_argument(
        "--proof",
        type=Path,
        default=Path("/tmp/hireflow-cloudflare-live-e2e-proof.json"),
    )
    args = parser.parse_args()
    if not args.run_live:
        parser.error(
            "Pass --run-live to explicitly enable this synthetic remote verification"
        )
    require(
        args.proof.resolve().parent == Path("/tmp").resolve(),
        "Keep the sanitized live verification proof in /tmp",
    )
    secret_file = ROOT / "cloudflare/.dev.vars"
    require(secret_file.is_file(), "Ignored cloudflare/.dev.vars is required")
    require(
        secret_file.stat().st_mode & 0o077 == 0, "Use mode 600 for cloudflare/.dev.vars"
    )
    access_code = dotenv_values(secret_file).get("ACCESS_CODE") or ""
    require(
        len(access_code) >= 24 and "\n" not in access_code and "\r" not in access_code,
        "A valid owner access code is required",
    )
    proof: dict[str, Any] = {
        "status": "failed",
        "base_url": args.base_url,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "synthetic_records_retained": True,
        "emails_sent": 0,
    }
    with tempfile.TemporaryDirectory(prefix="hireflow-live-private-") as directory:
        client = CurlSession(args.base_url, access_code, Path(directory))
        try:
            verify(client, proof)
        except Exception as error:
            proof["error_type"] = type(error).__name__
            proof["error"] = (
                str(error).replace(access_code, "[redacted]")
                if isinstance(error, VerificationFailure)
                else "Verification interrupted; no raw provider or HTTP response is logged"
            )
        finally:
            proof["requests"] = client.requests
            proof["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            private_file(args.proof, json.dumps(proof, indent=2).encode())
    print(json.dumps(proof, indent=2))
    return 0 if proof["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
