#!/usr/bin/env python3
# Copyright 2026 Learning Commons
# SPDX-License-Identifier: Apache-2.0

"""Verify minimum usability of files produced by render_documents.py.

This is a mechanical post-render gate. It checks that every requested output exists,
is non-empty, and contains readable document text. It does not review lesson quality,
source accuracy, visual layout, or cross-document pedagogy.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._hidden_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag.lower() in {"script", "style", "head"}:
            self._hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "head"} and self._hidden_depth:
            self._hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self._hidden_depth and data.strip():
            self.parts.append(data.strip())


def _safe_doc_id(raw: object, fallback: str) -> str:
    value = str(raw or fallback)
    return re.sub(r"[^\w\-]", "_", Path(value).name) or fallback


def _check_html(path: Path) -> list[str]:
    try:
        source = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        return [f"cannot read UTF-8 HTML: {exc}"]
    parser = _VisibleTextParser()
    try:
        parser.feed(source)
        parser.close()
    except Exception as exc:
        return [f"invalid HTML stream: {exc}"]
    return [] if " ".join(parser.parts).strip() else ["HTML has no visible body text"]


#: Text the renderers emit where an image could not be embedded. Both the DOCX and the
#: HTML product use these; a rendered deliverable that contains one lost content.
_IMAGE_FAILURE_MARKERS = (
    "图片格式无法嵌入",
    "图片未能嵌入",
    "图片读取失败",
    "图片嵌入失败",
    "SVG 光栅化失败",
)


def _count_figure_blocks(document: dict, shared: dict | None = None) -> int:
    """How many figure blocks a document declares, after `from_shared` expansion.

    Uses lesson_common.expand_blocks so this count follows exactly the same expansion the
    renderers apply — a wrapper type that hides a figure would otherwise make the count too
    low and let a lost image pass this gate.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    try:
        from lesson_common import expand_blocks  # noqa: E402
    except ImportError:  # pragma: no cover - scripts dir is always alongside this file
        expand_blocks = None

    def walk(blocks) -> int:
        if expand_blocks is not None:
            blocks = expand_blocks(blocks, shared or {}, document.get("audience") or "teacher")
        total = 0
        for blk in blocks or []:
            if not isinstance(blk, dict):
                continue
            kind = str(blk.get("type") or "").strip().lower()
            if kind in {"figure", "image"}:
                total += 1
            elif kind == "columns":
                total += walk(blk.get("left") or []) + walk(blk.get("right") or [])
            elif kind == "group":
                total += walk(blk.get("blocks") or [])
        return total

    sections = document.get("sections") or []
    preamble = document.get("preamble") or []
    return walk(preamble) + sum(
        walk(s.get("blocks")) for s in sections if isinstance(s, dict))


def _check_docx(path: Path, expected_figures: int | None = None) -> list[str]:
    required = {"[Content_Types].xml", "word/document.xml"}
    try:
        with zipfile.ZipFile(path) as archive:
            missing = sorted(required - set(archive.namelist()))
            if missing:
                return ["DOCX is missing required parts: " + ", ".join(missing)]
            bad_member = archive.testzip()
            if bad_member:
                return [f"DOCX contains a corrupt ZIP member: {bad_member}"]
            document_xml = archive.read("word/document.xml")
            media = [n for n in archive.namelist() if n.startswith("word/media/")]
    except (OSError, zipfile.BadZipFile, KeyError) as exc:
        return [f"cannot open DOCX package: {exc}"]
    try:
        root = ElementTree.fromstring(document_xml)
    except ElementTree.ParseError as exc:
        return [f"DOCX document.xml is invalid: {exc}"]
    text = "".join(
        node.text or ""
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1] == "t"
    ).strip()
    errors: list[str] = []
    if not text:
        errors.append("DOCX has no readable document text")
    drawing_tag = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}drawing"
    drawings = sum(1 for node in root.iter() if node.tag == drawing_tag)
    if drawings and not media:
        errors.append(f"DOCX has {drawings} drawing(s) but no embedded media")
    for marker in _IMAGE_FAILURE_MARKERS:
        if marker in text:
            errors.append(f"DOCX still contains an image-failure placeholder: {marker}")
    if expected_figures is not None and drawings < expected_figures:
        errors.append(
            f"DOCX embeds {drawings} image(s) but the source declares "
            f"{expected_figures} figure(s) — some image did not make it into the document"
        )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="source JSON passed to render_documents.py")
    parser.add_argument("--format", choices=["html", "docx", "both"], default="html")
    parser.add_argument("--only", nargs="*", default=None,
                        help="document ids requested from render_documents.py")
    parser.add_argument("--outdir", default=".")
    args = parser.parse_args()

    try:
        source = json.loads(Path(args.input).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"error: cannot read source JSON: {exc}", file=sys.stderr)
        return 1

    documents = source.get("documents")
    if not isinstance(documents, list) or not documents:
        print("error: no `documents` array in input", file=sys.stderr)
        return 1

    selected: list[tuple[str, dict]] = []
    for index, document in enumerate(documents, start=1):
        if not isinstance(document, dict):
            print(f"error: documents[{index - 1}] is not an object", file=sys.stderr)
            return 1
        raw_id = str(document.get("id") or f"document_{index}")
        safe_id = _safe_doc_id(raw_id, f"document_{index}")
        if args.only and raw_id not in args.only and safe_id not in args.only:
            continue
        selected.append((safe_id, document))

    if not selected:
        print("error: no documents selected; check --only ids", file=sys.stderr)
        return 1

    suffixes = [".html"]
    if args.format in {"docx", "both"}:
        suffixes.append(".docx")

    outdir = Path(args.outdir)
    failures: list[str] = []
    checked: list[str] = []
    shared = source.get("shared") or {}
    for doc_id, document in selected:
        expected = _count_figure_blocks(document, shared) if isinstance(shared, dict) else None
        for suffix in suffixes:
            path = outdir / f"{doc_id}{suffix}"
            if not path.is_file():
                failures.append(f"{path}: missing")
                continue
            if path.stat().st_size == 0:
                failures.append(f"{path}: empty")
                continue
            errors = (_check_html(path) if suffix == ".html"
                      else _check_docx(path, expected_figures=expected))
            if errors:
                failures.extend(f"{path}: {error}" for error in errors)
            else:
                checked.append(str(path))

    if failures:
        for failure in failures:
            print("FAIL " + failure, file=sys.stderr)
        return 1
    print("verified " + ", ".join(checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
