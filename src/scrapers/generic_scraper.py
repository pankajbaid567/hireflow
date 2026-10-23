"""
Generic scraper for custom career pages.

Auto-detects whether a page is static HTML or JavaScript-rendered (SPA).
Routes to StaticScraper for static pages, and uses Playwright for dynamic pages.
"""

import argparse
import requests
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from src.models.job import Job
from src.scrapers.static_scraper import StaticScraper, extract_jobs_with_llm, extract_company_from_url


def is_dynamic_page(html: str) -> bool:
    """
    Heuristic to detect if a page is a JavaScript-rendered SPA.
    
    Returns True if:
    - Body text is extremely short (< 500 chars)
    - Root elements like <div id="root"> are empty
    - There is a prominent <noscript> tag indicating JS is required
    """
    soup = BeautifulSoup(html, "lxml")
    body = soup.body
    if not body:
        return True
        
    # Check text content length
    text_content = body.get_text(strip=True)
    if len(text_content) < 500:
        return True
        
    # Check for common SPA empty root divs
    for root_id in ["root", "app", "__next", "mount"]:
        root_el = body.find(id=root_id)
        if root_el:
            root_text = root_el.get_text(strip=True)
            if len(root_text) < 100:
                return True
                
    # Check for noscript indicating JS requirement
    noscript = body.find("noscript")
    if noscript:
        noscript_text = noscript.get_text(strip=True).lower()
        if "enable javascript" in noscript_text or "javascript is required" in noscript_text:
            return True
            
    return False


class GenericScraper:
    """
    A generic scraper that handles both static and dynamic career pages.
    """
    def __init__(self, url: str):
        self.url = url
        self.company_name = extract_company_from_url(url)
        self.jobs: list[Job] = []

    def scrape(self) -> list[Job]:
        """
        Auto-detect the page type and scrape jobs.
        """
        print(f"Fetching {self.url} to determine page type...")
        response = requests.get(self.url, timeout=10)
        response.raise_for_status()
        
        if not is_dynamic_page(response.text):
            print("Detected static HTML page. Using requests + LLM parser.")
            static_scraper = StaticScraper(self.url)
            self.jobs = static_scraper.scrape_from_html(response.text)
            return self.jobs
            
        print("Detected JavaScript-rendered SPA. Using Playwright + LLM parser.")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            )
            try:
                page = context.new_page()
                page.goto(self.url, wait_until="domcontentloaded")
                # Wait an extra second to allow JS frameworks to render
                page.wait_for_timeout(1000)
                rendered_html = page.content()
                
                def load_detail(url):
                    detail = context.new_page()
                    try:
                        detail.goto(url, wait_until="domcontentloaded", timeout=15000)
                        return detail.content()[:500000]
                    finally:
                        detail.close()
                self.jobs = extract_jobs_with_llm(rendered_html, self.url, detail_loader=load_detail)
            finally:
                context.close()
                browser.close()
                
        return self.jobs

    def scrape_from_html(self, html: str, force_dynamic: bool = False) -> list[Job]:
        """
        Test helper to bypass network and auto-detection.
        """
        if force_dynamic or is_dynamic_page(html):
            # In a real dynamic scenario, HTML passed here would be the pre-rendered shell.
            # But for testing extraction, we just assume it's fully rendered HTML.
            pass
            
        self.jobs = extract_jobs_with_llm(html, self.url)
        return self.jobs


def main():
    """CLI entry point for the generic scraper."""
    parser = argparse.ArgumentParser(description="Generic scraper for custom career pages.")
    parser.add_argument("--url", required=True, help="Career page URL")
    parser.add_argument("--mode", choices=["list", "job"], default="list")
    args = parser.parse_args()

    scraper = GenericScraper(args.url)
    jobs = scraper.scrape()

    if args.mode == "list":
        print(f"\nFound {len(jobs)} job(s) from {scraper.company_name}:\n")
        for job in jobs:
            print(f"  [{job.listing_type.value.upper()}] {job.title}")
            print(f"    Company:  {job.company}")
            print(f"    Location: {job.location}")
            print(f"    URL:      {job.url}")
            print()
    elif args.mode == "job":
        from src.scrapers.db_utils import save_jobs_to_db
        saved = save_jobs_to_db(jobs)
        print(f"Saved {saved} of {len(jobs)} jobs to database.")


if __name__ == "__main__":
    main()
