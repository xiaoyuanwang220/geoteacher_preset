from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATA_PATH = ROOT_DIR / "config" / "china_geography_kg.json"
COLLECTIONS = (
    "standards",
    "progressions",
    "learning_components",
    "misconceptions",
    "lessons",
    "materials",
)


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _strings(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    raise ValueError("参数必须是字符串或字符串数组")


def _contains(haystack: str, needle: str) -> bool:
    return needle.casefold() in haystack.casefold()


def _score(record: dict[str, Any], terms: list[str], fields: tuple[str, ...]) -> int:
    haystack = " ".join(_text(record.get(field)) for field in fields)
    return sum(1 for term in terms if _contains(haystack, term))


class KnowledgeStore:
    def __init__(self, data: dict[str, Any], source_path: Path) -> None:
        self.data = data
        self.source_path = source_path

    @classmethod
    def from_path(cls, path: Path) -> "KnowledgeStore":
        try:
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError as exc:
            raise ValueError(f"知识图谱数据文件不存在: {path}") from exc
        except json.JSONDecodeError as exc:
            raise ValueError(f"知识图谱数据不是有效JSON: {path}: {exc}") from exc
        if not isinstance(value, dict):
            raise ValueError("知识图谱数据顶层必须是对象")
        for name in COLLECTIONS:
            rows = value.get(name)
            if not isinstance(rows, list):
                raise ValueError(f"知识图谱字段 {name} 必须是数组")
            if any(not isinstance(row, dict) for row in rows):
                raise ValueError(f"知识图谱字段 {name} 只能包含对象")
        return cls(value, path)

    def find_standard_statement(
        self,
        code: str = "",
        keywords: list[str] | str | None = None,
        module: str = "",
    ) -> dict[str, Any]:
        code = _text(code)
        terms = _strings(keywords)
        module = _text(module)
        ranked: list[tuple[int, dict[str, Any]]] = []
        for row in self.data["standards"]:
            row_code = _text(row.get("code"))
            if code and not row_code.casefold().startswith(code.casefold()):
                continue
            if module and not _contains(_text(row.get("module")), module):
                continue
            score = _score(
                row,
                terms,
                ("code", "statement", "module", "topic", "behavior", "keywords"),
            )
            if terms and score == 0:
                continue
            ranked.append((score, row))
        ranked.sort(key=lambda item: (-item[0], _text(item[1].get("code"))))
        standards = [row for _, row in ranked[:20]]
        return {"standards": standards, "total": len(ranked)}

    def find_standards_progression_from_standard(
        self,
        caseIdentifierUUID: str,
        direction: str = "backward",
    ) -> dict[str, Any]:
        identifier = _text(caseIdentifierUUID)
        direction = _text(direction) or "backward"
        if direction not in {"backward", "forward"}:
            raise ValueError("direction 只能是 backward 或 forward")
        matches = [
            row
            for row in self.data["progressions"]
            if _text(row.get("caseIdentifierUUID")) == identifier
            and _text(row.get("direction")) == direction
        ]
        standards: list[dict[str, Any]] = []
        for row in matches:
            values = row.get("standards", [])
            if isinstance(values, list):
                standards.extend(value for value in values if isinstance(value, dict))
        return {"caseIdentifierUUID": identifier, "direction": direction, "standards": standards}

    def find_learning_components_from_standard(self, caseIdentifierUUID: str) -> dict[str, Any]:
        identifier = _text(caseIdentifierUUID)
        components = [
            row
            for row in self.data["learning_components"]
            if _text(row.get("caseIdentifierUUID")) == identifier
        ][:5]
        return {"caseIdentifierUUID": identifier, "components": components}

    def find_misconceptions_for_standard(
        self,
        caseIdentifierUUID: str,
        subject: str = "高中地理",
    ) -> dict[str, Any]:
        identifier = _text(caseIdentifierUUID)
        subject = _text(subject) or "高中地理"
        misconceptions = [
            row
            for row in self.data["misconceptions"]
            if _text(row.get("caseIdentifierUUID")) == identifier
            and (not row.get("subject") or _contains(_text(row.get("subject")), subject))
        ][:3]
        return {
            "caseIdentifierUUID": identifier,
            "subject": subject,
            "misconceptions": misconceptions,
        }

    def find_curriculum_lessons(
        self,
        caseIdentifierUUID: str,
        topic: str = "",
        module: str = "",
        textbookVersion: str = "",
        author: str = "",
    ) -> dict[str, Any]:
        identifier = _text(caseIdentifierUUID)
        filters = {
            "topic": _text(topic),
            "module": _text(module),
            "textbookVersion": _text(textbookVersion),
            "author": _text(author),
        }
        ranked: list[tuple[int, dict[str, Any]]] = []
        for row in self.data["lessons"]:
            identifiers = _strings(row.get("caseIdentifierUUIDs", row.get("caseIdentifierUUID")))
            if identifier and identifier not in identifiers:
                continue
            score = 0
            rejected = False
            for field, value in filters.items():
                if not value:
                    continue
                if _contains(_text(row.get(field)), value):
                    score += 1
                else:
                    rejected = True
                    break
            if not rejected:
                ranked.append((score, row))
        ranked.sort(key=lambda item: (-item[0], _text(item[1].get("lessonIdentifier"))))
        lessons = [row for _, row in ranked[:20]]
        return {"lessons": lessons, "total": len(ranked)}

    def find_materials_for_lesson(
        self,
        lessonIdentifier: str,
        materialSource: list[str] | str | None = None,
    ) -> dict[str, Any]:
        identifier = _text(lessonIdentifier)
        sources = _strings(materialSource)
        materials = []
        for row in self.data["materials"]:
            if _text(row.get("lessonIdentifier")) != identifier:
                continue
            if sources and _text(row.get("materialSource")) not in sources:
                continue
            materials.append(row)
        return {"lessonIdentifier": identifier, "materials": materials}


TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "find_standard_statement",
        "description": "按编号、关键词和模块查询中国普通高中地理课程标准。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "code": {"type": "string"},
                "keywords": {"type": "array", "items": {"type": "string"}},
                "module": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "find_standards_progression_from_standard",
        "description": "查询目标课标最相关的前置或后续学习连接。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "caseIdentifierUUID": {"type": "string"},
                "direction": {"type": "string", "enum": ["backward", "forward"]},
            },
            "required": ["caseIdentifierUUID"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_learning_components_from_standard",
        "description": "查询目标课标对应的概念、证据类型、地理行为和质量要求。",
        "inputSchema": {
            "type": "object",
            "properties": {"caseIdentifierUUID": {"type": "string"}},
            "required": ["caseIdentifierUUID"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_misconceptions_for_standard",
        "description": "查询目标课标相关的学生表现、可能原因和教师动作。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "caseIdentifierUUID": {"type": "string"},
                "subject": {"type": "string"},
            },
            "required": ["caseIdentifierUUID"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_curriculum_lessons",
        "description": "查询与目标课标、模块、主题或教材版本匹配的高中地理课例。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "caseIdentifierUUID": {"type": "string"},
                "topic": {"type": "string"},
                "module": {"type": "string"},
                "textbookVersion": {"type": "string"},
                "author": {"type": "string"},
            },
            "required": ["caseIdentifierUUID"],
            "additionalProperties": False,
        },
    },
    {
        "name": "find_materials_for_lesson",
        "description": "提取指定课例的核心问题、任务关系、地理表征和评价等教学精华。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "lessonIdentifier": {"type": "string"},
                "materialSource": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["lessonIdentifier"],
            "additionalProperties": False,
        },
    },
]


class McpApplication:
    def __init__(self, store: KnowledgeStore) -> None:
        self.store = store
        self.tools: dict[str, Callable[..., dict[str, Any]]] = {
            "find_standard_statement": store.find_standard_statement,
            "find_standards_progression_from_standard": store.find_standards_progression_from_standard,
            "find_learning_components_from_standard": store.find_learning_components_from_standard,
            "find_misconceptions_for_standard": store.find_misconceptions_for_standard,
            "find_curriculum_lessons": store.find_curriculum_lessons,
            "find_materials_for_lesson": store.find_materials_for_lesson,
        }

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        function = self.tools.get(name)
        if function is None:
            raise ValueError(f"未知工具: {name}")
        if not isinstance(arguments, dict):
            raise ValueError("arguments 必须是对象")
        return function(**arguments)

    def handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        method = _text(request.get("method"))
        request_id = request.get("id")
        if request_id is None:
            return None
        try:
            if method == "initialize":
                params = request.get("params") if isinstance(request.get("params"), dict) else {}
                protocol = _text(params.get("protocolVersion")) or "2024-11-05"
                result = {
                    "protocolVersion": protocol,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "china-geography-kg", "version": "0.1.0"},
                    "instructions": "查询中国高中地理课标、学习进阶、学习困难和课例精华。",
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOL_SCHEMAS}
            elif method == "tools/call":
                params = request.get("params")
                if not isinstance(params, dict):
                    raise ValueError("tools/call 缺少params")
                value = self.call_tool(_text(params.get("name")), params.get("arguments", {}))
                result = {
                    "content": [
                        {"type": "text", "text": json.dumps(value, ensure_ascii=False)}
                    ],
                    "structuredContent": value,
                    "isError": False,
                }
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }
        except (TypeError, ValueError) as exc:
            if method == "tools/call":
                result = {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                }
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32602, "message": str(exc)},
                }
        return {"jsonrpc": "2.0", "id": request_id, "result": result}


def data_path_from_args(value: str | None) -> Path:
    configured = value or os.environ.get("CHINA_GEOGRAPHY_KG_DATA")
    return Path(configured) if configured else DEFAULT_DATA_PATH


def serve(app: McpApplication) -> None:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("JSON-RPC消息必须是对象")
            response = app.handle(request)
        except (json.JSONDecodeError, ValueError) as exc:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": str(exc)},
            }
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="中国高中地理知识图谱MCP服务")
    parser.add_argument("--data", help="结构化知识图谱JSON路径")
    parser.add_argument("--validate-data", action="store_true", help="校验数据后退出")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    path = data_path_from_args(args.data)
    try:
        store = KnowledgeStore.from_path(path)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from exc
    if args.validate_data:
        counts = {name: len(store.data[name]) for name in COLLECTIONS}
        print(json.dumps({"path": str(path), "counts": counts}, ensure_ascii=False))
        return
    serve(McpApplication(store))


if __name__ == "__main__":
    main()
