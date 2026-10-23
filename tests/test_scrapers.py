"""
Tests for Lever and Greenhouse scrapers.

All tests use mock HTML fixtures — no network or browser required.
Covers parsing, field extraction, listing type classification,
pagination, and database save logic.
"""

import pytest
from unittest.mock import patch, MagicMock

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.models.job import Job, ListingType
from src.config.database import Base
from src.scrapers.lever_scraper import (
    LeverScraper,
    classify_listing_type,
    extract_company_from_url,
    parse_listing_page,
    parse_detail_page,
)
from src.scrapers.greenhouse_scraper import (
    GreenhouseScraper,
    classify_listing_type as gh_classify_listing_type,
    extract_company_from_url as gh_extract_company_from_url,
    parse_listing_page as gh_parse_listing_page,
    parse_detail_page as gh_parse_detail_page,
    has_next_page,
    get_next_page_url,
)


# ============================================================
# Mock HTML Fixtures — Lever
# ============================================================

LEVER_LISTING_SINGLE = """
<html>
<body>
<div class="postings-wrapper">
  <div class="posting">
    <a class="posting-title" href="https://jobs.lever.co/testco/abc-123">
      <h5>Senior Software Engineer</h5>
    </a>
    <div class="posting-categories">
      <span class="sort-by-location">San Francisco, CA</span>
    </div>
    <a class="posting-btn-submit" href="https://jobs.lever.co/testco/abc-123/apply">Apply</a>
  </div>
</div>
</body>
</html>
"""

LEVER_LISTING_MULTIPLE = """
<html>
<body>
<div class="postings-wrapper">
  <div class="posting">
    <a class="posting-title" href="https://jobs.lever.co/testco/abc-123">
      <h5>Senior Software Engineer</h5>
    </a>
    <div class="posting-categories">
      <span class="sort-by-location">San Francisco, CA</span>
    </div>
    <a class="posting-btn-submit" href="https://jobs.lever.co/testco/abc-123/apply">Apply</a>
  </div>
  <div class="posting">
    <a class="posting-title" href="https://jobs.lever.co/testco/def-456">
      <h5>Software Engineering Intern - Summer 2025</h5>
    </a>
    <div class="posting-categories">
      <span class="sort-by-location">New York, NY</span>
    </div>
    <a class="posting-btn-submit" href="https://jobs.lever.co/testco/def-456/apply">Apply</a>
  </div>
  <div class="posting">
    <a class="posting-title" href="https://jobs.lever.co/testco/ghi-789">
      <h5>Data Science Co-op</h5>
    </a>
    <div class="posting-categories">
      <span class="sort-by-location">Remote</span>
    </div>
    <a class="posting-btn-submit" href="https://jobs.lever.co/testco/ghi-789/apply">Apply</a>
  </div>
</div>
</body>
</html>
"""

LEVER_DETAIL_ENGINEER = """
<html>
<body>
<div class="posting-page">
  <div class="posting-headline">
    <h2>Senior Software Engineer</h2>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>About the role</h3>
    <p>We are looking for a Senior Software Engineer to join our team.</p>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>Requirements</h3>
    <ul>
      <li>5+ years of experience</li>
      <li>Python and JavaScript expertise</li>
    </ul>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>Nice to have</h3>
    <p>Experience with distributed systems.</p>
  </div>
</div>
</body>
</html>
"""

LEVER_DETAIL_INTERN = """
<html>
<body>
<div class="posting-page">
  <div class="posting-headline">
    <h2>Software Engineering Intern - Summer 2025</h2>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>About the internship</h3>
    <p>Join us for a 12-week summer internship program.</p>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>Qualifications</h3>
    <ul>
      <li>Currently enrolled in a CS program</li>
      <li>Strong problem-solving skills</li>
    </ul>
  </div>
</div>
</body>
</html>
"""

LEVER_DETAIL_COOP = """
<html>
<body>
<div class="posting-page">
  <div class="posting-headline">
    <h2>Data Science Co-op</h2>
  </div>
  <div class="section-wrapper page-full-width">
    <h3>About the co-op</h3>
    <p>A 6-month co-op position for data science students.</p>
  </div>
</div>
</body>
</html>
"""


# ============================================================
# Mock HTML Fixtures — Greenhouse
# ============================================================

GREENHOUSE_LISTING_SINGLE = """
<html>
<body>
<div id="main">
  <section class="level-0">
    <div class="opening">
      <a href="/testco/jobs/1001">Product Manager</a>
      <span class="location">Austin, TX</span>
    </div>
  </section>
</div>
</body>
</html>
"""

GREENHOUSE_LISTING_MULTIPLE = """
<html>
<body>
<div id="main">
  <section class="level-0">
    <div class="opening">
      <a href="/testco/jobs/1001">Product Manager</a>
      <span class="location">Austin, TX</span>
    </div>
    <div class="opening">
      <a href="/testco/jobs/1002">Machine Learning Intern</a>
      <span class="location">Seattle, WA</span>
    </div>
    <div class="opening">
      <a href="/testco/jobs/1003">Backend Engineer</a>
      <span class="location">Remote - US</span>
    </div>
  </section>
</div>
</body>
</html>
"""

GREENHOUSE_LISTING_PAGE1 = """
<html>
<body>
<div id="main">
  <section class="level-0">
    <div class="opening">
      <a href="/testco/jobs/2001">Frontend Developer</a>
      <span class="location">London, UK</span>
    </div>
  </section>
  <div class="pagination">
    <span class="next"><a href="/testco?page=2">Next</a></span>
  </div>
</div>
</body>
</html>
"""

GREENHOUSE_LISTING_PAGE2 = """
<html>
<body>
<div id="main">
  <section class="level-0">
    <div class="opening">
      <a href="/testco/jobs/2002">DevOps Apprentice</a>
      <span class="location">Berlin, DE</span>
    </div>
  </section>
</div>
</body>
</html>
"""

GREENHOUSE_DETAIL_PM = """
<html>
<body>
<div id="content">
  <h1>Product Manager</h1>
  <div class="location">Austin, TX</div>
  <p>We are looking for a Product Manager to lead our team in building
     amazing products. You will work closely with engineering and design.</p>
  <h2>Responsibilities</h2>
  <ul>
    <li>Define product roadmap</li>
    <li>Prioritize features</li>
  </ul>
</div>
</body>
</html>
"""

GREENHOUSE_DETAIL_ML_INTERN = """
<html>
<body>
<div id="content">
  <h1>Machine Learning Intern</h1>
  <div class="location">Seattle, WA</div>
  <p>Join our ML team as a summer intern. You will work on real-world
     machine learning projects and learn from industry experts.</p>
  <h2>Requirements</h2>
  <ul>
    <li>Currently pursuing a degree in CS, ML, or related field</li>
    <li>Experience with Python and TensorFlow</li>
  </ul>
</div>
</body>
</html>
"""

GREENHOUSE_DETAIL_BACKEND = """
<html>
<body>
<div id="content">
  <h1>Backend Engineer</h1>
  <div class="location">Remote - US</div>
  <p>Build and maintain our backend services using Python and PostgreSQL.</p>
</div>
</body>
</html>
"""

GREENHOUSE_DETAIL_FRONTEND = """
<html>
<body>
<div id="content">
  <h1>Frontend Developer</h1>
  <div class="location">London, UK</div>
  <p>Build beautiful, performant web applications using React and TypeScript.</p>
</div>
</body>
</html>
"""

GREENHOUSE_DETAIL_APPRENTICE = """
<html>
<body>
<div id="content">
  <h1>DevOps Apprentice</h1>
  <div class="location">Berlin, DE</div>
  <p>Learn DevOps practices in our apprenticeship program.</p>
</div>
</body>
</html>
"""


# ============================================================
# Lever Tests
# ============================================================

class TestLeverListingTypClassification:
    """Test listing type classification based on title keywords."""

    def test_regular_job(self):
        assert classify_listing_type("Senior Software Engineer") == ListingType.job

    def test_intern_keyword(self):
        assert classify_listing_type("Software Engineering Intern") == ListingType.internship

    def test_internship_keyword(self):
        assert classify_listing_type("Summer Internship Program") == ListingType.internship

    def test_coop_keyword(self):
        assert classify_listing_type("Data Science Co-op") == ListingType.internship

    def test_apprentice_keyword(self):
        assert classify_listing_type("DevOps Apprentice") == ListingType.internship

    def test_trainee_keyword(self):
        assert classify_listing_type("Engineering Trainee") == ListingType.internship

    def test_case_insensitive(self):
        assert classify_listing_type("SOFTWARE ENGINEERING INTERN") == ListingType.internship


class TestLeverCompanyExtraction:
    """Test company name extraction from Lever URLs."""

    def test_basic_url(self):
        assert extract_company_from_url("https://jobs.lever.co/anthropic") == "anthropic"

    def test_trailing_slash(self):
        assert extract_company_from_url("https://jobs.lever.co/anthropic/") == "anthropic"

    def test_with_path(self):
        assert extract_company_from_url("https://jobs.lever.co/anthropic/abc-123") == "anthropic"


class TestLeverParseListingPage:
    """Test parsing of Lever listing page HTML."""

    def test_parse_single_posting(self):
        postings = parse_listing_page(
            LEVER_LISTING_SINGLE,
            "https://jobs.lever.co/testco"
        )
        assert len(postings) == 1
        assert postings[0]["title"] == "Senior Software Engineer"
        assert postings[0]["location"] == "San Francisco, CA"
        assert "abc-123" in postings[0]["application_url"]

    def test_parse_multiple_postings(self):
        postings = parse_listing_page(
            LEVER_LISTING_MULTIPLE,
            "https://jobs.lever.co/testco"
        )
        assert len(postings) == 3
        titles = [p["title"] for p in postings]
        assert "Senior Software Engineer" in titles
        assert "Software Engineering Intern - Summer 2025" in titles
        assert "Data Science Co-op" in titles

    def test_locations_extracted(self):
        postings = parse_listing_page(
            LEVER_LISTING_MULTIPLE,
            "https://jobs.lever.co/testco"
        )
        locations = [p["location"] for p in postings]
        assert "San Francisco, CA" in locations
        assert "New York, NY" in locations
        assert "Remote" in locations


class TestLeverParseDetailPage:
    """Test parsing of Lever detail page HTML."""

    def test_parse_engineer_detail(self):
        result = parse_detail_page(LEVER_DETAIL_ENGINEER)
        assert "Senior Software Engineer" in result["jd_text"]
        assert "5+ years of experience" in result["jd_text"]
        assert "distributed systems" in result["jd_text"]

    def test_parse_intern_detail(self):
        result = parse_detail_page(LEVER_DETAIL_INTERN)
        assert "12-week summer internship" in result["jd_text"]
        assert "CS program" in result["jd_text"]


class TestLeverScraper:
    """Integration tests for LeverScraper using mock HTML."""

    def test_scrape_single_job(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_SINGLE,
            [LEVER_DETAIL_ENGINEER]
        )
        assert len(jobs) == 1
        job = jobs[0]
        assert isinstance(job, Job)
        assert job.title == "Senior Software Engineer"
        assert job.company == "testco"
        assert job.location == "San Francisco, CA"
        assert job.listing_type == ListingType.job
        assert "Senior Software Engineer" in job.description
        assert job.url is not None

    def test_scrape_multiple_jobs(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_MULTIPLE,
            [LEVER_DETAIL_ENGINEER, LEVER_DETAIL_INTERN, LEVER_DETAIL_COOP]
        )
        assert len(jobs) == 3

        # Verify all are Job instances
        for job in jobs:
            assert isinstance(job, Job)
            assert job.company == "testco"
            assert job.title
            assert job.url

    def test_listing_type_internship(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_MULTIPLE,
            [LEVER_DETAIL_ENGINEER, LEVER_DETAIL_INTERN, LEVER_DETAIL_COOP]
        )
        types = {j.title: j.listing_type for j in jobs}
        assert types["Senior Software Engineer"] == ListingType.job
        assert types["Software Engineering Intern - Summer 2025"] == ListingType.internship
        assert types["Data Science Co-op"] == ListingType.internship

    def test_listing_type_regular_job(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_SINGLE,
            [LEVER_DETAIL_ENGINEER]
        )
        assert jobs[0].listing_type == ListingType.job

    def test_description_populated(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_SINGLE,
            [LEVER_DETAIL_ENGINEER]
        )
        assert len(jobs[0].description) > 0
        assert "5+ years of experience" in jobs[0].description


# ============================================================
# Greenhouse Tests
# ============================================================

class TestGreenhouseCompanyExtraction:
    """Test company name extraction from Greenhouse URLs."""

    def test_basic_url(self):
        assert gh_extract_company_from_url("https://boards.greenhouse.io/notion") == "notion"

    def test_trailing_slash(self):
        assert gh_extract_company_from_url("https://boards.greenhouse.io/notion/") == "notion"

    def test_with_path(self):
        assert gh_extract_company_from_url("https://boards.greenhouse.io/notion/jobs/123") == "notion"


class TestGreenhouseParseListingPage:
    """Test parsing of Greenhouse listing page HTML."""

    def test_parse_single_posting(self):
        postings = gh_parse_listing_page(
            GREENHOUSE_LISTING_SINGLE,
            "https://boards.greenhouse.io/testco"
        )
        assert len(postings) == 1
        assert postings[0]["title"] == "Product Manager"
        assert postings[0]["location"] == "Austin, TX"

    def test_parse_multiple_postings(self):
        postings = gh_parse_listing_page(
            GREENHOUSE_LISTING_MULTIPLE,
            "https://boards.greenhouse.io/testco"
        )
        assert len(postings) == 3
        titles = [p["title"] for p in postings]
        assert "Product Manager" in titles
        assert "Machine Learning Intern" in titles
        assert "Backend Engineer" in titles

    def test_urls_resolved(self):
        postings = gh_parse_listing_page(
            GREENHOUSE_LISTING_SINGLE,
            "https://boards.greenhouse.io/testco"
        )
        assert postings[0]["detail_url"].startswith("https://boards.greenhouse.io")


class TestGreenhouseParseDetailPage:
    """Test parsing of Greenhouse detail page HTML."""

    def test_parse_pm_detail(self):
        result = gh_parse_detail_page(GREENHOUSE_DETAIL_PM)
        assert "Product Manager" in result["jd_text"]
        assert "product roadmap" in result["jd_text"]

    def test_parse_ml_intern_detail(self):
        result = gh_parse_detail_page(GREENHOUSE_DETAIL_ML_INTERN)
        assert "machine learning" in result["jd_text"].lower()
        assert result["location"] == "Seattle, WA"


class TestGreenhousePagination:
    """Test Greenhouse pagination detection."""

    def test_has_next_page_true(self):
        assert has_next_page(GREENHOUSE_LISTING_PAGE1) is True

    def test_has_next_page_false(self):
        assert has_next_page(GREENHOUSE_LISTING_PAGE2) is False

    def test_get_next_page_url(self):
        url = get_next_page_url(
            GREENHOUSE_LISTING_PAGE1,
            "https://boards.greenhouse.io/testco"
        )
        assert url is not None
        assert "page=2" in url

    def test_get_next_page_url_none(self):
        url = get_next_page_url(
            GREENHOUSE_LISTING_PAGE2,
            "https://boards.greenhouse.io/testco"
        )
        assert url is None


class TestGreenhouseScraper:
    """Integration tests for GreenhouseScraper using mock HTML."""

    def test_scrape_single_job(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_SINGLE],
            [GREENHOUSE_DETAIL_PM]
        )
        assert len(jobs) == 1
        job = jobs[0]
        assert isinstance(job, Job)
        assert job.title == "Product Manager"
        assert job.company == "testco"
        assert job.location == "Austin, TX"
        assert job.listing_type == ListingType.job
        assert "product roadmap" in job.description

    def test_scrape_multiple_jobs(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_MULTIPLE],
            [GREENHOUSE_DETAIL_PM, GREENHOUSE_DETAIL_ML_INTERN, GREENHOUSE_DETAIL_BACKEND]
        )
        assert len(jobs) == 3
        for job in jobs:
            assert isinstance(job, Job)
            assert job.company == "testco"
            assert job.title
            assert job.url

    def test_listing_type_internship(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_MULTIPLE],
            [GREENHOUSE_DETAIL_PM, GREENHOUSE_DETAIL_ML_INTERN, GREENHOUSE_DETAIL_BACKEND]
        )
        types = {j.title: j.listing_type for j in jobs}
        assert types["Product Manager"] == ListingType.job
        assert types["Machine Learning Intern"] == ListingType.internship
        assert types["Backend Engineer"] == ListingType.job

    def test_listing_type_regular_job(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_SINGLE],
            [GREENHOUSE_DETAIL_PM]
        )
        assert jobs[0].listing_type == ListingType.job

    def test_scrape_with_pagination(self):
        """Test that scrape_from_html handles multiple listing pages (pagination)."""
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_PAGE1, GREENHOUSE_LISTING_PAGE2],
            [GREENHOUSE_DETAIL_FRONTEND, GREENHOUSE_DETAIL_APPRENTICE]
        )
        assert len(jobs) == 2
        titles = [j.title for j in jobs]
        assert "Frontend Developer" in titles
        assert "DevOps Apprentice" in titles

        # Verify apprentice is classified as internship
        apprentice = next(j for j in jobs if j.title == "DevOps Apprentice")
        assert apprentice.listing_type == ListingType.internship

    def test_description_populated(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_SINGLE],
            [GREENHOUSE_DETAIL_PM]
        )
        assert len(jobs[0].description) > 0
        assert "product roadmap" in jobs[0].description


# ============================================================
# Database Save Tests (using SQLite in-memory)
# ============================================================

class TestSaveJobsToDb:
    """Test save_jobs_to_db using an in-memory SQLite database."""

    @pytest.fixture(autouse=True)
    def setup_db(self):
        """Create an in-memory SQLite DB and patch SessionLocal."""
        engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(engine)
        TestSession = sessionmaker(bind=engine)

        self._engine = engine
        self._TestSession = TestSession

        # Patch SessionLocal in db_utils to use our test DB
        with patch("src.scrapers.db_utils.SessionLocal", TestSession):
            yield

        Base.metadata.drop_all(engine)

    def _make_job(self, title="Test Job", company="testco", url="https://example.com/job/1"):
        return Job(
            title=title,
            company=company,
            location="Remote",
            description="Build Python backend services with documented APIs, SQL data models, reliable tests and deployment workflows. Work with the engineering team on one scoped delivery.",
            url=url,
            listing_type=ListingType.job,
        )

    def test_save_single_job(self):
        from src.scrapers.db_utils import save_jobs_to_db

        job = self._make_job()
        saved = save_jobs_to_db([job])
        assert saved == 1

        # Verify it's in the DB
        session = self._TestSession()
        count = session.query(Job).count()
        session.close()
        assert count == 1

    def test_save_multiple_jobs(self):
        from src.scrapers.db_utils import save_jobs_to_db

        jobs = [
            self._make_job(title="Job A", url="https://example.com/job/a"),
            self._make_job(title="Job B", url="https://example.com/job/b"),
            self._make_job(title="Job C", url="https://example.com/job/c"),
        ]
        saved = save_jobs_to_db(jobs)
        assert saved == 3

    def test_deduplication_by_url(self):
        from src.scrapers.db_utils import save_jobs_to_db

        job1 = self._make_job(title="First Save", url="https://example.com/job/dup")
        job2 = self._make_job(title="Duplicate Save", url="https://example.com/job/dup")

        saved1 = save_jobs_to_db([job1])
        saved2 = save_jobs_to_db([job2])

        assert saved1 == 1
        assert saved2 == 0  # Duplicate URL, should be skipped

        # Verify only one record in DB
        session = self._TestSession()
        count = session.query(Job).count()
        session.close()
        assert count == 1

    def test_mixed_new_and_duplicate(self):
        from src.scrapers.db_utils import save_jobs_to_db

        jobs_batch1 = [
            self._make_job(title="Job A", url="https://example.com/job/a"),
        ]
        save_jobs_to_db(jobs_batch1)

        jobs_batch2 = [
            self._make_job(title="Job A (dup)", url="https://example.com/job/a"),
            self._make_job(title="Job D", url="https://example.com/job/d"),
        ]
        saved = save_jobs_to_db(jobs_batch2)
        assert saved == 1  # Only Job D is new


# ============================================================
# End-to-end integration (mock HTML, no network)
# ============================================================

class TestEndToEnd:
    """Verify scrapers produce correct Job objects end-to-end."""

    def test_lever_all_fields_present(self):
        scraper = LeverScraper("https://jobs.lever.co/testco")
        jobs = scraper.scrape_from_html(
            LEVER_LISTING_SINGLE,
            [LEVER_DETAIL_ENGINEER]
        )
        job = jobs[0]
        assert job.title == "Senior Software Engineer"
        assert job.company == "testco"
        assert job.location == "San Francisco, CA"
        assert job.description  # non-empty
        assert job.url  # non-empty
        assert job.listing_type in (ListingType.job, ListingType.internship)

    def test_greenhouse_all_fields_present(self):
        scraper = GreenhouseScraper("https://boards.greenhouse.io/testco")
        jobs = scraper.scrape_from_html(
            [GREENHOUSE_LISTING_SINGLE],
            [GREENHOUSE_DETAIL_PM]
        )
        job = jobs[0]
        assert job.title == "Product Manager"
        assert job.company == "testco"
        assert job.location == "Austin, TX"
        assert job.description  # non-empty
        assert job.url  # non-empty
        assert job.listing_type in (ListingType.job, ListingType.internship)

# ============================================================
# Generic Scraper Tests
# ============================================================

from src.scrapers.generic_scraper import is_dynamic_page, GenericScraper
from src.scrapers.static_scraper import clean_html

class TestGenericScraperAutoDetect:
    def test_auto_detect_static(self):
        long_text = "This is a very long text block that exists on a static career page. " * 10
        html = f"<html><body><h1>Jobs</h1><p>{long_text}</p><ul><li>SWE</li></ul></body></html>"
        assert is_dynamic_page(html) is False

    def test_auto_detect_dynamic_short_text(self):
        html = "<html><body><script>runApp();</script></body></html>"
        assert is_dynamic_page(html) is True

    def test_auto_detect_dynamic_empty_root(self):
        html = "<html><body><div id=\"root\"></div><p>Some small footer text</p></body></html>"
        assert is_dynamic_page(html) is True

    def test_auto_detect_dynamic_noscript(self):
        html = "<html><body><noscript>Please enable JavaScript to view this page.</noscript><div id=\"app\"></div></body></html>"
        assert is_dynamic_page(html) is True

class TestStaticScraperCleanHTML:
    def test_clean_html_removes_scripts(self):
        html = "<html><body><script>alert(1)</script><p>Job 1</p></body></html>"
        cleaned = clean_html(html)
        assert "alert(1)" not in cleaned
        assert "Job 1" in cleaned

    def test_clean_html_formats_links(self):
        html = "<html><body><a href=\"/jobs/1\">Software Engineer</a></body></html>"
        cleaned = clean_html(html)
        assert "Software Engineer [Link: /jobs/1]" in cleaned

class TestGenericScraperMockLLM:
    @patch("src.scrapers.static_scraper.get_llm_client")
    def test_static_scraper_extraction(self, mock_get_llm_client):
        mock_client = MagicMock()
        mock_client.extract.return_value = [
            {"title": "Backend Dev", "location": "NYC", "url": "https://example.com/b"}
        ]
        mock_get_llm_client.return_value = mock_client
        
        scraper = GenericScraper("https://example.com/careers")
        jobs = scraper.scrape_from_html("<html><body>Static Jobs</body></html>")
        
        # A title/link selected by a model without a source-backed detail JD
        # must not become a supposedly verified listing.
        assert jobs == []
