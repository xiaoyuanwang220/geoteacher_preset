#!/usr/bin/env python3
# Copyright 2026 Anthropic, PBC
# Copyright 2026 Learning Commons
# SPDX-License-Identifier: Apache-2.0

"""Render lesson JSON -> a styled, self-contained HTML page (a final deliverable in its own right).

HTML and DOCX are peers, not preview and final: teachers pick whichever suits the
occasion (screen/projector/browser print vs. re-editing in Word). The output is one
file with inline CSS and base64 images, so it can be sent, opened and printed without
any sidecar assets.

Visual design:
  - Real document structure: one <h1>, <section> per heading with an <h2>, <h3>/<h4>
    below. That gives the browser outline, find-in-page, screen readers and the
    in-page table of contents something to work with.
  - Clear hierarchy with restrained colour: a colour band plus a border, never colour
    alone, so a greyscale photocopy keeps every distinction.
  - Figures: data charts render as inline SVG (vector, prints without needing
    background-colour support); images are inlined as base64.

Block types (canonical names; legacy aliases accepted, see ALIASES in lesson_common):
  paragraph, labeled, list, h2, h3, callout, table, cards, columns, group, page_break,
  phase_header, fill_in, instructions, workspace, checklist, source_card, fill_table,
  number_line, chart, figure

Usage:
    python render_lesson_html.py lesson.json -o lesson.html
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from html import escape
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lesson_common import (  # noqa: E402
    DEFAULT_THEME, Theme, CALLOUT_KINDS,
    btype as _btype, resolve_callout_kind as _resolve_callout_kind,
    answer_profile, expand_document, build_header, preamble_blocks, coerce_marks,
    workspace_height, normalize_text, label_text, label_sep, table_row_height,
    coerce_headers, coerce_rows,
)

FILL_IN_SIZES = {"short": "6em", "med": "14em", "long": "100%"}

# Figures. Two block types, one job each:
#   chart  — data the lesson owns: geometry is computed once in chart_bars.compute_layout
#            and drawn here as inline SVG (vector, prints without background colour).
#   figure — an existing raster image (a scanned textbook map, an exam figure): inlined
#            as base64 so the HTML stays one self-contained file.
FIGURE_MAX_WIDTH_PT = 460.8  # 6.4in — A4 width minus the 0.7in margins, with slack

# Directory of the lesson JSON currently being rendered. Relative figure paths resolve
# from here first, so a lesson folder can carry its own assets/ next to lesson.json.
# Module-level rather than a parameter: render_block is called from eight places and a
# 9th argument threaded through all of them buys nothing.
_SOURCE_DIR: Path | None = None


def _asset_dirs(source_dir: Path | None) -> list[Path]:
    """Where a relative `src`/`path` in a figure block may be resolved from."""
    dirs = [Path.cwd()]
    if source_dir is not None:
        dirs.insert(0, source_dir)
    dirs.append(Path(__file__).resolve().parent)
    return dirs


def _resolve_asset(raw: str, source_dir: Path | None) -> Path | None:
    if not raw:
        return None
    p = Path(raw)
    if p.is_absolute():
        return p if p.is_file() else None
    for base in _asset_dirs(source_dir):
        cand = (base / p).resolve()
        if cand.is_file():
            return cand
    return None


def _image_data_uri(path: Path) -> str | None:
    ext = path.suffix.lower().lstrip(".")
    mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
            "gif": "image/gif", "webp": "image/webp", "svg": "image/svg+xml"}.get(ext)
    if mime is None:
        return None
    try:
        blob = path.read_bytes()
    except OSError:
        return None
    return f"data:{mime};base64," + base64.b64encode(blob).decode("ascii")


def render_figure_block(blk: dict, source_dir: Path | None = None) -> str:
    """An existing image, inlined. Missing assets are reported, never silently dropped."""
    source_dir = source_dir if source_dir is not None else _SOURCE_DIR
    raw = str(blk.get("src") or blk.get("path") or "").strip()
    caption = str(blk.get("caption") or "").strip()
    alt = str(blk.get("alt") or caption or "插图").strip()
    cap_html = f"<div class=\"figure-caption\">{md(caption)}</div>" if caption else ""
    if not raw:
        return (f"<div class=\"figure missing\"><p class=\"figure-caption\">"
                f"图片块缺少 src 字段（alt：{md(alt)}）</p></div>")
    path = _resolve_asset(raw, source_dir)
    uri = _image_data_uri(path) if path else None
    if uri is None:
        # A placeholder that says what is missing, rather than an empty box that looks
        # like a styling bug once printed.
        return ("<div class=\"figure missing\"><div class=\"figure-missing-box\">"
                f"图片未能嵌入：{md(raw)}</div>"
                f"<p class=\"figure-caption\">{md(alt)}</p></div>")
    try:
        width_in = float(blk.get("width_in") or 5.6)
    except (TypeError, ValueError):
        width_in = 5.6
    width_pt = max(60.0, min(width_in * 72.0, FIGURE_MAX_WIDTH_PT))
    return (f"<figure class=\"figure\"><img src=\"{uri}\" alt=\"{escape(alt, quote=True)}\""
            f" style=\"max-width:{width_pt:.1f}pt\">{cap_html}</figure>")


def render_chart_block(blk: dict) -> str:
    """A data chart: geometry from chart_bars, markup as inline SVG."""
    try:
        import chart_bars
    except ImportError as exc:  # pragma: no cover - packaging failure, not a user error
        return (f"<div class=\"chart\"><p class=\"chart-note\">图表组件不可用："
                f"{md(str(exc))}</p></div>")
    layout = chart_bars.compute_layout(blk, width_pt=FIGURE_MAX_WIDTH_PT)
    if not layout.get("ok"):
        return (f"<div class=\"chart\"><p class=\"chart-note\">图表数据有误："
                f"{md(str(layout.get('error', '未知原因')))}</p></div>")
    # render_svg already draws the title, legend, axis labels and the source note at the
    # foot of the figure — do NOT emit them again around it, that doubles the note.
    svg = chart_bars.render_svg(layout)
    return f"<figure class=\"chart\">{svg}</figure>"


def md(text) -> str:
    t = escape(normalize_text(text), quote=True)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)", r"<i>\1</i>", t)
    # Preserve line structure: text fields use \n for meaningful line breaks (sub-parts,
    # multi-paragraph callouts). Collapsing them produced unreadable prose blobs.
    t = re.sub(r"[ \t]*\n[ \t]*", "<br>", t)
    return t


def answer_space(blk: dict, theme) -> str:
    """Open writing space — blank whitespace, or ruled lines for lower-grade prose."""
    h = workspace_height(blk, theme)
    if blk.get("ruled", theme.ruled_default):
        gap = float(theme.answer_gap)
        n = max(2, int(round(h / gap)))
        lines = f"<div class=\"ansline\" style=\"height:{gap:g}pt\"></div>" * n
        return f"<div class=\"ans\">{lines}</div>"
    return f"<div class=\"ans\" style=\"height:{h:g}pt\"></div>"


def css(theme: Theme) -> str:
    """All styling lives in theme.css (next to this script) so the designer can edit it
    directly. CSS custom properties carry the few themeable values."""
    css_path = Path(__file__).resolve().parent / "theme.css"
    base = css_path.read_text(encoding="utf-8") if css_path.exists() else ""
    if not base:
        print(f"warning: {css_path} not found — output will be unstyled", file=sys.stderr)
    try:
        title_size = float(theme.raw.get("title_size", DEFAULT_THEME["title_size"]))
    except (TypeError, ValueError):
        title_size = DEFAULT_THEME["title_size"]
    try:
        body_size = float(theme.raw.get("body_size", DEFAULT_THEME["body_size"]))
    except (TypeError, ValueError):
        body_size = DEFAULT_THEME["body_size"]
    root = (":root{"
            f"--primary:{theme.safe('primary')};--title-color:{theme.safe('title_color')};"
            f"--text:{theme.safe('text')};--muted:{theme.safe('muted')};"
            f"--rule:{theme.safe('rule')};--border:{theme.safe('border')};"
            f"--title-size:{title_size}pt;--body-size:{body_size}pt"
            "}")
    return root + "\n" + base


def render_block(blk: dict, theme: Theme) -> str:
    # Adding a block type or text field? Render it in render_lesson_docx.py in
    # the same commit — the html and docx renderers must emit the same text.
    t = _btype(blk)
    if t == "paragraph":
        return f"<p>{md(blk.get('text', ''))}</p>"
    if t == "labeled":
        lbl = label_text(blk)
        return f"<p><b>{md(lbl)}{label_sep(lbl)}</b> {md(blk.get('text', ''))}</p>"
    if t == "h2":
        # Semantic tag + legacy class: the tag builds a real document outline (browser
        # TOC, screen readers, find-in-page); the class keeps existing styling intact.
        return f"<h3 class=\"h2\">{md(blk.get('text', ''))}</h3>"
    if t == "h3":
        return f"<h4 class=\"h3\">{md(blk.get('text', ''))}</h4>"
    if t == "instructions":
        return f"<p class=\"instr\">{md(blk.get('text', ''))}</p>"
    if t in ("list", "checklist"):
        cls = ' class="check"' if t == "checklist" else ""
        tag = "ol" if blk.get("ordered") else "ul"
        items = "".join(f"<li>{md(i)}</li>" for i in blk.get("items", []))
        head = (f"<p class=\"listlabel\"><b>{md(label_text(blk))}</b></p>"
                if blk.get("label") else "")
        return f"{head}<{tag}{cls}>{items}</{tag}>"
    if t == "callout":
        # Models sometimes write "body"/"content" for the content key — tolerate rather than
        # silently rendering an empty box.
        text = blk.get("text") or blk.get("body") or blk.get("content") or ""
        kind = _resolve_callout_kind(blk)
        icon, klass = CALLOUT_KINDS[kind]
        label = label_text(blk)
        head = (f"<div class=\"co-label\"><span class=\"co-icon\">{icon}</span>"
                f"<b>{md(label)}</b></div>" if label
                else f"<div class=\"co-label\"><span class=\"co-icon\">{icon}</span></div>")
        body = f"<p style=\"margin:0\">{md(text)}</p>" if text else ""
        return f"<div class=\"co {klass}\">{head}{body}</div>"
    if t == "cards":
        items = [c if isinstance(c, dict) else {"title": str(c), "text": ""}
                 for c in blk.get("items", [])]
        cards = "".join(
            "<div class=\"card\">"
            f"<div class=\"card-title\">{md(c.get('title', ''))}</div>"
            f"<div class=\"card-body\">{md(c.get('text', ''))}</div></div>"
            for c in items)
        return f"<div class=\"cards\">{cards}</div>"
    if t == "fill_in":
        size = FILL_IN_SIZES.get(str(blk.get("size", "med")).lower(), FILL_IN_SIZES["med"])
        line = f"<span class=\"fillin\" style=\"width:{size}\"></span>"
        if blk.get("label"):
            return f"<p class=\"fillin-row\"><b>{md(label_text(blk))}:</b> {line}</p>"
        return f"<p class=\"fillin-row\">{line}</p>"
    if t == "phase_header":
        mins = blk.get("minutes")
        right = f"<span class=\"mins\">{md(mins)} 分钟</span>" if mins is not None else ""
        return (f"<h3 class=\"h2 phase\"><span>{md(blk.get('name', ''))}</span>"
                f"{right}</h3>")
    if t == "group":
        inner = "".join(render_block(b, theme) for b in blk.get("blocks", []))
        return f"<div style=\"page-break-inside:avoid\">{inner}</div>"
    if t == "workspace":
        return answer_space(blk, theme)
    if t == "labeled_box":
        label = md(label_text(blk))
        head = f"<p class=\"listlabel\"><b>{label}</b></p>" if label else ""
        return f"{head}{answer_space(blk, theme)}"
    if t == "page_break":
        return "<hr class=\"pagebreak\">"
    if t == "table":
        headers = coerce_headers(blk.get("headers"))
        head = ""
        if headers:
            # scope="col" lets a screen reader announce the column when reading a cell;
            # without it every cell is read as unlabelled data.
            head = ("<thead><tr>"
                    + "".join(f"<th scope=\"col\">{md(str(h).rstrip(': '))}</th>"
                              for h in headers)
                    + "</tr></thead>")
        rows = []
        for r in coerce_rows(blk.get("rows")):
            # An underscore run is the model writing "blank to fill in" — render it as a
            # real blank cell, not literal underscores.
            r = ["" if str(c).strip().strip("_") == "" and "_" in str(c) else c for c in r]
            full_blank = not any(str(c).strip() for c in r)
            row_h = table_row_height(blk, theme, full_blank=full_blank)
            cells = []
            for c in r:
                style = ""
                if not str(c).strip():  # td height acts as a minimum; the row still grows
                    style = f" style=\"height:{row_h:g}pt\""
                cells.append(f"<td{style}>{md(c)}</td>")
            rows.append("<tr>" + "".join(cells) + "</tr>")
        classes = [] if headers else ["headless"]
        if blk.get("display") == "large":
            classes.append("display-large")
        klass = f" class=\"{' '.join(classes)}\"" if classes else ""
        body = ("<tbody>" + "".join(rows) + "</tbody>") if rows else ""
        return f"<table{klass}>{head}{body}</table>"
    if t == "columns":
        left = "".join(render_block(b, theme) for b in blk.get("left", []))
        right = "".join(render_block(b, theme) for b in blk.get("right", []))
        return f"<div class=\"cols\"><div>{left}</div><div>{right}</div></div>"
    if t == "source_card":
        bits = " · ".join(md(str(blk.get(k))) for k in ("author", "date", "origin")
                          if blk.get(k))
        title = md(blk.get("title", ""))
        excerpt = md(blk.get("excerpt") or blk.get("text") or "")
        meta = f"<span class=\"sc-meta\"> — {bits}</span>" if bits else ""
        raw_url = str(blk.get("url") or "").strip()
        source_link = (f"<div class=\"sc-link\">来源链接：<a href=\"{escape(raw_url, quote=True)}\">"
                       f"{escape(raw_url)}</a></div>") if raw_url else ""
        return (f"<div class=\"sourcecard\"><div class=\"sc-head\"><b>{title}</b>{meta}</div>"
                f"<div class=\"sc-body\">{excerpt}</div>{source_link}</div>")
    if t == "fill_table":
        headers = coerce_headers(blk.get("headers"))
        row_h = table_row_height(blk, theme, full_blank=True)
        head = ("<tr>" + "".join(f"<th>{md(h)}</th>" for h in headers) + "</tr>") if headers else ""
        try:
            cols = max(1, len(headers) or int(blk.get("cols") or 2))
        except (TypeError, ValueError):
            cols = 2
        cols = min(cols, 12)
        rows_val = blk.get("rows")
        if isinstance(rows_val, list):
            # Mixed rows: a non-empty list renders its cells (a worked example);
            # an empty list [] renders a blank write-in row.
            body = ""
            for r in coerce_rows(rows_val[:50]):
                cells = r[:cols]
                cells += [""] * (cols - len(cells))
                # Underscore runs are write-in blanks, not text (same rule as `table`,
                # and as the docx fill_table path which forwards through _emit_table).
                cells = ["" if str(c).strip().strip("_") == "" and "_" in str(c) else c
                         for c in cells]
                tds = "".join(
                    f"<td>{md(c)}</td>" if str(c).strip()
                    else f"<td style=\"height:{row_h:g}pt\"></td>" for c in cells)
                body += f"<tr>{tds}</tr>"
            if not body:
                try:
                    n = int(blk.get("blank_rows") or 1)
                except (TypeError, ValueError):
                    n = 1
                n = min(max(1, n), 50)
                body = ("<tr>" + (f"<td style=\"height:{row_h:g}pt\"></td>" * cols) + "</tr>") * n
        else:
            try:
                n = int(blk.get("blank_rows") or rows_val or 3)
            except (TypeError, ValueError):
                n = 3
            n = min(max(1, n), 50)
            body = ("<tr>" + (f"<td style=\"height:{row_h:g}pt\"></td>" * cols) + "</tr>") * n
        return f"<table>{head}{body}</table>"
    if t == "number_line":
        lo, hi = blk.get("min", 0), blk.get("max", 10)
        try:
            raw_ticks = None if blk.get("ticks") is None else int(blk.get("ticks"))
        except (TypeError, ValueError):
            raw_ticks = None
        # An explicit 0 means "blank line — students partition it themselves": the
        # bar and its end labels still draw, but with no tick marks at all.
        is_blank = raw_ticks == 0
        ticks = 10 if raw_ticks is None else raw_ticks
        ticks = min(max(1, ticks), 100)
        marks = coerce_marks(blk.get("marks"))
        try:
            lo_f, hi_f = float(lo), float(hi)
            span = hi_f - lo_f or 1.0
        except (TypeError, ValueError):
            lo_f, hi_f, span = 0.0, float(ticks), float(ticks)
        eps = abs(span) * 0.002
        marks = [(v, lab) for v, lab in marks
                 if abs(v - lo_f) > eps and abs(v - hi_f) > eps]
        tick_html = "".join(
            f"<span class=\"nl-tick\" style=\"left:{(i/ticks)*100:.2f}%"
            + (";border-left:none" if is_blank else "") + "\">"
            f"<span class=\"nl-lab\">{md(lo if i == 0 else hi if i == ticks else '')}</span></span>"
            for i in range(ticks + 1))
        mark_html = "".join(
            f"<span class=\"nl-mark\" style=\"left:{((v-lo_f)/span)*100:.2f}%\"></span>"
            + (f"<span class=\"nl-mlab\" style=\"left:{((v-lo_f)/span)*100:.2f}%\">{md(lab)}</span>" if lab else "")
            for v, lab in marks)
        return (f"<div class=\"numberline\"><div class=\"nl-bar\">{tick_html}{mark_html}"
                f"</div></div>")
    if t == "chart":
        return render_chart_block(blk)
    if t == "figure":
        return render_figure_block(blk)
    # NEVER dump raw JSON into the page — a printed worksheet with {"type": ...} on it is a
    # blocking print-safety failure (seen in real model output: "list" and "labeled_box").
    if blk.get("text"):
        return f"<p>{md(blk.get('text'))}</p>"
    if blk.get("items"):
        return "<ul>" + "".join(f"<li>{md(i)}</li>" for i in blk.get("items", [])) + "</ul>"
    # Unknown type with no renderable content: emit nothing. (No debug comment — the type
    # string is model-controlled and could contain "-->" to break out of an HTML comment.)
    return ""


def _section_ids(sections: list) -> list[str]:
    """Deterministic anchor ids, one per section, in document order.

    Index-based on purpose: no hashing (which varies per process), no transliteration
    of Chinese headings, and stable across re-renders so a teacher's bookmark or a
    shared link keeps working after the source is edited.
    """
    return [f"sec{i + 1}" for i in range(len(sections))]


def _toc(sections: list, ids: list[str]) -> list[str]:
    """Screen-only table of contents. A 12-section plan is unscannable without one.

    Only rendered when the document has enough sections to need navigation; a
    three-section worksheet does not.
    """
    if len(sections) < 5:
        return []
    items = []
    for section, sid in zip(sections, ids):
        heading = str(section.get("heading", "")).rstrip(": ")
        if heading:
            items.append(f"<li><a href=\"#{sid}\">{md(heading)}</a></li>")
    if not items:
        return []
    return ["<nav class=\"toc\"><div class=\"toc-title\">本页内容</div><ol>"
            + "".join(items) + "</ol></nav>"]


def render(data: dict, source_dir: Path | str | None = None) -> str:
    global _SOURCE_DIR
    _SOURCE_DIR = Path(source_dir).resolve() if source_dir is not None else None
    data = expand_document(data, data.get("audience", "teacher"))
    theme = Theme(data.get("theme"))
    (theme.answer_height, theme.answer_gap,
     theme.answer_row, theme.ruled_default) = answer_profile(data)
    theme.student_doc = data.get("audience") == "student"
    hdr = build_header(data)
    out = ["<header class=\"hdr\">"]
    if hdr["eyebrow"]:
        out.append(f"<div class=\"eyebrow\">{md(hdr['eyebrow'])}</div>")
    out.append(f"<h1 class=\"title\">{md(hdr['title'])}</h1>")
    if hdr["meta"]:
        out.append(f"<div class=\"meta\">{md(hdr['meta'])}</div>")
    out.append("</header>")
    if hdr["name_line"]:
        out.append(f"<p style=\"margin:6pt 0 22pt\">{md(hdr['name_line'])}</p>")

    for blk in preamble_blocks(data):
        out.append(render_block(blk, theme))

    LIGHT_TYPES = {"paragraph", "labeled", "list", "checklist", "h2", "h3", "callout",
                   "instructions"}
    HEAVY_TYPES = {"group", "workspace", "labeled_box"}
    sections = data.get("sections", [])
    ids = _section_ids(sections)
    out.extend(_toc(sections, ids))
    for section, sid in zip(sections, ids):
        # h2, not h1: the document title in the header is the only h1, so the outline
        # reads "title -> section -> sub-section" as an author would expect.
        heading = str(section.get("heading", "")).rstrip(": ")
        h1 = (f"<h2 class=\"h1\" id=\"{sid}\"><span>{md(heading)}</span></h2>")
        # The section heading + leading light blocks + the first atomic item
        # (group/workspace) print as one unbreakable unit, so an instructions box never
        # strands above a page break while its first problem starts the next page.
        blocks = list(section.get("blocks", []))
        unit = [h1]
        glued = 0
        while blocks and glued < 4 and _btype(blocks[0]) in LIGHT_TYPES:
            unit.append(render_block(blocks.pop(0), theme))
            glued += 1
        if blocks and _btype(blocks[0]) in HEAVY_TYPES:
            unit.append(render_block(blocks.pop(0), theme))
        if len(unit) > 1:
            out.append("<section><div style=\"page-break-inside:avoid\">"
                       + "".join(unit) + "</div>")
        else:
            out.append("<section>" + h1)
        for blk in blocks:
            out.append(render_block(blk, theme))
        out.append("</section>")

    if data.get("footer_note"):
        out.append(f"<div class=\"footer\">{md(data['footer_note'])}</div>")

    title = escape(str(data.get("title", "Lesson Plan")), quote=True)
    # lang + viewport: without lang the browser picks Western line-breaking and font
    # fallbacks for Chinese, and screen readers use the wrong voice profile. Without
    # viewport the fixed 7.1in column forces horizontal scrolling on a tablet.
    return ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<meta name=\"generator\" content=\"geo-teacher lesson renderer\">"
            "<title>" + title
            + "</title><style>" + css(theme) + "</style></head><body><main class=\"page\">"
            + "".join(out) + "</main></body></html>")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="lesson JSON file")
    ap.add_argument("-o", "--output", default="lesson.html")
    args = ap.parse_args()
    src = Path(args.input)
    data = json.loads(src.read_text(encoding="utf-8"))
    Path(args.output).write_text(render(data, source_dir=src.parent), encoding="utf-8")
    print(f"wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
