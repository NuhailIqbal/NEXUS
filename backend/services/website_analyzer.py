"""Fetches a business website and extracts readable text for the "Analyze" button
on the Create Agent form — used to suggest a main goal / industry from the site's
own content. Network access is user-triggered (any URL they type), so this is
guarded against SSRF: only public http(s) hosts are ever fetched."""
import ipaddress
import logging
import socket
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

MAX_DOWNLOAD_BYTES = 2_000_000  # 2MB cap — plenty for a marketing page, avoids huge downloads
MAX_TEXT_CHARS = 6000  # kept well under the LLM's context, just needs a gist of the business


class WebsiteFetchError(Exception):
    """Raised with a message that's safe to show the user directly."""
    pass


def _normalize_url(raw: str) -> str:
    """Trim the user's input and prepend https:// when no http(s) scheme was typed.
    Raises WebsiteFetchError if the input is empty."""
    raw = (raw or "").strip()
    if not raw:
        raise WebsiteFetchError("Enter a website URL first.")
    if not raw.startswith(("http://", "https://")):
        raw = f"https://{raw}"
    return raw


def _assert_public_host(hostname: str) -> None:
    """Block loopback/private/link-local targets (SSRF) — e.g. localhost, 127.0.0.1,
    10.x/172.16-31.x/192.168.x, and the 169.254.169.254 cloud-metadata address."""
    # Resolve the name ourselves and vet every address it maps to (A and AAAA), so a
    # hostname with even one internal record is rejected. httpx resolves the name again
    # when it connects, so this is a pre-flight check, not a pinned connection.
    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(hostname, None)}
    except socket.gaierror as e:
        raise WebsiteFetchError(f"Couldn't resolve '{hostname}' — check the URL.") from e
    for addr in addrs:
        ip = ipaddress.ip_address(addr)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise WebsiteFetchError("That URL points to a private/internal address, which isn't allowed.")


async def fetch_website_text(url: str) -> tuple[str, str]:
    """Returns (title, extracted_text). Raises WebsiteFetchError with a user-facing message."""
    # Validate before any network I/O: scheme must be http(s) and the host must resolve
    # only to public addresses.
    url = _normalize_url(url)
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise WebsiteFetchError("Enter a valid http(s) website URL.")
    _assert_public_host(parsed.hostname)

    try:
        # Streamed so the body can be capped at MAX_DOWNLOAD_BYTES rather than fully
        # buffered. Redirects are followed (up to 5) and the User-Agent is Mozilla-compatible
        # while still naming this bot.
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0, max_redirects=5) as client:
            async with client.stream("GET", url, headers={"User-Agent": "Mozilla/5.0 (compatible; EDMNexusBot/1.0)"}) as resp:
                if resp.status_code >= 400:
                    raise WebsiteFetchError(f"The site responded with an error (HTTP {resp.status_code}).")
                # Re-check the *final* host after redirects — a redirect could point internal.
                # This runs once response headers have arrived, so it stops the body from
                # being read and returned; it does not prevent the request itself.
                final_host = urlparse(str(resp.url)).hostname
                if final_host and final_host != parsed.hostname:
                    _assert_public_host(final_host)
                chunks = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    # Hitting the cap is not an error: stop reading and parse the partial
                    # HTML collected so far (the chunk that crossed the cap is dropped).
                    if total > MAX_DOWNLOAD_BYTES:
                        break
                    chunks.append(chunk)
                # errors="ignore" drops undecodable bytes so a bad or mislabeled charset
                # cannot abort the analysis.
                html = b"".join(chunks).decode(resp.encoding or "utf-8", errors="ignore")
    # Re-raise our own user-facing errors untouched; only httpx failures are translated below.
    except WebsiteFetchError:
        raise
    except httpx.TimeoutException as e:
        raise WebsiteFetchError("The site took too long to respond.") from e
    except httpx.HTTPError as e:
        raise WebsiteFetchError(f"Couldn't reach that site: {e}") from e

    soup = BeautifulSoup(html, "html.parser")
    # Fall back to the hostname when the page has no usable <title>.
    title = (soup.title.string.strip() if soup.title and soup.title.string else "") or parsed.hostname

    # Remove elements whose contents are not readable page copy (code, styles, embedded
    # media) so they do not pollute the text sent to the LLM.
    for tag in soup(["script", "style", "noscript", "svg", "img", "video", "iframe"]):
        tag.decompose()

    # The meta description goes first so it is kept when the combined text is truncated
    # to MAX_TEXT_CHARS below.
    meta_desc = ""
    meta_tag = soup.find("meta", attrs={"name": "description"})
    if meta_tag and meta_tag.get("content"):
        meta_desc = meta_tag["content"].strip()

    body_text = soup.get_text(separator=" ", strip=True)
    combined = " ".join(part for part in (meta_desc, body_text) if part)
    combined = " ".join(combined.split())  # collapse whitespace

    if not combined:
        raise WebsiteFetchError("Couldn't find any readable text on that page.")

    # Truncated to MAX_TEXT_CHARS to bound the size of the prompt later built from this text.
    return title, combined[:MAX_TEXT_CHARS]
