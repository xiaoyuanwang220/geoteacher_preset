from __future__ import annotations

import importlib
import json
from pathlib import Path
from typing import Any

from adapters.base import OfficialSourceAdapter
from core.errors import ConnectorError, SourceChangedError
from core.models import SourceDefinition, now_iso, safe_int, text
from core.security import is_allowed_https_url


ALLOWED_CAPABILITIES = {"search", "fetch", "series", "map", "dataset"}
DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parent.parent / "source_registry.json"


class SourceRegistry:
    def __init__(
        self,
        path: str | Path = DEFAULT_REGISTRY_PATH,
        adapters: dict[str, OfficialSourceAdapter] | None = None,
    ) -> None:
        self.path = Path(path)
        self.definitions = self._load_definitions()
        self.load_errors: dict[str, str] = {}
        self.adapters = adapters if adapters is not None else self._load_adapters()

    def _load_definitions(self) -> dict[str, SourceDefinition]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ConnectorError(f"来源注册表无法读取: {exc}") from exc
        if not isinstance(raw, dict) or not raw:
            raise ConnectorError("来源注册表必须是非空 JSON 对象")

        definitions: dict[str, SourceDefinition] = {}
        for key, value in raw.items():
            if not isinstance(value, dict):
                raise ConnectorError(f"来源 {key} 的声明必须是对象")
            definition = SourceDefinition.from_mapping(text(key), value)
            if not definition.key or not definition.organization:
                raise ConnectorError(f"来源 {key} 缺少 key 或 organization")
            if not definition.domains:
                raise ConnectorError(f"来源 {key} 缺少 domains")
            unknown = set(definition.capabilities) - ALLOWED_CAPABILITIES
            if unknown:
                raise ConnectorError(f"来源 {key} 声明了未知能力: {sorted(unknown)}")
            if definition.enabled and ":" not in definition.adapter:
                raise ConnectorError(f"来源 {key} 的 adapter 必须是 module:Class")
            definitions[definition.key] = definition
        return definitions

    def _load_adapters(self) -> dict[str, OfficialSourceAdapter]:
        adapters: dict[str, OfficialSourceAdapter] = {}
        for key, definition in self.definitions.items():
            if not definition.enabled:
                continue
            try:
                module_name, class_name = definition.adapter.split(":", 1)
                module = importlib.import_module(module_name)
                adapter_class = getattr(module, class_name)
                adapter = adapter_class(definition)
                if not isinstance(adapter, OfficialSourceAdapter):
                    raise TypeError("适配器未实现 OfficialSourceAdapter")
                adapters[key] = adapter
            except (ImportError, AttributeError, TypeError, ValueError) as exc:
                self.load_errors[key] = str(exc)
        return adapters

    def list_sources(self) -> dict[str, Any]:
        sources = []
        for key, definition in self.definitions.items():
            item = definition.as_dict(available=key in self.adapters)
            if key in self.load_errors:
                item["error"] = self.load_errors[key]
            sources.append(item)
        return {"status": "ok", "sources": sources}

    def source_for_url(self, url: str) -> str | None:
        for key, definition in self.definitions.items():
            if definition.enabled and is_allowed_https_url(url, definition.domains):
                return key
        return None

    def adapter(self, source: str, capability: str | None = None) -> OfficialSourceAdapter:
        if source not in self.definitions:
            raise ConnectorError(f"未知数据源: {source}")
        definition = self.definitions[source]
        if not definition.enabled:
            raise ConnectorError(f"数据源尚未启用: {source}")
        if capability and capability not in definition.capabilities:
            raise ConnectorError(f"数据源 {source} 不支持 {capability} 能力")
        if source not in self.adapters:
            detail = self.load_errors.get(source, "适配器未加载")
            raise ConnectorError(f"数据源 {source} 不可用: {detail}")
        return self.adapters[source]

    def keys_for(self, source: str, capability: str) -> list[str]:
        source = text(source) or "all"
        if source != "all":
            self.adapter(source, capability)
            return [source]
        return [
            key
            for key, definition in self.definitions.items()
            if definition.enabled
            and capability in definition.capabilities
            and key in self.adapters
        ]


class GeographyDataService:
    def __init__(self, registry: SourceRegistry | None = None) -> None:
        self.registry = registry or SourceRegistry()

    def list_sources(self) -> dict[str, Any]:
        return self.registry.list_sources()

    def search_sources(
        self,
        query: str,
        source: str = "all",
        page: int = 1,
        limit: int = 5,
        sort: str = "relevance",
    ) -> dict[str, Any]:
        limit = safe_int(limit, 5, 1, 10)
        keys = self.registry.keys_for(source, "search")
        by_source: list[list[dict[str, Any]]] = []
        errors: list[dict[str, str]] = []
        total_hits = 0
        for key in keys:
            try:
                response = self.registry.adapter(key, "search").search(
                    query=query,
                    page=page,
                    limit=limit,
                    sort=sort,
                )
                total_hits += safe_int(response.get("totalHits"), 0, 0, 2_000_000_000)
                by_source.append([dict(item) for item in response.get("results") or []])
            except SourceChangedError as exc:
                errors.append({"sourceKey": key, "status": "source_changed", "message": str(exc)})
            except ConnectorError as exc:
                errors.append({"sourceKey": key, "status": "error", "message": str(exc)})

        results: list[dict[str, Any]] = []
        if sort == "dateDesc":
            results = [item for group in by_source for item in group]
            results.sort(key=lambda item: text(item.get("publishedAt")), reverse=True)
        else:
            for index in range(max((len(group) for group in by_source), default=0)):
                for group in by_source:
                    if index < len(group):
                        results.append(group[index])
        results = results[:limit]

        if results and errors:
            status = "partial"
        elif results:
            status = "ok"
        elif any(error["status"] == "source_changed" for error in errors):
            status = "source_changed"
        elif errors:
            status = "error"
        else:
            status = "not_found"
        return {
            "status": status,
            "query": text(query),
            "source": text(source) or "all",
            "sourcesQueried": keys,
            "page": safe_int(page, 1, 1, 100),
            "limit": limit,
            "sort": sort,
            "totalHits": total_hits,
            "results": results,
            "errors": errors,
            "retrievedAt": now_iso(),
            "warnings": [
                "搜索结果是候选来源；实际用于课程前仍需读取原文并核验年份、单位和统计口径。"
            ],
        }

    def fetch_source(
        self,
        url: str,
        source: str = "auto",
        max_chars: int = 12_000,
    ) -> dict[str, Any]:
        source = text(source) or "auto"
        resolved = self.registry.source_for_url(url) if source == "auto" else source
        if resolved is None:
            raise ConnectorError("URL 不属于已登记的权威数据源")
        return self.registry.adapter(resolved, "fetch").fetch(url=url, max_chars=max_chars)
