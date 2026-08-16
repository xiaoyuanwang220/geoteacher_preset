from __future__ import annotations

import argparse
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from adapters.gov_portal import MAX_CONTENT_CHARS, MAX_RESULTS
from core.errors import ConnectorError
from core.models import safe_int, text
from core.registry import GeographyDataService


SERVER_NAME = "china-geography-data"
SERVER_VERSION = "0.3.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765


TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "list_official_sources",
        "description": "列出中国地理权威数据 MCP 当前登记的数据源及可用能力。",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "search_official_sources",
        "description": (
            "在已登记的中国地理权威网站中检索官方数据与原始发布。"
            "source 可指定 nbs、cma 或 all，默认 all。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "检索词，建议包含指标、地区和年份"},
                "source": {"type": "string", "enum": ["all", "nbs", "cma"]},
                "page": {"type": "integer", "minimum": 1, "maximum": 100},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS},
                "sort": {"type": "string", "enum": ["relevance", "dateDesc"]},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch_official_source",
        "description": (
            "读取已登记权威网站的官方 HTML 页面并提取标题、发布日期和正文。"
            "默认根据 URL 自动选择国家统计局或中国气象局适配器；PDF 当前只返回入口。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "source": {"type": "string", "enum": ["auto", "nbs", "cma"]},
                "max_chars": {"type": "integer", "minimum": 1000, "maximum": MAX_CONTENT_CHARS},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "search_nbs_sources",
        "description": "兼容工具：仅检索国家统计局。新流程优先使用 search_official_sources。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "page": {"type": "integer", "minimum": 1, "maximum": 100},
                "limit": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTS},
                "sort": {"type": "string", "enum": ["relevance", "dateDesc"]},
            },
            "required": ["query"],
            "additionalProperties": False,
        },
    },
    {
        "name": "fetch_nbs_source",
        "description": "兼容工具：仅读取国家统计局来源。新流程优先使用 fetch_official_source。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 1000, "maximum": MAX_CONTENT_CHARS},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
]


class McpApplication:
    def __init__(self, service: GeographyDataService | None = None) -> None:
        self.service = service or GeographyDataService()
        self.tools: dict[str, Callable[..., dict[str, Any]]] = {
            "list_official_sources": self.service.list_sources,
            "search_official_sources": self.service.search_sources,
            "fetch_official_source": self.service.fetch_source,
            "search_nbs_sources": self._search_nbs_sources,
            "fetch_nbs_source": self._fetch_nbs_source,
        }

    def _search_nbs_sources(self, **arguments: Any) -> dict[str, Any]:
        return self.service.search_sources(source="nbs", **arguments)

    def _fetch_nbs_source(self, **arguments: Any) -> dict[str, Any]:
        return self.service.fetch_source(source="nbs", **arguments)

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        function = self.tools.get(name)
        if function is None:
            raise ConnectorError(f"未知工具: {name}")
        if not isinstance(arguments, dict):
            raise ConnectorError("arguments 必须是对象")
        return function(**arguments)

    def handle(self, request: dict[str, Any]) -> dict[str, Any] | None:
        method = text(request.get("method"))
        request_id = request.get("id")
        if request_id is None:
            return None
        try:
            if method == "initialize":
                params = request.get("params") if isinstance(request.get("params"), dict) else {}
                protocol = text(params.get("protocolVersion")) or "2024-11-05"
                result = {
                    "protocolVersion": protocol,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                    "instructions": (
                        "按需检索并读取国家统计局与中国气象局官方来源。搜索结果只作为候选；"
                        "用于课程前核验年份、单位和统计口径。"
                    ),
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOL_SCHEMAS}
            elif method == "tools/call":
                params = request.get("params")
                if not isinstance(params, dict):
                    raise ConnectorError("tools/call 缺少 params")
                value = self.call_tool(text(params.get("name")), params.get("arguments", {}))
                result = {
                    "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                    "structuredContent": value,
                    "isError": False,
                }
            else:
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32601, "message": f"Method not found: {method}"},
                }
        except (TypeError, ValueError, ConnectorError) as exc:
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


def run_stdio(app: McpApplication) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("请求必须是 JSON 对象")
            response = app.handle(request)
        except (json.JSONDecodeError, ValueError) as exc:
            response = {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32700, "message": str(exc)},
            }
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()


class _McpHttpHandler(BaseHTTPRequestHandler):
    server_version = "ChinaGeographyDataMcp/0.3"

    @property
    def app(self) -> McpApplication:
        return getattr(self.server, "mcp_app")

    def _send_json(self, status: int, payload: dict[str, Any] | None) -> None:
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        if body:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept, MCP-Protocol-Version")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "server": SERVER_NAME, "version": SERVER_VERSION})
        elif self.path == "/mcp":
            self._send_json(405, {"error": "请通过 POST 调用 /mcp"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/mcp":
            self._send_json(404, {"error": "not found"})
            return
        length = safe_int(self.headers.get("Content-Length"), 0, 0, 1_048_577)
        if not length or length > 1_048_576:
            self._send_json(413, {"error": "invalid request size"})
            return
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(request, dict):
                raise ValueError("请求必须是 JSON 对象")
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            self._send_json(
                400,
                {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}},
            )
            return
        response = self.app.handle(request)
        self._send_json(202 if response is None else 200, response)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")


def run_http(app: McpApplication, host: str, port: int) -> None:
    server = ThreadingHTTPServer((host, port), _McpHttpHandler)
    setattr(server, "mcp_app", app)
    sys.stderr.write(f"{SERVER_NAME} listening on http://{host}:{port}/mcp\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def run_smoke_query(app: McpApplication, query: str, source: str) -> int:
    result = app.service.search_sources(query=query, source=source, limit=3)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("status") in {"ok", "partial"} else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="中国地理权威数据检索 MCP")
    parser.add_argument("--transport", choices=("stdio", "http"), default="stdio")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--smoke-query", help="直接执行一次真实检索并打印结果")
    parser.add_argument("--source", choices=("all", "nbs", "cma"), default="all")
    args = parser.parse_args(argv)
    app = McpApplication()
    if args.smoke_query:
        return run_smoke_query(app, args.smoke_query, args.source)
    if args.transport == "http":
        run_http(app, args.host, args.port)
    else:
        run_stdio(app)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
