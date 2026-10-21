"""Apply to one listing, preserving failures and avoiding duplicate submissions."""

import logging
import time

from playwright.sync_api import (
    Error as PlaywrightError,
    TimeoutError as PlaywrightTimeout,
    sync_playwright,
)

from src.automation.captcha_handler import CaptchaHandler, normalize_url
from src.automation.form_filler import (
    FormFiller,
    FormStructureError,
    ManualActionRequired,
)
from src.models.application import Application, ApplicationStatus
from src.utils.status_logger import StatusLogger

logger = logging.getLogger(__name__)


class ApplicationAgent:
    def __init__(
        self,
        max_retries=3,
        retry_delay=1,
        *,
        llm_client=None,
        timeout_ms=15000,
        headless=True,
        sleep=time.sleep,
    ):
        if max_retries < 1 or retry_delay < 0:
            raise ValueError("max_retries must be positive and retry_delay nonnegative")
        self.max_retries, self.retry_delay = max_retries, retry_delay
        self.filler = FormFiller(llm_client, timeout_ms)
        self.captcha = CaptchaHandler()
        self.timeout_ms, self.headless, self.sleep = timeout_ms, headless, sleep

    def _attempt(self, application_url, resume_path, user_profile, jd_text):
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=self.headless)
            try:
                page = browser.new_page()
                page.set_default_timeout(self.timeout_ms)
                response = page.goto(
                    normalize_url(application_url), wait_until="domcontentloaded"
                )
                if response and response.status >= 500:
                    raise ConnectionError(
                        f"Career page returned HTTP {response.status}"
                    )
                if response and response.status >= 400:
                    raise FormStructureError(
                        f"Career page returned HTTP {response.status}"
                    )
                if self.captcha.detect(page):
                    raise ManualActionRequired("CAPTCHA detected")
                fields, form = self.filler.fill(
                    page, user_profile, resume_path, jd_text
                )
                if self.captcha.detect(page):
                    raise ManualActionRequired("CAPTCHA detected")
                try:
                    self.filler.submit(page, form)
                except ManualActionRequired:
                    if self.captcha.detect(page):
                        raise ManualActionRequired("CAPTCHA detected")
                    raise
                return fields
            finally:
                browser.close()

    def apply(
        self,
        application_url,
        resume_path,
        user_profile,
        jd_text="",
        *,
        db=None,
        application_id=None,
    ):
        result = {
            "status": "failed",
            "fields_filled": [],
            "attempts": 0,
            "failure_reason": None,
            "manual_action_url": None,
        }
        try:
            app = db.get(Application, application_id) if db is not None else None
            if db is not None and app is None:
                raise ValueError("A valid application_id is required when saving to DB")
            if app is not None:
                if app.status == ApplicationStatus.applied:
                    return {**result, "status": "applied", "attempts": app.attempts}
                if app.status != ApplicationStatus.confirmed:
                    raise ValueError("Application must be confirmed before applying")
                # Atomic claim prevents two workers from submitting the same confirmed record.
                claimed = (
                    db.query(Application)
                    .filter(
                        Application.id == app.id,
                        Application.status == ApplicationStatus.confirmed,
                    )
                    .update(
                        {"status": ApplicationStatus.applying},
                        synchronize_session=False,
                    )
                )
                if claimed != 1:
                    raise ValueError("Application is already being processed")
                from src.models.status_event import ApplicationStatusEvent

                db.add(ApplicationStatusEvent(application_id=app.id, status="applying"))
                db.commit()
                db.refresh(app)
            for attempt in range(1, self.max_retries + 1):
                result["attempts"] = attempt
                try:
                    result["fields_filled"] = self._attempt(
                        application_url, resume_path, user_profile, jd_text
                    )
                    result.update(status="applied", failure_reason=None)
                    break
                except ManualActionRequired as exc:
                    result.update(
                        status="needs_action",
                        failure_reason=str(exc),
                        manual_action_url=application_url,
                    )
                    break
                except FormStructureError as exc:
                    result["failure_reason"] = str(exc)
                    break
                except (PlaywrightTimeout, ConnectionError, OSError) as exc:
                    result["failure_reason"] = f"Temporary network failure: {exc}"
                    if attempt < self.max_retries:
                        self.sleep(self.retry_delay * 2 ** (attempt - 1))
                except PlaywrightError as exc:
                    result["failure_reason"] = f"Browser failure: {exc}"
                    if any(code in str(exc) for code in ("net::ERR_", "NS_ERROR_NET_")):
                        if attempt < self.max_retries:
                            self.sleep(self.retry_delay * 2 ** (attempt - 1))
                    else:
                        break
                except Exception as exc:
                    result["failure_reason"] = f"Application error: {exc}"
                    break
            if app is not None:
                app.attempts = result["attempts"]
                StatusLogger(db).log(
                    app,
                    result["status"],
                    result["failure_reason"],
                    result["manual_action_url"],
                )
        except Exception as exc:
            if db is not None:
                db.rollback()
            result.update(status="failed", failure_reason=str(exc))
            logger.exception("Application could not be processed or persisted")
        return result
