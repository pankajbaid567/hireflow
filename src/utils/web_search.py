"""Small injectable search adapter. Missing credentials produce explicit errors."""

import ipaddress
from time import monotonic
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urljoin

import httpx

from src.config.settings import get_settings
from src.utils.llm_client import _is_placeholder_or_empty


def public_url(url):
    try:
        parsed = urlparse(url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in {None, 80, 443}
            or "." not in parsed.hostname
        ):
            return False
        if parsed.hostname in {
            "localhost",
            "metadata.google.internal",
        } or parsed.hostname.endswith((".local", ".internal", ".localhost", ".test", ".invalid")):
            return False
        try:
            return ipaddress.ip_address(parsed.hostname).is_global
        except ValueError:
            return True
    except (ValueError, TypeError):
        return False


class WebSearch:
    def __init__(self, settings=None, client=None):
        self.settings = settings or get_settings()
        self.client = client or httpx.Client(timeout=10, follow_redirects=True)

    def search(self, query, *, max_results=8, news=False):
        if not _is_placeholder_or_empty(self.settings.tavily_api_key):
            response = self.client.post(
                "https://api.tavily.com/search",
                json={
                    "api_key": self.settings.tavily_api_key,
                    "query": query,
                    "max_results": max_results,
                    "topic": "news" if news else "general",
                    **({"time_range": "year"} if news else {}),
                },
            )
            self._raise_for_status(response)
            return response.json().get("results", [])
        if not _is_placeholder_or_empty(self.settings.serpapi_api_key):
            response = self.client.get(
                "https://serpapi.com/search.json",
                params={
                    "api_key": self.settings.serpapi_api_key,
                    "q": query,
                    "engine": "google",
                    "num": max_results,
                    **({"tbm": "nws", "tbs": "qdr:m3"} if news else {}),
                },
            )
            self._raise_for_status(response)
            payload = response.json()
            if payload.get("error"):
                raise RuntimeError("Search provider could not complete the query")
            return [
                {**r, "url": r.get("link"), "content": r.get("snippet", "")}
                for r in payload.get("news_results" if news else "organic_results", [])
            ]
        raise RuntimeError(
            "Configure TAVILY_API_KEY or SERPAPI_API_KEY to discover current sources"
        )

    def accessible(self, url):
        if not public_url(url):
            return False
        try:
            # A streamed GET also works on documentation hosts that reject HEAD.
            for _ in range(5):
                if not public_url(url):
                    return False
                with self.client.stream("GET", url, follow_redirects=False) as response:
                    if response.is_redirect:
                        url = urljoin(url, response.headers.get("location", ""))
                        continue
                    return response.status_code < 400
            return False
        except (httpx.HTTPError, ValueError):
            return False

    def read_page(self, url, *, max_bytes=180000, timeout_seconds=10):
        """Read bounded visible public HTML; validate every redirect before I/O."""
        if not public_url(url):
            return None
        maximum = max(1, min(180000, int(max_bytes)))
        deadline = monotonic() + max(1, min(15, timeout_seconds))
        try:
            for _ in range(3):
                remaining = deadline - monotonic()
                if remaining <= 0 or not public_url(url):
                    return None
                with self.client.stream("GET", url, follow_redirects=False, timeout=remaining, headers={"Accept": "text/html, text/plain"}) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            return None
                        url = urljoin(url, location)
                        continue
                    if not response.is_success:
                        return None
                    chunks, size, truncated = [], 0, False
                    for chunk in response.iter_bytes():
                        if monotonic() >= deadline:
                            return None
                        remaining_bytes = maximum - size
                        chunks.append(chunk[:remaining_bytes])
                        size += min(len(chunk), remaining_bytes)
                        if len(chunk) > remaining_bytes or size >= maximum:
                            truncated = True
                            break
                    body = b"".join(chunks).decode("utf-8", errors="ignore")
                    soup = BeautifulSoup(body, "html.parser")
                    title = soup.title.get_text(" ", strip=True) if soup.title else ""
                    for hidden in soup(["script", "style", "nav", "header", "footer", "noscript"]):
                        hidden.decompose()
                    return {"url": url, "body": body, "text": soup.get_text("\n", strip=True)[:30000], "title": title, "truncated": truncated, "content_type": response.headers.get("content-type", "")}
            return None
        except (httpx.HTTPError, ValueError, TypeError):
            return None

    @staticmethod
    def _raise_for_status(response):
        # SerpAPI includes its credential in the query string. Never put the
        # full request URL into a persisted guide warning or public API error.
        if response.status_code >= 400:
            raise RuntimeError(
                f"Search provider request failed (HTTP {response.status_code})"
            )

    def close(self):
        self.client.close()
