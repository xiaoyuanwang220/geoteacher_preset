from __future__ import annotations

import html
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def clean_text(value: Any) -> str:
    value = html.unescape(text(value))
    value = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def safe_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


@dataclass(frozen=True)
class SourceDefinition:
    key: str
    organization: str
    adapter: str
    domains: tuple[str, ...]
    capabilities: tuple[str, ...]
    enabled: bool = True

    @classmethod
    def from_mapping(cls, key: str, value: dict[str, Any]) -> "SourceDefinition":
        return cls(
            key=key,
            organization=text(value.get("organization")),
            adapter=text(value.get("adapter")),
            domains=tuple(text(item).lower().rstrip(".") for item in value.get("domains", [])),
            capabilities=tuple(text(item) for item in value.get("capabilities", [])),
            enabled=bool(value.get("enabled", True)),
        )

    def as_dict(self, available: bool) -> dict[str, Any]:
        return {
            "key": self.key,
            "organization": self.organization,
            "domains": list(self.domains),
            "capabilities": list(self.capabilities),
            "enabled": self.enabled,
            "available": available,
        }


@dataclass(frozen=True)
class SearchHit:
    source_key: str
    source_id: str
    title: str
    publisher: str
    category: str
    url: str
    published_at: str
    summary: str
    file_type: str
    attachments: list[dict[str, str]]
    verification: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "sourceKey": self.source_key,
            "sourceId": self.source_id,
            "title": self.title,
            "publisher": self.publisher,
            "category": self.category,
            "url": self.url,
            "publishedAt": self.published_at,
            "summary": self.summary,
            "fileType": self.file_type,
            "attachments": self.attachments,
            "verification": self.verification,
        }


@dataclass(frozen=True)
class FetchedSource:
    status: str
    source_key: str
    title: str
    publisher: str
    published_at: str
    url: str
    content_type: str
    content: str
    truncated: bool
    verification: str
    warnings: list[str]

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "sourceKey": self.source_key,
            "title": self.title,
            "publisher": self.publisher,
            "publishedAt": self.published_at,
            "url": self.url,
            "contentType": self.content_type,
            "content": self.content,
            "truncated": self.truncated,
            "verification": self.verification,
            "retrievedAt": now_iso(),
            "warnings": self.warnings,
        }
