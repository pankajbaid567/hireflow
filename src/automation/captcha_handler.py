"""Recognize challenges; never attempt to solve or bypass them."""

from pathlib import Path
from urllib.parse import unquote, urlparse


def normalize_url(url):
    if url.startswith("file://"):
        parts = urlparse(url)
        path = unquote((parts.netloc + parts.path) if parts.netloc else parts.path)
        return Path(path).resolve().as_uri()
    return url


class CaptchaHandler:
    selectors = (
        'iframe[src*="recaptcha"]',
        ".g-recaptcha",
        "[data-sitekey]",
        'iframe[src*="hcaptcha"]',
        ".h-captcha",
        'iframe[src*="challenges.cloudflare.com"]',
        ".cf-turnstile",
        'img[src*="captcha" i]',
        'img[alt*="captcha" i]',
        'input[name*="captcha" i]:not([type="hidden"])',
        '[id="captcha-challenge"]',
    )

    def detect(self, page_or_url):
        if isinstance(page_or_url, str):
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    page.goto(
                        normalize_url(page_or_url),
                        wait_until="domcontentloaded",
                        timeout=15000,
                    )
                    return self.detect(page)
                finally:
                    browser.close()
        page = page_or_url
        if any(page.locator(selector).count() for selector in self.selectors):
            return True
        text = page.locator("body").inner_text().lower()
        return any(
            phrase in text
            for phrase in (
                "verify you are human",
                "verify that you are human",
                "complete the captcha",
                "select all images",
                "enter the characters shown",
                "i am not a robot",
            )
        )
