"""Bar chart geometry + two renderings (SVG for HTML, PNG for DOCX).

Geometry is computed ONCE here so the HTML and DOCX products show the same chart.
No third-party plotting library: SVG is string-built, PNG is drawn with Pillow.

Why one module for both products (P-20 / P-10 in docs/modules/课程方案-问题记录.md): the failure the
chart block exists to kill is a bar whose length does not match its number — hand-typed `█`
blocks drew 6.1% and 6.8% at the same length and turned a 0.17-point gap into 1.5. If HTML and
DOCX each computed their own scale, the two products would disagree the same way. So this
module owns the arithmetic, and the two renderers are only allowed to DRAW `layout`.

Coordinate contract
-------------------
* Units are **pt** everywhere. `render_png` converts to pixels with `pt * dpi / 72`; it never
  re-derives a scale, a bar length or a label position.
* A key ending in ``_baseline`` is the y of the text baseline (SVG ``y``, Pillow anchor
  ``*s``), so both renderers put text at the same place.
* Bars are horizontal: the category axis is vertical, the value axis horizontal, so
  ``bar["w"]`` is the value-proportional length and ``tick["x"]`` the tick position.

Renderers are deliberately dumb. If you find yourself computing a coordinate in
render_lesson_html.py or render_lesson_docx.py, it belongs here instead.

Black-and-white safety
----------------------
Series are separated by FILL PATTERN first (solid / hollow / solid mid-grey / hollow dashed)
and only then by grey level, so a photocopy of either product still distinguishes 焦作 from
全国. ``layout["series_styles"]`` carries the pattern; colours are a render-time palette.

`■` (U+25A0) is never emitted: lesson_common.py:26 defines it as the "unknown number" symbol
and injects a maths definition line wherever it appears (P-27). Every text that reaches an
output goes through `_clean`, which maps a stray U+25A0 to the hollow square U+25A1.
"""
from __future__ import annotations

import io
import math
import os
import unicodedata

try:  # Pillow is only needed for the DOCX product; the HTML product must import this module
    from PIL import Image, ImageDraw, ImageFont  # on a host without Pillow.
    _PIL_ERROR = ""
except Exception as _exc:  # pragma: no cover - exercised only on hosts without Pillow
    Image = ImageDraw = ImageFont = None
    _PIL_ERROR = f"{type(_exc).__name__}: {_exc}"

__all__ = [
    "compute_layout", "render_svg", "render_png",
    "ChartError", "ChartFontError", "ChartRenderError",
    "MAX_CATEGORIES", "MAX_SERIES", "DEFAULT_COLORS",
]

# ---- limits the chart block accepts -----------------------------------------------------
MAX_CATEGORIES = 12
MAX_SERIES = 4

# ---- geometry constants (pt) ------------------------------------------------------------
# Bar height per series count. Few categories get generous bars; the ceiling is lowered when
# the category count alone would make the figure taller than it is wide (12 lines of data
# would otherwise produce a near-square figure that eats most of an A4 page).
BAR_HEIGHTS = {1: 16.0, 2: 12.0, 3: 10.0, 4: 8.0}
MIN_BAR_H = 5.0               # below this, value labels collide
PLOT_H_RATIO = 0.60           # plot height ceiling, as a fraction of the canvas width
BAR_GAP = 3.0                 # between bars inside one category
GROUP_GAP_WIDE = 10.0         # between categories, few categories
GROUP_GAP_NARROW = 8.0        # between categories, many categories
FONT_SIZES = {"title": 10.5, "legend": 8.5, "category": 8.5,
              "tick": 7.5, "value": 7.5, "note": 7.5}
RULES = {"axis": 0.7, "grid": 0.4, "bar": 0.7, "tick": 0.5}   # stroke widths, pt

# ---- CJK fonts --------------------------------------------------------------------------
# Hard-coded Windows paths on purpose: the DOCX product is printed on Windows teacher
# machines. A missing font must FAIL (see ChartFontError), never silently fall back to PIL's
# bitmap font, which renders every Chinese glyph as a box.
CJK_TITLE_FONT = os.environ.get("CHART_CJK_TITLE_FONT") or r"C:\Windows\Fonts\simhei.ttf"
CJK_BODY_FONT = os.environ.get("CHART_CJK_BODY_FONT") or r"C:\Windows\Fonts\simsun.ttc"

# ---- palette ----------------------------------------------------------------------------
# Grey levels, not hues: print_color_adjust cannot be relied on for a printed sheet, and SVG
# `fill` is content (it prints) while a CSS background is not.
DEFAULT_COLORS = {
    "ink": "#222222",     # text, solid bars, outlines
    "mid": "#A3A3A3",     # third series fill
    "muted": "#666666",   # note, secondary text
    "rule": "#6E747A",    # axis line
    "grid": "#DCE0E4",    # gridlines
    "paper": "#FFFFFF",
}

# Pattern assignment, fixed here so both products label the same series the same way.
# solid dark -> hollow dark -> solid grey -> hollow dashed. Two series (the common case:
# 焦作 vs 全国) differ by fill, which survives both greyscale printing and photocopying.
SERIES_STYLES = (
    {"fill_mode": "solid", "tone": "ink", "dashed": False},
    {"fill_mode": "hollow", "tone": "ink", "dashed": False},
    {"fill_mode": "solid", "tone": "mid", "dashed": False},
    {"fill_mode": "hollow", "tone": "ink", "dashed": True},
)

SVG_FONT_TITLE = "SimHei, 'Heiti SC', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif"
SVG_FONT_BODY = "SimSun, 'Songti SC', 'Microsoft YaHei', 'Noto Serif CJK SC', serif"

_UNKNOWN_SQUARE = "\u25a0"   # ■  — written as an escape so this source file never carries it
_HOLLOW_SQUARE = "\u25a1"    # □  — safe substitute, triggers no lesson_common injection
_CLOSERS = "，。、；：！？）》」』〕】%,.;:!?)]}"


class ChartError(RuntimeError):
    """Base class for chart failures that the caller must not ignore."""


class ChartFontError(ChartError):
    """A CJK font could not be loaded, so Chinese would print as boxes."""


class ChartRenderError(ChartError):
    """A layout could not be drawn (invalid layout, or Pillow unavailable)."""


# =========================================================================================
# Text measurement
# =========================================================================================
# SVG and Pillow cannot agree on glyph metrics, so both renderers reserve space from THIS
# estimate instead of the font engine. It only ever sizes padding and wrapping: bar lengths
# and tick positions are exact ratios of the data, never text measurements.

def _char_em(ch: str) -> float:
    """Approximate advance width of one character, in em."""
    if ch == " ":
        return 0.32
    if ch in "iljtfrI.,;:'\"!|`()[]{}":
        return 0.30
    if ch == "%":
        return 0.72
    if ch.isdigit():
        return 0.55
    if ch.isascii() and ch.isalpha():
        return 0.60
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 1.00
    return 0.62


def _text_width(text: str, size_pt: float) -> float:
    """Estimated single-line width, pt."""
    return sum(_char_em(ch) for ch in str(text)) * float(size_pt)


def _clean(text) -> str:
    """Normalize any user string to one printable line, and drop the ■ injection hazard."""
    s = str(text if text is not None else "")
    if _UNKNOWN_SQUARE in s:
        s = s.replace(_UNKNOWN_SQUARE, _HOLLOW_SQUARE)
    s = "".join(ch for ch in s if ch in "\t\n" or ord(ch) >= 32)
    return " ".join(s.replace("\t", " ").split("\n")).strip()


def _wrap(text: str, max_w: float, size_pt: float, max_lines: int = 2) -> list[str]:
    """Greedy per-character wrap. Chinese has no spaces, so character wrapping is correct;
    closing punctuation is kept off the next line's start."""
    text = _clean(text)
    if not text:
        return []
    if _text_width(text, size_pt) <= max_w:
        return [text]
    lines: list[str] = []
    cur, cur_w = "", 0.0
    for ch in text:
        w = _char_em(ch) * size_pt
        if cur and cur_w + w > max_w and ch not in _CLOSERS:
            lines.append(cur)
            cur, cur_w = "", 0.0
        cur += ch
        cur_w += w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        kept = lines[:max_lines]
        tail = "".join(lines[max_lines - 1:])
        while tail and _text_width(tail + "…", size_pt) > max_w:
            tail = tail[:-1]
        kept[-1] = tail + "…"
        lines = kept
    return lines


def _fmt_num(value: float) -> str:
    """Shortest honest label for a number: 60 -> '60', 42.6 -> '42.6', 2.5 -> '2.5'."""
    v = float(value)
    if abs(v - round(v)) < 1e-9:
        return str(int(round(v)))
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return s or "0"


def _n(value) -> str:
    """Format a coordinate for an SVG attribute (3 dp ≈ 0.004 px at 300 dpi)."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "0"
    if not math.isfinite(v):
        return "0"
    s = f"{v:.3f}"
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"


def _esc(text) -> str:
    """XML-escape text; every string that reaches the SVG goes through here."""
    out = str(text)
    for raw, enc in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;"),
                     ('"', "&quot;"), ("'", "&#39;")):
        out = out.replace(raw, enc)
    return out


# =========================================================================================
# Spec validation
# =========================================================================================

class _SpecError(ValueError):
    """Internal: one readable reason the spec cannot be drawn. Never escapes the module."""


def _require_number(value, where: str) -> float:
    if isinstance(value, bool):
        raise _SpecError(f"{where} 必须是数字，收到布尔值 {value!r}")
    if isinstance(value, (int, float)):
        out = float(value)
    elif isinstance(value, str) and value.strip():
        try:
            out = float(value.strip())
        except ValueError:
            raise _SpecError(f"{where} 不是数字：{value!r}") from None
    else:
        raise _SpecError(f"{where} 不是数字：{value!r}")
    if not math.isfinite(out):
        raise _SpecError(f"{where} 不是有限数字：{value!r}")
    return out


def _as_bool_flag(raw, default: bool = True) -> bool:
    if raw is None:
        return default
    if isinstance(raw, str):
        return raw.strip().lower() not in ("false", "no", "0", "off", "否", "")
    return bool(raw)


def _axis_values(top: float, step: float) -> list[float]:
    """0, step, 2*step … up to `top`, with `top` itself always present."""
    top, step = float(top), float(step)
    if not (step > 0):
        return [0.0, top]
    count = int(round(top / step))
    values = [round(i * step, 10) for i in range(max(0, count) + 1)]
    if not values:
        values = [0.0]
    if abs(values[-1] - top) > 1e-9:
        values.append(top)
    return values


def _nice_step(span: float) -> float:
    """A 1/2/2.5/5 × 10^k step giving 4-7 ticks over `span`."""
    span = float(span)
    if not (span > 0):
        return 1.0
    best = None
    for k in range(-6, 8):
        for m in (1.0, 2.0, 2.5, 5.0):
            step = m * (10.0 ** k)
            count = span / step
            if 3.0 <= count <= 6.0:
                score = abs(count - 4.5)
                if best is None or score < best[0] - 1e-12:
                    best = (score, step)
    if best is None:
        return span / 4.0
    return best[1]


def _error_layout(message: str, width: float) -> dict:
    """The shape every caller can rely on when the spec is unusable."""
    width = float(width) if isinstance(width, (int, float)) and math.isfinite(float(width)) \
        and float(width) > 0 else 460.8
    return {
        "ok": False, "error": message,
        "width": width, "height": 34.0,
        "plot_x": 0.0, "plot_w": 0.0, "plot_top": 0.0, "plot_h": 0.0, "plot_bottom": 0.0,
        "bars": [], "ticks": [], "series_names": [], "series_styles": [],
        "categories": [], "category_labels": [],
        "title": "", "unit": "", "note": "",
        "title_x": 0.0, "title_baseline": 0.0,
        "title_lines": [], "title_baselines": [],
        "legend": {"x": 0.0, "y": 0.0, "items": [], "overlaps_title": False,
                   "baselines": [], "rows": []},
        "axis": {"x0": 0.0, "x1": 0.0, "y": 0.0, "label_baseline": 0.0},
        "note_box": {"x": 0.0, "baselines": [], "line_h": 0.0, "lines": []},
        "fonts": dict(FONT_SIZES), "rules": dict(RULES),
        "scale": {"max": 0.0, "step": 0.0, "data_max": 0.0},
        "value_labels": False,
    }


# =========================================================================================
# compute_layout
# =========================================================================================

def compute_layout(spec: dict, *, width_pt: float = 460.8) -> dict:
    """Return a theme-independent geometry dict. Pure function, no I/O.

    spec 字段（全部来自 lesson.json 的 chart 块）：
      title: str            图表标题（可含图号），可缺省
      categories: list[str] 横轴分类名（每根条一个），必填，1..12 个
      series: list[dict]    [{"name": "焦作", "values": [6.1, 42.6, 51.3]}, ...]
                            必填，1..4 个序列；每个 values 长度必须等于 categories
      max: float|None       显式上界（None 时按数据最大值取整到"好看"的刻度）
      unit: str             数值单位后缀，如 "%"、"元"、"万人次"，可缺省
      note: str             来源注/读图提醒，可缺省
      value_labels: bool    是否在每根条末端标数值，默认 True

    width_pt 是画布宽度：DOCX 侧固定 6.4in = 460.8pt（A4 去 0.7in 边距后可用 6.87in），
    高度由内容推出，两种产物共用同一个纵横比。

    返回的 geometry 除文档约定的字段外，还带两个渲染器直接使用的绘制指引：
    ``category_labels`` / ``legend`` / ``axis`` / ``note_box`` / ``fonts`` / ``rules`` /
    ``series_styles``，含义同模块 docstring 的坐标约定。非法输入返回 ok=False + error，
    本函数不抛异常。
    """
    try:
        return _compute_layout(spec, width_pt=width_pt)
    except _SpecError as exc:
        return _error_layout(str(exc), width_pt)
    except Exception as exc:  # last line of defence: a broken chart must not kill a lesson
        return _error_layout(
            f"图表数据无法计算（{type(exc).__name__}: {exc}）", width_pt)


def _compute_layout(spec: dict, *, width_pt: float) -> dict:
    # ---- spec we cannot work with ------------------------------------------------
    if not isinstance(spec, dict):
        raise _SpecError(f"图表数据必须是对象，收到 {type(spec).__name__}")
    try:
        width = float(width_pt)
    except (TypeError, ValueError):
        raise _SpecError(f"width_pt 必须是数字，收到 {width_pt!r}") from None
    if not math.isfinite(width) or width <= 0:
        raise _SpecError(f"width_pt 必须为正数，收到 {width_pt!r}")

    # ---- categories --------------------------------------------------------------
    raw_categories = spec.get("categories")
    if not isinstance(raw_categories, (list, tuple)) or not raw_categories:
        raise _SpecError("categories 必须是非空列表（1—12 个分类名）")
    if len(raw_categories) > MAX_CATEGORIES:
        raise _SpecError(f"categories 最多 {MAX_CATEGORIES} 个，收到 {len(raw_categories)} 个")
    categories = []
    for i, raw in enumerate(raw_categories):
        name = _clean(raw)
        if not name:
            raise _SpecError(f"categories[{i}] 为空")
        categories.append(name)

    # ---- series ------------------------------------------------------------------
    raw_series = spec.get("series")
    if not isinstance(raw_series, (list, tuple)) or not raw_series:
        raise _SpecError("series 必须是非空列表（1—4 个序列）")
    if len(raw_series) > MAX_SERIES:
        raise _SpecError(f"series 最多 {MAX_SERIES} 个，收到 {len(raw_series)} 个")
    series: list[dict] = []
    for j, raw in enumerate(raw_series):
        if not isinstance(raw, dict):
            raise _SpecError(f"series[{j}] 必须是对象，收到 {type(raw).__name__}")
        values = raw.get("values")
        if not isinstance(values, (list, tuple)):
            raise _SpecError(f"series[{j}].values 必须是数字列表")
        if len(values) != len(categories):
            raise _SpecError(
                f"series[{j}].values 有 {len(values)} 个值，categories 有 "
                f"{len(categories)} 个，必须一一对应")
        numbers = [_require_number(v, f"series[{j}].values[{k}]")
                   for k, v in enumerate(values)]
        for k, v in enumerate(numbers):
            if v < 0:
                raise _SpecError(
                    f"series[{j}].values[{k}] 为负数（{_fmt_num(v)}），"
                    "条形图只支持非负数")
        name = _clean(raw.get("name")) or f"序列{j + 1}"
        series.append({"name": name, "values": numbers})

    # ---- vertical scale ----------------------------------------------------------
    # The baseline is pinned to 0: a truncated axis is what made the 0.17-point gap look like
    # 1.5 in the first place, and readers assume bars start at zero.
    data_max = max(max(item["values"]) for item in series)
    raw_max = spec.get("max")
    if raw_max is None or (isinstance(raw_max, str) and not raw_max.strip()):
        if data_max <= 0:
            raise _SpecError("所有数值都是 0，无法自动确定刻度上界；请显式给出 max")
        step = _nice_step(data_max)
        top = math.ceil(data_max / step - 1e-9) * step
        top = max(top, data_max)
    else:
        top = _require_number(raw_max, "max")
        if top <= 0:
            raise _SpecError(f"max 必须为正数，收到 {_fmt_num(top)}")
        if top < data_max - 1e-9:
            raise _SpecError(
                f"max={_fmt_num(top)} 小于数据最大值 {_fmt_num(data_max)}，条会溢出绘图区")
        step = _nice_step(top)

    title = _clean(spec.get("title"))
    unit = _clean(spec.get("unit"))
    note = _clean(spec.get("note"))
    value_labels = _as_bool_flag(spec.get("value_labels"), True)

    # ---- font sizes and frame ----------------------------------------------------
    fs = dict(FONT_SIZES)
    pad = 2.0
    top_pad = pad
    inner_w = width - 2 * pad

    # A title that does not fit is wrapped, never allowed to run past the right edge (in the
    # DOCX product an overflowing title is silently clipped at the image border).
    title_lines = _wrap(title, inner_w, fs["title"], max_lines=2) if title else []
    title_line_h = fs["title"] * 1.50
    title_baselines = [top_pad + fs["title"] * 1.05 + i * title_line_h
                       for i in range(len(title_lines))]
    title_h = len(title_lines) * title_line_h
    title_baseline = title_baselines[0] if title_baselines else 0.0

    # Legend: on the title row when it genuinely fits beside the title, otherwise on its own
    # row(s). Items wrap into rows rather than shrinking, so four long series names cannot
    # start off the left edge of the canvas.
    n_cat, n_ser = len(categories), len(series)
    swatch_w = 11.0
    swatch_h = fs["legend"] * 0.78
    legend_gap = 12.0
    legend_item_w = [swatch_w + 3.0 + _text_width(s["name"], fs["legend"]) for s in series]
    single_row_w = sum(legend_item_w) + (n_ser - 1) * legend_gap
    title_line_0_w = _text_width(title_lines[0], fs["title"]) if title_lines else 0.0
    legend_overlaps_title = bool(len(title_lines) == 1) and (title_line_0_w + 14.0
                                                            <= inner_w - single_row_w)
    legend_rows: list[list[int]] = []
    if legend_overlaps_title:
        legend_rows = [[j for j in range(n_ser)]]
        legend_h = 0.0
        legend_top = title_baselines[0] - fs["legend"] * 1.0
    else:
        row: list[int] = []
        row_w = 0.0
        for j, item_w in enumerate(legend_item_w):
            add = item_w if not row else item_w + legend_gap
            if row and row_w + add > inner_w:
                legend_rows.append(row)
                row, row_w = [j], item_w
            else:
                row.append(j)
                row_w += add
        if row:
            legend_rows.append(row)
        legend_h = len(legend_rows) * fs["legend"] * 1.80
        legend_top = top_pad + fs["legend"] * 1.15

    plot_top = top_pad + title_h + legend_h + 3.0

    # ---- horizontal scale --------------------------------------------------------
    # Bars get thinner when height is the binding constraint: 12 categories × 1 series at full
    # bar height would make a near-square figure that eats most of an A4 page. The floor keeps
    # bars tall enough for their value labels to stay legible, and the ceiling keeps the figure
    # wider than tall so it reads like a chart rather than a block.
    group_gap = GROUP_GAP_WIDE if n_cat <= 4 else GROUP_GAP_NARROW
    bar_gaps_h = n_cat * (n_ser - 1) * BAR_GAP
    group_gaps_h = (n_cat - 1) * group_gap
    height_budget = PLOT_H_RATIO * width
    bar_h = BAR_HEIGHTS[n_ser]
    plot_h = n_cat * (n_ser * bar_h + (n_ser - 1) * BAR_GAP) + group_gaps_h
    if plot_h > height_budget:
        fitted = (height_budget - bar_gaps_h - group_gaps_h) / float(n_cat * n_ser)
        if fitted > MIN_BAR_H:
            bar_h = fitted
            plot_h = n_cat * (n_ser * bar_h + (n_ser - 1) * BAR_GAP) + group_gaps_h
    group_h = n_ser * bar_h + (n_ser - 1) * BAR_GAP

    category_w = max(_text_width(c, fs["category"]) for c in categories)
    plot_x = pad + category_w + 7.0

    value_texts = [f"{_fmt_num(v)}{unit}" for s in series for v in s["values"]]
    value_label_w = max((_text_width(t, fs["value"]) for t in value_texts), default=0.0) \
        if value_labels else 0.0
    # The right gutter holds the value label of the longest bar, and half of the axis-end
    # tick label (centred on the plot edge), whichever is wider.
    axis_end_w = _text_width(_fmt_num(top) + unit, fs["tick"]) / 2.0
    right_pad = max(value_label_w + 5.0, axis_end_w + 3.0)
    plot_w = width - plot_x - right_pad
    if plot_w < 60.0:
        raise _SpecError(
            f"画布宽 {_fmt_num(width)}pt 不足：留给绘图区的宽度只有 "
            f"{_fmt_num(plot_w)}pt，至少要 60pt")

    plot_bottom = plot_top + plot_h
    axis_label_baseline = plot_bottom + 2.5 + fs["tick"]
    axis_h = (axis_label_baseline - plot_bottom) + 1.5

    # ---- note (source line / reading reminder) -----------------------------------
    # Wrapped here, not in the renderers: both products must break the source line at the same
    # character, or the DOCX and HTML notes read differently.
    note_lines = _wrap(note, width - 2 * pad, fs["note"]) if note else []
    note_line_h = fs["note"] * 1.50
    note_first = plot_bottom + axis_h + 3.0 + fs["note"] * 0.95
    note_baselines = [note_first + i * note_line_h for i in range(len(note_lines))]
    if note_baselines:
        height = note_baselines[-1] + fs["note"] * 0.35 + pad
    else:
        height = plot_bottom + axis_h + pad

    # ---- ticks -------------------------------------------------------------------
    values = _axis_values(top, step)
    ticks: list[dict] = []
    for idx, value in enumerate(values):
        label = _fmt_num(value) + (unit if idx == len(values) - 1 else "")
        ticks.append({
            "value": float(value),
            "x": plot_x + (float(value) / top) * plot_w,
            "label": label,
            "baseline": axis_label_baseline,
            "grid": True,
            "last": idx == len(values) - 1,
        })

    # ---- bars --------------------------------------------------------------------
    # The ONLY place a number becomes a length: w = value / axis_max * plot_w. No rounding,
    # no per-bar scaling, so 42.6 : 36.5 : 51.3 survive exactly.
    bars: list[dict] = []
    category_labels: list[dict] = []
    for i, category in enumerate(categories):
        group_top = plot_top + i * (group_h + group_gap)
        group_mid = group_top + group_h / 2.0
        category_labels.append({
            "text": category,
            "x": plot_x - 7.0,
            "baseline": group_mid + fs["category"] * 0.35,
            "anchor": "end",
        })
        for j, item in enumerate(series):
            value = item["values"][i]
            y = group_top + j * (bar_h + BAR_GAP)
            w = (value / top) * plot_w
            bars.append({
                "category": category,
                "series_name": item["name"],
                "series_index": j,
                "value": float(value),
                "x": plot_x,
                "y": y,
                "w": w,
                "h": bar_h,
                "value_label": f"{_fmt_num(value)}{unit}",
                "label_x": plot_x + w + 3.0,
                "label_baseline": y + bar_h / 2.0 + fs["value"] * 0.35,
            })

    # ---- legend items ------------------------------------------------------------
    # Laid out per row: each row is right-aligned against the canvas edge, so the legend block
    # as a whole stays inside the frame whatever the series names are.
    legend_items: list[dict] = []
    legend_row_baselines: list[float] = []
    for r, row_indices in enumerate(legend_rows or [[]]):
        row_w = (sum(legend_item_w[j] for j in row_indices)
                 + max(0, len(row_indices) - 1) * legend_gap)
        baseline = legend_top + fs["legend"] * 1.15 + r * fs["legend"] * 1.80
        legend_row_baselines.append(baseline)
        cursor = width - pad - row_w
        for j in row_indices:
            legend_items.append({
                "name": series[j]["name"],
                "series_index": j,
                "style": SERIES_STYLES[j % len(SERIES_STYLES)],
                "swatch": {"x": cursor, "y": baseline - swatch_h + fs["legend"] * 0.18,
                           "w": swatch_w, "h": swatch_h},
                "label_x": cursor + swatch_w + 3.0,
                "baseline": baseline,
                "row": r,
            })
            cursor += legend_item_w[j] + legend_gap
    # Items must be emitted in series order for a stable paint order.
    legend_items.sort(key=lambda it: it["series_index"])

    return {
        "ok": True, "error": None,
        "width": width, "height": height,

        # plotting frame
        "plot_x": plot_x, "plot_w": plot_w,
        "plot_top": plot_top, "plot_h": plot_h, "plot_bottom": plot_bottom,

        # data marks
        "bars": bars,
        "ticks": ticks,
        "categories": categories,
        "category_labels": category_labels,
        "series_names": [item["name"] for item in series],
        "series_styles": [dict(SERIES_STYLES[j % len(SERIES_STYLES)])
                          for j in range(n_ser)],

        # text
        "title": title, "unit": unit, "note": note,
        "title_x": pad, "title_baseline": title_baseline,
        "title_lines": title_lines,
        "title_baselines": title_baselines,
        "legend": {"x": width - pad - max(
                       [sum(legend_item_w[j] for j in ri)
                        + max(0, len(ri) - 1) * legend_gap for ri in (legend_rows or [[]])]
                       or [0.0]),
                   "y": legend_top + fs["legend"] * 1.15,
                   "items": legend_items, "overlaps_title": legend_overlaps_title,
                   "baselines": legend_row_baselines,
                   "rows": legend_rows or []},
        "axis": {"x0": plot_x, "x1": plot_x + plot_w, "y": plot_bottom,
                 "label_baseline": axis_label_baseline},
        "note_box": {"x": pad, "baselines": note_baselines, "line_h": note_line_h,
                     "lines": note_lines},
        "fonts": fs,
        "rules": dict(RULES),
        "scale": {"max": top, "step": step, "data_max": data_max},
        "value_labels": value_labels,
    }


# =========================================================================================
# SVG (HTML product)
# =========================================================================================

def _palette(colors: dict | None) -> dict:
    pal = dict(DEFAULT_COLORS)
    for key, value in (colors or {}).items():
        if key in pal and isinstance(value, str) and value.strip():
            pal[key] = value.strip()
    return pal


def _error_svg(message: str, width: float) -> str:
    """A visible, printable error frame — never an empty string (an empty box on a printed
    page is indistinguishable from a lost figure)."""
    width = float(width) if width and float(width) > 0 else 460.8
    fs = 8.5
    lines = _wrap(f"图表数据有误：{_clean(message)}", width - 16.0, fs, max_lines=2)
    height = 10.0 + len(lines) * fs * 1.5
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_n(width)} {_n(height)}" '
        f'width="100%" preserveAspectRatio="xMinYMin meet" role="img" class="chart chart-error" '
        f'data-chart-error="1" aria-label="图表数据有误" '
        f'style="width:100%;height:auto;display:block">',
        f'<title>{_esc("图表数据有误")}</title>',
        f'<rect x="0.5" y="0.5" width="{_n(width - 1)}" height="{_n(height - 1)}" '
        f'fill="#FFFFFF" stroke="{DEFAULT_COLORS["rule"]}" stroke-width="0.7" '
        f'stroke-dasharray="3 2"/>',
    ]
    for i, line in enumerate(lines):
        base = 6.0 + fs + i * fs * 1.5
        out.append(
            f'<text x="{_n(8.0)}" y="{_n(base)}" font-family="{SVG_FONT_BODY}" '
            f'font-size="{_n(fs)}" fill="{DEFAULT_COLORS["muted"]}">{_esc(line)}</text>')
    out.append("</svg>")
    return "\n".join(out)


def render_svg(layout: dict, colors: dict | None = None) -> str:
    """Return an inline <svg> element string (no XML declaration, no <script>).

    * viewBox keeps it vector-scalable; width="100%" lets it fill a narrow column.
    * Every text node is escaped, and no text path can emit `■`.
    * Series differ by fill pattern and grey level, so the chart survives a greyscale print.
    * layout["ok"] is False -> an error frame is returned, never an empty string.

    colors may override "ink" / "mid" / "muted" / "rule" / "grid" / "paper"; the fill PATTERN
    of each series is fixed in layout["series_styles"], so a theme can recolor the chart
    without breaking black-and-white legibility.
    """
    lay = layout if isinstance(layout, dict) else {}
    if not lay.get("ok"):
        try:
            width = float(lay.get("width") or 460.8)
        except (TypeError, ValueError):
            width = 460.8
        return _error_svg(lay.get("error") or "图表数据不合法", width)

    pal = _palette(colors)
    fs = lay.get("fonts") or FONT_SIZES
    rules = lay.get("rules") or RULES
    width = float(lay["width"])
    height = float(lay["height"])
    styles = lay.get("series_styles") or list(SERIES_STYLES)

    aria = _clean(lay.get("title")) or "数据图"
    out: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_n(width)} {_n(height)}" '
        f'width="100%" preserveAspectRatio="xMinYMin meet" role="img" class="chart" '
        f'data-chart-ok="1" aria-label="{_esc(aria)}" '
        f'style="width:100%;height:auto;display:block">',
        f'<title>{_esc(aria)}</title>',
        f'<g font-family="{SVG_FONT_BODY}" fill="{pal["ink"]}">',
        f'<rect x="0" y="0" width="{_n(width)}" height="{_n(height)}" fill="{pal["paper"]}"/>',
    ]

    plot_left = float(lay["plot_x"])
    plot_right = plot_left + float(lay["plot_w"])
    plot_top = float(lay["plot_top"])
    plot_bottom = float(lay["plot_bottom"])

    # gridlines first, so bars sit on top of them
    for tick in lay.get("ticks") or []:
        out.append(
            f'<line x1="{_n(tick["x"])}" y1="{_n(plot_top)}" x2="{_n(tick["x"])}" '
            f'y2="{_n(plot_bottom)}" stroke="{pal["grid"]}" '
            f'stroke-width="{_n(rules["grid"])}" stroke-dasharray="2 2"/>')

    # bars: fill pattern = series identity
    for bar in lay.get("bars") or []:
        style = styles[bar.get("series_index", 0) % len(styles)] if styles else SERIES_STYLES[0]
        fill = pal["paper"] if style.get("fill_mode") == "hollow" else pal[style.get("tone", "ink")]
        dash = ' stroke-dasharray="4 2"' if style.get("dashed") else ""
        out.append(
            f'<rect x="{_n(bar["x"])}" y="{_n(bar["y"])}" width="{_n(bar["w"])}" '
            f'height="{_n(bar["h"])}" fill="{fill}" stroke="{pal[style.get("tone", "ink")]}" '
            f'stroke-width="{_n(rules["bar"])}"{dash}/>')

    # axis line + tick marks
    out.append(
        f'<line x1="{_n(plot_left)}" y1="{_n(plot_bottom)}" x2="{_n(plot_right)}" '
        f'y2="{_n(plot_bottom)}" stroke="{pal["rule"]}" '
        f'stroke-width="{_n(rules["axis"])}"/>')
    for tick in lay.get("ticks") or []:
        out.append(
            f'<line x1="{_n(tick["x"])}" y1="{_n(plot_bottom)}" x2="{_n(tick["x"])}" '
            f'y2="{_n(plot_bottom + 2.5)}" stroke="{pal["rule"]}" '
            f'stroke-width="{_n(rules["tick"])}"/>')

    # tick labels
    for tick in lay.get("ticks") or []:
        out.append(
            f'<text x="{_n(tick["x"])}" y="{_n(tick["baseline"])}" '
            f'font-size="{_n(fs["tick"])}" fill="{pal["muted"]}" '
            f'text-anchor="middle">{_esc(tick["label"])}</text>')

    # category labels (right-aligned against the plot edge)
    for label in lay.get("category_labels") or []:
        out.append(
            f'<text x="{_n(label["x"])}" y="{_n(label["baseline"])}" '
            f'font-size="{_n(fs["category"])}" fill="{pal["ink"]}" '
            f'text-anchor="end">{_esc(label["text"])}</text>')

    # value labels at the bar ends
    if lay.get("value_labels"):
        for bar in lay.get("bars") or []:
            out.append(
                f'<text x="{_n(bar["label_x"])}" y="{_n(bar["label_baseline"])}" '
                f'font-size="{_n(fs["value"])}" fill="{pal["ink"]}" '
                f'text-anchor="start">{_esc(bar["value_label"])}</text>')

    # title (may wrap to two lines)
    title_lines = lay.get("title_lines") or ([lay["title"]] if lay.get("title") else [])
    title_baselines = lay.get("title_baselines") or []
    for i, line in enumerate(title_lines):
        baseline = title_baselines[i] if i < len(title_baselines) else lay.get("title_baseline", 0)
        out.append(
            f'<text x="{_n(lay["title_x"])}" y="{_n(baseline)}" '
            f'font-family="{SVG_FONT_TITLE}" font-size="{_n(fs["title"])}" '
            f'font-weight="700" fill="{pal["ink"]}">{_esc(line)}</text>')

    # legend: a real rectangle swatch, never a ■ character (P-27)
    for item in (lay.get("legend") or {}).get("items") or []:
        style = item.get("style") or SERIES_STYLES[0]
        sw = item["swatch"]
        fill = pal["paper"] if style.get("fill_mode") == "hollow" else pal[style.get("tone", "ink")]
        dash = ' stroke-dasharray="4 2"' if style.get("dashed") else ""
        out.append(
            f'<rect x="{_n(sw["x"])}" y="{_n(sw["y"])}" width="{_n(sw["w"])}" '
            f'height="{_n(sw["h"])}" fill="{fill}" stroke="{pal[style.get("tone", "ink")]}" '
            f'stroke-width="{_n(rules["bar"] * 0.8)}"{dash}/>')
        out.append(
            f'<text x="{_n(item["label_x"])}" y="{_n(item["baseline"])}" '
            f'font-size="{_n(fs["legend"])}" fill="{pal["ink"]}">'
            f'{_esc(item["name"])}</text>')

    # note (source line) — lines and baselines both come from layout
    note_box = lay.get("note_box") or {}
    baselines = note_box.get("baselines") or []
    for i, line in enumerate(note_box.get("lines") or []):
        if i >= len(baselines):
            break
        out.append(
            f'<text x="{_n(note_box["x"])}" y="{_n(baselines[i])}" '
            f'font-size="{_n(fs["note"])}" fill="{pal["muted"]}">{_esc(line)}</text>')

    out.append("</g>")
    out.append("</svg>")
    return "\n".join(out)


# =========================================================================================
# PNG (DOCX product)
# =========================================================================================

_FONT_CACHE: dict[tuple, object] = {}


def _load_font(path: str, size_px: int, role: str):
    """Load a TrueType CJK font or fail loudly.

    PIL's silent fallback is a bitmap font whose Chinese glyphs are empty boxes. A DOCX that
    prints boxes is worse than a render error the caller can report, so there is no fallback
    here — only ChartFontError.
    """
    key = (path, size_px)
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached
    if ImageFont is None:
        raise ChartFontError(
            f"Pillow 不可用（{_PIL_ERROR}），无法生成 PNG 图表；HTML 侧仍可正常出图")
    if not path or not os.path.exists(path):
        raise ChartFontError(
            f"中文字体不存在（{role}）：{path}；图表拒绝回退到位图字体（中文会变成方块）")
    try:
        font = ImageFont.truetype(path, size_px, index=0)
    except Exception as exc:
        raise ChartFontError(
            f"中文字体加载失败（{role}）：{path}；{type(exc).__name__}: {exc}") from exc
    _FONT_CACHE[key] = font
    return font


def _rgb(value: str) -> tuple[int, int, int]:
    """Hex colour -> RGB. Unparseable colours fall back to black rather than raising: a bad
    theme token must not break figure generation."""
    s = str(value or "").strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) >= 6:
        try:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            pass
    return (0, 0, 0)


def _dashed_line(draw, p0, p1, color, width_px: int, dash_px: tuple[float, float]) -> None:
    x0, y0 = p0
    x1, y1 = p1
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length <= 0:
        return
    ux, uy = dx / length, dy / length
    on, off = dash_px
    pos = 0.0
    while pos < length:
        end = min(pos + on, length)
        draw.line([(x0 + ux * pos, y0 + uy * pos), (x0 + ux * end, y0 + uy * end)],
                  fill=color, width=width_px)
        pos = end + off


def _dashed_rect(draw, box, color, width_px: int, dash_px: tuple[float, float]) -> None:
    x0, y0, x1, y1 = box
    for p0, p1 in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)),
                   ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        _dashed_line(draw, p0, p1, color, width_px, dash_px)


def render_png(layout: dict, *, dpi: int = 300) -> bytes:
    """Return PNG bytes drawn with Pillow, at the same coordinates as render_svg.

    * Canvas = layout width/height in pt converted with pt -> inch (/72) -> px (*dpi).
    * dpi is written into the PNG so Word places the image at the intended physical size.
    * Chinese text uses simhei.ttf (title) / simsun.ttc (body); a load failure raises
      ChartFontError instead of printing boxes.
    * An invalid layout raises ChartRenderError: embedding a "chart failed" placeholder into a
      Word deliverable is worse than letting the caller report the data error.
    """
    if not isinstance(layout, dict) or not layout.get("ok"):
        message = (layout or {}).get("error") if isinstance(layout, dict) else "layout 不是对象"
        raise ChartRenderError(f"图表数据有误，无法生成 PNG：{message or '未知原因'}")
    try:
        dpi = int(dpi)
    except (TypeError, ValueError):
        raise ChartRenderError(f"dpi 必须是整数，收到 {dpi!r}") from None
    if dpi <= 0:
        raise ChartRenderError(f"dpi 必须为正数，收到 {dpi!r}")

    pal = _palette(None)
    fs = layout.get("fonts") or FONT_SIZES
    rules = layout.get("rules") or RULES
    styles = layout.get("series_styles") or list(SERIES_STYLES)

    scale = dpi / 72.0                     # pt -> px

    def px(value: float) -> float:
        return float(value) * scale

    def stroke(pt_value: float) -> int:
        return max(1, int(round(float(pt_value) * scale)))

    width_px = int(round(float(layout["width"]) * scale))
    height_px = int(round(float(layout["height"]) * scale))
    if width_px < 1 or height_px < 1:
        raise ChartRenderError(f"画布尺寸过小：{width_px}×{height_px} px")

    image = Image.new("RGB", (width_px, height_px), _rgb(pal["paper"]))
    draw = ImageDraw.Draw(image)

    def text_font(kind: str, size_pt: float):
        role = "标题" if kind == "title" else "正文"
        path = CJK_TITLE_FONT if kind == "title" else CJK_BODY_FONT
        size_px = max(6, int(round(float(size_pt) * scale)))
        return _load_font(path, size_px, role)

    ink, muted, rule, grid_c = (_rgb(pal["ink"]), _rgb(pal["muted"]),
                                _rgb(pal["rule"]), _rgb(pal["grid"]))
    paper = _rgb(pal["paper"])

    plot_left = float(layout["plot_x"])
    plot_right = plot_left + float(layout["plot_w"])
    plot_top = float(layout["plot_top"])
    plot_bottom = float(layout["plot_bottom"])

    # gridlines
    for tick in layout.get("ticks") or []:
        _dashed_line(draw, (px(tick["x"]), px(plot_top)), (px(tick["x"]), px(plot_bottom)),
                     grid_c, stroke(rules["grid"]), (px(2.0), px(2.0)))

    # bars
    for bar in layout.get("bars") or []:
        style = styles[bar.get("series_index", 0) % len(styles)] if styles else SERIES_STYLES[0]
        tone = _rgb(pal[style.get("tone", "ink")])
        box = [px(bar["x"]), px(bar["y"]),
               px(bar["x"] + bar["w"]), px(bar["y"] + bar["h"])]
        fill = paper if style.get("fill_mode") == "hollow" else tone
        if box[2] <= box[0]:                     # a zero value draws no bar, only its label
            continue
        draw.rectangle(box, fill=fill)
        if style.get("dashed"):
            _dashed_rect(draw, box, tone, stroke(rules["bar"]), (px(4.0), px(2.0)))
        else:
            draw.rectangle(box, outline=tone, width=stroke(rules["bar"]))

    # axis + tick marks
    draw.line([(px(plot_left), px(plot_bottom)), (px(plot_right), px(plot_bottom))],
              fill=rule, width=stroke(rules["axis"]))
    for tick in layout.get("ticks") or []:
        draw.line([(px(tick["x"]), px(plot_bottom)),
                   (px(tick["x"]), px(plot_bottom + 2.5))],
                  fill=rule, width=stroke(rules["tick"]))

    # tick labels
    tick_font = text_font("body", fs["tick"])
    for tick in layout.get("ticks") or []:
        draw.text((px(tick["x"]), px(tick["baseline"])), str(tick["label"]),
                  font=tick_font, fill=muted, anchor="ms")

    # category labels
    cat_font = text_font("body", fs["category"])
    for label in layout.get("category_labels") or []:
        draw.text((px(label["x"]), px(label["baseline"])), str(label["text"]),
                  font=cat_font, fill=ink, anchor="rs")

    # value labels
    if layout.get("value_labels"):
        value_font = text_font("body", fs["value"])
        for bar in layout.get("bars") or []:
            draw.text((px(bar["label_x"]), px(bar["label_baseline"])),
                      str(bar["value_label"]), font=value_font, fill=ink, anchor="ls")

    # title
    title_lines = layout.get("title_lines") or ([layout["title"]] if layout.get("title") else [])
    title_baselines = layout.get("title_baselines") or []
    if title_lines:
        title_font = text_font("title", fs["title"])
        for i, line in enumerate(title_lines):
            baseline = (title_baselines[i] if i < len(title_baselines)
                        else layout.get("title_baseline", 0.0))
            draw.text((px(layout["title_x"]), px(baseline)),
                      _clean(line), font=title_font, fill=ink, anchor="ls")

    # legend
    legend_font = text_font("body", fs["legend"])
    for item in (layout.get("legend") or {}).get("items") or []:
        style = item.get("style") or SERIES_STYLES[0]
        tone = _rgb(pal[style.get("tone", "ink")])
        sw = item["swatch"]
        box = [px(sw["x"]), px(sw["y"]), px(sw["x"] + sw["w"]), px(sw["y"] + sw["h"])]
        if style.get("fill_mode") == "hollow":
            draw.rectangle(box, fill=paper)
        else:
            draw.rectangle(box, fill=tone)
        if style.get("dashed"):
            _dashed_rect(draw, box, tone, stroke(rules["bar"] * 0.8), (px(4.0), px(2.0)))
        else:
            draw.rectangle(box, outline=tone, width=stroke(rules["bar"] * 0.8))
        draw.text((px(item["label_x"]), px(item["baseline"])), str(item["name"]),
                  font=legend_font, fill=ink, anchor="ls")

    # note
    note_box = layout.get("note_box") or {}
    baselines = note_box.get("baselines") or []
    note_font = text_font("body", fs["note"])
    for i, line in enumerate((note_box.get("lines") or [])[:len(baselines)]):
        draw.text((px(note_box.get("x", 2.0)), px(baselines[i])), line,
                  font=note_font, fill=muted, anchor="ls")

    buf = io.BytesIO()
    image.save(buf, format="PNG", dpi=(dpi, dpi), optimize=True)
    return buf.getvalue()


# =========================================================================================
# Manual check: python chart_bars.py  ->  writes both products for 图1 to %TEMP%
# =========================================================================================

if __name__ == "__main__":  # pragma: no cover
    import json
    import tempfile

    SAMPLE = {
        "title": "图1  三次产业结构（2024年，单位：%）",
        "categories": ["第一产业", "第二产业", "第三产业"],
        "series": [{"name": "焦作", "values": [6.1, 42.6, 51.3]},
                   {"name": "全国", "values": [6.8, 36.5, 56.7]}],
        "max": 60, "unit": "%",
        "note": "同一年、同一口径直接比较；数据见材料10、材料11",
    }
    lay = compute_layout(SAMPLE)
    print(json.dumps({"ok": lay["ok"], "error": lay["error"],
                      "width": lay["width"], "height": lay["height"],
                      "bars": [{"s": b["series_name"], "c": b["category"],
                                "v": b["value"], "w": round(b["w"], 4)} for b in lay["bars"]],
                      "ticks": [(t["value"], round(t["x"], 2), t["label"])
                                for t in lay["ticks"]]},
                     ensure_ascii=False, indent=2))
    if lay["ok"]:
        svg = render_svg(lay)
        png = render_png(lay)
        tmp = tempfile.gettempdir()
        with open(os.path.join(tmp, "chart-selftest.svg"), "w", encoding="utf-8") as fh:
            fh.write(svg)
        with open(os.path.join(tmp, "chart-selftest.png"), "wb") as fh:
            fh.write(png)
        print(f"svg {len(svg)} chars, U+25A0 present: {_UNKNOWN_SQUARE in svg}")
        print(f"png {len(png)} bytes -> {os.path.join(tmp, 'chart-selftest.png')}")
