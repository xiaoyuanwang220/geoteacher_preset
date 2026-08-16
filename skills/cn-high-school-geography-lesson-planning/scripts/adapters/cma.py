from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin

from adapters.gov_portal import MAX_QUERY_LENGTH, MAX_RESULTS, GovPortalAdapter
from core.errors import ConnectorError, SourceChangedError
from core.models import SearchHit, clean_text, now_iso, safe_int, text


class _ListingParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_item = False
        self.item_depth = 0
        self.href = ""
        self.anchor_depth = 0
        self.anchor_parts: list[str] = []
        self.item_parts: list[str] = []
        self.items: list[tuple[str, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = {key.lower(): text(value) for key, value in attrs}
        classes = set(attrs_dict.get("class", "").split())
        if tag.lower() == "li" and ("list-item" in classes or not self.in_item):
            self.in_item = True
            self.item_depth = 1
            self.href = ""
            self.anchor_parts = []
            self.item_parts = []
            return
        if not self.in_item:
            return
        self.item_depth += 1
        if tag.lower() == "a" and attrs_dict.get("href"):
            self.href = attrs_dict["href"]
            self.anchor_depth = 1
        elif self.anchor_depth:
            self.anchor_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if not self.in_item:
            return
        if self.anchor_depth:
            self.anchor_depth -= 1
        self.item_depth -= 1
        if tag.lower() == "li" or self.item_depth <= 0:
            title = clean_text(" ".join(self.anchor_parts))
            item_text = clean_text(" ".join(self.item_parts))
            if self.href and title:
                self.items.append((self.href, title, item_text))
            self.in_item = False
            self.item_depth = 0

    def handle_data(self, data: str) -> None:
        if not self.in_item:
            return
        value = clean_text(data)
        if not value:
            return
        self.item_parts.append(value)
        if self.anchor_depth:
            self.anchor_parts.append(value)


class CmaAdapter(GovPortalAdapter):
    search_page = "https://www.cma.gov.cn/"
    listing_pages = (
        ("气象报告", "https://www.cma.gov.cn/zfxxgk/gknr/qxbg/"),
        ("气象要闻", "https://www.cma.gov.cn/2011xwzx/2011xqxxw/2011xqxyw/"),
    )

    @staticmethod
    def _query_tokens(query: str) -> list[str]:
        return [
            token
            for token in re.split(r"[\s,，。;；、]+", query)
            if len(token) >= 2
        ]

    def search(
        self,
        query: str,
        page: int = 1,
        limit: int = 5,
        sort: str = "relevance",
    ) -> dict[str, Any]:
        query = text(query)
        if not query:
            raise ConnectorError("query 不能为空")
        if len(query) > MAX_QUERY_LENGTH:
            raise ConnectorError(f"query 不能超过 {MAX_QUERY_LENGTH} 个字符")
        page = safe_int(page, 1, 1, 100)
        limit = safe_int(limit, 5, 1, MAX_RESULTS)
        if sort not in {"relevance", "dateDesc"}:
            raise ConnectorError("sort 只能是 relevance 或 dateDesc")

        tokens = self._query_tokens(query)
        candidates: dict[str, dict[str, Any]] = {}
        parsed_item_count = 0
        for category, listing_url in self.listing_pages:
            response = self._request("GET", listing_url, allow_redirects=True)
            if not self._is_allowed_url(response.url):
                raise ConnectorError("中国气象局栏目页跳转到非白名单域名，已拒绝读取")
            parser = _ListingParser()
            parser.feed(response.content.decode("utf-8-sig", errors="replace"))
            parsed_item_count += len(parser.items)
            for href, title, item_text in parser.items:
                url = urljoin(response.url, href)
                if not self._is_allowed_url(url):
                    continue
                score = sum(1 for token in tokens if token.lower() in title.lower())
                if not score:
                    continue
                date_match = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", item_text)
                published_at = (
                    f"{date_match.group(1)}-{int(date_match.group(2)):02d}-{int(date_match.group(3)):02d}"
                    if date_match
                    else ""
                )
                candidate = SearchHit(
                    source_key=self.key,
                    source_id=url,
                    title=title,
                    publisher=self.organization,
                    category=category,
                    url=url,
                    published_at=published_at,
                    summary="",
                    file_type="html" if url.lower().endswith((".htm", ".html")) else "",
                    attachments=[],
                    verification="official-domain:cma",
                ).as_dict()
                candidate["relevanceScore"] = score
                existing = candidates.get(url)
                if existing is None or score > existing["relevanceScore"]:
                    candidates[url] = candidate

        if parsed_item_count == 0:
            raise SourceChangedError("中国气象局栏目索引结构已变化")

        results = list(candidates.values())
        if sort == "dateDesc":
            results.sort(key=lambda item: text(item.get("publishedAt")), reverse=True)
        else:
            results.sort(
                key=lambda item: (item["relevanceScore"], text(item.get("publishedAt"))),
                reverse=True,
            )
        for item in results:
            item.pop("relevanceScore", None)
        start = (page - 1) * limit
        paged = results[start : start + limit]
        return {
            "status": "ok" if paged else "not_found",
            "query": query,
            "page": page,
            "limit": limit,
            "sort": sort,
            "totalHits": len(results),
            "results": paged,
            "source": {
                "key": self.key,
                "publisher": self.organization,
                "searchPage": self.search_page,
                "searchService": "中国气象局官方 HTTPS 栏目索引",
            },
            "retrievedAt": now_iso(),
            "warnings": ["搜索结果是候选来源；课程使用前仍需读取原文并核验。"],
        }

    def fetch(self, url: str, max_chars: int = 12_000) -> dict[str, Any]:
        result = super().fetch(url, max_chars=max_chars)
        content = text(result.get("content"))
        if result.get("status") == "ok" and "相关文档" in content and len(content) < 1_000:
            result["status"] = "partial"
            result.setdefault("warnings", []).append(
                "该页面主要提供报告附件入口，当前正文不足以核验报告中的具体数据。"
            )
        return result
