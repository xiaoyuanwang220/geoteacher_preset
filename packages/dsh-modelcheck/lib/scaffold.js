// ModelCheck —— 项目发现与 `.modelcheck/` 脚手架
//
// 解决的问题：已有模型项目（往往有自己的 src/ dist/ 文档）里手工写 .modelcheck/{config,components}.json
// 又慢又容易写错。本模块做**只读扫描 + 一次性脚手架**：
//   · discoverCandidates：会话工作区里有哪些像"模型项目"的目录（支持多模型工作区）；
//   · scanProject：探测预览入口、技术路线、构建产物、源码清单、文档、组件候选；
//   · applyScaffold：写入 config.json 与 components.json（不写契约、不写判据）；
//   · buildContractDraft：把 agent 给的轻量 criteria 列表整理成契约草稿（仍需用户在面板确认）。
//
// 约束：只用 node: 内置模块与包内相对路径；不读工作区以外的路径；不覆盖已有文件（除非 force）。
// 判据内容仍只来自项目文档与用户确认，脚手架不生成任何"通用判据模板"。

import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';

import { Store } from './store.js';
import { contractContentHash, normalizeContract, validateContract } from './contract.js';
import { nowIso, sha256 } from './util.js';

export const SCAFFOLD_VERSION = 'modelcheck-scaffold/1';

const MAX_VISIT_DIRS = 400;
const MAX_SOURCE_FILES = 160;
const MAX_OUTPUT_FILES = 40;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_COMPONENTS = 80;
const MAX_DOCS = 30;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.modelcheck', '.workbuddy', '.agents', '.claude', '.cache',
  'book', '课本', 'assets', 'vendor', 'reference', 'visual-baseline', 'reports', 'artifacts',
  '__pycache__', '.venv', 'venv', 'dist-old', '.idea', '.vscode'
]);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm', '.css']);
const ENTRY_CANDIDATES = ['dist/index.html', 'index.html', 'src/index.html', 'public/index.html'];
const MARKER_PACKAGE = 'package.json';
const ID_ATTR_RE = /data-(?:mc-id|role)\s*=\s*["']([A-Za-z0-9][A-Za-z0-9 ._:/-]{0,60})["']/g;
const NAME_ASSIGN_RE = /\.name\s*=\s*["']([^"'\r\n]{1,60})["']/g;
const NAME_PROP_RE = /\bname\s*:\s*["']([^"'\r\n]{1,60})["']/g;
const USER_DATA_RE = /userData\s*\.\s*(?:mcId|mc_id)\s*=\s*["']([A-Za-z0-9][A-Za-z0-9._:-]{1,60})["']/g;
// 这些是通用对象名，不是教学组件；扫描时过滤，避免把 scene/camera 当组件登记。
const GENERIC_NAMES = new Set(['scene', 'camera', 'renderer', 'group', 'mesh', 'material', 'geometry', 'light', 'ambient', 'directional', 'point', 'spot', 'texture', 'object', 'arrow', 'line', 'text', 'label', 'circle', 'sphere', 'box', 'plane', 'main', 'default', 'root', 'container', 'wrapper', 'canvas', 'svg', 'img', 'div', 'span']);

export class ScaffoldError extends Error {
  constructor(code, message, issues) {
    super(message);
    this.name = 'ScaffoldError';
    this.code = code;
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep));
}
function relPosix(from, to) {
  return relative(from, to).split(sep).join('/');
}
async function exists(path) {
  try {
    await access(path, FS_CONSTANTS.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
async function readTextSafe(path, maxBytes) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const buffer = await readFile(path);
    if (buffer.byteLength > maxBytes) return buffer.subarray(0, maxBytes).toString('utf8');
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}
function slugify(value) {
  const text = String(value || '').trim().toLowerCase();
  const ascii = text.replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '');
  if (ascii) return ascii;
  // 中文/非 ASCII 目录名：用短哈希生成稳定且可区分的 id（标题仍保留中文）。
  return 'mc-' + sha256(String(value || 'project')).slice('sha256:'.length).slice(0, 8);
}
function firstLine(text, max) {
  if (typeof text !== 'string') return '';
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0]?.slice(0, max || 80) || '';
}
function titleFromDir(dir) {
  const name = basename(dir);
  return name && name !== '.' && name !== sep ? name : '未命名模型';
}

const VALID_ROUTES = new Set(['three', 'svg', 'dom', 'image']);

/**
 * 检查 `.modelcheck` 的真实初始化状态。
 *
 * 只看目录是否存在不够：空目录、0 字节文件、只写了一半（只有 config 没有 components）、
 * 或 JSON 损坏，都不能算“已初始化”。状态：
 *   none    没有 .modelcheck 目录
 *   empty   目录存在但没有任何文件（含只有 reports/ artifacts/ 子目录）
 *   partial 有文件但 config.json 或 components.json 缺失/无效
 *   ready   两个文件都在且结构有效（contract 可以尚未建立，由用户确认后再有）
 */
export async function inspectModelcheck(rootOrProjectDir) {
  const root = resolve(rootOrProjectDir);
  const dir = join(root, '.modelcheck');
  const base = {
    dir,
    dirExists: false,
    state: 'none',
    empty: false,
    files: [],
    configValid: false,
    componentsValid: false,
    componentsCount: 0,
    contractStatus: null,
    missing: ['config.json', 'components.json'],
    issues: []
  };
  if (!(await isDir(dir))) return base;

  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  const empty = files.length === 0;

  // config.json：能解析、有 projectId、有合法 route 与 preview.entry 才算有效。
  let configValid = false;
  const configText = await readTextSafe(join(dir, 'config.json'), MAX_ENTRY_BYTES);
  if (configText !== null && configText.trim() !== '') {
    try {
      const raw = JSON.parse(configText);
      const hasProject = raw && typeof raw === 'object' && typeof raw.projectId === 'string' && raw.projectId.trim() !== '';
      const routeOk = raw && VALID_ROUTES.has(raw.route);
      const entryOk = raw && raw.preview && typeof raw.preview.entry === 'string' && raw.preview.entry.trim() !== '';
      configValid = Boolean(hasProject && routeOk && entryOk);
      if (!configValid) base.issues.push('config.json 缺少 projectId / 合法 route / preview.entry');
    } catch {
      base.issues.push('config.json 不是合法 JSON');
    }
  } else if (configText !== null) {
    base.issues.push('config.json 是空文件');
  }

  // components.json：必须能解析且 components 是数组（空数组也算结构有效）。
  let componentsValid = false;
  let componentsCount = 0;
  const componentsText = await readTextSafe(join(dir, 'components.json'), MAX_ENTRY_BYTES);
  if (componentsText !== null && componentsText.trim() !== '') {
    try {
      const raw = JSON.parse(componentsText);
      componentsValid = Array.isArray(raw && raw.components);
      componentsCount = componentsValid ? raw.components.length : 0;
      if (!componentsValid) base.issues.push('components.json 缺少 components 数组');
    } catch {
      base.issues.push('components.json 不是合法 JSON');
    }
  } else if (componentsText !== null) {
    base.issues.push('components.json 是空文件');
  }

  let contractStatus = null;
  const contractText = await readTextSafe(join(dir, 'contract.json'), 2 * 1024 * 1024);
  if (contractText !== null && contractText.trim() !== '') {
    try {
      contractStatus = JSON.parse(contractText).status ?? null;
    } catch {
      contractStatus = 'invalid';
      base.issues.push('contract.json 不是合法 JSON');
    }
  }

  const missing = [];
  if (!configValid) missing.push('config.json');
  if (!componentsValid) missing.push('components.json');
  const state = empty ? 'empty' : (!configValid || !componentsValid ? 'partial' : 'ready');

  return {
    ...base,
    dirExists: true,
    state,
    empty,
    files,
    configValid,
    componentsValid,
    componentsCount,
    contractStatus,
    missing
  };
}

/** 判断一个目录是否像"可建模的网页项目"。 */
export async function isProjectDir(dir) {
  if (!(await isDir(dir))) return false;
  if (await exists(join(dir, MARKER_PACKAGE))) return true;
  if (await exists(join(dir, 'index.html'))) return true;
  if (await exists(join(dir, 'dist', 'index.html'))) return true;
  if (await exists(join(dir, 'src', 'index.html'))) return true;
  // 老项目形态：单文件构建在根目录、入口名不是 index.html（如 三圈环流模型.html）。
  // 注意：只认根目录 html，不能因为子目录里恰好有 index.html 就把父目录当成项目。
  const rootEntries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (rootEntries.some((entry) => entry.isFile() && /\.html?$/i.test(entry.name))) return true;
  return false;
}

/**
 * 扫描会话工作区，列出候选模型项目。
 * @param {string} startDir 会话工作目录（绝对路径）
 * @param {{maxDepth?:number}} [options]
 */
export async function discoverCandidates(startDir, options = {}) {
  const start = resolve(startDir);
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 2, 0), 3);
  const visited = [];
  const candidates = [];

  async function summarize(dir) {
    const scan = await scanProject(dir);
    const mc = await inspectModelcheck(dir);
    const entry = scan.previewEntry || '';
    let score = 0;
    if (entry.startsWith('dist/')) score += 4;
    else if (entry.startsWith('src/')) score += 2;
    else if (entry) score += 3;
    if (await exists(join(dir, MARKER_PACKAGE))) score += 1;
    if (scan.route === 'three') score += 3;
    else if (scan.route === 'svg' || scan.route === 'dom') score += 2;
    if (scan.components.length > 0) score += 2;
    if (mc.state === 'ready') score += 5;
    else if (mc.state === 'partial') score += 2;
    return {
      root: dir,
      relativeRoot: relPosix(start, dir) || '.',
      name: basename(dir),
      title: scan.title,
      route: scan.route,
      previewEntry: scan.previewEntry,
      sourcesCount: scan.sources.length,
      buildOutputs: scan.buildOutputs,
      componentsCount: scan.components.length,
      // 只看目录/单文件存在不够：空目录、半成品、坏 JSON 都不算已初始化。
      modelcheck: {
        state: mc.state,
        dirExists: mc.dirExists,
        empty: mc.empty,
        files: mc.files,
        missing: mc.missing,
        componentsCount: mc.componentsCount,
        contractStatus: mc.contractStatus,
        issues: mc.issues
      },
      hasModelcheck: mc.state === 'ready',
      needsInit: mc.state !== 'ready',
      warnings: scan.warnings,
      score
    };
  }

  async function visit(dir, depth) {
    if (visited.length >= MAX_VISIT_DIRS) return;
    if (!(await isDir(dir))) return;
    if (depth > 0 && SKIP_DIRS.has(basename(dir).toLowerCase())) return;
    visited.push(dir);
    if (await isProjectDir(dir)) {
      candidates.push(await summarize(dir));
      // 项目内部一般不再嵌套模型项目；继续向下会扫到 assets/node_modules 噪声。
      return;
    }
    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      if (entry.name.startsWith('.')) continue;
      await visit(join(dir, entry.name), depth + 1);
    }
  }

  await visit(start, 0);
  candidates.sort((a, b) => b.score - a.score || a.relativeRoot.localeCompare(b.relativeRoot));
  return { startDir: start, candidates, scannedDirs: visited.length };
}

/** 探测单个模型项目的配置素材（只读）。 */
export async function scanProject(dir) {
  const root = resolve(dir);
  const warnings = [];
  let title = titleFromDir(root);
  let packageName = null;

  const packageRaw = await readTextSafe(join(root, MARKER_PACKAGE), 256 * 1024);
  if (packageRaw) {
    try {
      const pkg = JSON.parse(packageRaw);
      packageName = typeof pkg.name === 'string' ? pkg.name : null;
      if (typeof pkg.description === 'string' && pkg.description.trim()) title = pkg.description.trim().slice(0, 80);
      else if (packageName) title = packageName;
    } catch {
      warnings.push('package.json 解析失败，标题与项目 id 使用目录名');
    }
  }

  let previewEntry = null;
  for (const candidate of ENTRY_CANDIDATES) {
    if (await exists(join(root, candidate))) {
      previewEntry = candidate;
      break;
    }
  }
  if (!previewEntry) {
    // 回退：老项目常见“单文件构建在根目录、名字不是 index.html”（如 三圈环流教学模型.html），
    // 或入口在 build/ 之类的一级目录里。找到后仍要求用户/agent 确认。
    const fallback = await findFallbackEntry(root);
    if (fallback) {
      previewEntry = fallback;
      warnings.push('未找到 index.html / dist/index.html / src/index.html，回退探测到入口 ' + fallback + '（请确认 preview.entry）');
    }
  }
  if (!previewEntry) {
    const blend = (await readdir(root).catch(() => [])).find((name) => extname(name).toLowerCase() === '.blend');
    if (blend) {
      warnings.push('目录里只有 .blend 文件：Blender 路线一期不支持，不能生成可预览的 ModelCheck 项目');
    } else {
      warnings.push('没有找到 index.html / dist/index.html / src/index.html，预览入口需要手工指定');
    }
  }

  let route = 'dom';
  if (previewEntry) {
    const entryText = await readTextSafe(join(root, previewEntry), MAX_ENTRY_BYTES);
    if (entryText) {
      if (/WebGLRenderer|\bTHREE\s*\.|from\s+["']three["']|three(?:\.module)?(?:\.min)?\.js/i.test(entryText)) route = 'three';
      else if (/<svg[\s>]/i.test(entryText)) route = 'svg';
      else if (/<canvas[\s>]/i.test(entryText)) route = 'dom';
      else if (/<img[\s>]/i.test(entryText)) route = 'image';
    } else {
      warnings.push('预览入口读取失败，技术路线按 dom 处理，需要人工确认');
    }
  }

  const sources = await collectSources(root, previewEntry);
  const buildOutputs = await collectBuildOutputs(root);
  const docs = await collectDocs(root);
  const components = await collectComponentCandidates(root, sources, route, previewEntry);
  // 交付版与校验版分离：校验版通常由 __VERIFY__ 构建产出，含 __MC_PREVIEW__ 钩子。
  const verifyEntry = await findVerifyEntry(root, previewEntry);
  if (route === 'three' && !verifyEntry) {
    warnings.push('未发现校验版入口（含 __MC_PREVIEW__ 的构建）：运行时取证需要它；可让构建输出 tools/verify-build.html 后设置 preview.verifyEntry');
  }

  if (components.length === 0) {
    warnings.push('没有从源码里识别出组件候选：请让 agent 用 modelcheck_components 依据渲染结构登记，或在页面加 data-mc-id');
  }
  if (/blend/i.test(route)) warnings.push('Blender 路线一期不支持');

  return {
    schemaVersion: SCAFFOLD_VERSION,
    root,
    projectId: slugify(packageName || basename(root)),
    title,
    route,
    previewEntry,
    deliveryEntry: previewEntry,
    verifyEntry,
    sources,
    buildOutputs,
    docs,
    components,
    // 初始化状态按文件内容判断：空目录/半成品/坏 JSON 都不算 ready。
    modelcheck: await inspectModelcheck(root),
    warnings,
    notes: [
      '组件候选来自源码静态扫描，中文标签需要 agent 用 modelcheck_components 补全；没有 data-mc-id 的模型请在渲染对象上设置稳定名称',
      '契约判据不从扫描结果生成：请依据项目《科学性文档》《开发文档》用 modelcheck_contract 提议，并由用户在面板确认',
      'sources 用于源码哈希，buildOutputs 用于构建哈希；不确定时保守多列，不要漏'
    ]
  };
}

async function collectSources(root, previewEntry) {
  const files = [];
  async function walk(dir, depth) {
    if (files.length >= MAX_SOURCE_FILES) return;
    if (!(await isDir(dir))) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        if (depth >= 4) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!SOURCE_EXT.has(ext)) continue;
      const rel = relPosix(root, full);
      // 预览入口单独由 preview.entry 表达；这里仍纳入 sources，保证构建内容变化会触发失效。
      files.push(rel);
    }
  }
  if (previewEntry && !previewEntry.startsWith('dist/')) files.push(previewEntry);
  await walk(join(root, 'src'), 0);
  // 有些老项目把源码放在 `模型源码/`、`js/`、`source/` 之类的一级目录里；扫描它们（构建脚本目录除外）。
  const ignoredTopDirs = new Set(['tools', 'scripts', 'build', 'dist', 'node_modules']);
  const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (files.length >= MAX_SOURCE_FILES) break;
    if (!entry.isDirectory()) continue;
    if (ignoredTopDirs.has(entry.name.toLowerCase()) || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
    if (entry.name.startsWith('.')) continue;
    await walk(join(root, entry.name), 0);
  }
  for (const entry of rootEntries) {
    if (files.length >= MAX_SOURCE_FILES) break;
    if (!entry.isFile()) continue;
    if (SOURCE_EXT.has(extname(entry.name).toLowerCase())) files.push(entry.name);
  }
  return [...new Set(files)].filter((file, index) => index < MAX_SOURCE_FILES).sort();
}

/** 标准入口不存在时的回退探测：根目录单页 HTML → 一级子目录 index.html。 */
async function findFallbackEntry(root) {
  const rootEntries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const rootHtml = rootEntries
    .filter((entry) => entry.isFile() && /\.html?$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (rootHtml.length > 0) return rootHtml[0];
  const dirs = rootEntries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !SKIP_DIRS.has(entry.name.toLowerCase()) && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    if (await exists(join(root, dir, 'index.html'))) return dir + '/index.html';
  }
  return null;
}

/** 探测校验版入口（含 __MC_PREVIEW__ 的构建，用于面板取证）。 */
const VERIFY_ENTRY_CANDIDATES = [
  'tools/verify-build.html',
  'verify-build.html',
  'dist/verify-build.html',
  'dist/verify/index.html',
  'verify.html'
];
async function findVerifyEntry(root, previewEntry) {
  for (const candidate of VERIFY_ENTRY_CANDIDATES) {
    if (candidate === previewEntry) continue;
    if (await exists(join(root, candidate))) {
      const text = await readTextSafe(join(root, candidate), MAX_ENTRY_BYTES);
      // 只有真的包含钩子才认为是校验版；否则交给 readiness 报“缺钩子”。
      if (text && text.includes('__MC_PREVIEW__')) return candidate;
      if (text) return candidate;
    }
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.html?$/i.test(entry.name)) continue;
    if (entry.name === previewEntry) continue;
    if (!/verify/i.test(entry.name)) continue;
    return entry.name;
  }
  return null;
}

async function collectBuildOutputs(root) {  const outputs = [];
  const dist = join(root, 'dist');
  if (!(await isDir(dist))) return outputs;
  let entries;
  try {
    entries = await readdir(dist, { withFileTypes: true });
  } catch {
    return outputs;
  }
  for (const entry of entries) {
    if (outputs.length >= MAX_OUTPUT_FILES) break;
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!['.html', '.js', '.mjs', '.css'].includes(ext)) continue;
    outputs.push('dist/' + entry.name);
  }
  return outputs.sort();
}

async function collectDocs(root) {
  const docs = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (docs.length >= MAX_DOCS) break;
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;
    docs.push(entry.name);
  }
  const docsDir = join(root, 'docs');
  if (await isDir(docsDir)) {
    const nested = await readdir(docsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of nested) {
      if (docs.length >= MAX_DOCS) break;
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') docs.push('docs/' + entry.name);
    }
  }
  return [...new Set(docs)].sort();
}

function observablesFor(route) {
  if (route === 'three') {
    return [
      { name: 'position', unit: 'world' },
      { name: 'direction', unit: 'deg' },
      { name: 'visible', unit: 'bool' }
    ];
  }
  if (route === 'svg' || route === 'dom') {
    return [
      { name: 'endpoint', unit: 'world' },
      { name: 'direction', unit: 'deg' },
      { name: 'visible', unit: 'bool' }
    ];
  }
  return [{ name: 'visible', unit: 'bool' }];
}

async function collectComponentCandidates(root, sources, route, previewEntry) {
  const found = [];
  const seen = new Set();
  for (const rel of sources.slice(0, MAX_SOURCE_FILES)) {
    const ext = extname(rel).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.html', '.htm'].includes(ext)) continue;
    const text = await readTextSafe(join(root, rel), MAX_ENTRY_BYTES);
    if (!text) continue;
    const lines = text.split(/\r?\n/);
    function pushCandidate(kind, id, lineNumber, rawLine) {
      if (found.length >= MAX_COMPONENTS) return;
      const value = String(id || '').trim();
      if (!value || value.length < 2 || seen.has(value)) return;
      if (/^(true|false|null|undefined|function|object|string|number|boolean|default|main|this)$/i.test(value)) return;
      if (GENERIC_NAMES.has(value.toLowerCase())) return;
      seen.add(value);
      const pick = kind === 'data-mc-id' ? `[data-mc-id="${value}"]`
        : kind === 'data-role' ? `[data-role="${value}"]`
          : value;
      const labelMatch = rawLine && rawLine.match(/data-mc-label\s*=\s*["']([^"']{1,60})["']/);
      found.push({
        id: value,
        label: labelMatch ? labelMatch[1] : value,
        route,
        locator: { file: rel, symbol: value, line: lineNumber },
        pick,
        related: [],
        observables: observablesFor(route),
        sharedDependencies: [],
        candidateKind: kind
      });
    }
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const match of line.matchAll(ID_ATTR_RE)) pushCandidate(line.includes('data-mc-id') ? 'data-mc-id' : 'data-role', match[1], index + 1, line);
      for (const match of line.matchAll(USER_DATA_RE)) pushCandidate('userData.mcId', match[1], index + 1, line);
      if (ext !== '.html' && ext !== '.htm') {
        for (const match of line.matchAll(NAME_ASSIGN_RE)) pushCandidate('name-assignment', match[1], index + 1, line);
        for (const match of line.matchAll(NAME_PROP_RE)) pushCandidate('name-property', match[1], index + 1, line);
      }
    }
  }
  // 构建产物里也可能显式带 data-mc-id（源码模板之外）；只认 data 属性，避免把打包库里的 name 当组件。
  if (previewEntry && /\.html?$/i.test(previewEntry) && found.length < MAX_COMPONENTS) {
    const entryText = await readTextSafe(join(root, previewEntry), MAX_ENTRY_BYTES);
    if (entryText) {
      const lines = entryText.split(/\r?\n/);
      for (let index = 0; index < lines.length && found.length < MAX_COMPONENTS; index += 1) {
        for (const match of lines[index].matchAll(ID_ATTR_RE)) {
          const value = match[1];
          if (seen.has(value) || GENERIC_NAMES.has(value.toLowerCase())) continue;
          seen.add(value);
          found.push({
            id: value,
            label: value,
            route,
            locator: { file: previewEntry, symbol: value, line: index + 1 },
            pick: lines[index].includes('data-mc-id') ? `[data-mc-id="${value}"]` : `[data-role="${value}"]`,
            related: [],
            observables: observablesFor(route),
            sharedDependencies: [],
            candidateKind: 'built-html'
          });
        }
      }
    }
  }
  return found;
}

/** 由扫描结果生成 config.json（纯函数，测试可直接断言）。 */
export function buildConfig(scan, overrides = {}) {
  const previewEntry = overrides.previewEntry || scan.previewEntry || 'index.html';
  const route = overrides.route || scan.route || 'dom';
  const unitToPx = Number.isFinite(overrides.unitToPx)
    ? Number(overrides.unitToPx)
    : (route === 'three' ? 1 : 1);
  return {
    schemaVersion: 1,
    projectId: overrides.projectId || scan.projectId,
    title: overrides.title || scan.title,
    route,
    preview: {
      entry: previewEntry,
      deliveryEntry: overrides.deliveryEntry || scan.deliveryEntry || previewEntry,
      verifyEntry: overrides.verifyEntry || scan.verifyEntry || null,
      viewport: { width: 1280, height: 720 },
      unitToPx,
      injectBridge: true
    },
    build: {
      entry: previewEntry,
      outputs: Array.isArray(overrides.buildOutputs) ? overrides.buildOutputs : scan.buildOutputs.slice()
    },
    sources: Array.isArray(overrides.sources) ? overrides.sources.slice() : scan.sources.slice(),
    budget: {
      maxRounds: { science: 3, dev: 3, prototype: 5, production: 8, delivery: 3 },
      maxMinutes: 120,
      stagnantRounds: 3
    }
  };
}

/** 由扫描结果生成 components.json（纯函数）。 */
export function buildComponents(scan, overrides = {}) {
  const components = Array.isArray(overrides.components) ? overrides.components : scan.components;
  return {
    schemaVersion: 1,
    components: components.map((item) => ({
      id: item.id,
      label: item.label || item.id,
      // kind 是启发式候选，agent 需要复核；用于界面分组与自检。
      kind: item.kind || kindOfCandidate(item),
      route: item.route || scan.route,
      locator: item.locator || { file: scan.previewEntry || 'index.html', symbol: item.id, line: 1 },
      pick: item.pick || item.id,
      related: Array.isArray(item.related) ? item.related : [],
      observables: Array.isArray(item.observables) ? item.observables : observablesFor(scan.route),
      sharedDependencies: Array.isArray(item.sharedDependencies) ? item.sharedDependencies : []
    }))
  };
}

/** 组件类型启发式：只用于初始分组，agent 必须复核。 */
function kindOfCandidate(item) {
  const id = String((item && item.id) || '');
  if (/环流|圈/.test(id)) return 'cell';
  if (/带|风/.test(id)) return 'belt';
  if (/地球|地轴|经纬|grid|axis|earth/i.test(id)) return 'structure';
  if (/区域|region/i.test(id)) return 'region';
  return 'other';
}

/**
 * 写入脚手架。已有 config/components 时默认不覆盖。
 * @returns {Promise<{root:string, scan:object, config:object, components:object, written:string[], skipped:string[], nextSteps:string[]}>}
 */
export async function applyScaffold(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  if (!(await isDir(root))) throw new ScaffoldError('not-a-directory', '目标不是目录：' + root);
  const before = await inspectModelcheck(root);
  const scan = await scanProject(root);
  const store = new Store(root);
  await store.ensureLayout();

  const force = options.force === true;
  const config = buildConfig(scan, options.overrides || {});
  const components = buildComponents(scan, options.overrides || {});
  const written = [];
  const skipped = [];

  // 已有效的不覆盖；缺失、空文件或坏 JSON 一律补齐（否则“空 .modelcheck”会永远停在半初始化）。
  const writeConfig = force || !before.configValid;
  const writeComponents = force || !before.componentsValid;
  if (!writeConfig) {
    skipped.push('config.json（已存在且有效，未覆盖）');
  } else {
    await store.writeJson(store.paths.config, config);
    written.push('config.json');
  }
  if (!writeComponents) {
    skipped.push('components.json（已存在且有效，未覆盖）');
  } else {
    await store.writeJson(store.paths.components, components);
    written.push('components.json');
  }

  const after = await inspectModelcheck(root);
  const notes = [];
  if (before.state === 'empty') notes.push('检测到空 .modelcheck 目录（没有任何文件），已按初始化处理');
  if (before.state === 'partial') notes.push('检测到部分初始化（' + before.missing.join('、') + ' 缺失或无效），已补齐');
  if (before.state === 'ready' && written.length === 0) notes.push('项目此前已完整初始化，本次未改写任何文件');

  const nextSteps = [
    '用 modelcheck_components 复核组件候选并补中文 label / 代码位置（扫描只是候选）',
    '把项目《科学性文档》《开发文档》中的可判定陈述整理成判据：modelcheck_contract action=scaffold，然后由用户在面板确认',
    '判据确认后运行 modelcheck_verify；几何判据需要打开「建模判定」面板的「标注」页签取得运行时证据',
    '全部阻塞项 pass 后调用 modelcheck_complete 申请认证'
  ];
  return {
    root,
    before,
    after,
    state: after.state,
    scan,
    config,
    components,
    written,
    skipped,
    notes,
    nextSteps,
    scaffoldVersion: SCAFFOLD_VERSION,
    at: nowIso()
  };
}

/**
 * 由轻量 criteria 列表生成契约草稿（不写盘、不确认）。
 * spec: { contractVersion?, sourceDocs?: string[], criteria: [{ id?, claim, level?, blocking?, method?, acceptance?,
 *         rule, component?, depends?, context?, requiredEvidence?, source? }] }
 */
export async function buildContractDraft(spec, scan) {
  if (!spec || !Array.isArray(spec.criteria) || spec.criteria.length === 0) {
    throw new ScaffoldError('contract/empty', 'scaffold 至少需要一条 criteria');
  }
  const criteria = spec.criteria.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ScaffoldError('contract/criterion', '第 ' + (index + 1) + ' 条判据不是对象');
    const rule = item.rule;
    if (!rule || typeof rule !== 'object') throw new ScaffoldError('contract/rule', '判据 ' + (item.id || index + 1) + ' 缺少 rule');
    const depends = Array.isArray(item.depends)
      ? item.depends.slice()
      : (typeof rule.file === 'string' ? [rule.file] : []);
    return {
      id: item.id || ('USR-' + String(index + 1).padStart(2, '0')),
      level: item.level || 'P1',
      blocking: item.blocking !== undefined ? item.blocking : (item.level || 'P1') !== 'P2',
      claim: item.claim,
      method: item.method || 'auto',
      rule,
      component: item.component || (rule.component || rule.from || null),
      depends,
      status: 'unverified',
      evidence: null,
      acceptance: item.acceptance || 'auto',
      requiredEvidence: item.requiredEvidence || (rule.kind === 'text' || rule.kind === 'hash' ? 'config' : 'runtime'),
      context: item.context || {},
      source: item.source || { doc: 'TODO：从项目科学性/开发文档补来源条款', section: '' }
    };
  });
  const requestedDocs = Array.isArray(spec.sourceDocs) && spec.sourceDocs.length > 0
    ? spec.sourceDocs
    : (scan && scan.docs ? scan.docs.slice(0, 5) : []);
  // 来源文档必须有真实内容哈希（契约校验要求 sha256:…）；读不到的文件不进 source，由 agent 补。
  const source = [];
  if (scan && scan.root) {
    for (const doc of requestedDocs) {
      const text = await readTextSafe(join(scan.root, doc), MAX_ENTRY_BYTES);
      if (text === null) continue;
      source.push({ doc, section: 'TODO：标明条款与内容哈希来源', hash: sha256(text) });
    }
  }
  const draft = {
    schemaVersion: 1,
    contractVersion: spec.contractVersion || '0.1.0',
    status: 'proposed',
    source,
    criteria
  };
  const normalized = normalizeContract(draft);
  const check = validateContract(normalized);
  if (!check.ok) {
    throw new ScaffoldError('contract/invalid', '契约草稿校验失败', check.errors);
  }
  normalized.status = 'proposed';
  normalized.contentHash = contractContentHash(normalized);
  return normalized;
}

/** 写入契约草稿（contract.proposed.json），并返回写入后的对象。 */
export async function writeContractDraft(store, draft) {
  await store.ensureLayout();
  await store.writeJson(store.paths.contractProposed, draft);
  return draft;
}
