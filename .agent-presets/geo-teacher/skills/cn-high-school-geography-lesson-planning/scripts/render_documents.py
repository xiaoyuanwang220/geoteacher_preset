#!/usr/bin/env python3
# Copyright 2026 Anthropic, PBC
# Copyright 2026 Learning Commons
# SPDX-License-Identifier: Apache-2.0

"""Render every document in a multi-document source JSON (HTML and/or editable .docx).

Both formats are final deliverables chosen by the teacher; neither is a preview of the other
(see SKILL.md 输出契约).

The material source declares ONE `shared` block (content that appears in more than one
document) plus a `documents` array, so the deliverables of one lesson — 教学设计 /
学生学习材料 / 课堂观察记录表 — stay consistent with each other by construction instead of
being kept in sync by hand.

Each document is a full block-document — same schema as render_lesson_html.py /
render_lesson_docx.py (eyebrow / title / meta / sections / theme / audience) — and pulls shared
content with {"type": "from_shared", "key": ...} blocks, so shared content is written once and
cannot drift between documents.

Material source shape:
  {
    "shared": {"standard_code": ..., "standard_text": ..., "grade": ..., "duration": ...,
               <any model-chosen keys: a block, a list of blocks, or a faceted
                {teacher, student, stimulus} value>, ...},
    "theme": {...},                              // default theme for every document
    "documents": [
      {"id": "教学设计",     "audience": "teacher", "title": ..., "sections": [...]},
      {"id": "学生学习材料", "audience": "student", "title": ..., "sections": [...]}
    ]
  }

`id` becomes the output filename (Unicode ids stay readable); a document's own `theme`
overrides the top-level one.

Usage:
    python render_documents.py lesson.json --format html             # all docs -> HTML
    python render_documents.py lesson.json --format docx             # all docs -> editable .docx
    python render_documents.py lesson.json --only 学生学习材料 --format docx
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def build_doc(source: dict, doc: dict) -> dict:
    """Merge a document entry with the source's shared block and default theme."""
    out = dict(doc)
    out.setdefault("shared", source.get("shared", {}))
    theme = dict(source.get("theme") or {})
    theme.update(doc.get("theme") or {})
    if theme:
        out["theme"] = theme
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="source JSON with a `documents` array")
    ap.add_argument("--format", choices=["html", "docx", "both"], default="html")
    ap.add_argument("--only", nargs="*", default=None,
                    help="document ids to render (default: all)")
    ap.add_argument("--outdir", default=".")
    args = ap.parse_args()

    source = json.loads(Path(args.input).read_text(encoding="utf-8"))
    docs = source.get("documents", [])
    if not docs:
        print("error: no `documents` array in input", file=sys.stderr)
        return 1
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    written = []
    for i, doc in enumerate(docs):
        # Sanitize the document id before it becomes a filename: the id comes from generated
        # JSON, so strip path separators and anything outside [A-Za-z0-9_-].
        doc_id_raw = str(doc.get("id") or f"document_{i + 1}")
        # Keep Unicode word characters so Simplified-Chinese document ids remain readable
        # filenames, while still replacing path separators and punctuation.
        doc_id = re.sub(r"[^\w\-]", "_", Path(doc_id_raw).name) or f"document_{i + 1}"
        if args.only and doc_id_raw not in args.only and doc_id not in args.only:
            continue
        full = build_doc(source, doc)
        # HTML and DOCX are both final deliverables (see SKILL.md 输出契约): HTML suits
        # screen reading, projection and browser printing; DOCX suits re-editing and
        # school templates. Neither is a preview of the other. The HTML twin is always
        # written so a DOCX-only request still leaves a readable copy of the same source —
        # it is a consistency reference, not a downgrade.
        from render_lesson_html import render as render_html
        path = outdir / f"{doc_id}.html"
        # source_dir lets a figure block's relative path resolve from the lesson folder
        # (…/lesson.json + assets/…) instead of the shell's working directory.
        path.write_text(render_html(full, source_dir=Path(args.input).parent),
                        encoding="utf-8")
        written.append(str(path))
        if args.format in ("docx", "both"):
            from render_lesson_docx import render as render_docx
            path = outdir / f"{doc_id}.docx"
            render_docx(full, str(path), source_dir=Path(args.input).parent)
            written.append(str(path))

    if not written:
        print("nothing rendered — check --only ids against the documents' `id` fields",
              file=sys.stderr)
        return 1
    print("wrote " + ", ".join(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
