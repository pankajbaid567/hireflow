"""
Lever ATS scraper.

Scrapes job listings from Lever career pages (jobs.lever.co/<company>).
Extracts all required fields and saves to the jobs table.

Usage:
    python -m src.scrapers.lever_scraper --url "https://jobs.lever.co/anthropic" --mode job
    python -m src.scrapers.lever_scraper --url "https://jobs.lever.co/anthropic" --mode list
"""

import argparse
import time
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from src.models.job import Job, ListingType
from src.utils.listings import enrich_job
from src.scrapers.static_scraper import structured_postings

# Keywords that indicate an internship listing
INTERNSHIP_KEYWORDS = ("intern", "co-op", "coop", "apprentice", "trainee")

# Minimum delay (seconds) between consecutive HTTP requests
RATE_LIMIT_DELAY = 1.0


def classify_listing_type(title: str) -> ListingType:
    """
    Classify a job title as internship or job based on keyword matching.

    Args:
        title: The job title string to classify.

    Returns:
        ListingType.internship if any internship keyword is found,
        ListingType.job otherwise.
    """
    title_lower = title.lower()
    for keyword in INTERNSHIP_KEYWORDS:
        if keyword in title_lower:
            return ListingType.internship
    return ListingType.job


def extract_company_from_url(url: str) -> str:
    """
    Extract the company name/slug from a Lever URL.

    Args:
        url: A URL like "https://jobs.lever.co/anthropic"

    Returns:
        The company slug, e.g. "anthropic"
    """
    parsed = urlparse(url)
    # Path is like "/anthropic" or "/anthropic/"
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    return parts[0] if parts else "unknown"


def parse_listing_page(html: str, base_url: str) -> list[dict]:
    """
    Parse a Lever listing page and extract job posting links and metadata.

    Lever renders all postings on a single page — each posting is a div
    with class "posting" containing a link to the detail page.

    Args:
        html: Raw HTML of the Lever listings page.
        base_url: The base URL for resolving relative links.

    Returns:
        List of dicts with keys: title, location, url, categories
    """
    soup = BeautifulSoup(html, "lxml")
    postings = []

    for posting in soup.select(".posting"):
        # Title
        title_el = posting.select_one(".posting-title h5, a.posting-title")
        title = title_el.get_text(strip=True) if title_el else ""

        # Location
        location_el = posting.select_one(
            ".posting-categories .sort-by-location, "
            ".posting-categories .location"
        )
        location = location_el.get_text(strip=True) if location_el else ""

        # URL — the anchor wrapping the posting title
        link_el = posting.select_one("a.posting-btn-submit")
        if not link_el:
            link_el = posting.select_one("a[href]")
        url = link_el["href"] if link_el and link_el.get("href") else ""

        # If the URL is just "/apply", make it absolute
        if url and not url.startswith("http"):
            url = base_url.rstrip("/") + "/" + url.lstrip("/")

        # Extract the posting detail page URL (not the apply URL)
        detail_link = posting.select_one("a.posting-title")
        detail_url = ""
        if detail_link and detail_link.get("href"):
            detail_url = detail_link["href"]
            if not detail_url.startswith("http"):
                detail_url = base_url.rstrip("/") + "/" + detail_url.lstrip("/")

        postings.append({
            "title": title,
            "location": location,
            "application_url": url,
            "detail_url": detail_url if detail_url else url,
        })

    return postings


def parse_detail_page(html: str) -> dict:
    """
    Parse a Lever job detail page and extract the full job description
    and posting date.

    Args:
        html: Raw HTML of the Lever job detail page.

    Returns:
        Dict with keys: jd_text, posted_date
    """
    soup = BeautifulSoup(html, "lxml")

    # Job description — the main content sections
    content_sections = soup.select(".section-wrapper.page-full-width")
    jd_parts = []
    for section in content_sections:
        text = section.get_text(separator="\n", strip=True)
        if text:
            jd_parts.append(text)
    jd_text = "\n\n".join(jd_parts) if jd_parts else ""

    # If no sections found, try the content div directly
    if not jd_text:
        content_div = soup.select_one(".content, .posting-page")
        if content_div:
            jd_text = content_div.get_text(separator="\n", strip=True)

    # Posting date — Lever often includes commitment/team/date in categories
    posted_date = None
    commitment_el = soup.select_one(
        ".posting-categories .sort-by-commitment, "
        ".posting-categories .commitment"
    )
    # Lever doesn't reliably expose posting date on detail pages.
    # We leave it as None; a future enhancement can extract from APIs.

    return {
        "jd_text": jd_text,
        "structured_posting": next(iter(structured_postings(html)), None),
        "posted_date": posted_date,
    }


class LeverScraper:
    """
    Scraper for Lever career pages.

    Navigates to a company's Lever career page, collects all job postings,
    visits each detail page to extract the full description, and returns
    Job model instances ready for DB insertion.

    Attributes:
        url: The Lever career page URL.
        company_name: Extracted company slug from the URL.
        jobs: List of scraped Job instances.
    """

    def __init__(self, url: str):
        """
        Initialize the Lever scraper.

        Args:
            url: Lever career page URL (e.g., "https://jobs.lever.co/anthropic")
        """
        self.url = url
        self.company_name = extract_company_from_url(url)
        self.jobs: list[Job] = []

    def scrape(self) -> list[Job]:
        """
        Execute the full scraping pipeline using Playwright.

        1. Navigate to the listing page
        2. Collect all posting metadata
        3. Visit each detail page (with rate limiting)
        4. Parse and create Job objects

        Returns:
            List of Job model instances with all extracted fields.
        """
        self.jobs = []

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
                listing_html = page.content()

                # Parse listing page to get all posting metadata
                postings = parse_listing_page(listing_html, self.url)

                for posting in postings:
                    if not posting.get("detail_url"):
                        continue

                    # Rate limiting
                    time.sleep(RATE_LIMIT_DELAY)

                    # Navigate to detail page
                    detail_page = context.new_page()
                    try:
                        detail_page.goto(
                            posting["detail_url"], wait_until="domcontentloaded"
                        )
                        detail_html = detail_page.content()
                        detail_data = parse_detail_page(detail_html)

                        listing_type = classify_listing_type(posting["title"])

                        job = Job(
                            title=posting["title"],
                            company=self.company_name,
                            location=posting["location"],
                            description=detail_data["jd_text"],
                            url=posting["application_url"]
                            or posting["detail_url"],
                            posted_date=detail_data["posted_date"],
                            listing_type=listing_type,
                        )
                        enrich_job(job, detail_data.get("structured_posting"))
                        self.jobs.append(job)
                    finally:
                        detail_page.close()

            finally:
                context.close()
                browser.close()

        return self.jobs

    def scrape_from_html(
        self, listing_html: str, detail_htmls: list[str]
    ) -> list[Job]:
        """
        Parse pre-fetched HTML without using Playwright.

        This method is designed for testing — it accepts raw HTML strings
        and runs the same parsing logic without requiring a browser.

        Args:
            listing_html: HTML of the Lever listing page.
            detail_htmls: List of HTML strings for each job detail page.

        Returns:
            List of Job model instances.
        """
        self.jobs = []
        postings = parse_listing_page(listing_html, self.url)

        for i, posting in enumerate(postings):
            if i < len(detail_htmls):
                detail_data = parse_detail_page(detail_htmls[i])
            else:
                detail_data = {"jd_text": "", "posted_date": None}

            listing_type = classify_listing_type(posting["title"])

            job = Job(
                title=posting["title"],
                company=self.company_name,
                location=posting["location"],
                description=detail_data["jd_text"],
                url=posting["application_url"] or posting["detail_url"],
                posted_date=detail_data["posted_date"],
                listing_type=listing_type,
            )
            enrich_job(job, detail_data.get("structured_posting"))
            self.jobs.append(job)

        return self.jobs


def main():
    """CLI entry point for the Lever scraper."""
    parser = argparse.ArgumentParser(
        description="Scrape job listings from a Lever career page."
    )
    parser.add_argument(
        "--url",
        required=True,
        help="Lever career page URL (e.g., https://jobs.lever.co/anthropic)",
    )
    parser.add_argument(
        "--mode",
        choices=["list", "job"],
        default="list",
        help="'list' to print jobs, 'job' to save to database",
    )
    args = parser.parse_args()

    scraper = LeverScraper(args.url)
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
