def job_data(job):
    return {"listing_type":job.listing_type.value,"source":job.source,"canonical_url":job.canonical_url or job.url,"application_url":job.application_url or job.url,"required_skills":job.required_skills or [],"required_experience":job.required_experience,"posted_date":job.posted_date.isoformat() if job.posted_date else None,"expires_at":job.expires_at.isoformat() if job.expires_at else None,"selection_process":job.selection_process or [],"compensation":job.compensation,"provenance":job.provenance or {},"quality":{"risk":job.spam_confidence,"reason":job.quality_reason,"method":job.quality_method}}


def application_data(application):
    snapshot = (application.job_snapshot or {}) if application.status.value not in {"pending", "planned"} else {}
    return {
        "id": application.id,
        "job_id": application.job_id,
        **job_data(application.job),
        **{key:value for key,value in snapshot.items() if key in job_data(application.job)},
        "company": snapshot.get("company") or application.job.company,
        "role": snapshot.get("role") or application.job.title,
        "status": application.status.value,
        "match_score": application.match_score,
        "skill_gaps": application.skill_gaps,
        "resume_version": application.resume_version,
        "resume_url": (
            f"/resumes/{application.user_id}/{application.id}/download"
            if application.resume_path
            else None
        ),
        "prep_guide_url": (
            f"/applications/{application.id}/prep-guide"
            if application.prep_guide
            else None
        ),
        "failure_reason": application.failure_reason,
        "manual_action_url": application.manual_action_url,
        "applied_at": application.applied_at,
        "created_at": application.created_at,
        "attempts": application.attempts,
        "status_history": [
            {
                "status": event.status,
                "reason": event.reason,
                "timestamp": event.created_at,
            }
            for event in application.status_history
        ],
    }
