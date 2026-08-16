from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import urlparse


def is_allowed_https_url(url: str, domains: Iterable[str]) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return False
    host = (parsed.hostname or "").lower().rstrip(".")
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)
