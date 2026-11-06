// GeoTeacher Agent — 内核插件（geo.kernel）
// 数据层 + 分析引擎 + 风格档案，供各功能插件通过 geo.kernel 服务消费。
// 不注册业务路由（只提供 /geo/core/health 健康检查）。
// 数据路径解析见 apply() 的「数据路径解析」一节：插件 config ＞ 用户配置文件 ＞ 明确报错。
// 不含任何作者机器路径；未配置时工具抛错，不静默回退、不返回空数据。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ========== taxonomy 解析 ==========
// 优先使用“预设包自身声明的 YAML 解析依赖”（package.json → dependencies.yaml）；
// 未安装时降级为下面的行解析，并在接口的 `parser` 字段如实标注，不静默冒充完整解析。
// 行解析覆盖当前四份真实源文件的实际形态：meta 键缩进 2、节点 `- id` 缩进 2、字段缩进 4、列表项缩进 6。
const TAXONOMY_META_KEYS = 'subject|taxonomy_name|version|status|constructed_at';
const TAXONOMY_FIELD_KEYS = 'level|name|parent_id|definition|status|confidence|needs_review|review_note';
const TAXONOMY_LIST_KEYS = 'includes|excludes|aliases';

let yamlParsePromise = null;
function loadYamlParse() {
  if (!yamlParsePromise) {
    yamlParsePromise = import('yaml')
      .then((m) => {
        if (m && typeof m.parse === 'function') return m.parse;
        if (m && m.default && typeof m.default.parse === 'function') return m.default.parse;
        return null;
      })
      .catch(() => null);
  }
  return yamlParsePromise;
}

function unquoteScalar(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (value === 'null' || value === '~') return null;
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function toNeedsReview(value) {
  return value === true || value === 'true';
}

// 行解析（降级路径）：返回 { meta, nodes }
function parseTaxonomyDocumentLegacy(text) {
  const meta = {};
  const nodes = [];
  let current = null;
  let listField = null;
  for (const line of text.split('\n')) {
    const idMatch = line.match(/^  - id:\s*(\S+)\s*$/);
    if (idMatch) {
      if (current) nodes.push(current);
      current = { id: idMatch[1] };
      listField = null;
      continue;
    }
    if (!current) {
      const metaMatch = line.match(new RegExp(`^  (${TAXONOMY_META_KEYS}):\\s*(.*)$`));
      if (metaMatch) meta[metaMatch[1]] = unquoteScalar(metaMatch[2]);
      continue;
    }
    const listMatch = line.match(new RegExp(`^    (${TAXONOMY_LIST_KEYS}):\\s*(\\[\\])?\\s*$`));
    if (listMatch) {
      listField = listMatch[1];
      if (!Array.isArray(current[listField])) current[listField] = [];
      continue;
    }
    if (listField) {
      const itemMatch = line.match(/^      -\s+(.*)$/);
      if (itemMatch) { current[listField].push(unquoteScalar(itemMatch[1])); continue; }
      if (/^    \S/.test(line)) listField = null;   // 回到字段层，继续走下面的字段匹配
      else continue;                                 // 更深层（如 source_refs）忽略
    }
    const f = line.match(new RegExp(`^    (${TAXONOMY_FIELD_KEYS}):\\s*(.*)$`));
    if (f) current[f[1]] = unquoteScalar(f[2]);
  }
  if (current) nodes.push(current);
  // 必须收敛到与 YAML 路径相同的节点形态：降级路径把 needs_review 读成字符串
  // "false"（非空字符串为真），若不过归一化，`filter(n => n.needs_review)` 会命中全部节点，
  // 使 meta.needsReview 列出整棵树（2026-10-20 运行时实测：162 个节点全部被列出）。
  return normalizeParsedDocument({ meta, nodes });
}

// 真实 YAML 解析结果 → 统一节点形态（补齐列表字段、归一化 needs_review）
function normalizeParsedDocument(parsed) {
  const src = parsed && typeof parsed === 'object' ? parsed : {};
  const meta = src.meta && typeof src.meta === 'object' ? src.meta : {};
  const nodes = (Array.isArray(src.nodes) ? src.nodes : []).map((n) => ({
    id: n && n.id,
    level: n && n.level,
    name: n && n.name,
    parent_id: n && n.parent_id != null ? n.parent_id : null,
    definition: n && n.definition,
    status: n && n.status,
    confidence: n && n.confidence,
    review_note: n && n.review_note,
    needs_review: toNeedsReview(n && n.needs_review),
    includes: Array.isArray(n && n.includes) ? n.includes : [],
    excludes: Array.isArray(n && n.excludes) ? n.excludes : [],
    aliases: Array.isArray(n && n.aliases) ? n.aliases : [],
  })).filter((n) => n.id);
  return { meta, nodes };
}

// 读取全部 taxonomy 文件：逐份记录版本/状态/内容指纹，读不到与解析失败都显式返回
async function loadTaxonomyAll(fsService, configDir) {
  const entries = await fsService.listDir(configDir);
  const parseYaml = await loadYamlParse();
  const parser = parseYaml ? 'yaml' : 'legacy';
  const readAt = new Date().toISOString();
  const sources = [];
  const errors = [];
  const nodes = [];
  for (const entry of entries) {
    if (!entry.name || !entry.name.endsWith('.yaml')) continue;
    const target = entry.target || entry;
    try {
      const text = await fsService.readText(target);
      let doc;
      if (parseYaml) {
        try {
          doc = normalizeParsedDocument(parseYaml(text));
        } catch (e) {
          errors.push({ file: entry.name, kind: 'parse', message: 'YAML 解析失败：' + ((e && e.message) || e) });
          continue;
        }
      } else {
        doc = parseTaxonomyDocumentLegacy(text);
      }
      sources.push({
        file: entry.name,
        version: doc.meta.version == null ? null : String(doc.meta.version),
        status: doc.meta.status == null ? null : String(doc.meta.status),
        contentHash: 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex'),
        readAt,
        parser,
        nodeCount: doc.nodes.length,
      });
      for (const n of doc.nodes) nodes.push(n);
    } catch (e) {
      errors.push({ file: entry.name, kind: 'read', message: '读取失败：' + ((e && e.message) || e) });
    }
  }
  return { parser, sources, errors, nodes };
}

function buildTaxonomyTree(allNodes) {
  const nodeMap = new Map();
  allNodes.forEach((n) => nodeMap.set(n.id, { ...n, children: [] }));
  const roots = [];
  allNodes.forEach((n) => {
    if (n.parent_id && nodeMap.has(n.parent_id)) nodeMap.get(n.parent_id).children.push(nodeMap.get(n.id));
    else if (!n.parent_id) roots.push(nodeMap.get(n.id));
  });
  return roots;
}

function flattenTaxonomy(roots) {
  const out = [];
  const walk = (arr, ancestors) => {
    for (const n of arr) {
      const here = ancestors.concat([{ id: n.id, name: n.name, level: n.level }]);
      out.push({ node: n, path: here });
      if (n.children && n.children.length) walk(n.children, here);
    }
  };
  walk(roots, []);
  return out;
}

function resolveTaxonomyMatches(flat, opts) {
  const ids = Array.isArray(opts.ids) ? opts.ids.filter(Boolean) : [];
  if (ids.length) {
    const matches = [];
    const unmatched = [];
    for (const id of ids) {
      const hit = flat.find((f) => f.node.id === id);
      if (hit) matches.push(hit); else unmatched.push(id);
    }
    return { matchKind: matches.length ? (unmatched.length ? 'partial' : 'exact') : 'none', matches, unmatched };
  }
  const q = String(opts.query || '').trim();
  if (!q) return { matchKind: 'none', matches: [], unmatched: [] };
  const exact = flat.filter((f) => f.node.name === q || f.node.id === q);
  if (exact.length) return { matchKind: 'exact', matches: exact, unmatched: [] };
  const approx = flat.filter((f) => {
    const hay = [f.node.name, f.node.definition, (f.node.aliases || []).join(' '), (f.node.includes || []).join(' ')].filter(Boolean).join(' ');
    return hay.includes(q);
  });
  return { matchKind: approx.length ? 'candidates' : 'none', matches: approx, unmatched: [] };
}

// ========== 文件遍历 ==========
// mtime 归一化为毫秒数（Date/字符串/数字兼容；取不到返回 null，不抛错）
function normalizeMtimeMs(info) {
  if (!info) return null;
  let m = info.mtimeMs ?? info.mtime ?? null;
  if (m == null) return null;
  if (m instanceof Date) return m.getTime();
  if (typeof m === 'string') { const p = Date.parse(m); return isNaN(p) ? null : p; }
  if (typeof m === 'number') return m;
  return null;
}

async function collectMdFiles(fsService, dirTarget, out) {
  // 读取失败必须传给调用方；否则配置错误或权限错误会被当作空题库。
  const entries = await fsService.listDir(dirTarget);
  for (const entry of entries) {
    const name = entry.name;
    if (!name) continue;
    const childTarget = entry.target || entry;
    let isDir = false;
    const kind = entry.kind || entry.type;
    if (kind === 'directory' || kind === 'dir') {
      isDir = true;
    } else if (kind === 'file') {
      isDir = false;
    } else {
      try {
        const info = await fsService.stat(childTarget);
        isDir = !!(info && (typeof info.isDirectory === 'function' ? info.isDirectory() : (info.kind === 'directory' || info.type === 'directory')));
      } catch (e2) {
        isDir = false;
      }
    }
    if (isDir) {
      await collectMdFiles(fsService, childTarget, out);
    } else if (name.endsWith('.md')) {
      // 收集 mtime 供 loadBank 新鲜度检查（stat 不可用时置 null）
      let mtime = null;
      try {
        const info = await fsService.stat(childTarget);
        mtime = normalizeMtimeMs(info);
      } catch (e3) { mtime = null; }
      out.push({ name, target: childTarget, mtime });
    }
  }
}

// ========== 图片相对路径解析（imageRefs 用，纯字符串，不依赖 path 模块） ==========
// 把 md 里的相对图片路径 ![c](rel) 基于 md 所在磁盘目录解析为绝对磁盘路径。
function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}
function toBackslashes(p) {
  return String(p).replace(/\//g, '\\');
}
function resolveImagePath(baseDir, rel) {
  // 统一成 / 段，用栈解析 ./ .. 和普通段
  const base = normalizeSlashes(baseDir).split('/');
  const segs = normalizeSlashes(rel).split('/');
  const stack = [];
  for (const s of base) { if (s) stack.push(s); } // 保留盘符如 "E:" 与各目录段
  // 去掉 base 末尾的目录名项会丢失；这里 base 是 md 目录完整路径，直接作为初始栈
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length > 1) stack.pop(); continue; }
    stack.push(seg);
  }
  // 处理盘符场景：形如 ["E:", "dir", ...] → "E:/dir/..."
  const joined = stack.join('/');
  // 若首段是 "E:" 之类盘符，补成 "E:/..."
  const abs = /^[A-Za-z]:/.test(stack[0] || '') ? joined : ('/' + joined);
  return toBackslashes(abs);
}
// ========== frontmatter 解析 ==========
export function parseFrontmatter(text) {
  const meta = {};
  text = text.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const fm = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (fm) {
      let value = fm[2].trim();
      if (value.startsWith('[') || value.startsWith('{')) continue;
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      meta[fm[1]] = value;
    }
  }
  return meta;
}

// 题面文字里的图片语法替换为图注占位：图片本体由题面图片附件交付，
// 文字中不得残留图片路径（路径常含题号/文件名，等于把原卷线索带进解题输入）。
function stripImageMarkdown(text) {
  return String(text || '').replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (m, caption) => (caption ? '[图：' + caption + ']' : '[图]'));
}

// ========== 题目文件解析 ==========
function extractMaterial(lines) {
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    // 保留图注文字（图片路径丢弃，caption 有用信息保留）
    const imgMatch = t.match(/^!\[([^\]]*)\]\([^)]*\)\s*$/);
    if (imgMatch) {
      const caption = (imgMatch[1] || '').trim();
      if (caption) out.push('[图] ' + caption);
      continue;
    }
    if (t === '') continue;
    out.push(stripImageMarkdown(t));
  }
  return out.join('\n');
}

function pickValue(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  let value = line.slice(idx + 1).trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value;
}

function parseKmBlock(block) {
  const knowledgePoints = [];
  let current = null;
  let inKp = false;
  let inTags = false;
  const extraTags = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (/^knowledge_points:/.test(t)) { inKp = true; inTags = false; continue; }
    if (/^extra_tags:/.test(t)) { inKp = false; inTags = true; continue; }
    if (/^question_id:|^question_number:|^sub_question:|^taxonomy_version:|^confidence:|^label_status:|^needs_review:|^taxonomy_review:|^note:|^review_note:|^issue_type:/.test(t)) continue;
    if (inTags) {
      const m = t.match(/^- (.+)$/);
      if (m) extraTags.push(pickValue('- ' + m[1]) || m[1]);
      continue;
    }
    if (!inKp) continue;
    const rm = t.match(/^- role:\s*(.+)$/);
    if (rm) {
      if (current) knowledgePoints.push(current);
      current = { role: rm[1].trim() };
      continue;
    }
    if (!current) continue;
    const f = t.match(/^(weight|domain|theme|knowledge_unit_id|knowledge_unit|evidence):\s*(.*)$/);
    if (f) {
      current[f[1]] = pickValue(t) || f[2].trim();
    }
  }
  if (current) knowledgePoints.push(current);
  return { knowledgePoints, extraTags };
}

// ========== 题答分离：题面图片 / 解析图 / 边界检测 ==========
// 题库 md 版式（真实题库实测）：`## 题组材料`、`## 相关图片`、`## 第N题`
// （综合题为 `### 第17题（1）`）、`## 教学备注`；答案与解析以加粗行 `**答案**：`、
// `**解析**：` 开头。解题输入只能含题面：材料 + 题干 + 选项 + 小问 + 题面图片；
// 解析图、答案/解析、`**知识点归属**` 与 MANAGED-KM 块一律不进入。
const ANSWER_MARK_RE = /^\*\*答案\*\*\s*[：:]/;
// 只把"答案/解析怎么起头"的整行视为答案痕迹：行首可带列表符或编号，
// 但不得匹配 question_id、字段名或"精品解析"这类文件名/标题（避免误判整份题组）。
const ANSWER_HINT_LINE_RE = /^(?:[-*+>]\s*|\d+[.、)\]]\s*)?(?:【答案】|【解析】|参考答案|正确答案|(?:答案|解析)\s*[：:])/;

function sectionImageRefs(lines) {
  const out = [];
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  for (const line of lines) {
    re.lastIndex = 0;
    let m = null;
    while ((m = re.exec(line)) !== null) {
      const rel = m[2];
      const ext = String(rel).split('.').pop().toLowerCase();
      if (!/png|jpe?g|webp|gif/.test(ext)) continue;
      out.push({ caption: (m[1] || '').trim(), rel });
    }
  }
  return out;
}

// 按第一个 `**答案**` 加粗行切分小节：head = 题干/选项区（题面），tail = 答案/解析区。
function splitQuestionBody(lines) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (ANSWER_MARK_RE.test(lines[i].trim())) { idx = i; break; }
  }
  if (idx < 0) return { head: lines, tail: [], hasAnswerMarker: false };
  return { head: lines.slice(0, idx), tail: lines.slice(idx), hasAnswerMarker: true };
}

export function parseQuestionFileFull(text) {
  const sections = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(/^(#{2,3}) (.+)$/);
    if (m) {
      current = { level: m[1].length, title: m[2].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  let material = '';
  const questions = [];
  const questionImages = []; // 题面图片：材料图 + 相关图片 + 各小问答案标记之前的正文图
  const analysisImages = []; // 解析图：答案/解析区与教学备注中的图片，永不进入解题输入
  const boundaryIssues = [];
  const addQuestionImage = (ref, source) => {
    if (questionImages.some((img) => img.rel === ref.rel)) return;
    questionImages.push({ imageId: 'fig_' + (questionImages.length + 1), caption: ref.caption, rel: ref.rel, source, order: questionImages.length + 1 });
  };
  const addAnalysisImage = (ref, source) => {
    if (analysisImages.some((img) => img.rel === ref.rel)) return;
    analysisImages.push({ imageId: 'ana_' + (analysisImages.length + 1), caption: ref.caption, rel: ref.rel, source, order: analysisImages.length + 1 });
  };
  for (const sec of sections) {
    const title = sec.title;
    if (/^题组材料/.test(title)) {
      material = extractMaterial(sec.lines);
      for (const ref of sectionImageRefs(sec.lines)) addQuestionImage(ref, 'material');
      continue;
    }
    if (/^相关图片/.test(title)) {
      for (const ref of sectionImageRefs(sec.lines)) addQuestionImage(ref, 'related_images');
      continue;
    }
    if (/^教学备注/.test(title)) {
      for (const ref of sectionImageRefs(sec.lines)) addAnalysisImage(ref, 'teacher_notes');
      continue;
    }
    if (/^第\d+题/.test(title)) {
      const body = sec.lines.join('\n');
      const q = parseOneQuestion(title, body);
      const split = splitQuestionBody(sec.lines);
      for (const ref of sectionImageRefs(split.head)) addQuestionImage(ref, 'question');
      for (const ref of sectionImageRefs(split.tail)) addAnalysisImage(ref, 'analysis');
      if (!q) {
        boundaryIssues.push({
          kind: 'unparsed_question_section',
          sectionTitle: title,
          snippet: body.trim().slice(0, 120),
          message: '该小节未能解析出题面（缺 question_id 或题干），题答边界无法确定'
        });
        continue;
      }
      if (!split.hasAnswerMarker) {
        boundaryIssues.push({
          questionId: q.questionId,
          kind: 'missing_answer_marker',
          sectionTitle: title,
          message: '该小问缺少 **答案** 标记，无法判定题面与答案的分界'
        });
      } else {
        const hintLine = split.head
          .map((l) => l.trim())
          .find((l) => l && !/^question_id\s*[：:]/.test(l) && !/^<!--/.test(l) && !/^#{1,6}\s/.test(l) && ANSWER_HINT_LINE_RE.test(l));
        if (hintLine) {
          boundaryIssues.push({
            questionId: q.questionId,
            kind: 'answer_text_in_question_area',
            sectionTitle: title,
            snippet: hintLine.slice(0, 120),
            message: '答案标记之前的区域出现答案或解析痕迹，题面可能混入答案内容'
          });
        }
      }
      questions.push(q);
      continue;
    }
  }
  return { material, questions, questionImages, analysisImages, boundaryIssues };
}

// 把题面图片的相对引用按 md 所在目录解析为绝对路径；不改动顺序。
function resolveQuestionImagePaths(images, mdDiskPath) {
  const mdDir = String(mdDiskPath || '').replace(/\\/g, '/');
  const slashIdx = mdDir.lastIndexOf('/');
  const baseDir = slashIdx > 0 ? mdDir.slice(0, slashIdx) : mdDir;
  return (images || []).map((img) => ({ ...img, sourcePath: resolveImagePath(baseDir, img.rel) }));
}

function parseOneQuestion(title, body) {
  let questionId = '';
  let stem = '';
  const options = [];
  let answer = '';
  let analysis = '';
  let phase = 'idle';
  const lines = body.split('\n');

  const kmStart = body.indexOf('<!-- MANAGED-KM-START');
  let km = { knowledgePoints: [], extraTags: [] };
  if (kmStart >= 0) {
    const kmEnd = body.indexOf('-->', kmStart);
    if (kmEnd > kmStart) {
      km = parseKmBlock(body.slice(kmStart, kmEnd));
    }
  }

  let inKm = false; // MANAGED-KM 块状态机：KM 内 YAML 行不按正文处理（修复 question_id 双引号污染）
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    // KM 块行跳过：start 行开状态，首个 --> 行闭（与 kmStart/kmEnd 边界一致，含同行闭合）
    if (/^<!-- MANAGED-KM-START/.test(t)) { inKm = true; continue; }
    if (inKm) {
      if (/-->/.test(t)) inKm = false;
      continue;
    }

    // 单正则兼容反引号/双引号/裸 id；KM 行已被跳过，此兼容为纵深防御
    const qid = t.match(/^question_id:\s*["`]?([^"`]+)["`]?\s*$/);
    if (qid) { questionId = qid[1].trim(); continue; }

    const stemMark = t.match(/^\*\*(题干|小问)\*\*[：:]\s*(.*)$/);
    if (stemMark) {
      phase = 'stem';
      const inline = stemMark[2].trim(); // 捕获组 2 = 真实题干内容（组 1 是「题干/小问」marker）
      if (inline) stem = inline;
      continue;
    }
    const optMark = t.match(/^\*\*选项\*\*[：:]\s*(.*)$/);
    if (optMark) {
      phase = 'options';
      const inline = optMark[1].trim();
      if (inline) {
        const m = inline.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
        if (m) options.push(m[1] + '. ' + m[2]);
      }
      continue;
    }
    const ansMark = t.match(/^\*\*答案\*\*[：:]\s*(.*)$/);
    if (ansMark) {
      phase = 'answer';
      const inline = ansMark[1].trim();
      if (inline) answer = inline;
      continue;
    }
    const anaMark = t.match(/^\*\*解析\*\*[：:]\s*(.*)$/);
    if (anaMark) {
      phase = 'analysis';
      const inline = anaMark[1].trim();
      if (inline) analysis = inline;
      continue;
    }
    if (/^\*\*知识点归属\*\*/.test(t) || /^\*\*整体置信度\*\*/.test(t)) { phase = 'idle'; continue; }
    if (/^<!--/.test(t)) { phase = 'idle'; continue; }
    if (/^#{1,3} /.test(t)) { phase = 'idle'; continue; }

    if (phase === 'stem') {
      const m = t.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
      if (m) {
        phase = 'options';
        options.push(m[1] + '. ' + m[2]);
      } else {
        stem += (stem ? '\n' : '') + t;
      }
      continue;
    }
    if (phase === 'options') {
      const m = t.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
      if (m) options.push(m[1] + '. ' + m[2]);
      continue;
    }
    if (phase === 'answer') {
      const am = t.match(/^【答案】?\s*\d*[.、．)]\s*([A-D])(?:\s*(.*))?$/);
      if (am) answer = am[1] + (am[2] ? ' ' + am[2] : '');
      else answer += (answer ? '\n' : '') + t;
      continue;
    }
    if (phase === 'analysis') {
      analysis += (analysis ? '\n' : '') + t;
      continue;
    }
  }

  stem = stripImageMarkdown(stem).replace(/\\\./g, '.');
  const cleanedOptions = options.map(o => stripImageMarkdown(o)).filter(Boolean);
  const cleanedAnswer = stripImageMarkdown(answer);
  const cleanedAnalysis = stripImageMarkdown(analysis);
  if (!questionId || (!stem && cleanedOptions.length === 0)) return null;
  return { questionId, stem, options: cleanedOptions, answer: cleanedAnswer, analysis: cleanedAnalysis, knowledgePoints: km.knowledgePoints, extraTags: km.extraTags };
}

// ========== 分析引擎 ==========
function detectStemMode(stem, isChoice) {
  if (/①|②|③|④/.test(stem) && /[（(]\s*[)）]/.test(stem)) return '组合判断（①②③④选组）';
  if (/原因是|为什么/.test(stem)) return '原因分析';
  if (/影响|作用|意义/.test(stem)) return '影响/意义评价';
  if (/措施|对策|建议|治理|方式|途径/.test(stem)) return '措施对策类';
  if (/比较|差异|对比/.test(stem)) return '比较分析';
  if (!isChoice) return '综合问答题（分析/说明类）';
  if (/[（(]\s*[)）]/.test(stem)) return '单项判断选择';
  return '选择判断';
}

function detectContextType(material) {
  const types = [];
  if (/图|示意|统计|表格|坐标|曲线/.test(material)) types.push('图表/示意图');
  if (/(省|市|地区|口岸|山脉|河流|盆地|高原|平原|城市|县|岛|湾)/.test(material)) types.push('区域案例');
  if (/近年来|20\d{2}年|目前|近期|现在/.test(material)) types.push('时事/动态');
  if (/材料一|材料二|材料三/.test(material)) types.push('多材料组合');
  if (types.length === 0) types.push('文字材料');
  return types;
}

function detectLiteracy(stem, material) {
  const text = stem + material;
  const literacy = [];
  if (/(生态|环境|资源|可持续|人地|治理|协调|低碳|绿色)/.test(text)) literacy.push('人地协调观');
  if (/(要素|关联|影响|作用|机制|综合|产业|结构)/.test(text)) literacy.push('综合思维');
  if (/(区域|区位|地方|分布|城市|港口|腹地|城市群)/.test(text)) literacy.push('区域认知');
  if (/(措施|建议|方案|实践|调查|规划|示范|应用)/.test(text)) literacy.push('地理实践力');
  if (literacy.length === 0) literacy.push('综合思维');
  return literacy;
}

function detectAbility(stem, isChoice) {
  if (/评价|是否合理|利弊/.test(stem)) return '评价';
  if (/分析|说明|指出|归纳|概括/.test(stem)) return '分析';
  if (!isChoice) return '分析';
  if (/简述|描述|列举|识别/.test(stem)) return '应用';
  return '理解';
}

function detectDifficulty(q) {
  let score = 0;
  if (q.options && q.options.length >= 4) score += 1;
  if (/①|②|③|④/.test(q.stem)) score += 1;
  if (q.knowledgePoints.length >= 3) score += 1;
  if (!q.options || q.options.length === 0) score += 1;
  if (score >= 3) return '偏难';
  if (score === 2) return '中等';
  return '基础';
}

// ========== 讲题 Solver 骨架引擎（P1，geo_solve 支撑） ==========
// 设问类型化分类（去机械化：不套"自然原因+人文原因"式模板，按材料实际支撑组织）
const QUESTION_TYPES = {
  cause: { name: '原因分析', hint: '按因果层次组织：直接原因→根本条件→触发因素→加剧因素；材料没提的层次不硬凑', verbs: ['原因', '成因', '为什么', '源于', '由于', '取决于'] },
  effect: { name: '影响/意义评价', hint: '分主体（对自然/对人文，受益/受损）+ 分层次（直接—间接、短期—长期）+ 经济/社会/生态维度，按材料支持组织', verbs: ['影响', '意义', '作用'] },
  process: { name: '形成过程/演变', hint: '按阶段与时间顺序组织：环节链（环节→驱动因素→动态变化），不是静态罗列', verbs: ['过程', '演变', '形成', '发育', '演化'] },
  compare: { name: '比较分析', hint: '可比指标 + 同口径 + 区域限定；只比较材料与知识支持的方面', verbs: ['比较', '差异', '对比', '区别'] },
  evaluate: { name: '评价/利弊', hint: '分主体利弊 + 代价与可行性 + 适用条件；结论有前提', verbs: ['评价', '是否合理', '利弊', '可行性'] },
  measure: { name: '措施/对策', hint: '针对性（对应原因/问题）+ 分主体（政府/企业/个人）+ 可行性；措施为什么能解决这个问题', verbs: ['措施', '对策', '建议', '治理', '途径', '方式'] },
  describe: { name: '分布/特征描述', hint: '空间方位/范围/形状/集中或分散 + 随….变化 + 数据支撑；有位置/方向/数值依据，不是形容词堆砌', verbs: ['分布', '特征', '描述', '简述', '指出', '标识'] },
  trend: { name: '变化/趋势', hint: '时间尺度的动态表述（方向+幅度+速率），区分现状/过程/预测', verbs: ['趋势', '变化趋势', '增速', '变化特点'] }
};

function classifyQuestion(stem) {
  for (const key of Object.keys(QUESTION_TYPES)) {
    if (QUESTION_TYPES[key].verbs.some(v => stem.includes(v))) {
      return { key, name: QUESTION_TYPES[key].name, hint: QUESTION_TYPES[key].hint };
    }
  }
  return { key: 'other', name: '综合/开放', hint: '按材料实际支撑组织：先明确对象与行为动词，再找要素证据，避免机械套模板' };
}

// 要素维度排查词表（自然 + 人文清单，供 dimensionScan 使用）
const ELEMENT_DIMENSIONS = {
  position: { name: '位置', keywords: ['纬度', '经度', '位于', '方位', '海陆', '东部', '西部', '南部', '北部', '临海', '内陆'] },
  terrain: { name: '地形', keywords: ['地形', '地貌', '山地', '平原', '高原', '盆地', '丘陵', '坡度', '海拔', '谷地'] },
  climate: { name: '气候', keywords: ['气候', '气温', '降水', '季风', '温度', '雨量', '干湿', '盛行风', '光照'] },
  water: { name: '水源', keywords: ['水源', '河流', '湖泊', '径流', '水文', '地下水', '水系', '流域', '湿地'] },
  soil: { name: '土壤', keywords: ['土壤', '土层', '腐殖', '肥力', '冻土'] },
  biology: { name: '生物/植被', keywords: ['植被', '生物', '森林', '草原', '作物', '物种', '栖息', '自然带'] },
  population: { name: '人口/聚落', keywords: ['人口', '聚落', '城市', '村庄', '城镇', '人口密度', '居住'] },
  agriculture: { name: '农业', keywords: ['农业', '种植', '养殖', '农作物', '耕地', '粮食', '农作'] },
  industry: { name: '工业', keywords: ['工业', '产业', '工厂', '制造', '加工', '钢铁', '机械', '能源', '电力', '经济'] },
  services: { name: '服务业', keywords: ['服务业', '旅游', '商业', '金融', '物流', '第三产业'] },
  transport: { name: '交通', keywords: ['交通', '铁路', '公路', '港口', '航线', '运输', '枢纽', '腹地'] },
  market: { name: '市场', keywords: ['市场', '需求', '消费', '客源', '销售', '出口', '内销'] },
  policy: { name: '政策', keywords: ['政策', '政府', '补贴', '规划', '法规', '扶持', '制度'] },
  technology: { name: '技术', keywords: ['技术', '科技', '研发', '自动化', '智能化', '工艺'] }
};

function dimensionScan(material) {
  const hits = {};
  for (const key of Object.keys(ELEMENT_DIMENSIONS)) {
    const dim = ELEMENT_DIMENSIONS[key];
    const evidence = dim.keywords.filter(kw => material.includes(kw));
    if (evidence.length) hits[key] = { name: dim.name, evidence };
  }
  return hits;
}

function detectDistractors(analysisText) {
  const result = [];
  if (!analysisText) return result;
  const sentences = analysisText.split(/[。；]/);
  for (let i = 0; i < sentences.length; i++) {
    const m = sentences[i].match(/([A-D①②③④])\s*(?:错误|不正确)/);
    if (m) {
      const prev = (sentences[i - 1] || '').trim();
      const reason = (prev ? prev + '。' : '') + sentences[i].trim();
      result.push({ option: m[1], reason: reason.slice(0, 60) });
    }
  }
  return result;
}

// ========== 同类题比较（题库检索，讲稿依据） ==========
// 先按设问任务、推理关系、材料特征检索相关题目；不能只因考点相同就归为同类。
function chartKindsOf(material) {
  const text = String(material || '');
  const kinds = [];
  if (/柱状|折线|曲线/.test(text)) kinds.push('折线/柱状图');
  if (/表格|统计表/.test(text)) kinds.push('统计表');
  if (/区域图|地形图|分布图|地图/.test(text)) kinds.push('区域/分布图');
  if (/剖面图|示意图/.test(text)) kinds.push('示意图');
  if (/景观|照片/.test(text)) kinds.push('景观照片');
  return kinds;
}

function similarityFeatures(item) {
  const stem = item.stem || '';
  const material = item.material || '';
  const isChoice = (item.options || []).length > 0;
  const scans = dimensionScan(material);
  const coreKp = (item.knowledgePoints || []).find(kp => kp.role === 'core_exam_point') || (item.knowledgePoints || [])[0] || {};
  return {
    isChoice,
    framework: classifyQuestion(stem),
    scans,
    dimensionKeys: Object.keys(scans),
    contextTypes: detectContextType(material),
    literacy: detectLiteracy(stem, material),
    ability: detectAbility(stem, isChoice),
    corePoint: coreKp.knowledge_unit || coreKp.knowledgeUnit || '',
    chartKinds: chartKindsOf(material),
    hasImageMaterial: /图|示意|坐标|曲线|统计|表格/.test(material)
  };
}

function overlap(a, b) {
  return (a || []).filter(x => (b || []).includes(x));
}

export function rankSimilarQuestions(all, current, limit = 5) {
  if (!current) return { basis: [], insufficient: true, gap: '缺少本题信息，无法检索同类题' };
  const base = similarityFeatures(current);
  const scored = [];
  for (const item of all || []) {
    if (!item || item.questionId === current.questionId) continue;
    // 同题组共用材料，不构成"同类题"比较对象（方法与条件差异无法从不同材料验证）。
    if (item.file && current.file && item.file === current.file) continue;
    const feat = similarityFeatures(item);
    let score = 0;
    const shared = [];
    if (feat.framework.key === base.framework.key) { score += 3; shared.push(`设问任务相同（${feat.framework.name}）`); }
    if (feat.isChoice === base.isChoice) score += 2;
    if (feat.ability === base.ability) score += 1;
    if (feat.corePoint && feat.corePoint === base.corePoint) { score += 2; shared.push(`核心考点相同（${feat.corePoint}）`); }
    const dims = overlap(feat.dimensionKeys, base.dimensionKeys);
    if (dims.length) { score += Math.min(2, dims.length); shared.push(`材料证据维度相近（${dims.map(k => ELEMENT_DIMENSIONS[k] && ELEMENT_DIMENSIONS[k].name).filter(Boolean).join('、')}）`); }
    const contexts = overlap(feat.contextTypes, base.contextTypes);
    if (contexts.length) { score += 1; shared.push(`情境类型相同（${contexts.join('、')}）`); }
    const charts = overlap(feat.chartKinds, base.chartKinds);
    if (charts.length) { score += 1; shared.push(`图表类型相同（${charts.join('、')}）`); }
    if (score < 4) continue;
    const differences = [];
    if (feat.isChoice !== base.isChoice) differences.push(`题型不同（${feat.isChoice ? '选择题' : '综合题'}）`);
    if (feat.ability !== base.ability) differences.push(`能力层次不同（${feat.ability}）`);
    if (feat.corePoint && base.corePoint && feat.corePoint !== base.corePoint) differences.push(`核心考点不同（${feat.corePoint}）`);
    const baseOnly = base.dimensionKeys.filter(k => !feat.dimensionKeys.includes(k));
    if (baseOnly.length) differences.push(`材料缺少本题的维度证据（${baseOnly.map(k => ELEMENT_DIMENSIONS[k] && ELEMENT_DIMENSIONS[k].name).filter(Boolean).join('、')}）`);
    scored.push({
      questionId: item.questionId,
      file: item.file || '',
      groupLabel: `${(item.meta && item.meta.year) || ''}${(item.meta && item.meta.region) || ''}卷 第${(item.meta && String(item.meta.question_numbers || '').replace(/,/g, '-')) || ''}题`,
      stem: (item.stem || '').slice(0, 80),
      materialSnippet: (item.material || '').slice(0, 80),
      questionType: feat.framework.name,
      ability: feat.ability,
      score,
      sharedTask: shared.find(s => s.startsWith('设问任务')) || '',
      sharedReasoning: shared.find(s => s.startsWith('材料证据')) || '',
      sharedMaterial: shared.find(s => s.startsWith('情境类型')) || shared.find(s => s.startsWith('图表类型')) || '',
      sameCorePoint: Boolean(feat.corePoint && feat.corePoint === base.corePoint),
      differences: differences.join('；')
    });
  }
  scored.sort((a, b) => b.score - a.score || String(a.questionId).localeCompare(String(b.questionId)));
  const basis = scored.slice(0, Math.max(0, limit));
  const insufficient = basis.length < 2;
  return {
    basis,
    insufficient,
    gap: insufficient
      ? `题库中与该题设问任务/推理关系相近的题目不足 2 道（已检索到 ${basis.length} 道）；只能依据本题与已列题目比较，不凭单题经验编造通用套路`
      : ''
  };
}

// ========== 解题运行记录（题面就绪 → 作答已提交 → 核验完成） ==========
// 服务端持有 run：绑定题目、题面指纹、独立作答与核验结论；答案接口只在作答提交后开放。
export const SOLVE_STATES = Object.freeze({
  READY: 'question_ready',
  SUBMITTED: 'submitted',
  VERIFIED: 'verified'
});
export const SOLVE_RUNS_SCHEMA = 1;

// 题面指纹：只取题面（材料/题干/选项/题面图片），绝不含答案/解析，保证"题面变化后重新解题"。
export function questionFingerprint(parts) {
  const material = String((parts && parts.material) || '');
  const stems = ((parts && parts.stems) || []).join('\u0001');
  const options = ((parts && parts.options) || []).map(o => (o || []).join('\u0003')).join('\u0001');
  const images = ((parts && parts.images) || []).map(img => (img && (img.rel || img)) || '').join('\u0001');
  const text = [String((parts && parts.questionId) || ''), material, stems, options, images].join('\u0002');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'fp_' + h.toString(16).padStart(8, '0');
}

function hashAnswer(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function createSolveRegistry(options) {
  const opts = options || {};
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxRuns = Number.isSafeInteger(opts.maxRuns) && opts.maxRuns > 0 ? opts.maxRuns : 200;
  const runs = new Map();
  const latest = new Map();

  function cloneRun(run) {
    return JSON.parse(JSON.stringify(run));
  }

  function remember(run) {
    runs.set(run.runId, run);
    latest.set(run.questionId, run.runId);
    if (runs.size > maxRuns) {
      const ordered = [...runs.values()].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      const drop = ordered.slice(0, runs.size - maxRuns);
      for (const r of drop) {
        runs.delete(r.runId);
        if (latest.get(r.questionId) === r.runId) latest.delete(r.questionId);
      }
    }
    return run;
  }

  function list() {
    return [...runs.values()].map(cloneRun);
  }

  function restore(items) {
    runs.clear();
    latest.clear();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.runId || !item.questionId) continue;
      runs.set(item.runId, item);
      const prev = latest.get(item.questionId);
      const prevRun = prev ? runs.get(prev) : null;
      if (!prevRun || (item.createdAt || 0) >= (prevRun.createdAt || 0)) latest.set(item.questionId, item.runId);
    }
  }

  function ensureRun(input) {
    const questionId = String((input && input.questionId) || '');
    const fingerprint = String((input && input.questionFingerprint) || '');
    const previousId = latest.get(questionId);
    const previous = previousId ? runs.get(previousId) : null;
    if (previous && previous.questionFingerprint === fingerprint) {
      const reusable = previous.state === SOLVE_STATES.SUBMITTED || previous.state === SOLVE_STATES.VERIFIED;
      return { run: cloneRun(previous), reused: reusable, invalidated: false };
    }
    const runId = `${questionId}__${fingerprint}`;
    const existing = runs.get(runId);
    if (existing) {
      // 题面回退到旧版本时，旧 run 仍是当前题面的有效记录：重新指向它，避免误报版本变化。
      latest.set(questionId, runId);
      return { run: cloneRun(existing), reused: existing.state !== SOLVE_STATES.READY, invalidated: false };
    }
    const run = remember({
      runId,
      questionId,
      questionFingerprint: fingerprint,
      state: SOLVE_STATES.READY,
      createdAt: nowFn(),
      submittedAt: null,
      judgeOpenedAt: null,
      verifiedAt: null,
      answer: null,
      conclusion: null
    });
    return { run: cloneRun(run), reused: false, invalidated: Boolean(previous) };
  }

  function get(runId) {
    const run = runs.get(String(runId || ''));
    return run ? cloneRun(run) : null;
  }

  function latestForQuestion(questionId) {
    const runId = latest.get(String(questionId || ''));
    const run = runId ? runs.get(runId) : null;
    return run ? cloneRun(run) : null;
  }

  function submit(runId, payload) {
    const run = runs.get(String(runId || ''));
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND' };
    const p = payload || {};
    const answerText = String(p.answerText || '').trim();
    if (!answerText) return { ok: false, code: 'EMPTY_ANSWER' };
    // 原始独立作答不可被覆盖：已提交/已核验时，只有同一份作答可重复提交（幂等）。
    if (run.state !== SOLVE_STATES.READY) {
      const sameHash = run.answer && run.answer.answerHash === hashAnswer(answerText);
      if (sameHash) return { ok: true, run: cloneRun(run) };
      return { ok: false, code: 'ANSWER_IMMUTABLE' };
    }
    run.answer = {
      answerText: answerText.slice(0, 8000),
      keyEvidence: String(p.keyEvidence || '').slice(0, 2000),
      childSessionId: String(p.childSessionId || ''),
      answerHash: hashAnswer(answerText),
      submittedAt: nowFn()
    };
    run.state = SOLVE_STATES.SUBMITTED;
    run.submittedAt = run.answer.submittedAt;
    remember(run);
    return { ok: true, run: cloneRun(run) };
  }

  function openReference(runId) {
    const run = runs.get(String(runId || ''));
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND' };
    if (run.state === SOLVE_STATES.READY) return { ok: false, code: 'SOLVE_NOT_SUBMITTED' };
    run.judgeOpenedAt = run.judgeOpenedAt || nowFn();
    remember(run);
    return { ok: true, run: cloneRun(run) };
  }

  const VERDICTS = ['consistent', 'partially_consistent', 'inconsistent'];
  function recordVerification(runId, conclusion) {
    const run = runs.get(String(runId || ''));
    if (!run) return { ok: false, code: 'RUN_NOT_FOUND' };
    if (!run.judgeOpenedAt) return { ok: false, code: 'JUDGE_NOT_OPENED' };
    const c = conclusion || {};
    if (!VERDICTS.includes(c.verdict)) return { ok: false, code: 'CONCLUSION_INVALID', message: 'verdict 必须是 consistent | partially_consistent | inconsistent' };
    const toList = (v) => (Array.isArray(v) ? v : []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 12);
    run.conclusion = {
      verdict: c.verdict,
      matched: toList(c.matched),
      missed: toList(c.missed),
      wrong: toList(c.wrong),
      disputed: toList(c.disputed),
      correction: String(c.correction || '').slice(0, 1200),
      verifiedAt: nowFn()
    };
    run.state = SOLVE_STATES.VERIFIED;
    run.verifiedAt = run.conclusion.verifiedAt;
    remember(run);
    return { ok: true, run: cloneRun(run) };
  }

  function statusFor(questionId, currentFingerprint) {
    const run = latestForQuestion(questionId);
    if (!run) {
      return { state: 'none', runId: null, fingerprintMatches: false, submittedAt: null, judgedAt: null, canJudge: false, canExplain: false };
    }
    const matches = !currentFingerprint || run.questionFingerprint === currentFingerprint;
    return {
      state: run.state,
      runId: run.runId,
      fingerprintMatches: matches,
      submittedAt: run.submittedAt || null,
      judgedAt: run.judgeOpenedAt || null,
      verifiedAt: run.verifiedAt || null,
      canJudge: matches && run.state !== SOLVE_STATES.READY,
      canExplain: matches && run.state === SOLVE_STATES.VERIFIED
    };
  }

  return {
    ensureRun,
    submit,
    openReference,
    recordVerification,
    get,
    latestForQuestion,
    statusFor,
    list,
    restore,
    hashAnswer
  };
}

// ========== 蓝图引擎 ==========

function collectSamePointContexts(all, currentQ, coreKp) {
  const kuId = coreKp.knowledge_unit_id || coreKp.knowledgeUnitId;
  const out = [];
  for (const item of all) {
    if (item.questionId === currentQ.questionId) continue;
    const hit = (item.knowledgePoints || []).some(kp =>
      (kp.knowledge_unit_id === kuId || kp.knowledgeUnitId === kuId));
    if (hit) {
      out.push({ file: item.file, material: (item.material || '').slice(0, 80), stem: item.stem.slice(0, 40) });
    }
  }
  return out;
}

function buildBlueprint(analysis, all, q) {  const coreKp = analysis.examPoints[0] || {};
  const alternatives = collectSamePointContexts(all, q, coreKp);
  const suggested = alternatives.length > 0
    ? `换用同考点其他情境（如「${alternatives[0].material.replace(/[，。].*$/, '')}」）或结合时事素材`
    : '结合时事热点或教材案例设计全新情境（当前题库该考点情境较少）';
  const isChoice = q.options && q.options.length > 0;
  return {
    corePoint: {
      domain: coreKp.domain || '',
      theme: coreKp.theme || '',
      knowledgeUnit: coreKp.knowledge_unit || coreKp.knowledgeUnit || '',
      weight: coreKp.weight || '1.0'
    },
    contextSuggestion: suggested,
    alternativeContexts: alternatives,
    stemTemplate: `仿写：保持「${analysis.stemMode}」的考查角度，将情境替换为「${suggested.split('「')[1] ? suggested.split('「')[1].replace(/」.*$/, '') : '新情境'}」，设问对象换为新情境中的同类主体`,
    alternativeAngle: isChoice
      ? '换角度：从"判断现象"转为"分析成因/影响"，或将单项选择改为组合判断（①②③④）'
      : '换角度：从"分析/说明"改为"评价/比较"，或增设小问要求"提出措施并说明依据"',
    optionDesign: isChoice
      ? {
          correct: `正确项设计：依据「${coreKp.knowledge_unit || '核心考点'}」的核心机制，保证与材料信息直接对应`,
          distractors: analysis.distractors.length > 0
            ? analysis.distractors.map(d => `迁移原题干扰逻辑（${d.option}：${d.reason}），换情境后重写干扰项，保持"绝对化/片面化/因果倒置"等设错方式`)
            : ['设置与材料信息相悖的绝对化表述', '设置片面因果（只对一半）', '设置程度夸大项']
        }
      : null,
    literacy: analysis.literacy,
    difficulty: analysis.difficulty
  };
}

function buildAnalysis(q, material, file) {
  const isChoice = q.options && q.options.length > 0;
  const examPoints = (q.knowledgePoints || []).map(kp => ({
    role: kp.role === 'core_exam_point' ? '核心考点'
         : kp.role === 'supporting_knowledge' ? '支撑知识'
         : kp.role === 'material_clue' ? '材料线索'
         : kp.role === 'background_knowledge' ? '背景知识' : (kp.role || ''),
    weight: kp.weight,
    domain: kp.domain || '',
    theme: kp.theme || '',
    knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || '',
    evidence: kp.evidence || ''
  }));
  return {
    questionId: q.questionId,
    file,
    questionType: isChoice ? '选择题' : '综合题',
    stemMode: detectStemMode(q.stem, isChoice),
    contextTypes: detectContextType(material),
    literacy: detectLiteracy(q.stem, material),
    abilityLevel: detectAbility(q.stem, isChoice),
    difficulty: detectDifficulty(q),
    examPoints,
    distractors: isChoice ? detectDistractors(q.analysis) : [],
    material,
    stem: q.stem,
    options: q.options,
    extraTags: q.extraTags || []
  };
}

// ========== Markdown 导出 ==========
function renderAnalysisMarkdown(result) {
  const { analysis, blueprint } = result;
  let md = '';
  md += `# 真题分析报告\n\n`;
  md += `- 题目 ID：${analysis.questionId}\n`;
  md += `- 来源：${analysis.file}\n\n`;
  md += `## 一、真题分析（为什么这样考）\n\n`;
  md += `### 考什么\n`;
  for (const kp of analysis.examPoints) {
    md += `- **[${kp.role}] 权重 ${kp.weight}**：${kp.domain} → ${kp.theme} → ${kp.knowledgeUnit}\n`;
    if (kp.evidence) md += `  - 映射证据：${kp.evidence}\n`;
  }
  md += `\n### 怎么考\n`;
  md += `- 题型：${analysis.questionType}\n`;
  md += `- 设问模式：${analysis.stemMode}\n`;
  md += `- 情境类型：${analysis.contextTypes.join('、')}\n`;
  md += `- 材料：${(analysis.material || '').slice(0, 120)}${(analysis.material || '').length > 120 ? '…' : ''}\n`;
  md += `- 题干：${analysis.stem}\n`;
  if (analysis.options.length > 0) md += `- 选项：${analysis.options.join('；')}\n`;
  md += `\n### 为什么这样考\n`;
  md += `- 素养立意：${analysis.literacy.join('、')}\n`;
  md += `- 能力层次：${analysis.abilityLevel}\n`;
  md += `- 难度定位：${analysis.difficulty}\n`;
  if (analysis.distractors.length > 0) {
    md += `- 干扰项设计逻辑（规则提取）：\n`;
    for (const d of analysis.distractors) md += `  - ${d.option}：${d.reason}\n`;
  }
  if (analysis.extraTags.length > 0) md += `- 情境标签：${analysis.extraTags.join('、')}\n`;
  md += `\n## 二、命题蓝图（下一道题怎么设计）\n\n`;
  md += `### 考点锁定\n`;
  md += `- 核心考点：${blueprint.corePoint.domain} → ${blueprint.corePoint.theme} → ${blueprint.corePoint.knowledgeUnit}（权重 ${blueprint.corePoint.weight}）\n`;
  md += `\n### 情境换新\n`;
  md += `- 建议：${blueprint.contextSuggestion}\n`;
  if (blueprint.alternativeContexts.length > 0) {
    md += `- 同考点可参考情境：\n`;
    for (const alt of blueprint.alternativeContexts.slice(0, 5)) {
      md += `  - ${alt.file}：材料「${alt.material}」；设问「${alt.stem}」\n`;
    }
  }
  md += `\n### 设问设计\n`;
  md += `- 保留角度（仿写）：${blueprint.stemTemplate}\n`;
  md += `- 换角度（迁移）：${blueprint.alternativeAngle}\n`;
  if (blueprint.optionDesign) {
    md += `\n### 选项设计（选择题）\n`;
    md += `- 正确项：${blueprint.optionDesign.correct}\n`;
    md += `- 干扰项：\n`;
    for (const d of blueprint.optionDesign.distractors) md += `  - ${d}\n`;
  }
  md += `\n### 素养与难度目标\n`;
  md += `- 素养：${blueprint.literacy.join('、')}\n`;
  md += `- 难度：${blueprint.difficulty}\n`;
  return md;
}

// ========== 讲题 Judge 骨架（P2） ==========
// 倒推采分点 scorePoints：从答案/解析+知识点映射提取"该题要采的几个要点"，
// 供 geo_judge 在开放答案后做得分点覆盖核验。综合题按要点/维度拆分；选择题给整题采分点。
function buildScorePoints(q, isChoice) {
  const points = [];
  if (isChoice) {
    const ansExpr = (q.answer || '').trim();
    const correctOption = /^([A-D])/.exec(ansExpr);
    // 采分点 = 正确选项 + 其对应知识单元（从 KM 映射取核心考点）
    const coreKp = (q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point');
    points.push({
      type: 'choice',
      option: correctOption ? correctOption[1] : '',
      answer: ansExpr,
      knowledgeUnit: (coreKp && (coreKp.knowledge_unit || coreKp.knowledgeUnit)) || '',
      evidence: (coreKp && coreKp.evidence) || '',
      weight: (coreKp && coreKp.weight) || '1.0'
    });
    return points;
  }
  // 综合题：按答案的要点拆分（分号/换行/序号），每点补要素维度与知识点
  const clu = ELEMENT_DIMENSIONS;
  const fragment = (q.answer || '').split(/[；;]\s*|\n+/).map(s => s.trim()).filter(Boolean);
  const body = fragment.length > 1 ? fragment : ((q.answer || '' + q.analysis) || '').split(/[；;]\s*|\n+/).map(s => s.trim()).filter(Boolean);
  const source = body.length > 0 ? body : [(q.answer || '').trim() || '（解析待补）'];
  for (const seg of source) {
    const dims = Object.keys(clu).filter(k => clu[k].keywords.some(kw => seg.includes(kw)));
    points.push({ type: 'comprehensive', point: seg, dimension: dims.map(k => clu[k].name), applied: '' });
  }
  return points;
}

// 讲题 Judge 骨架：答案/解析/采分点由 openReferenceAnswer 按题组逐小问组装（见 api.openReferenceAnswer）。


// ========== 讲题 Explainer 骨架（P3 · 三对象） ==========
// 将已验证解题过程按讲解对象重组（教学化重组，不照抄解析）。
// 输入：题目 + solver 已生成的题干/选项 + judge 核验结果 + 同考点变式 + 讲解对象 audience。
export const EXPLAIN_AUDIENCES = ['student', 'teacher', 'setter'];
export const EXPLAIN_RULESET_VERSION = 3;
const AUDIENCE_LABELS = { student: '学生', teacher: '教师', setter: '命题人' };

// 讲稿语言与文体、对象细则只维护一份：skills/references/explainer-audiences.md。
// 内核骨架只给出结构、对象侧重与待填字段，不重复教学话术（计划 §三）。

// 三对象共同要求：讲题由地理问题、材料证据与学科原理推动。
function buildCommonAnalysis() {
  return {
    requirements: [
      '讲解由地理问题、材料证据与学科原理推动，不得对照答案补理由',
      '方法总结按问题结构提炼可迁移思路及适用边界，避免固定因素清单',
      '跨学科从地理问题出发，只在真正有解释价值时引入，不为凑章节强行关联'
    ],
    fourQuestions: [
      '为什么用这个知识（知识选择依据）',
      '为什么依靠这条材料（材料使用依据）',
      '这一步为什么能推出下一步（推理链条因果）',
      '这题为什么不是另一个答案（排除论证）'
    ]
  };
}

// 跨学科状态由讲题阶段按题面判断；工具不做关键词启发式关联。
function buildInterdisciplinary() {
  return {
    status: 'pending',
    allowedStatus: ['applicable', 'not_applicable', 'pending'],
    chain: ['地理解释需要', '学科工具', '情境对应', '解释贡献', '适用限制'],
    note: '工具不预判跨学科价值：先由讲题阶段按四问判定——必要性（删去该学科原理后结论是否仍成立）、参与环节（是否进入推理链，而非只影响读图与表达）、学科归属（是否本属地理课程自身的图表解读能力）、可交代性（是否为学生已学且题面有交代）；任一不通过即记 not_applicable 且不生成跨学科内容，通过才按“地理解释需要→学科工具→情境对应→解释贡献→适用限制”判断并记状态；证据不足时不硬讲，不适用时简短说明。'
  };
}

function buildStudentPlan() {
  return {
    entryQuestion: '',      // 待在讲题阶段填写：拿到这道题第一步想什么
    steps: [],              // 待在讲题阶段填写：可执行的思考步骤
    methodBoundary: '',     // 待在讲题阶段填写：方法的适用条件与边界
    // 设问先行六步：段内动作序列（不得作顶层目录，恒以列表项渲染）。见 docs/讲题学生版结构方案.md §二/§六。
    flow: ['设问先行', '定向读材料', '知识选择', '推理链', '作答与检查', '方法提炼'],
    stepPlacement: { examine: '①', solve: '②③④⑤', reflect: '⑥', note: '外层仍为四段式' },
    stepTemplate: [
      {
        step: '① 拆设问（先行）',
        action: '先看问什么：对象＋行为动词＋限定词（时间/空间/尺度/比较基准）→ 判定设问类型',
        anchor: '行为动词决定“答到什么程度”，限定词决定“答哪一段、跟谁比”'
      },
      {
        step: '② 带着问题读材料',
        action: '拿①列出的要素清单进材料，只找用得上的证据，点明哪些信息与本题无关；涉图按图例→坐标→数值→分布→趋势',
        anchor: '材料不是拿来通读的：设问问什么就去材料里找什么；先定区域与尺度，再取证'
      },
      {
        step: '③ 知识选择',
        action: '明确“为什么要用这个知识”：题目哪条线索激活了哪条原理',
        anchor: '知识不是背出来的，是被题目线索和区域特征选出来的；换一个区域是否仍用同一条'
      },
      {
        step: '④ 推理链',
        action: '材料证据×知识×设问 → 地理因果链或逐项排除；每步标注“为什么能推出下一步”',
        anchor: '把前提→结论的因果说显性，不留逻辑缝隙；选择题要讲清每个干扰项错在哪'
      },
      {
        step: '⑤ 作答与检查',
        action: '组织要点、规范地理术语与表述，自检是否答到设问要求',
        anchor: '答案由推理自然引出，不先亮答案再凑理由'
      },
      {
        step: '⑥ 方法提炼',
        action: '把这道题升维成这一类题的思考模板，写明适用边界',
        anchor: '下一次遇到同类问题，第一步该做什么、什么时候要换方法'
      }
    ],
    // 语言与对象细则统一在 references，内核不重复：见 skills/references/explainer-audiences.md §4。
    reference: 'skills/references/explainer-audiences.md §4（学生对象写法、语言文体与六步推进约束）'
  };
}

function buildTeacherPlan() {
  return {
    nodeTemplate: ['思维培养目标', '问题/活动', '学生思维动作', '关注的回答及依据', '分支追问与必要支架', '撤去支架后的独立表现'],
    thinkingGoals: [],      // 待填写：本题专属的思维培养目标
    studentActions: [],     // 待填写：学生思维动作
    progressiveQuestions: [], // 待填写：递进追问
    scaffolds: [],          // 待填写：必要支架
    scaffoldRemoval: { signal: '', observe: '' }, // 待填写：何时撤、撤后观察什么
    independentTransfer: { task: '', observe: '' }, // 待填写：独立迁移检测与观察点
    // 语言与对象细则统一在 references，内核不重复：见 skills/references/explainer-audiences.md §5。
    reference: 'skills/references/explainer-audiences.md §5（教师对象组织模板、启发式追问与支架撤除要求）'
  };
}

function buildSetterPlan(isChoice) {
  return {
    structure: ['考查目标', '情境/材料/设问', '设问、材料与选项的干扰辨析', '预期认知路径', '答案成立条件及错误路径', '迁移与跨学科设计', '题组和质量评价'],
    interferenceLayers: [
      { layer: '设问', applicable: true, findings: [] },
      { layer: '材料（含图表）', applicable: true, findings: [] },
      isChoice
        ? { layer: '选项', applicable: true, findings: [] }
        : { layer: '选项', applicable: false, note: '综合题无选项：选项层不适用；可分析典型偏离思路，但不得虚构选项', findings: [] }
    ],
    constraints: [
      '无原作者说明时标注“依据题面推断”，不冒称原作者故意如此设计',
      '无试测数据时不生成正确率、区分度数值或实际测量效果断言',
      '某层未发现干扰时如实说明，不强凑三层',
      '不把必要背景、其他小问所需信息或未用于最终答案的内容一律判作干扰；不把合理限定误判为文字陷阱'
    ],
    // 三层识别内容、每条干扰必给字段与负例约束只维护一份：references §6。
    reference: 'skills/references/explainer-audiences.md §6（三层干扰辨析完整表）'
  };
}

function buildStudentTeacherStructure(q, isChoice, difficulty, framework, scans, variants, coreKp, audience, comparison) {
  const emphasis = audience === 'teacher' ? {
    locate: '教学价值、核心与支撑知识、重点难点及原因、应培养的思维',
    examine: '设计让学生自主界定问题的切入与追问，而非教师宣布框架',
    solve: '关键处怎样提问、给提示、检验理解，逐步让学生独立完成',
    reflect: '引导学生自己概括、比较、修正方法；设计独立迁移检测与观察点'
  } : {
    locate: '要解决什么问题、核心知识与必要联系，以及该知识在本题解题中的作用',
    examine: '识别对象、任务动词、限定条件、时空尺度；第一步想什么、为什么',
    solve: '怎么想、怎么做、每步依据与关键辨析；同类题的识别与调整',
    reflect: '错因、可迁移思路与适用边界、条件变化时如何调整'
  };
  const examPoint = (coreKp && (coreKp.knowledge_unit || coreKp.knowledgeUnit)) || '待填';
  const supporting = (q.knowledgePoints || [])
    .filter(kp => kp && kp.role !== 'core_exam_point')
    .map(kp => ({
      knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || '',
      weight: kp.weight || ''
    }))
    .filter(kp => kp.knowledgeUnit)
    .slice(0, 4);
  const cmp = comparison || { basis: [], insufficient: true, gap: '未检索同类题' };
  return {
    frame: '题目定位—审题—破题—反思与迁移',
    note: '四维（知识/解题/方法/跨学科）融入四段段内，不另设替代四段式的顶层目录；子标题按题目与对象灵活设置。',
    reference: 'skills/references/explainer-audiences.md §4/§5',
    locate: {
      title: '题目定位',
      fields: bestowBasicLabels(q, isChoice, difficulty, framework),
      knowledgeRole: {
        examPoint,
        supporting,
        roleInSolving: '', // 待填：该知识点在本题解题中起什么作用（为什么用它、它把哪一步推下去）
        note: '学生对象讲"为什么用它、它怎样帮助解题"；教师对象讲"学生需建立哪些知识联系、如何引导其选择并运用"'
      },
      audienceFocus: emphasis.locate
    },
    examine: { title: '审题', hint: framework.hint, audienceFocus: emphasis.examine },
    solve: {
      title: '破题',
      choiceNote: isChoice ? '选择题：读图→定向读材料→逐项排除链（材料证据×知识×设问），每个干扰项讲清错因；不让排除选项替代问题分析' : '综合题：读图→定向读材料→要素维度排查→采分点组织（要素+证据+结论）→术语规范；不凑采分点替代问题分析',
      dimensionScan: scans,
      comparison: {
        basis: (cmp.basis || []).map(item => ({
          questionId: item.questionId,
          file: item.file,
          groupLabel: item.groupLabel,
          stem: item.stem,
          questionType: item.questionType,
          sharedTask: item.sharedTask,
          sharedReasoning: item.sharedReasoning,
          sharedMaterial: item.sharedMaterial,
          differences: item.differences
        })),
        insufficient: Boolean(cmp.insufficient),
        gap: cmp.gap || '',
        citationRule: '总结须列出所依据的题目（题组+题号）及具体对应关系；相关题不足时明确缺口，不凭单题经验编造通用套路',
        focus: '学生：说明如何识别同类、从哪里入手、推理怎样展开、条件变化怎样调整；教师：用相关题目的比较引导学生自己归纳方法与适用条件'
      },
      audienceFocus: emphasis.solve
    },
    reflect: {
      title: '反思与迁移',
      alternatives: variants,
      coreKnowledgeUnit: examPoint,
      transfer: {
        student: '换一道相关题时，怎样沿用本题方法，哪些条件变了要调整',
        teacher: '怎样安排独立尝试，观察哪些表现判断学生是否真正具备迁移能力'
      },
      audienceFocus: emphasis.reflect
    }
  };
}

function buildSetterStructure(q, isChoice, framework, scans, variants, coreKp) {
  const meta = q.meta || {};
  const optionCount = (q.options || []).length;
  return {
    frame: '考查目标→情境/材料/设问→干扰辨析→预期认知路径→答案成立条件及错误路径→迁移与跨学科设计→题组和质量评价',
    note: '分析已有题目不强迫其服从生成器的题数或生成顺序约束；无原作者说明时标注“依据题面推断”。',
    sections: [
      {
        key: 'examTarget', title: '考查目标',
        items: [
          `核心考点：${(coreKp && (coreKp.knowledge_unit || coreKp.knowledgeUnit)) || '待填'}（权重 ${(coreKp && coreKp.weight) || '—'}）`,
          `设问类型：${framework.name}；素养立意：${detectLiteracy(q.stem, q.material || '').join('、') || '待填'}`,
          '待填：实际任务是否有效承载该考查目标（须由讲题阶段依据题面判断）'
        ]
      },
      {
        key: 'context', title: '情境、材料与设问',
        items: [
          `材料长度：${q.material ? q.material.length : 0} 字；涉图：${/图|示意|坐标|曲线|统计|表格/.test(q.material || '') ? '是' : '否'}`,
          `小问/小题数：${q.questionId ? 1 : 0}（本题实例）；题干：${(q.stem || '').slice(0, 120)}`,
          isChoice ? `选项数：${optionCount}` : '综合题：无选项',
          `年份省份题号：${(meta.year || '')}${(meta.region || '')}卷 ${meta.question_numbers || ''}`
        ]
      },
      {
        key: 'interference', title: '设问、材料与选项的干扰辨析（必检）',
        items: [
          '逐层检查：设问层、材料（含图表）层、选项层；不能缩减为错误选项解析',
          '每个确认存在的干扰给出：位置及原文/图表证据→可能诱发的错误思路→辨别所需的知识或证据→对考查的作用→质量判断',
          '某层未发现干扰时如实说明；综合题将选项层标为不适用，可分析典型偏离思路但不得虚构选项'
        ]
      },
      {
        key: 'cognitionPath', title: '预期认知路径',
        items: ['待填：材料和设问如何引发认知操作、是否可绕开考点（须由讲题阶段依据题面推断）']
      },
      {
        key: 'answerConditions', title: '答案成立条件及错误路径',
        items: [
          '待填：答案成立的必要条件，以及主要错误路径',
          isChoice ? '选择题：检查正确项唯一性及干扰项机制' : '综合题：检查合理答案范围、评分依据与开放性'
        ]
      },
      {
        key: 'transferDesign', title: '迁移与跨学科设计',
        items: [
          '待填：是否测到迁移、是否仅靠记忆套路即可完成',
          '待填：跨学科是否服务目标、材料是否交代必要知识、有无暗中超纲',
          `同考点变式候选：${(variants || []).length ? (variants || []).slice(0, 5).map(v => v.file).join('、') : '题库暂无'}`
        ]
      },
      {
        key: 'qualityReview', title: '题组与质量评价',
        items: ['待填：题组内的递进关系与本题质量判断；无试测数据时不生成正确率、区分度数值或实际测量效果断言']
      }
    ]
  };
}

// 讲稿内容要求（计划 §四 的四项）：骨架只给一句可执行侧重，详细写法见 references。
export const EXPLAIN_CONTENT_REQUIREMENTS = {
  student: [
    { item: '考查知识', focus: '考什么知识点、为什么用它、它怎样帮助解题' },
    { item: '解题过程', focus: '清楚展示怎么想、怎么做、每步依据和关键辨析' },
    { item: '同类问题', focus: '用易懂的方法说明如何识别、入手、推理及条件变化时怎样调整' },
    { item: '迁移运用', focus: '知道换一道相关题时如何使用方法' }
  ],
  teacher: [
    { item: '考查知识', focus: '学生需要建立哪些知识联系，如何引导其选择并运用知识' },
    { item: '解题过程', focus: '在关键处怎样提问、提供提示和检验学生理解，逐步让学生独立完成' },
    { item: '同类问题', focus: '怎样用题库相关题目的比较，引导学生自己归纳方法与适用条件' },
    { item: '迁移运用', focus: '怎样安排独立尝试，观察学生是否真正具备解决问题的能力' }
  ]
};

export function buildExplainerReport(q, isChoice, variants, audience, comparison) {
  const aud = EXPLAIN_AUDIENCES.includes(audience) ? audience : 'student';
  const coreKp = (q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point');
  const framework = classifyQuestion(q.stem);
  const scans = dimensionScan(q.material || '');
  const literacy = detectLiteracy(q.stem, q.material || '');
  const difficulty = detectDifficulty(q);
  const focusElements = Object.keys(scans).map(k => scans[k].name);
  const cmp = comparison || { basis: [], insufficient: true, gap: '未检索同类题' };
  const report = {
    schemaVersion: EXPLAIN_RULESET_VERSION,
    audience: aud,
    audienceLabel: AUDIENCE_LABELS[aud],
    questionId: q.questionId,
    basic: {
      type: isChoice ? '选择题' : '综合题',
      difficulty,
      literacy: literacy.join('、'),
      questionType: framework.name,
      focusElements,
      materialLength: q.material ? q.material.length : 0,
      hasImage: /图|示意|坐标|曲线|统计|表格/.test(q.material || '')
    },
    commonAnalysis: buildCommonAnalysis(),
    interdisciplinary: buildInterdisciplinary(),
    contentRequirements: aud === 'setter' ? [] : EXPLAIN_CONTENT_REQUIREMENTS[aud]
  };
  if (aud === 'setter') {
    report.structure = buildSetterStructure(q, isChoice, framework, scans, variants, coreKp);
    report.audiencePlan = buildSetterPlan(isChoice);
    report.audienceDeliverable = '命题分析文档：设计评价 + 三层干扰辨析；保留独立的命题分析结构，不套用学生/教师四段式';
  } else {
    report.structure = buildStudentTeacherStructure(q, isChoice, difficulty, framework, scans, variants, coreKp, aud, cmp);
    report.audiencePlan = aud === 'teacher' ? buildTeacherPlan() : buildStudentPlan();
    report.audienceDeliverable = aud === 'teacher'
      ? '教师对象：四段式教学引导稿，含思维培养目标、递进追问、支架撤除与独立迁移检测'
      : '学生对象：四段式讲稿（可直接用于讲解），可含答案；“无答案练习支架”另附，不混为同一模式';
  }
  // 缓存键区分题目（题面口径）、对象与讲稿规则版本；题面变化必须换键。
  const fp = questionFingerprint({
    questionId: q.questionId,
    material: q.material,
    stems: [q.stem],
    options: [q.options || []],
    images: []
  });
  report.cacheKey = `${q.questionId}#${fp}#${aud}#rules${EXPLAIN_RULESET_VERSION}`;
  return report;
}

function bestowBasicLabels(q, isChoice, difficulty, framework) {
  const meta = q.meta || {};
  return {
    type: isChoice ? '选择题' : '综合题',
    difficulty,
    yearProvince: `${meta.year || ''}${meta.region || ''}卷`,
    numbers: meta.question_numbers || '',
    literacy: detectLiteracy(q.stem, q.material || '').join('、'),
    frameworkName: framework.name
  };
}

// ========== 风格档案聚合（七维度） ==========
function buildStyleProfile(pickedGroups, analyses) {
  const groupSizes = pickedGroups.map(g => g.items.length);
  const materials = pickedGroups.map(g => g.items[0] ? (g.items[0].material || '') : '');
  const chartKinds = new Set();
  for (const m of materials) {
    if (/柱状|折线|曲线/.test(m)) chartKinds.add('折线/柱状图');
    if (/表格|统计表/.test(m)) chartKinds.add('统计表');
    if (/区域图|地形图|分布图|地图/.test(m)) chartKinds.add('区域/分布图');
    if (/剖面图|示意图/.test(m)) chartKinds.add('示意图');
  }
  const groupStructure = {
    groupCount: pickedGroups.length,
    questionsPerGroup: groupSizes.length ? `${Math.min(...groupSizes)}-${Math.max(...groupSizes)}` : '-',
    sharedMaterialForms: [...new Set(materials.map(m =>
      /材料一|材料二/.test(m) ? '多材料组合' : /图|表/.test(m) ? '图/表+情境' : '情境段'))]
  };
  const ctxUnion = new Set();
  let sentenceCount = 0;
  let dataDense = 0;
  for (const m of materials) {
    for (const t of detectContextType(m)) ctxUnion.add(t);
    sentenceCount += (m.match(/[。！？]/g) || []).length;
    if (/\d/.test(m)) dataDense += 1;
  }
  const materialFeatures = {
    avgSentences: materials.length ? (sentenceCount / materials.length).toFixed(1) : '-',
    contextTypes: [...ctxUnion],
    dataDensity: materials.length ? `${Math.round(dataDense / materials.length * 100)}%含数据` : '-'
  };
  const chartFeatures = { chartTypes: chartKinds.size ? [...chartKinds] : ['无图/纯文字'] };
  const verbs = new Map();
  const modes = new Set();
  for (const a of analyses) {
    modes.add(a.stemMode);
    const verbHit = (a.stem || '').match(/^(请)?(简述|说明|分析|指出|推测|评价|比较|描述|解释|判断|提出|列举|归纳|概括)/);
    if (verbHit) verbs.set(verbHit[2], (verbs.get(verbHit[2]) || 0) + 1);
  }
  const questionFeatures = {
    stemModes: [...modes],
    verbFrequency: [...verbs.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`)
  };
  let combo = 0, choiceTotal = 0;
  const distractorNotes = new Set();
  for (const a of analyses) {
    if (a.options && a.options.length) {
      choiceTotal += 1;
      if (/①|②|③|④/.test(a.stem)) combo += 1;
    }
    for (const d of a.distractors) {
      if (/绝对|一定|都|只/.test(d.reason)) distractorNotes.add('绝对化');
      if (/因果|倒置/.test(d.reason)) distractorNotes.add('因果倒置');
      if (/片面|只对一半/.test(d.reason)) distractorNotes.add('片面化');
      if (/无中生有|材料未提/.test(d.reason)) distractorNotes.add('无中生有');
    }
  }
  const optionFeatures = {
    comboRatio: choiceTotal ? `${Math.round(combo / choiceTotal * 100)}%组合式` : '-',
    distractorTactics: distractorNotes.size ? [...distractorNotes] : ['（未从解析中归纳）']
  };
  const compItems = [];
  for (const a of analyses) {
    if (a.questionType === '综合题') compItems.push(a);
  }
  const compSizes = compItems.map(a => (a.stem.match(/（\d）/g) || []).length);
  const comprehensiveFeatures = {
    itemCount: compItems.length,
    subQuestionRange: compSizes.length ? `${Math.min(...compSizes)}-${Math.max(...compSizes)}小问` : '-'
  };
  const analysisFeatures = {
    hasInsightExtension: /点睛/.test(materials.join('')) ? '部分含【点睛】知识拓展' : '未见【点睛】扩展',
    citationStyle: '解析引用材料信息（规则推断）'
  };
  return {
    groupStructure,
    materialFeatures,
    chartFeatures,
    questionFeatures,
    optionFeatures,
    analysisFeatures,
    comprehensiveFeatures
  };
}

export default {
  name: 'geo-core',
  inject: ['fs', 'webServer'],
  apply(ctx, config) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;
    const cfg = config || {};
    // ── 数据路径解析 ────────────────────────────────────────────────────────────
    // 优先级：插件 config（组合文件覆盖，留给其它部署）＞ 用户配置文件 ＞ 明确报错。
    // 不用 cwd 推导：插件在 apply 期没有会话上下文，工具执行上下文（ToolExecutionInput）里也没有 cwd，
    // 所以插件拿不到"用户的工作区"，只能由用户显式给出，或落在确定的锚点上。
    //
    // 用户配置文件：<DSH_HOME>/geo-teacher/config.json
    //   DSH_HOME = process.env.DSH_HOME || <用户目录>/.dsh
    //   键：knowledgeBasePath｜questionBankPath｜outputPath｜workspaceRoot（全部可选）
    //   相对路径以该配置文件所在目录为基准。
    // 考点库若已随包发布（<预设包>/knowledge/ 存在），knowledgeBasePath 缺省即指向它，无需配置。
    const PKG_ROOT = join(HERE, '..', '..');
    const PACKAGED_KNOWLEDGE_DIR = join(PKG_ROOT, 'knowledge');
    const CONFIG_PATH = join(
      process.env.DSH_HOME || join(homedir(), '.dsh'),
      'geo-teacher',
      'config.json'
    );
    const CONFIG_DIR = dirname(CONFIG_PATH);
    const CONFIG_HINT = '请在 ' + CONFIG_PATH + ' 写入该键（格式见项目 README「配置数据路径」一节）';

    function readUserConfig() {
      try {
        if (!existsSync(CONFIG_PATH)) return {};
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          console.error('geo-core: ' + CONFIG_PATH + ' 不是 JSON 对象，已忽略');
          return {};
        }
        return parsed;
      } catch (e) {
        console.error('geo-core: 读取 ' + CONFIG_PATH + ' 失败：' + ((e && e.message) || e));
        return {};
      }
    }

    const fileCfg = readUserConfig();
    const pick = (key) => {
      const fromPlugin = cfg[key];
      if (fromPlugin !== undefined && fromPlugin !== null && fromPlugin !== '') return fromPlugin;
      const fromFile = fileCfg[key];
      if (fromFile !== undefined && fromFile !== null && fromFile !== '') return fromFile;
      return null;
    };
    const toAbs = (p) => (isAbsolute(p) ? p : join(CONFIG_DIR, p));

    const KNOWLEDGE_BASE_PATH = pick('knowledgeBasePath')
      ? toAbs(pick('knowledgeBasePath'))
      : (existsSync(PACKAGED_KNOWLEDGE_DIR) ? PACKAGED_KNOWLEDGE_DIR : null);
    const QUESTION_BANK_PATH = pick('questionBankPath') ? toAbs(pick('questionBankPath')) : null;
    const OUTPUT_PATH = pick('outputPath') ? toAbs(pick('outputPath')) : join(CONFIG_DIR, 'outputs');
    const WORKSPACE_ROOT = pick('workspaceRoot') ? toAbs(pick('workspaceRoot')) : CONFIG_DIR;

    // 导出写盘用的沙箱策略：standing mount 无会话上下文，fs 服务会用部署默认 workspaceRoot，
    // 写用户工作区会被拒；这里显式传入解析后的 workspaceRoot。
    const WRITE_POLICY = { mode: 'workspace-write', workspaceRoot: WORKSPACE_ROOT };

    // 未配置时的统一报错：绝不回落到作者路径，也不静默返回空数据。
    function requirePath(value, what, key) {
      if (!value) throw new Error('未配置' + what + '路径（' + key + '）：' + CONFIG_HINT);
      try {
        if (statSync(value).isDirectory()) return value;
      } catch (e) {
        throw new Error(what + '目录不可用（' + key + '）：' + value + '。' + CONFIG_HINT + '。原因：' + e.message);
      }
      throw new Error(what + '路径不是目录（' + key + '）：' + value + '。' + CONFIG_HINT);
    }

    // ========== 题库索引（预构建 + 磁盘持久化 + 内存缓存） ==========
    let _bankCache = null; // 内存缓存：{ byId: Map, all: [], filesCount, builtAt }
    const INDEX_PATH = OUTPUT_PATH + '/question-index.json';
    // 索引格式版本：items 结构/字段变化时必须递增；scripts/geo-verify.mjs 的 index-data 断言按此版本校验
    // v4：题答分离（questionImages/analysisImages/boundaryIssues），服务端解题运行记录依赖题面图片字段
    const INDEX_VERSION = 4;

    async function loadBank() {
      requirePath(QUESTION_BANK_PATH, '真题库', 'questionBankPath');
      // 1. 内存缓存命中 → 直接返回
      if (_bankCache) return _bankCache;

      // 2. 尝试从磁盘读索引
      const bankDir = await fsService.resolve(QUESTION_BANK_PATH);
      const files = [];
      await collectMdFiles(fsService, bankDir, files);
      const currentFileCount = files.length;

      try {
        const idxTarget = await fsService.resolve(INDEX_PATH);
        const raw = await fsService.readText(idxTarget);
        const idx = JSON.parse(raw);
        // 新鲜度检查：version 代际（须与 INDEX_VERSION 一致）+ 文件数 + mtime（任一文件晚于 builtAt 即重建）
        const builtAt = Date.parse(idx && idx.builtAt) || 0;
        let fresh = !!(idx && idx.version === INDEX_VERSION && idx.fileCount === currentFileCount && Array.isArray(idx.items));
        if (fresh) {
          const maxMtime = files.reduce((mx, f) => (f.mtime && f.mtime > mx ? f.mtime : mx), 0);
          if (maxMtime > 0 && maxMtime > builtAt) fresh = false; // stat 不可用时 maxMtime=0 → 跳过 mtime 判断
        }
        if (fresh) {
          const byId = new Map();
          const all = [];
          for (const item of idx.items) {
            // 确保 knowledgePoints 是数组
            if (!Array.isArray(item.knowledgePoints)) item.knowledgePoints = [];
            if (!Array.isArray(item.questionImages)) item.questionImages = [];
            if (!Array.isArray(item.analysisImages)) item.analysisImages = [];
            if (!Array.isArray(item.boundaryIssues)) item.boundaryIssues = [];
            byId.set(item.questionId, item);
            all.push(item);
          }
          _bankCache = { byId, all, filesCount: currentFileCount, builtAt: idx.builtAt, fromIndex: true };
          console.log(`geo-core: 题库索引从磁盘加载 (${all.length} 小问, ${currentFileCount} 文件)`);
          return _bankCache;
        }
      } catch (e) {
        // 索引不存在/损坏/版本不符/文件更新 → 重建
      }

      // 3. 全量扫描 + 构建索引
      const byId = new Map();
      const all = [];
      for (const f of files) {
        const content = await fsService.readText(f.target);
        const meta = parseFrontmatter(content);
        // 先取得文件磁盘绝对路径：题答分离要在解析期按 md 目录解析题面图片引用
        let filePath = '';
        try { filePath = fsService.processPath(f.target); } catch (e) { filePath = f.name; }
        const parsed = parseQuestionFileFull(content);
        for (const q of parsed.questions) {
          const boundaryIssues = (parsed.boundaryIssues || []).filter(
            (issue) => !issue.questionId || issue.questionId === q.questionId
          );
          const item = {
            ...q,
            file: f.name,
            filePath,
            material: parsed.material,
            meta,
            knowledgePoints: q.knowledgePoints || [],
            questionImages: parsed.questionImages || [],
            analysisImages: parsed.analysisImages || [],
            boundaryIssues
          };
          byId.set(q.questionId, item);
          all.push(item);
        }
      }
      _bankCache = { byId, all, filesCount: currentFileCount, builtAt: new Date().toISOString(), fromIndex: false };
      console.log(`geo-core: 题库全量扫描完成 (${all.length} 小问, ${currentFileCount} 文件), 正在写索引...`);

      // 4. 写磁盘索引
      try {
        const indexData = {
          version: INDEX_VERSION, // v3：索引持久化完整题目信息（answer/analysis），修复磁盘加载后 judge 标准答案丢失（方案 A）
          builtAt: _bankCache.builtAt,
          fileCount: currentFileCount,
          questionCount: all.length,
          items: all.map(item => ({
            questionId: item.questionId,
            file: item.file,
            filePath: item.filePath || '',
            stem: item.stem,
            options: item.options || [],
            material: item.material,
            answer: item.answer || '',
            analysis: item.analysis || '',
            questionImages: item.questionImages || [],
            analysisImages: item.analysisImages || [],
            boundaryIssues: item.boundaryIssues || [],
            meta: item.meta || {},
            knowledgePoints: (item.knowledgePoints || []).map(kp => ({
              role: kp.role,
              domain: kp.domain || '',
              theme: kp.theme || '',
              knowledge_unit: kp.knowledge_unit || kp.knowledgeUnit || '',
              knowledge_unit_id: kp.knowledge_unit_id || kp.knowledgeUnitId || '',
              theme_id: kp.theme_id || '',
              weight: kp.weight || '',
              evidence: kp.evidence || ''
            })),
            extraTags: item.extraTags || []
          }))
        };
        await fsService.writeText(
          await fsService.resolve(INDEX_PATH),
          JSON.stringify(indexData, null, 2),
          undefined, undefined, WRITE_POLICY
        );
        console.log('geo-core: 题库索引已写入 ' + INDEX_PATH);
      } catch (e) {
        console.error('geo-core: 索引写盘失败（不影响运行）:', e.message);
      }

      return _bankCache;
    }

    // 手动重建索引（供未来调用：题库更新后清除缓存）
    function invalidateBankCache() {
      _bankCache = null;
    }

    function groupInfo(item) {
      const meta = item.meta || {};
      const isChoice = item.options && item.options.length > 0;
      const typeLabel = isChoice ? '选择题' : '综合题';
      const nums = String(meta.question_numbers || '').replace(/,/g, '-');
      const label = `${meta.year || ''}${meta.region || ''}卷 ${typeLabel} · 第${nums}题`;
      return { year: meta.year || '', region: meta.region || '', questionNumbers: nums, typeLabel, label };
    }

    // ========== 解题运行记录：持久化 + 题面上下文 ==========
    // 服务端持有 run（题面就绪 → 作答已提交 → 核验完成），绑定题目与题面指纹。
    // 记录落盘在 outputPath/solve-runs.json，重启后仍可核验/讲题；写盘失败只降级为内存态并如实记录。
    const SOLVE_RUNS_PATH = OUTPUT_PATH + '/solve-runs.json';
    const solveRegistry = createSolveRegistry({});
    let solveRunsLoaded = null;
    async function ensureSolveRunsLoaded() {
      if (solveRunsLoaded) return solveRunsLoaded;
      solveRunsLoaded = (async () => {
        try {
          const target = await fsService.resolve(SOLVE_RUNS_PATH);
          const raw = await fsService.readText(target);
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.runs)) solveRegistry.restore(parsed.runs);
        } catch (e) {
          // 首次运行或记录损坏：从空记录开始，不伪造历史
        }
        return true;
      })();
      return solveRunsLoaded;
    }
    let solvePersistChain = Promise.resolve(true);
    function persistSolveRuns() {
      const payload = JSON.stringify({
        version: SOLVE_RUNS_SCHEMA,
        updatedAt: new Date().toISOString(),
        runs: solveRegistry.list()
      }, null, 2);
      solvePersistChain = solvePersistChain.then(async () => {
        try {
          const target = await fsService.resolve(SOLVE_RUNS_PATH);
          await fsService.writeText(target, payload, undefined, undefined, WRITE_POLICY);
          return true;
        } catch (e) {
          console.error('geo-core: 解题运行记录写盘失败（内存状态仍有效）:', e.message);
          return false;
        }
      });
      return solvePersistChain;
    }

    // 题目所在 md 的磁盘路径：优先索引 filePath；旧索引缺失时遍历题库定位。
    async function resolveQuestionFilePath(bank, q, questionId) {
      const direct = q && q.filePath ? String(q.filePath) : '';
      if (direct) return direct;
      try {
        const bankDir = await fsService.resolve(requirePath(QUESTION_BANK_PATH, '真题库', 'questionBankPath'));
        const files = [];
        await collectMdFiles(fsService, bankDir, files);
        for (const f of files) {
          try {
            const text = await fsService.readText(f.target);
            if (text && text.indexOf(questionId) >= 0) return fsService.processPath(f.target);
          } catch (e) { /* skip */ }
        }
      } catch (e) { /* ignore */ }
      return '';
    }

    // 题组题面 + 指纹 + run 状态（prepareSolve / solveStatus / open / explain 共用）。
    async function questionRunContext(questionId) {
      const bank = await loadBank();
      const q = bank.byId.get(questionId);
      if (!q) return { notFound: true };
      const siblings = bank.all.filter(i => i.file === q.file);
      // 题组（含相互提示的小题）作为一个整体提交与核验：run 以题组首题 id 为键。
      const groupKey = (siblings[0] && siblings[0].questionId) || q.questionId;
      const questions = siblings.map(i => ({ questionId: i.questionId, stem: i.stem, options: i.options || [] }));
      const questionImages = (q.questionImages || []).map(img => ({
        imageId: img.imageId, caption: img.caption, rel: img.rel, source: img.source,
        order: typeof img.order === 'number' ? img.order : 0
      }));
      const questionFingerprintValue = questionFingerprint({
        questionId: groupKey,
        material: q.material || '',
        stems: questions.map(x => x.stem || ''),
        options: questions.map(x => x.options || []),
        images: questionImages
      });
      const boundaryIssues = [];
      for (const s of siblings) {
        for (const issue of (s.boundaryIssues || [])) {
          const key = [issue.kind, issue.questionId || '', issue.sectionTitle || ''].join('|');
          if (!boundaryIssues.some(x => [x.kind, x.questionId || '', x.sectionTitle || ''].join('|') === key)) boundaryIssues.push(issue);
        }
      }
      return {
        bank,
        q,
        siblings,
        groupKey,
        questions,
        questionImages,
        fingerprint: questionFingerprintValue,
        boundaryIssues,
        isChoice: (q.options || []).length > 0
      };
    }

    const api = {
      // 重建题库索引（题库更新后调用，清除内存缓存 + 磁盘索引）
      invalidateBankCache,

      // 兼容访问器：保持返回原数组结构，供既有路由/面板/健康检查继续消费。
      // 失败时仍返回 []（旧行为，不改变既有消费者）；需要"失败与无匹配分开"的调用方请用 getTaxonomy()。
      async getTaxonomyTree() {
        try {
          const configDir = await fsService.resolve(requirePath(KNOWLEDGE_BASE_PATH, '考点库', 'knowledgeBasePath'));
          const loaded = await loadTaxonomyAll(fsService, configDir);
          return buildTaxonomyTree(loaded.nodes);
        } catch (e) {
          console.error('geo-core: taxonomy failed', e);
          return [];
        }
      },

      // 新增兼容扩展接口：可选 query/ids 返回本次相关节点；版本/状态/指纹放在简短元数据中。
      // status: 'success' 读取正常；'partial' 部分文件失败但仍有可用数据；'error' 完全不可用。
      // matchKind: 'tree' 未指定目标（返回 roots）；'exact' | 'candidates' | 'partial' | 'none'；'unavailable' 读取失败。
      async getTaxonomy(options) {
        const opts = options || {};
        let loaded;
        try {
          const configDir = await fsService.resolve(requirePath(KNOWLEDGE_BASE_PATH, '考点库', 'knowledgeBasePath'));
          loaded = await loadTaxonomyAll(fsService, configDir);
        } catch (e) {
          return {
            status: 'error',
            matchKind: 'unavailable',
            message: '考点树不可读：' + ((e && e.message) || e),
            meta: null,
            sources: [],
            errors: [{ file: null, kind: 'read', message: String((e && e.message) || e) }],
          };
        }
        if (loaded.sources.length === 0) {
          return {
            status: 'error',
            matchKind: 'unavailable',
            message: loaded.errors.length
              ? '考点树全部文件读取或解析失败'
              : '配置目录内没有任何 .yaml 文件',
            parser: loaded.parser,
            meta: null,
            sources: [],
            errors: loaded.errors,
          };
        }
        const roots = buildTaxonomyTree(loaded.nodes);
        const flat = flattenTaxonomy(roots);
        const needsReview = loaded.nodes.filter((n) => n.needs_review).map((n) => n.id);
        const versions = [...new Set(loaded.sources.map((s) => s.version).filter(Boolean))];
        const statuses = [...new Set(loaded.sources.map((s) => s.status).filter(Boolean))];
        const meta = {
          parser: loaded.parser,
          fileCount: loaded.sources.length,
          nodeCount: loaded.nodes.length,
          taxonomyVersions: versions,
          taxonomyStatuses: statuses,
          multipleVersions: versions.length > 1,
          finalised: statuses.length > 0 && statuses.every((s) => s === 'final' || s === 'released'),
          needsReview,
          anyNeedsReview: needsReview.length > 0,
          errors: loaded.errors,
        };
        const out = {
          status: loaded.errors.length ? 'partial' : 'success',
          meta,
          sources: loaded.sources,
          errors: loaded.errors,
        };
        const hasTarget = (Array.isArray(opts.ids) && opts.ids.filter(Boolean).length > 0) || String(opts.query || '').trim();
        if (!hasTarget) {
          out.matchKind = 'tree';
          out.roots = roots;
          return out;
        }
        const r = resolveTaxonomyMatches(flat, opts);
        out.matchKind = r.matchKind;
        out.unmatched = r.unmatched;
        out.matches = r.matches.slice(0, Math.max(1, Number(opts.limit) || 20)).map((f) => ({
          id: f.node.id,
          name: f.node.name,
          level: f.node.level,
          parent_id: f.node.parent_id,
          definition: f.node.definition,
          includes: f.node.includes,
          excludes: f.node.excludes,
          aliases: f.node.aliases,
          needs_review: f.node.needs_review,
          review_note: f.node.review_note,
          path: f.path,
        }));
        return out;
      },

      // 重构：searchQuestions 支持结构化查询，统一 score 累加，按小问拆分返回。
      // 兼容旧接口：searchQuestions(knowledgeId, keyword) 仍可用。
      async searchQuestions(queryOrKnowledgeId, maybeKeyword) {
        try {
          // 参数归一化：兼容旧的两个字符串参数
          let region, year, questionNumber, questionType, keyword, knowledgeId;
          if (typeof queryOrKnowledgeId === 'object' && queryOrKnowledgeId !== null) {
            region = queryOrKnowledgeId.region || '';
            year = queryOrKnowledgeId.year ? String(queryOrKnowledgeId.year) : '';
            questionNumber = queryOrKnowledgeId.questionNumber ? String(queryOrKnowledgeId.questionNumber) : '';
            questionType = queryOrKnowledgeId.questionType || '';
            keyword = queryOrKnowledgeId.keyword || '';
            knowledgeId = queryOrKnowledgeId.knowledgeId || '';
          } else {
            knowledgeId = queryOrKnowledgeId || '';
            keyword = maybeKeyword || '';
          }

          const bank = await loadBank();
          const candidates = [];

          for (const item of bank.all) {
            const meta = item.meta || {};
            const kpList = item.knowledgePoints || [];
            let score = 0;

            // 结构化字段：精确匹配，高分
            if (region && (meta.region || '') === region) score += 10;
            if (year && String(meta.year || '') === year) score += 10;
            if (questionNumber && String(meta.question_numbers || '').includes(questionNumber)) score += 10;
            if (questionType && String(meta.question_type || '').includes(questionType)) score += 5;

            // 知识点：匹配 id + 名称 + 领域
            if (knowledgeId) {
              const kMatch = kpList.some(kp =>
                kp.knowledge_unit_id === knowledgeId ||
                kp.knowledgeUnitId === knowledgeId ||
                kp.theme_id === knowledgeId ||
                (kp.knowledge_unit || '').includes(knowledgeId) ||
                (kp.knowledgeUnit || '').includes(knowledgeId) ||
                (kp.domain || '').includes(knowledgeId) ||
                (kp.theme || '').includes(knowledgeId)
              );
              if (kMatch) score += 8;
              // 也搜材料/题干里的文字
              if (item.material.includes(knowledgeId)) score += 3;
              if (item.stem.includes(knowledgeId)) score += 3;
            }

            // 全文关键词：覆盖 material/stem/options/knowledgeUnit/meta
            if (keyword) {
              const kw = keyword;
              if (item.material.includes(kw)) score += 3;
              if (item.stem.includes(kw)) score += 3;
              if ((item.options || []).some(o => o.includes(kw))) score += 2;
              if (kpList.some(kp =>
                (kp.knowledge_unit || '').includes(kw) ||
                (kp.knowledgeUnit || '').includes(kw) ||
                (kp.domain || '').includes(kw) ||
                (kp.theme || '').includes(kw)
              )) score += 3;
              if ((meta.region || '').includes(kw)) score += 5;
              if (String(meta.year || '').includes(kw)) score += 5;
              if (String(meta.question_numbers || '').includes(kw)) score += 5;
              if ((meta.subject || '').includes(kw)) score += 2;
              if ((meta.source_document || '').includes(kw)) score += 2;
            }

            if (score > 0) candidates.push({ item, score });
          }

          // 按 score 降序，去重（同一文件内多题保留最高分的那道代表）
          candidates.sort((a, b) => b.score - a.score);

          // 按小问拆分返回：每道小问独立一条结果
          const seen = new Set();
          const results = [];
          for (const { item, score } of candidates) {
            if (results.length >= 30) break; // 上限
            if (seen.has(item.questionId)) continue;
            seen.add(item.questionId);
            results.push({
              questionId: item.questionId,
              file: item.file,
              group: groupInfo(item),
              stem: item.stem.slice(0, 100),
              knowledgePoints: (item.knowledgePoints || []).map(kp => ({
                role: kp.role,
                knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || ''
              })),
              score
            });
          }
          return results;
        } catch (e) {
          console.error('geo-core: searchQuestions failed', e);
          throw e;
        }
      },

      async getQuestionDetail(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const siblings = bank.all.filter(i => i.file === q.file);
          return {
            status: 'success',
            file: q.file,
            group: groupInfo(q),
            material: q.material,
            questions: siblings.map(i => ({
              stem: i.stem,
              options: i.options,
              questionId: i.questionId,
              // 检索详情与 solve 口径一致：不暴露 role/evidence（避免"哪个是核心考点"等解析派生信息）；role 仅在真题分析（geo_analyze）的 examPoints 中返回
              knowledgePoints: (i.knowledgePoints || []).map(kp => ({
                knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || ''
              }))
            }))
          };
        } catch (e) {
          return { status: 'error', message: '获取详情失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 题面访问：只返回材料、题干、选项与小问（不含答案/解析/知识点/图片）。
      async questionData(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const siblings = bank.all.filter(i => i.file === q.file);
          return {
            status: 'success',
            questionId: q.questionId,
            file: q.file,
            group: groupInfo(q),
            material: q.material,
            questions: siblings.map(i => ({
              questionId: i.questionId,
              stem: i.stem,
              options: i.options || []
            }))
          };
        } catch (e) {
          return { status: 'error', message: '获取题目失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 题面图片引用：只返回题面图片（材料图 / 相关图片 / 各小问答案标记之前的正文图）。
      // 解析图（答案、解析、教学备注中的图片）永不进入解题输入，见 prepareSolve。
      async imageRefs(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const mdDiskPath = await resolveQuestionFilePath(bank, q, questionId);
          if (!mdDiskPath) {
            return { status: 'warning', questionId, hasImages: false, images: [], message: '未找到该题所在文件，无法解析题面图片' };
          }
          const images = resolveQuestionImagePaths(q.questionImages || [], mdDiskPath);
          return {
            status: 'success',
            questionId,
            file: (String(mdDiskPath).split(/[\\/]/).pop() || ''),
            hasImages: images.length > 0,
            images,
            analysisImageCount: (q.analysisImages || []).length
          };
        } catch (e) {
          return { status: 'error', message: '题面图片引用解析失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题 Solver（P1）：审题骨架——设问类型框架 / 思维模式 / 焦点要素 / 维度扫描。
      // 只提供"怎么想"的骨架；绝不包含从官方解析派生的干扰项错因（那等于泄露答案），
      // 干扰项排除论证由模型独立完成，judge(answerData) 阶段才开放解析对照。
      async solutionScaffold(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const framework = classifyQuestion(q.stem);
          const scans = dimensionScan(q.material || '');
          return {
            status: 'success',
            questionId,
            isChoice: q.options && q.options.length > 0,
            questionFramework: { key: framework.key, name: framework.name, hint: framework.hint },
            thinkingModes: detectLiteracy(q.stem, q.material || ''),
            focusElements: Object.keys(scans).map(k => scans[k].name),
            dimensionScan: scans
          };
        } catch (e) {
          return { status: 'error', message: '骨架生成失败：' + (e && e.message ? e.message : e) };
        }
      },

      // ===== 讲题运行记录（题面就绪 → 作答已提交 → 核验完成）=====
      // 题面准备：分离题面与答案解析，指纹绑定题面；已有同指纹已提交 run 时直接复用。
      // 无法判定题答边界时指出具体题目，请教师确认，不猜测。
      async prepareSolve(questionId) {
        try {
          await ensureSolveRunsLoaded();
          const ctxInfo = await questionRunContext(questionId);
          if (ctxInfo.notFound) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          if (ctxInfo.boundaryIssues.length) {
            return {
              status: 'error',
              code: 'QUESTION_BOUNDARY_UNCERTAIN',
              questionId: ctxInfo.q.questionId,
              file: ctxInfo.q.file,
              boundaryIssues: ctxInfo.boundaryIssues,
              message: '题答边界无法确定：已指出具体题目，请教师确认后再解题（不猜测切分）'
            };
          }
          const mdDiskPath = await resolveQuestionFilePath(ctxInfo.bank, ctxInfo.q, questionId);
          const resolvedImages = mdDiskPath
            ? resolveQuestionImagePaths(ctxInfo.questionImages, mdDiskPath)
            : ctxInfo.questionImages.map(img => ({ ...img, sourcePath: '' }));
          const ensured = solveRegistry.ensureRun({
            questionId: ctxInfo.groupKey,
            questionFingerprint: ctxInfo.fingerprint
          });
          const run = ensured.run;
          return {
            status: 'success',
            runId: run.runId,
            questionId: ctxInfo.q.questionId,
            groupKey: ctxInfo.groupKey,
            file: ctxInfo.q.file,
            group: groupInfo(ctxInfo.q),
            questionFingerprint: ctxInfo.fingerprint,
            state: run.state,
            reused: ensured.reused,
            invalidatedPrevious: ensured.invalidated,
            material: ctxInfo.q.material || '',
            questions: ctxInfo.questions,
            questionImages: resolvedImages,
            analysisImageCount: (ctxInfo.q.analysisImages || []).length,
            // 成功路径下边界问题为空数组（有边界问题时上面已返回 QUESTION_BOUNDARY_UNCERTAIN）。
            boundaryIssues: [],
            // 已提交（或已核验）的 run 直接复用：把服务端保存的独立作答一并返回，避免重复解题。
            answer: run.answer
              ? {
                answerText: run.answer.answerText,
                keyEvidence: run.answer.keyEvidence,
                submittedAt: run.answer.submittedAt || run.submittedAt,
                answerHash: run.answer.answerHash
              }
              : null,
            solveStatus: solveRegistry.statusFor(ctxInfo.groupKey, ctxInfo.fingerprint)
          };
        } catch (e) {
          return { status: 'error', code: 'PREPARE_SOLVE_FAILED', message: '题面准备失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 记录独立作答：只能由插件在隔离解题子会话结束后调用；主模型传入的答案不经此接口。
      async recordIndependentAnswer(runId, payload) {
        try {
          await ensureSolveRunsLoaded();
          const res = solveRegistry.submit(runId, payload || {});
          if (!res.ok) return { status: 'error', code: res.code, message: '独立作答记录失败：' + res.code };
          await persistSolveRuns();
          return {
            status: 'success',
            runId: res.run.runId,
            questionId: res.run.questionId,
            state: res.run.state,
            submittedAt: res.run.submittedAt,
            answerHash: res.run.answer ? res.run.answer.answerHash : '',
            answerLength: res.run.answer ? res.run.answer.answerText.length : 0
          };
        } catch (e) {
          return { status: 'error', code: 'RECORD_ANSWER_FAILED', message: '独立作答记录失败：' + (e && e.message ? e.message : e) };
        }
      },

      async solveStatus(questionId) {
        try {
          await ensureSolveRunsLoaded();
          const ctxInfo = await questionRunContext(questionId);
          if (ctxInfo.notFound) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          return {
            status: 'success',
            questionId: ctxInfo.q.questionId,
            questionFingerprint: ctxInfo.fingerprint,
            boundaryIssues: ctxInfo.boundaryIssues,
            ...solveRegistry.statusFor(ctxInfo.groupKey, ctxInfo.fingerprint)
          };
        } catch (e) {
          return { status: 'error', code: 'SOLVE_STATUS_FAILED', message: '状态读取失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 开放参考答案（Judge 前半）：作答提交前一律拒绝，题面变化后旧作答失效。
      async openReferenceAnswer(questionId) {
        try {
          await ensureSolveRunsLoaded();
          const ctxInfo = await questionRunContext(questionId);
          if (ctxInfo.notFound) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          const status = solveRegistry.statusFor(ctxInfo.groupKey, ctxInfo.fingerprint);
          if (!status.runId || status.state === SOLVE_STATES.READY) {
            return {
              status: 'error',
              code: 'SOLVE_NOT_SUBMITTED',
              questionId: ctxInfo.q.questionId,
              solveStatus: status,
              message: '该题尚未完成独立作答，不能开放参考答案。先调用 geo_solve。'
            };
          }
          if (!status.fingerprintMatches) {
            return {
              status: 'error',
              code: 'QUESTION_VERSION_CHANGED',
              questionId: ctxInfo.q.questionId,
              solveStatus: status,
              message: '题面已变化，旧作答失效，必须重新解题后再开放答案。'
            };
          }
          const opened = solveRegistry.openReference(status.runId);
          if (!opened.ok) return { status: 'error', code: opened.code, message: '答案开放失败：' + opened.code };
          await persistSolveRuns();
          const run = opened.run;
          const reference = ctxInfo.siblings.map((item) => {
            const itemIsChoice = (item.options || []).length > 0;
            const scorePoints = buildScorePoints(item, itemIsChoice);
            return {
              questionId: item.questionId,
              isChoice: itemIsChoice,
              standardAnswer: item.answer || '',
              analysis: item.analysis || '',
              scorePoints,
              coverageGrid: scorePoints.map((p) => ({ match: p.option ? ('正确项=' + p.option) : p.point, hit: '', note: '' })),
              distractorTargets: itemIsChoice
                ? detectDistractors(item.analysis).map((d) => ({ option: d.option, reason: d.reason, independentJudged: '' }))
                : []
            };
          });
          return {
            status: 'success',
            questionId: ctxInfo.q.questionId,
            runId: run.runId,
            state: run.state,
            independent: {
              answerText: run.answer ? run.answer.answerText : '',
              keyEvidence: run.answer ? run.answer.keyEvidence : '',
              submittedAt: run.submittedAt,
              answerHash: run.answer ? run.answer.answerHash : ''
            },
            isChoice: ctxInfo.isChoice,
            reference,
            judgeOpenedAt: run.judgeOpenedAt,
            nextStep: '对照完成后，再次调用 geo_judge 并传入 conclusion 归档核验结论（一致/遗漏/错误/争议 + 修正结论）'
          };
        } catch (e) {
          return { status: 'error', code: 'OPEN_ANSWER_FAILED', message: '答案开放失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 归档核验结论（Judge 后半）：必须已开放答案；结论结构见 geo_judge 工具。
      async recordVerification(questionId, conclusion) {
        try {
          await ensureSolveRunsLoaded();
          const ctxInfo = await questionRunContext(questionId);
          if (ctxInfo.notFound) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          const status = solveRegistry.statusFor(ctxInfo.groupKey, ctxInfo.fingerprint);
          if (!status.runId || status.state === SOLVE_STATES.READY) {
            return { status: 'error', code: 'SOLVE_NOT_SUBMITTED', solveStatus: status, message: '该题尚未完成独立作答，不能归档核验结论。' };
          }
          if (!status.fingerprintMatches) {
            return { status: 'error', code: 'QUESTION_VERSION_CHANGED', solveStatus: status, message: '题面已变化，旧作答与核验失效，必须重新解题。' };
          }
          const res = solveRegistry.recordVerification(status.runId, conclusion);
          if (!res.ok) return { status: 'error', code: res.code, message: res.message || ('核验结论记录失败：' + res.code) };
          await persistSolveRuns();
          return {
            status: 'success',
            questionId: ctxInfo.q.questionId,
            runId: res.run.runId,
            state: res.run.state,
            verifiedAt: res.run.verifiedAt,
            conclusion: res.run.conclusion
          };
        } catch (e) {
          return { status: 'error', code: 'RECORD_VERIFICATION_FAILED', message: '核验结论归档失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题骨架（Explainer）：必须已完成核验；只读服务端记录，不再接收模型自报的独立答案/核验材料。
      async assembleExplanation(questionId, audience) {
        try {
          await ensureSolveRunsLoaded();
          const ctxInfo = await questionRunContext(questionId);
          if (ctxInfo.notFound) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          const status = solveRegistry.statusFor(ctxInfo.groupKey, ctxInfo.fingerprint);
          if (!status.runId || status.state === SOLVE_STATES.READY) {
            return {
              status: 'error',
              code: 'EXPLAIN_NOT_VERIFIED',
              solveStatus: status,
              message: '未完成核验，不能生成讲稿。先完成 geo_solve → geo_judge（开放答案）→ geo_judge（归档 conclusion）。'
            };
          }
          if (!status.fingerprintMatches) {
            return {
              status: 'error',
              code: 'QUESTION_VERSION_CHANGED',
              solveStatus: status,
              message: '题面已变化，旧作答与核验失效：必须重新解题与核验后才能生成讲稿。'
            };
          }
          if (status.state !== SOLVE_STATES.VERIFIED) {
            return {
              status: 'error',
              code: 'EXPLAIN_NOT_VERIFIED',
              solveStatus: status,
              message: '未完成核验，不能生成讲稿。先完成 geo_solve → geo_judge（开放答案）→ geo_judge（归档 conclusion）。'
            };
          }
          const run = solveRegistry.get(status.runId);
          if (!run) {
            return { status: 'error', code: 'EXPLAIN_NOT_VERIFIED', solveStatus: status, message: '未找到该题的有效运行记录，请重新解题与核验。' };
          }
          const coreKp = (ctxInfo.q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point') || (ctxInfo.q.knowledgePoints || [])[0] || {};
          const variants = collectSamePointContexts(ctxInfo.bank.all, ctxInfo.q, coreKp);
          const comparison = rankSimilarQuestions(ctxInfo.bank.all, ctxInfo.q, 5);
          const aud = EXPLAIN_AUDIENCES.includes(audience) ? audience : 'student';
          const report = buildExplainerReport(ctxInfo.q, ctxInfo.isChoice, variants, aud, comparison);
          return {
            status: 'success',
            questionId: ctxInfo.q.questionId,
            audience: aud,
            report,
            variants,
            comparison,
            verification: {
              status: 'verified',
              verified: true,
              evidence: 'server_run_record',
              runId: run.runId,
              submittedAt: run.submittedAt,
              judgeOpenedAt: run.judgeOpenedAt,
              verifiedAt: run.verifiedAt,
              independentAnswerHash: run.answer ? run.answer.answerHash : '',
              conclusion: run.conclusion,
              message: '核验状态来自服务端运行记录：答案在作答提交后开放，核验结论已归档。该记录证明流程顺序与材料交接，不证明内容正确。'
            }
          };
        } catch (e) {
          return { status: 'error', code: 'ASSEMBLE_EXPLANATION_FAILED', message: '讲题骨架生成失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 同类题比较依据：按设问任务 / 推理关系 / 材料特征检索，不只看考点是否相同。
      async similarQuestions(questionId, limit) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', code: 'QUESTION_NOT_FOUND', message: `未找到题目：${questionId}` };
          const result = rankSimilarQuestions(bank.all, q, Number.isSafeInteger(limit) && limit > 0 ? limit : 5);
          return { status: 'success', questionId, ...result };
        } catch (e) {
          return { status: 'error', code: 'SIMILAR_QUESTIONS_FAILED', message: '同类题检索失败：' + (e && e.message ? e.message : e) };
        }
      },

      async analyzeQuestion(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const analysis = buildAnalysis(q, q.material, q.file);
          const blueprint = buildBlueprint(analysis, bank.all, q);
          return { status: 'success', analysis, blueprint };
        } catch (e) {
          return { status: 'error', message: '分析失败：' + (e && e.message ? e.message : e) };
        }
      },

      async exportAnalysis(questionId) {
        try {
          const result = await this.analyzeQuestion(questionId);
          if (result.status !== 'success') return result;
          const md = renderAnalysisMarkdown(result);
          const base = (result.analysis.examPoints[0] && result.analysis.examPoints[0].knowledgeUnit) || questionId;
          const safe = String(base).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
          const fileName = `${safe}__${questionId.replace(/[\\/:*?"<>|]/g, '_')}.md`;
          const target = await fsService.resolve(OUTPUT_PATH + '\\' + fileName);
          await fsService.writeText(target, md, undefined, undefined, WRITE_POLICY);
          return { status: 'success', path: OUTPUT_PATH + '\\' + fileName };
        } catch (e) {
          return { status: 'error', message: '导出失败：' + (e && e.message ? e.message : e) };
        }
      },

      async styleProfile(region, years) {
        try {
          const bank = await loadBank();
          const yearSet = years && years.length ? new Set(years.map(String)) : null;
          const fileGroups = new Map();
          for (const item of bank.all) {
            if (!fileGroups.has(item.file)) {
              const meta = item.meta || {};
              fileGroups.set(item.file, { file: item.file, region: meta.region || '', year: String(meta.year || ''), items: [] });
            }
            fileGroups.get(item.file).items.push(item);
          }
          let candidates = [...fileGroups.values()];
          if (region && region !== 'all' && region !== '') candidates = candidates.filter(g => g.region === region);
          if (yearSet) candidates = candidates.filter(g => yearSet.has(g.year));
          const picked = [];
          const seenRegion = new Set();
          for (const g of candidates) {
            if (picked.length >= 4) break;
            if ((!region || region === 'all' || region === '') && g.region) {
              if (seenRegion.has(g.region)) continue;
              seenRegion.add(g.region);
            }
            picked.push(g);
          }
          if (picked.length === 0 && candidates.length) picked.push(candidates[0]);
          const analyses = [];
          for (const g of picked) {
            for (const item of g.items) {
              analyses.push(buildAnalysis(item, item.material, item.file));
            }
          }
          const dimensions = buildStyleProfile(picked, analyses);
          return {
            status: 'success',
            mode: region && region !== 'all' ? region + '卷独立' : '各省融合',
            source: picked.map(g => ({ region: g.region, year: g.year, file: g.file })),
            dimensions
          };
        } catch (e) {
          return { status: 'error', message: '风格档案生成失败：' + (e && e.message ? e.message : e) };
        }
      },

      async health() {
        // 先如实回显解析结果：用户自查"我配的路径插件到底认不认、存不存在"。
        const configInfo = {
          configPath: CONFIG_PATH,
          configFileFound: existsSync(CONFIG_PATH),
          packagedKnowledgeDir: PACKAGED_KNOWLEDGE_DIR,
          packagedKnowledgeDirUsed: KNOWLEDGE_BASE_PATH === PACKAGED_KNOWLEDGE_DIR,
          knowledgeBasePath: KNOWLEDGE_BASE_PATH,
          questionBankPath: QUESTION_BANK_PATH,
          outputPath: OUTPUT_PATH,
          workspaceRoot: WORKSPACE_ROOT,
          knowledgeBasePathExists: KNOWLEDGE_BASE_PATH ? existsSync(KNOWLEDGE_BASE_PATH) : false,
          questionBankPathExists: QUESTION_BANK_PATH ? existsSync(QUESTION_BANK_PATH) : false
        };
        const missing = [];
        if (!KNOWLEDGE_BASE_PATH) missing.push('knowledgeBasePath（考点库）');
        if (!QUESTION_BANK_PATH) missing.push('questionBankPath（真题库）');
        if (missing.length) {
          return {
            status: 'error',
            configured: false,
            message: '未配置：' + missing.join('、') + '。' + CONFIG_HINT,
            config: configInfo
          };
        }
        try {
          const taxonomy = await this.getTaxonomy({});
          if (taxonomy.status === 'error') {
            throw new Error(taxonomy.message + (taxonomy.errors?.length ? '：' + taxonomy.errors.map(e => e.message).join('；') : ''));
          }
          const bank = await loadBank();
          return {
            status: taxonomy.status,
            configured: true,
            config: configInfo,
            taxonomyFiles: taxonomy.meta.fileCount,
            taxonomyNodes: taxonomy.meta.nodeCount,
            taxonomyErrors: taxonomy.errors,
            bankFiles: bank.filesCount,
            bankQuestions: bank.all.length,
            indexBuiltAt: bank.builtAt || null,
            indexFromDisk: !!bank.fromIndex
          };
        } catch (e) {
          return {
            status: 'error',
            configured: true,
            message: '健康检查失败：' + (e && e.message ? e.message : e),
            config: configInfo
          };
        }
      }
    };

    webServer.register({
      kind: 'exact',
      path: '/geo/core/health',
      handler: async (req, res) => {
        try {
          const data = await api.health();
          const body = JSON.stringify(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
        } catch (e) {
          const body = JSON.stringify({ status: 'error', message: String((e && e.message) || e) });
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
        }
      }
    });

    ctx.provide('geoKernel', api);
    console.log('geo-core: geo.kernel 服务已注册');
  }
};
