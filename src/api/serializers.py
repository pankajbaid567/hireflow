def application_data(application):
    return {
        "id": application.id,
        "job_id": application.job_id,
        "company": application.job.company,
        "role": application.job.title,
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
