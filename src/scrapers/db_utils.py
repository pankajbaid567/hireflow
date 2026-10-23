"""
Database utility functions for scrapers.

Provides helpers to save scraped Job objects to the database,
handling deduplication via URL uniqueness.
"""

from sqlalchemy.exc import IntegrityError

from src.config.database import SessionLocal
from src.models.job import Job


def save_jobs_to_db(jobs: list[Job]) -> int:
    """
    Save a list of Job objects to the database.

    Skips duplicates based on the unique URL constraint.
    Returns the number of successfully saved jobs.

    Args:
        jobs: List of Job model instances to persist.

    Returns:
        Number of jobs that were actually inserted (excludes duplicates).
    """
    saved_count = 0
    db = SessionLocal()
    try:
        from src.utils.listings import enrich_job, canonical_url
        for job in jobs:
            if len((job.description or "").strip()) < 100 or (job.description or "").strip() == "Extracted via Generic Scraper":
                continue  # Incomplete evidence is not a verified full-JD record.
            job.url = canonical_url(job.url)
            enrich_job(job)
            # Check if a job with this URL already exists
            existing = db.query(Job).filter(Job.url == job.url).first()
            if existing:
                continue
            db.add(job)
            try:
                db.flush()
                saved_count += 1
            except IntegrityError:
                # Race condition: another process inserted the same URL
                db.rollback()
                continue
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
    return saved_count
