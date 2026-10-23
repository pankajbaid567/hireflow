"""Compile a UTC weekly cycle into a database record and shareable HTML."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path

from sqlalchemy import and_, or_
from sqlalchemy.orm import joinedload

from src.config.database import SessionLocal
from src.config.settings import get_settings
from src.models import Application, ApplicationStatus, User, WeeklyReport
from src.utils.dates import week_start
from src.utils.skills import extract_skills, normalize_skill
from src.api.serializers import job_data


class ReportGenerator:
    def __init__(self, db=None, storage_path=None):
        self.db = db
        self.root = Path(storage_path or get_settings().local_storage_path) / "reports"

    def generate(self, user_id, *, as_of=None):
        db = self.db if self.db is not None else SessionLocal()
        try:
            user = db.get(User, user_id)
            if user is None:
                raise ValueError("Profile not found")
            start = week_start(as_of)
            end = start + timedelta(days=7)
            rows = (
                db.query(Application)
                .options(
                    joinedload(Application.job), joinedload(Application.prep_guide)
                )
                .filter(
                    Application.user_id == user_id,
                    or_(
                        Application.cycle_start == start,
                        and_(
                            Application.cycle_start.is_(None),
                            Application.status != ApplicationStatus.pending,
                            Application.created_at
                            >= datetime.combine(
                                start, datetime.min.time(), timezone.utc
                            ),
                            Application.created_at
                            < datetime.combine(end, datetime.min.time(), timezone.utc),
                        ),
                    ),
                )
                .order_by(Application.id)
                .all()
            )
            skills = Counter()
            role_scores = defaultdict(list)
            applications = []
            base = get_settings().public_base_url.rstrip("/")
            for app in rows:
                skills.update(set(extract_skills((app.job_snapshot or {}).get("description") or app.job.description or "")))
                if app.match_score is not None:
                    role_scores[(app.job_snapshot or {}).get("role") or app.job.title].append(app.match_score)
                instructions = None
                if app.status == ApplicationStatus.failed:
                    instructions = "Review the failure reason and apply manually at the listing URL."
                elif app.status == ApplicationStatus.needs_action:
                    instructions = "Open the manual action URL, complete the required step, and check whether the application was received before resubmitting."
                applications.append(
                    {
                        "id": app.id,
                        **job_data(app.job),
                        **{key:value for key,value in (app.job_snapshot or {}).items() if key in job_data(app.job)},
                        "company": (app.job_snapshot or {}).get("company") or app.job.company,
                        "role": (app.job_snapshot or {}).get("role") or app.job.title,
                        "status": app.status.value,
                        "match_score": app.match_score,
                        "resume_url": (
                            base + f"/resumes/{user_id}/{app.id}/download"
                            if app.resume_path
                            else None
                        ),
                        "prep_guide_url": (
                            base + f"/applications/{app.id}/prep-guide"
                            if app.prep_guide
                            else None
                        ),
                        "failure_reason": app.failure_reason,
                        "manual_action_url": app.manual_action_url
                        or (app.job.url if instructions else None),
                        "instructions": instructions,
                    }
                )
            known = {
                normalize_skill(s)
                for s in (user.master_profile or {}).get("skills", [])
            }
            counts = sorted(
                skills.items(), key=lambda pair: (-pair[1], pair[0].casefold())
            )
            averages = {
                role: sum(values) / len(values) for role, values in role_scores.items()
            }
            types = sorted(averages, key=lambda role: (-averages[role], role))
            applied_count = sum(app.status == ApplicationStatus.applied for app in rows)
            scores = [app.match_score for app in rows if app.match_score is not None]
            metrics = {
                "application_count": len(rows),
                "applied_count": applied_count,
                "failed_count": sum(
                    app.status == ApplicationStatus.failed for app in rows
                ),
                "needs_action_count": sum(
                    app.status == ApplicationStatus.needs_action for app in rows
                ),
                "avg_match_score": round(sum(scores) / len(scores), 4) if scores else 0,
            }
            mode_groups = []
            for kind in ("internship", "job"):
                members = [item for item in applications if item["listing_type"] == kind]
                mode_groups.append({"listing_type":kind,"total_applications":len(members),"applied_count":sum(item["status"] == "applied" for item in members),"applications":members})
            metrics["quota_policy"] = "shared_across_modes_per_UTC_week"
            metrics["mode_summaries"] = [{key:value for key,value in group.items() if key != "applications"} for group in mode_groups]
            content = {
                "mode_groups": mode_groups,
                "week_start": start.isoformat(),
                "applications": applications,
                "top_skills": [{"skill": s, "frequency": n} for s, n in counts[:5]],
                "strongest_match_type": types[0] if types else None,
                "weakest_match_type": types[-1] if types else None,
                "study_plan": [
                    {
                        "skill": s,
                        "frequency": n,
                        "instruction": f"Study {s}, build a small example, and practice explaining it.",
                    }
                    for s, n in counts
                    if normalize_skill(s) not in known
                ][:3],
            }
            row = (
                db.query(WeeklyReport)
                .filter_by(user_id=user_id, week_start_date=start)
                .first()
            )
            if row is None:
                row = WeeklyReport(user_id=user_id, week_start_date=start)
                db.add(row)
            row.metrics, row.content = metrics, content
            row.applied_count, row.avg_match_score = (
                applied_count,
                metrics["avg_match_score"],
            )
            directory = self.root / str(user_id)
            directory.mkdir(parents=True, exist_ok=True)
            year, week, _ = start.isocalendar()
            path = directory / f"week_{year}_{week:02d}.html"
            temporary = path.with_suffix(".html.tmp")
            temporary.write_text(
                self.render_html(user.name, metrics, content), encoding="utf-8"
            )
            temporary.replace(path)
            row.html_path = str(path.resolve())
            db.commit()
            db.refresh(row)
            return {
                "id": row.id,
                "week_start": start,
                "metrics": metrics,
                "content": content,
                "applied_count": row.applied_count,
                "avg_match_score": row.avg_match_score,
                "html_url": f"/report/{user_id}/latest/html",
                "email_sent_at": row.email_sent_at,
            }
        finally:
            if self.db is None:
                db.close()

    @staticmethod
    def render_html(name, metrics, content):
        def link(url, label):
            from urllib.parse import urlparse

            if not url or urlparse(url).scheme not in {"http", "https"}:
                return ""
            return f'<a href="{escape(url, quote=True)}">{escape(label)}</a>'

        sections = []
        for app in content["applications"]:
            score = (
                f'{app["match_score"]:.0%}'
                if app["match_score"] is not None
                else "Unscored"
            )
            sections.append(
                f'<article><h3>{escape(app["company"])} - {escape(app["role"])}</h3><p><strong>{escape(app["status"])}</strong> | Match: {score}</p>'
                + (
                    f'<p class="action">{escape(app["failure_reason"] or "")} {escape(app["instructions"] or "")}</p>'
                    if app["instructions"]
                    else ""
                )
                + f'<p>{escape(app.get("listing_type", ""))} | Source: {escape(app.get("source") or "Not recorded")}</p>'
                + (f'<p>Pay: {escape(str(app["compensation"].get("currency") or "Currency unspecified"))} {escape(str(app["compensation"].get("minimum")))}–{escape(str(app["compensation"].get("maximum")))} / {escape(str(app["compensation"].get("period") or "period unspecified"))}</p>' if (app.get("compensation") or {}).get("disclosed") else '<p>Pay not disclosed.</p>')
                + "<p>"
                + " | ".join(
                    filter(
                        None,
                        (
                            link(app["resume_url"], "Resume PDF"),
                            link(app["prep_guide_url"], "Prep guide"),
                            link(app["manual_action_url"], "Open application"),
                        ),
                    )
                )
                + "</p></article>"
            )
        study = "".join(
            f'<li><strong>{escape(item["skill"])}</strong> - {item["frequency"]} listings. {escape(item["instruction"])}</li>'
            for item in content["study_plan"]
        )
        top = (
            ", ".join(
                f'{escape(i["skill"])} ({i["frequency"]})'
                for i in content["top_skills"]
            )
            or "No skills recorded yet"
        )
        modes = "".join(f'<li>{escape(group["listing_type"])}: {group["total_applications"]} opportunities, {group["applied_count"]} applied</li>' for group in content.get("mode_groups", []))
        return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HireFlow weekly report</title>
<style>body{{font:16px/1.6 system-ui,sans-serif;color:#183b3b;background:#f4f7f5;max-width:880px;margin:auto;padding:32px}}article{{background:white;padding:20px;border:1px solid #d7e5de;border-radius:12px;margin:16px 0}}a{{color:#087469}}.action{{background:#fff2dd;padding:12px}}h1,h2,h3{{line-height:1.3}}</style></head><body>
<p>HIREFLOW / WEEKLY REPORT</p><h1>{escape(name)}'s week of {escape(content["week_start"])}</h1>
<p>{metrics["application_count"]} applications | {metrics["applied_count"]} applied | {metrics["needs_action_count"]} need action | {metrics["failed_count"]} failed</p>
<h2>Modes this week</h2><p>Internship and Job share one weekly quota. Switching modes does not reset submitted/attempted usage.</p><ul>{modes}</ul>
<h2>This week's opportunities</h2>{"".join(sections) or "<p>No applications in this weekly cycle.</p>"}
<h2>Across your applications</h2><p>Top skills: {top}</p><p>Strongest match: {escape(content["strongest_match_type"] or "Not available")}. Weakest match: {escape(content["weakest_match_type"] or "Not available")}.</p>
<h2>Your study plan</h2><ol>{study or "<li>No missing skills identified this week.</li>"}</ol></body></html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate a HireFlow weekly report")
    parser.add_argument("--user-id", required=True, type=int)
    args = parser.parse_args()
    import json

    print(json.dumps(ReportGenerator().generate(args.user_id), indent=2, default=str))


if __name__ == "__main__":
    main()
