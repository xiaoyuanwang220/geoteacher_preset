from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from core.errors import CapabilityNotSupported
from core.models import SourceDefinition


class OfficialSourceAdapter(ABC):
    def __init__(self, definition: SourceDefinition) -> None:
        self.definition = definition

    @property
    def key(self) -> str:
        return self.definition.key

    @property
    def organization(self) -> str:
        return self.definition.organization

    @property
    def domains(self) -> tuple[str, ...]:
        return self.definition.domains

    @property
    def capabilities(self) -> tuple[str, ...]:
        return self.definition.capabilities

    @abstractmethod
    def search(
        self,
        query: str,
        page: int = 1,
        limit: int = 5,
        sort: str = "relevance",
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def fetch(self, url: str, max_chars: int = 12_000) -> dict[str, Any]:
        raise NotImplementedError

    def query_series(
        self,
        indicator: str,
        regions: list[str],
        start_year: int,
        end_year: int,
    ) -> dict[str, Any]:
        raise CapabilityNotSupported(f"数据源 {self.key} 尚不支持 series 能力")

    def find_map(self, query: str) -> dict[str, Any]:
        raise CapabilityNotSupported(f"数据源 {self.key} 尚不支持 map 能力")
