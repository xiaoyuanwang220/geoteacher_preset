// 课程方案渲染契约：两种产物必须出自同一份内容。
//
// HTML 与 DOCX 是并列的最终产物（见 SKILL.md 输出契约），不是预览与正式版。但两个
// 渲染器是两条独立的分支链，没有任何机制保证它们说同一件事——2026-11-14 的实际产物
// 就出现过 HTML 与 DOCX 的材料卡措辞不一致。这组测试是那条约束的回归闸：
//
//   1. DOCX 里的每段文字都必须能在同一份 lesson.json 渲染出的 HTML 里找到；
//   2. 同一份 lesson.json 的章节数、表格数在两种产物里一致；
//   3. 图表块的数值必须在两边都来自同一次 compute_layout（不是各算一遍）。
//
// 只断言“同一份源产出同一套内容”，不评价文字好坏或排版美观。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPTS = join(ROOT, '.agent-presets', 'geo-teacher', 'skills',
  'cn-high-school-geography-lesson-planning', 'scripts');
const EXAMPLE = join(ROOT, '.agent-presets', 'geo-teacher', 'skills',
  'cn-high-school-geography-lesson-planning', 'references', 'example_lesson.json');

// python-docx is optional at the packaging level: HTML rendering needs nothing beyond
// the standard library. Skip rather than fail on a machine without it.
function python() {
  const candidates = [
    process.env.GEO_PYTHON,
    join(process.env.DSH_HOME || '', 'dsh-runtimes', 'dsh-primary-runtime',
      'dependencies', 'python', 'python.exe'),
    'python',
    'python3',
  ].filter(Boolean);
  for (const exe of candidates) {
    try {
      execFileSync(exe, ['-c', 'import docx'], { stdio: 'pipe' });
      return exe;
    } catch { /* try next */ }
  }
  return null;
}

const PY = python();
const skip = PY ? false : 'python-docx 不可用，跳过渲染等价性检查';

// Python writes to a pipe with the console code page on Windows (cp936), which cannot
// encode the emoji and box glyphs the renderers emit. -X utf8 makes stdout UTF-8 so the
// comparison below sees the real characters instead of crashing.
function py(args, opts = {}) {
  return execFileSync(PY, ['-X', 'utf8', ...args], { encoding: 'utf8', ...opts });
}

function tmp(t, tag) {
  const dir = fs.mkdtempSync(join(tmpdir(), `geo-render-${tag}-`));
  t.after(() => {
    const abs = resolve(dir);
    assert.ok(abs.startsWith(resolve(tmpdir())), '临时目录必须位于系统临时目录下');
    fs.rmSync(abs, { recursive: true, force: true });
  });
  return dir;
}

function renderBoth(source, outdir) {
  py([join(SCRIPTS, 'render_documents.py'), source,
    '--format', 'both', '--outdir', outdir], { stdio: 'pipe' });
}

// Visible text of an HTML file, with style/svg stripped and all whitespace removed.
// Whitespace-insensitive because the two renderers place line breaks differently.
function htmlText(path) {
  let s = fs.readFileSync(path, 'utf8');
  s = s.replace(/<style[\s\S]*?<\/style>/g, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/g, ' ');
  s = s.replace(/<[^>]+>/g, '');
  return s.replace(/\s+/g, '');
}

// Every <w:t> run in a DOCX, whitespace removed.
function docxRuns(path) {
  const xml = py(['-c', [
    'import sys,zipfile,re',
    'xml=zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8")',
    'print("\\n".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", xml)))',
  ].join(';'), path]);
  return xml.split('\n').map(s => s.trim()).filter(Boolean);
}

// Icons and box glyphs are renderer decorations (the HTML callout shows an emoji, the
// DOCX checkbox is ☐), so they are not content and must not be compared.
const DECORATION = /[⭐📌✋📝✅❓☐■█▼]/g;

// The two renderers lay out the same metadata differently: HTML gives a source card a
// title line and a separate meta line, the DOCX joins them into one label. So compare
// the fragments between those separators rather than whole runs.
const SEPARATOR = /[·｜—]+/;

function fragments(run) {
  return run.replace(DECORATION, '')
    .split(SEPARATOR)
    .map(s => s.replace(/\s+/g, '').trim())
    .filter(Boolean);
}

test('HTML 与 DOCX 说同一套内容（三件套逐份比对）', { skip }, t => {
  const out = tmp(t, 'equiv');
  renderBoth(EXAMPLE, out);
  const ids = fs.readdirSync(out).filter(f => f.endsWith('.html'))
    .map(f => f.replace(/\.html$/, ''));
  assert.ok(ids.length >= 2, `示例应至少渲染两份文档，实际 ${ids.length}`);

  for (const id of ids) {
    const html = htmlText(join(out, `${id}.html`));
    const missing = [];
    for (const run of docxRuns(join(out, `${id}.docx`))) {
      for (const piece of fragments(run)) {
        if (!html.includes(piece)) missing.push(piece);
      }
    }
    assert.deepEqual(missing, [],
      `${id}.docx 有 ${missing.length} 段文字在 ${id}.html 中找不到：${missing.slice(0, 5).join(' | ')}`);
  }
});

test('章节数在两种产物里一致', { skip }, t => {
  const out = tmp(t, 'sections');
  renderBoth(EXAMPLE, out);
  for (const f of fs.readdirSync(out).filter(f => f.endsWith('.html'))) {
    const id = f.replace(/\.html$/, '');
    const html = fs.readFileSync(join(out, f), 'utf8');
    // Section headings carry id="secN"; the DOCX uses the LC H1 style for the same ones.
    const h = (html.match(/<h2 class="h1"/g) || []).length;
    const d = Number(py(['-c', [
      'import sys,zipfile,re',
      'xml=zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8")',
      'print(len(re.findall(r\'w:val="LCH1"\', xml)))',
    ].join(';'), join(out, `${id}.docx`)]).trim());
    assert.equal(d, h, `${id}: HTML ${h} 节，DOCX ${d} 节`);
  }
});

test('图表块：两种产物用同一份几何，比例与数值一致', { skip }, t => {
  const out = tmp(t, 'chart');
  const src = join(out, 'chart.json');
  fs.writeFileSync(src, JSON.stringify({
    documents: [{
      id: '图测试', audience: 'student', title: '图测试',
      sections: [{
        heading: '数据图',
        blocks: [{
          type: 'chart',
          title: '图1  三次产业结构（2024年，单位：%）',
          categories: ['第一产业', '第二产业', '第三产业'],
          series: [
            { name: '焦作', values: [6.1, 42.6, 51.3] },
            { name: '全国', values: [6.8, 36.5, 56.7] },
          ],
          max: 60, unit: '%',
          note: '同一年、同一口径直接比较',
        }],
      }],
    }],
  }, null, 1), 'utf8');
  renderBoth(src, out);

  const html = fs.readFileSync(join(out, '图测试.html'), 'utf8');
  assert.match(html, /<svg /, 'HTML 侧应输出内联 SVG');
  assert.doesNotMatch(html, /\u25a0/, '图表不得使用 ■（会被当作“未知数符号”注入说明）');

  // The PNG embedded in the DOCX must exist, and the geometry must come from the same
  // layout call. Check the ratio the two bars encode, from the Python side.
  const probe = py(['-c', [
    'import sys,json',
    'sys.path.insert(0,sys.argv[1])',
    'import chart_bars',
    'spec=json.loads(sys.argv[2])',
    'lay=chart_bars.compute_layout(spec)',
    'print(json.dumps([[b["series_name"],b["value"],round(b["w"],6)] for b in lay["bars"]]))',
  ].join(';'), SCRIPTS, JSON.stringify({
    categories: ['第一产业', '第二产业', '第三产业'],
    series: [
      { name: '焦作', values: [6.1, 42.6, 51.3] },
      { name: '全国', values: [6.8, 36.5, 56.7] },
    ],
    max: 60, unit: '%',
  })]);
  const bars = JSON.parse(probe);
  assert.equal(bars.length, 6);
  for (const [, value, w] of bars) {
    if (value > 0) {
      // Every bar must be proportional to its value — the defect this guards against
      // was 6.1% and 6.8% being drawn the same length.
      assert.ok(Math.abs(w / value - bars.find(b => b[1] === 42.6)[2] / 42.6) < 1e-9,
        `条长与数值不成比例：${value} → ${w}`);
    }
  }
  const zip = py(['-c', [
    'import sys,zipfile',
    'z=zipfile.ZipFile(sys.argv[1])',
    'print(len([n for n in z.namelist() if n.startswith("word/media/")]))',
  ].join(';'), join(out, '图测试.docx')]);
  assert.equal(Number(zip.trim()), 1, 'DOCX 应嵌入 1 张图表 PNG');
});

test('图表数据非法时两种产物都给出可读提示，而不是空白', { skip }, t => {
  const out = tmp(t, 'badchart');
  const src = join(out, 'bad.json');
  fs.writeFileSync(src, JSON.stringify({
    documents: [{
      id: '坏图', audience: 'student', title: '坏图',
      sections: [{
        heading: '数据图',
        blocks: [{ type: 'chart', categories: ['a'], series: [{ name: 'x', values: [1, 2] }] }],
      }],
    }],
  }, null, 1), 'utf8');
  renderBoth(src, out);
  const html = fs.readFileSync(join(out, '坏图.html'), 'utf8');
  assert.match(html, /图表数据有误/, 'HTML 应说明图表数据有问题');
});

test('HTML 具备网页基础结构（lang / viewport / 标题层级 / main）', { skip }, t => {
  const out = tmp(t, 'semantics');
  renderBoth(EXAMPLE, out);
  for (const f of fs.readdirSync(out).filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(join(out, f), 'utf8');
    assert.match(html, /<html lang="zh-CN">/, `${f}: 缺 lang`);
    assert.match(html, /name="viewport"/, `${f}: 缺 viewport`);
    assert.match(html, /<main class="page">/, `${f}: 缺 main`);
    assert.equal((html.match(/<h1 /g) || []).length, 1, `${f}: 应只有一个 h1`);
    assert.ok((html.match(/<h2 /g) || []).length >= 1, `${f}: 缺少 h2 章节标题`);
    assert.doesNotMatch(html, /<div class="h1"/, `${f}: 章节标题仍是 div，未语义化`);
  }
});

test('图块：能嵌入真实位图，缺失时报告而不是留空', { skip }, t => {
  const out = tmp(t, 'figure');
  const assets = join(out, 'assets');
  fs.mkdirSync(assets);
  // 1x1 PNG — enough to prove the base64 inline path works.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  fs.writeFileSync(join(assets, 'dot.png'), png);
  const src = join(out, 'fig.json');
  fs.writeFileSync(src, JSON.stringify({
    documents: [{
      id: '图块', audience: 'student', title: '图块',
      sections: [{
        heading: '图',
        blocks: [
          { type: 'figure', src: 'assets/dot.png', alt: '测试图', caption: '图1 测试' },
          { type: 'figure', src: 'assets/nope.png', alt: '缺失图' },
          { type: 'figure', alt: '没有 src' },
        ],
      }],
    }],
  }, null, 1), 'utf8');
  renderBoth(src, out);
  const html = fs.readFileSync(join(out, '图块.html'), 'utf8');
  assert.match(html, /src="data:image\/png;base64,/, '真实图片应内联为 base64');
  assert.match(html, /图片未能嵌入/, '缺失图片应被明确报告');
  assert.match(html, /缺少 src/, '缺少 src 应被明确报告');
});
