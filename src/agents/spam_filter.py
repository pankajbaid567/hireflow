"""
Spam Filter Agent

Analyzes job listings for spam or low-quality data.
Identifies fake companies, unrealistic claims, or extremely sparse descriptions.
"""

import argparse
import sys
import logging
import math

from src.utils.llm_client import get_llm_client
from src.config.settings import get_settings
from src.config.database import SessionLocal
from src.models.job import Job


logger = logging.getLogger(__name__)


class SpamFilter:
    def __init__(self, threshold: float | None = None):
        self.threshold = get_settings().spam_filter_threshold if threshold is None else threshold
        self.llm = get_llm_client()

    def score(self, job_data: dict) -> dict:
        """
        Evaluate a job listing and return a spam score.
        
        Args:
            job_data: dict containing keys like 'jd_text', 'company_name', 'skills_required'
            
        Returns:
            dict with keys: 'spam_confidence' (float), 'is_spam' (bool), 'reason' (str)
        """
        jd_text = job_data.get("jd_text", "").strip()
        company = job_data.get("company_name", "").strip()
        
        # Heuristic 1: Missing company name
        if not company:
            return {
                "spam_confidence": 1.0,
                "is_spam": True,
                "reason": "Missing company name"
            }
            
        # Call LLM for NLP Classification
        prompt = f"""
        You are an expert NLP classifier for a job board. Your task is to analyze the following job listing and score it for spam (0.0 = completely legitimate, 1.0 = obvious spam).
        
        Spam indicators to look for:
        - Vague "rockstar" or "ninja" language without any actual substance.
        - Unrealistic salary claims or promises.
        - Extremely short description (under 50 words) with NO specific technical skills mentioned.
        
        IMPORTANT EXCEPTION:
        A short description (e.g., 20 words) from a legitimate startup that mentions specific technical skills (e.g. "Python", "React", "Data Pipeline") is NOT spam. Score it very low (e.g., 0.1).
        
        Job Data:
        - Company: {company}
        - Description: {jd_text[:3000]}  # truncated for safety
        - Skills: {job_data.get("skills_required", [])}
        
        Return ONLY valid JSON with two keys:
        - "spam_confidence": a float between 0.0 and 1.0
        - "reasoning": a brief explanation for your score
        """
        
        try:
            result = self.llm.extract(prompt)
            if not isinstance(result, dict):
                raise ValueError("LLM did not return a JSON object")
                
            confidence = float(result.get("spam_confidence", 0.0))
            if not math.isfinite(confidence) or not 0 <= confidence <= 1:
                raise ValueError("Invalid classifier confidence")
            is_spam = confidence >= self.threshold
            reason = result.get("reasoning", "")
            
            return {
                "spam_confidence": confidence,
                "is_spam": is_spam,
                "reason": reason
            }
        except Exception as e:
            logger.warning("Spam classifier unavailable (%s)", type(e).__name__)
            # Failsafe: if LLM fails, assume not spam to prevent blocking good jobs
            return {
                "spam_confidence": None,
                "is_spam": False,
                "classification_available": False,
                "reason": "Classification unavailable; this is not evidence of employer legitimacy."
            }


def run_filter_on_database():
    """CLI mode: Iterate through all jobs in the database and score them."""
    filter = SpamFilter()
    db = SessionLocal()
    
    try:
        # Fetch jobs that haven't been scored yet (where spam_confidence is None)
        # But for this issue, we will score ALL jobs to ensure coverage.
        jobs = db.query(Job).all()
        print(f"Found {len(jobs)} jobs in database to score.")
        
        spam_count = 0
        for i, job in enumerate(jobs):
            job_data = {
                "jd_text": job.description or "",
                "company_name": job.company or "",
                "skills_required": []  # Not extracted yet at this DB stage
            }
            
            print(f"[{i+1}/{len(jobs)}] Scoring '{job.title}' at {job.company}...")
            result = filter.score(job_data)
            
            if result.get("classification_available") is False or result.get("spam_confidence") is None:
                print("  -> Classification unavailable; previous assessment retained.")
                continue
            job.spam_confidence = result["spam_confidence"]
            job.is_spam = result["is_spam"]
            
            if job.is_spam:
                print(f"  -> SPAM DETECTED ({job.spam_confidence}): {result.get('reason')}")
                spam_count += 1
                
            db.commit()
            
        print(f"\nFinished scoring. Detected {spam_count} spam jobs out of {len(jobs)}.")
        
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HireFlow Spam Filter Agent")
    parser.add_argument("--run", action="store_true", help="Run spam filter against all jobs in the database")
    args = parser.parse_args()
    
    if args.run:
        run_filter_on_database()
    else:
        parser.print_help()
        sys.exit(1)
