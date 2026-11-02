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


def _check_docx(path: Path) -> list[str]:
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
    return [] if text else ["DOCX has no readable document text"]


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

    selected: list[str] = []
    for index, document in enumerate(documents, start=1):
        if not isinstance(document, dict):
            print(f"error: documents[{index - 1}] is not an object", file=sys.stderr)
            return 1
        raw_id = str(document.get("id") or f"document_{index}")
        safe_id = _safe_doc_id(raw_id, f"document_{index}")
        if args.only and raw_id not in args.only and safe_id not in args.only:
            continue
        selected.append(safe_id)

    if not selected:
        print("error: no documents selected; check --only ids", file=sys.stderr)
        return 1

    suffixes = [".html"]
    if args.format in {"docx", "both"}:
        suffixes.append(".docx")

    outdir = Path(args.outdir)
    failures: list[str] = []
    checked: list[str] = []
    for doc_id in selected:
        for suffix in suffixes:
            path = outdir / f"{doc_id}{suffix}"
            if not path.is_file():
                failures.append(f"{path}: missing")
                continue
            if path.stat().st_size == 0:
                failures.append(f"{path}: empty")
                continue
            errors = _check_html(path) if suffix == ".html" else _check_docx(path)
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
