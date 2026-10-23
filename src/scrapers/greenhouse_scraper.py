"""
Greenhouse ATS scraper.

Scrapes job listings from Greenhouse career boards (boards.greenhouse.io/<company>).
Extracts all required fields and saves to the jobs table.

Usage:
    python -m src.scrapers.greenhouse_scraper --url "https://boards.greenhouse.io/notion" --mode job
    python -m src.scrapers.greenhouse_scraper --url "https://boards.greenhouse.io/notion" --mode list
"""

import argparse
import time
from urllib.parse import urlparse, urljoin

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
    Extract the company name/slug from a Greenhouse URL.

    Args:
        url: A URL like "https://boards.greenhouse.io/notion"

    Returns:
        The company slug, e.g. "notion"
    """
    parsed = urlparse(url)
    parts = [p for p in parsed.path.strip("/").split("/") if p]
    return parts[0] if parts else "unknown"


def parse_listing_page(html: str, base_url: str) -> list[dict]:
    """
    Parse a Greenhouse listing page and extract job posting links.

    Greenhouse renders job listings as a list of links, often grouped
    by department. Each job has a title and link to the detail page.

    Args:
        html: Raw HTML of the Greenhouse listings page.
        base_url: The base URL for resolving relative links.

    Returns:
        List of dicts with keys: title, location, detail_url
    """
    soup = BeautifulSoup(html, "lxml")
    postings = []

    # Greenhouse uses different HTML structures.
    # Pattern 1: .opening elements with links
    for opening in soup.select(".opening"):
        link_el = opening.select_one("a[href]")
        if not link_el:
            continue

        title = link_el.get_text(strip=True)
        href = link_el["href"]

        # Resolve relative URLs
        if not href.startswith("http"):
            parsed_base = urlparse(base_url)
            href = f"{parsed_base.scheme}://{parsed_base.netloc}{href}"

        # Location
        location_el = opening.select_one(".location")
        location = location_el.get_text(strip=True) if location_el else ""

        postings.append({
            "title": title,
            "location": location,
            "detail_url": href,
        })

    # Pattern 2: Job listing table rows (some Greenhouse boards)
    if not postings:
        for row in soup.select("div.job-post, tr.job-post"):
            link_el = row.select_one("a[href]")
            if not link_el:
                continue

            title = link_el.get_text(strip=True)
            href = link_el["href"]

            if not href.startswith("http"):
                parsed_base = urlparse(base_url)
                href = f"{parsed_base.scheme}://{parsed_base.netloc}{href}"

            location_el = row.select_one(".location, .job-post-location")
            location = location_el.get_text(strip=True) if location_el else ""

            postings.append({
                "title": title,
                "location": location,
                "detail_url": href,
            })

    return postings


def parse_detail_page(html: str) -> dict:
    """
    Parse a Greenhouse job detail page and extract the full job description
    and posting date.

    Args:
        html: Raw HTML of the Greenhouse job detail page.

    Returns:
        Dict with keys: jd_text, location, posted_date
    """
    soup = BeautifulSoup(html, "lxml")

    # Job description — Greenhouse uses #content or .job-post-content
    jd_text = ""
    content_el = soup.select_one("#content, .job-post-content")
    if content_el:
        jd_text = content_el.get_text(separator="\n", strip=True)

    # Fallback: try the main content area
    if not jd_text:
        main_el = soup.select_one("main, .main-content, .app-body")
        if main_el:
            jd_text = main_el.get_text(separator="\n", strip=True)

    # Location from detail page (may be more specific than listing)
    location = ""
    location_el = soup.select_one(".location, .job-post-location")
    if location_el:
        location = location_el.get_text(strip=True)

    # Posting date — Greenhouse doesn't reliably expose this in the HTML.
    posted_date = None

    return {
        "jd_text": jd_text,
        "structured_posting": next(iter(structured_postings(html)), None),
        "location": location,
        "posted_date": posted_date,
    }


def has_next_page(html: str) -> bool:
    """
    Check if the current Greenhouse listing page has a 'Next' pagination link.

    Args:
        html: Raw HTML of the current listing page.

    Returns:
        True if a clickable next page link exists.
    """
    soup = BeautifulSoup(html, "lxml")

    # Pattern 1: pagination with next button
    next_btn = soup.select_one(".pagination .next a, a.next_page")
    if next_btn:
        return True

    # Pattern 2: pagination__next that is not disabled
    next_el = soup.select_one(".pagination__next")
    if next_el:
        classes = next_el.get("class", [])
        if "inactive" not in classes and "disabled" not in classes:
            return True

    return False


def get_next_page_url(html: str, current_url: str) -> str | None:
    """
    Extract the URL for the next page from pagination elements.

    Args:
        html: Raw HTML of the current listing page.
        current_url: The current page URL for resolving relative links.

    Returns:
        The next page URL, or None if no next page exists.
    """
    soup = BeautifulSoup(html, "lxml")

    next_link = soup.select_one(
        ".pagination .next a, a.next_page, .pagination__next a"
    )
    if next_link and next_link.get("href"):
        href = next_link["href"]
        if not href.startswith("http"):
            href = urljoin(current_url, href)
        return href

    return None


class GreenhouseScraper:
    """
    Scraper for Greenhouse career boards.

    Navigates to a company's Greenhouse career board, collects all job
    postings across paginated pages, visits each detail page to extract
    the full description, and returns Job model instances.

    Attributes:
        url: The Greenhouse career board URL.
        company_name: Extracted company slug from the URL.
        jobs: List of scraped Job instances.
    """

    def __init__(self, url: str):
        """
        Initialize the Greenhouse scraper.

        Args:
            url: Greenhouse board URL (e.g., "https://boards.greenhouse.io/notion")
        """
        self.url = url
        self.company_name = extract_company_from_url(url)
        self.jobs: list[Job] = []

    def scrape(self) -> list[Job]:
        """
        Execute the full scraping pipeline using Playwright.

        Handles pagination by checking for a next page link after each page.

        Returns:
            List of Job model instances with all extracted fields.
        """
        self.jobs = []
        all_postings = []

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
                current_url = self.url

                # Phase 1: Collect all postings across paginated pages
                while True:
                    page.goto(current_url, wait_until="domcontentloaded")
                    listing_html = page.content()
                    page_postings = parse_listing_page(
                        listing_html, current_url
                    )
                    all_postings.extend(page_postings)

                    # Check for next page
                    next_url = get_next_page_url(listing_html, current_url)
                    if next_url:
                        time.sleep(RATE_LIMIT_DELAY)
                        current_url = next_url
                    else:
                        break

                # Phase 2: Visit each detail page
                for posting in all_postings:
                    if not posting.get("detail_url"):
                        continue

                    time.sleep(RATE_LIMIT_DELAY)

                    detail_page = context.new_page()
                    try:
                        detail_page.goto(
                            posting["detail_url"], wait_until="domcontentloaded"
                        )
                        detail_html = detail_page.content()
                        detail_data = parse_detail_page(detail_html)

                        listing_type = classify_listing_type(posting["title"])

                        # Use detail page location if listing didn't have one
                        location = (
                            posting["location"]
                            or detail_data.get("location", "")
                        )

                        job = Job(
                            title=posting["title"],
                            company=self.company_name,
                            location=location,
                            description=detail_data["jd_text"],
                            url=posting["detail_url"],
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
        self, listing_htmls: list[str], detail_htmls: list[str]
    ) -> list[Job]:
        """
        Parse pre-fetched HTML without using Playwright.

        This method is designed for testing — it accepts raw HTML strings
        and runs the same parsing logic without requiring a browser.
        Supports multiple listing pages to test pagination.

        Args:
            listing_htmls: List of HTML strings for listing pages.
            detail_htmls: List of HTML strings for each job detail page.

        Returns:
            List of Job model instances.
        """
        self.jobs = []
        all_postings = []

        # Collect postings from all listing pages
        for listing_html in listing_htmls:
            page_postings = parse_listing_page(listing_html, self.url)
            all_postings.extend(page_postings)

        # Parse detail pages
        for i, posting in enumerate(all_postings):
            if i < len(detail_htmls):
                detail_data = parse_detail_page(detail_htmls[i])
            else:
                detail_data = {
                    "jd_text": "",
                    "location": "",
                    "posted_date": None,
                }

            listing_type = classify_listing_type(posting["title"])
            location = posting["location"] or detail_data.get("location", "")

            job = Job(
                title=posting["title"],
                company=self.company_name,
                location=location,
                description=detail_data["jd_text"],
                url=posting["detail_url"],
                posted_date=detail_data["posted_date"],
                listing_type=listing_type,
            )
            enrich_job(job, detail_data.get("structured_posting"))
            self.jobs.append(job)

        return self.jobs


def main():
    """CLI entry point for the Greenhouse scraper."""
    parser = argparse.ArgumentParser(
        description="Scrape job listings from a Greenhouse career board."
    )
    parser.add_argument(
        "--url",
        required=True,
        help=(
            "Greenhouse board URL "
            "(e.g., https://boards.greenhouse.io/notion)"
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["list", "job"],
        default="list",
        help="'list' to print jobs, 'job' to save to database",
    )
    args = parser.parse_args()

    scraper = GreenhouseScraper(args.url)
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
