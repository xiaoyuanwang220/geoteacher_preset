#!/usr/bin/env node
/**
 * geo-verify.mjs — 地理教师 Agent 确定性检查程序
 *
 * 用法：node scripts/geo-verify.mjs [--source] [--runtime] [--skip-runtime] [--json]
 * 退出码：0=通过  1=失败  2=用法错误  3=运行时冒烟不可达
 *
 * ── rc.2 适配（M0）────────────────────────────────────────────
 * 1. 预设的实时组合文件是 `.agent-presets/geo-teacher/cordis.patch.yml`（声明行形态）。
 *    旧 `$DSH_HOME/.agent-presets/<id>/{preset.yml,agent.cordis.yml}` 已退役：本脚本不再读取，
 *    也不再要求存在 C: 运行时副本。本机部署是 profile 中的 `link:` 依赖，但**不要求**其他安装
 *    也使用 link——部署形态只输出提示，不作为源码失败项。
 * 2. `cordis.patch.yml` 含 `!!js` 表达式，**不作为普通 YAML 求值**。本脚本只做结构扫描
 *    （兼容解析）：读取声明行、插件行、isolate 映射与 tool-web 配置，不执行任何表达式。
 *    静态检查边界：不验证 `!!js` 语义、不验证 Loader 实际挂载结果——后者属于重启后的运行时验收。
 *    为避免把 `!!js` 行当普通 YAML 解析而误报，本脚本不引入 YAML 解析依赖。
 * 3. 插件语法检查使用当前解释器（process.execPath），不依赖 PATH 中存在 `node`。
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 路径（环境计算，不写死用户名） ────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PRESET_SRC = join(PROJECT_ROOT, '.agent-presets', 'geo-teacher');
const PATCH_FILE = join(PRESET_SRC, 'cordis.patch.yml');
const PKG_FILE = join(PRESET_SRC, 'package.json');
const SKILLS_DIR = join(PRESET_SRC, 'skills');
const PRESET_PKG_NAME = '@geo-edu/dsh-geo-teacher-preset';
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
// 桌面 Host 默认端口参数 19387（DSH Desktop rc.2）；可用 DSH_WEB_URL 覆盖。
const DSH_WEB = process.env.DSH_WEB_URL || 'http://127.0.0.1:19387';

// ── 参数解析 ─────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  source: args.includes('--source'),
  runtime: args.includes('--runtime'),
  skipRuntime: args.includes('--skip-runtime'),
  json: args.includes('--json'),
};
// 默认：source +（非 skip-runtime 时尝试 runtime）
if (!flags.source && !flags.runtime && !flags.skipRuntime) {
  flags.source = true;
  flags.runtime = true;
}
if (flags.skipRuntime) {
  flags.runtime = false;
  if (!flags.source) flags.source = true;
}
// 未知参数检查
const known = ['--source', '--runtime', '--skip-runtime', '--json'];
for (const a of args) {
  if (!known.includes(a)) {
    console.error(`未知参数: ${a}`);
    console.error('用法: node scripts/geo-verify.mjs [--source] [--runtime] [--skip-runtime] [--json]');
    process.exit(2);
  }
}

// ── 工具函数 ─────────────────────────────────────────────────
function basename(p) { return p.split(/[\\/]/).pop(); }

function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walkFiles(p, out); }
    else out.push(p);
  }
  return out;
}

function globPattern(base, pattern) {
  // 简单 glob：plugins/*/index.js
  const results = [];
  if (!existsSync(base)) return results;
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = join(base, e.name);
    for (const f of readdirSync(sub, { withFileTypes: true })) {
      if (!f.isDirectory() && f.name === pattern) results.push(join(sub, f.name));
    }
  }
  return results;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// ── cordis.patch.yml 结构扫描（兼容解析，不求值 !!js） ───────
function parsePatchStructure(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const skip = (t) => t === '' || t.startsWith('#');
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const ROW_RE = /^(\s*)-\s+id:\s*([A-Za-z0-9._-]+)\s*$/;
  const NAME_RE = /^\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/;

  // 所有插件行：`- id: X` 之后同级或更深的第一个 `name:`
  const pluginRows = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip(lines[i].trim())) continue;
    const m = lines[i].match(ROW_RE);
    if (!m) continue;
    const indent = m[1].length;
    let name = null;
    for (let j = i + 1; j < lines.length; j++) {
      if (skip(lines[j].trim())) continue;
      if (indentOf(lines[j]) <= indent) break;
      const nm = lines[j].match(NAME_RE);
      if (nm) { name = nm[1]; break; }
    }
    pluginRows.push({ id: m[2], name, indent });
  }

  // 声明行：name 为 @deepseek-ai/dsh-agent-preset 的那一行
  let declaration = null;
  const decl = pluginRows.find(r => r.name === '@deepseek-ai/dsh-agent-preset');
  if (decl) {
    let configIndent = null;
    let configId = null;
    let pluginListIndent = null;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ROW_RE);
      if (!m || m[2] !== decl.id) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (skip(l.trim())) continue;
        const ind = indentOf(l);
        if (ind <= decl.indent) break;
        if (configIndent === null) {
          if (/^\s*config:\s*$/.test(l)) configIndent = ind;
          continue;
        }
        if (pluginListIndent === null && /^\s*plugins:\s*$/.test(l) && ind > configIndent) {
          pluginListIndent = ind;
          continue;
        }
        if (configId === null && ind > configIndent) {
          const cm = l.match(/^\s*id:\s*([A-Za-z0-9._-]+)\s*$/);
          if (cm) configId = cm[1];
        }
      }
      break;
    }
    const nested = pluginRows.filter(r => r.indent > decl.indent);
    declaration = {
      rowId: decl.id,
      configId,
      hasPluginsKey: pluginListIndent !== null,
      pluginCount: nested.length,
      rowsWithoutName: nested.filter(r => !r.name).map(r => r.id),
    };
  }

  // isolate 映射：每个 `isolate:` 块及其键，并回溯所属行
  const isolateMaps = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)isolate:\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    const keys = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (skip(lines[j].trim())) continue;
      if (indentOf(lines[j]) <= indent) break;
      const km = lines[j].match(/^\s*([A-Za-z0-9_.-]+):\s*(?:true|false)\s*$/);
      if (km) keys.push(km[1]);
    }
    let owner = null;
    for (let k = i - 1; k >= 0; k--) {
      const om = lines[k].match(ROW_RE);
      if (om && om[1].length < indent) { owner = om[2]; break; }
    }
    isolateMaps.push({ id: owner, keys });
  }

  // tool-web 的 fetch 开关（用于证据渠道报告）
  let toolWebFetch = null;
  const tw = pluginRows.find(r => r.id === 'tool-web');
  if (tw) {
    for (let i = 0; i < lines.length; i++) {
      if (!ROW_RE.test(lines[i]) || !lines[i].includes(`id: ${tw.id}`)) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (skip(lines[j].trim())) continue;
        if (indentOf(lines[j]) <= tw.indent) break;
        const fm = lines[j].match(/^\s*fetch:\s*(true|false)\s*$/);
        if (fm) { toolWebFetch = fm[1] === 'true'; break; }
      }
      break;
    }
  }

  return {
    hasJsExpressions: /!!js\b/.test(raw),
    pluginRows,
    declaration,
    isolateMaps,
    toolWebFetch,
  };
}

// ── 检查项 ───────────────────────────────────────────────────
const results = [];

function add(id, name, ok, detail = '') {
  results.push({ id, name, ok: !!ok, detail: String(detail) });
  if (!flags.json) {
    const mark = ok ? '✅' : '❌';
    console.log(`  ${mark}  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function addWarn(id, name, detail) {
  results.push({ id, name, ok: true, warn: true, detail: String(detail) });
  if (!flags.json) console.log(`  ⚠️  ${name} — ${detail}`);
}

// ── 1. 插件语法 ─────────────────────────────────────────────
async function checkSyntax() {
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  if (files.length === 0) { add('syntax', '插件语法', false, '未发现任何 plugins/*/index.js'); return; }
  let allOk = true;
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'ignore', timeout: 15000 });
    } catch (e) {
      add('syntax', `语法: ${basename(dirname(f))}/index.js`, false, (e && e.message) || 'node --check 失败');
      allOk = false;
    }
  }
  if (allOk) add('syntax', '插件语法 (node --check)', true, `${files.length} 个插件`);
}

// ── 2. 插件 ESM 导入 ────────────────────────────────────────
async function checkImport() {
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  let allOk = true;
  for (const f of files) {
    try {
      await import(pathToFileURL(f).href);
    } catch (e) {
      add('import', `ESM 导入: ${basename(dirname(f))}/index.js`, false, e.message);
      allOk = false;
    }
  }
  if (allOk) add('import', '插件 ESM 导入', true, `${files.length} 个插件`);
}

// ── 3. 插件 apply 冒烟 ─────────────────────────────────────
async function checkApply() {
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  const registered = [];
  const provided = [];
  const ctx = {
    fs: {
      resolve: async (p) => ({ path: p }),
      readText: async () => '',
      writeText: async () => {},
      readBytes: async () => { throw new Error('mock'); },
      listDir: async () => [],
      stat: async () => ({ isDirectory: () => false }),
      processPath: (t) => (t && t.path) || String(t),
    },
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 8,
        maxMessageImageBytes: 20 * 1024 * 1024,
      },
      saveImage: async () => ({ attachmentId: 'sha256:mock', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }),
    },
    tools: { register(def) { registered.push(def && def.name); return () => {}; } },
    webServer: { register() {}, registerUpgrade() {}, registerFallback() {}, tapIndex() { return () => {}; } },
    geoKernel: {},
    get() { return undefined; },
    provide(name) { provided.push(name); },
    on() { return () => {}; },
    effect(cb) { try { return cb(); } catch {} },
  };
  let allOk = true;
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(f).href);
      const plugin = mod.default;
      if (!plugin || typeof plugin.apply !== 'function') {
        add('apply', `apply 冒烟: ${basename(dirname(f))}/index.js`, false, '无 default.apply');
        allOk = false; continue;
      }
      const cfg = {};
      if (f.includes(`${join('plugins', 'core')}`) || f.includes('plugins/core/')) {
        // 合成路径：apply 冒烟只验证"不抛错"，不依赖任何真实数据目录，也不得引用作者机器路径。
        cfg.knowledgeBasePath = join(tmpdir(), 'geo-verify', 'knowledge');
        cfg.questionBankPath = join(tmpdir(), 'geo-verify', 'bank');
        cfg.outputPath = join(tmpdir(), 'geo-verify', 'outputs');
        cfg.workspaceRoot = join(tmpdir(), 'geo-verify');
      }
      plugin.apply(ctx, cfg);
    } catch (e) {
      add('apply', `apply 冒烟: ${basename(dirname(f))}/index.js`, false, (e && e.message) || String(e));
      allOk = false;
    }
  }
  if (allOk) add('apply', '插件 apply 冒烟 (mock ctx)', true,
    `${files.length} 个插件，注册 ${registered.length} 工具，提供 ${provided.length} 服务`);
}

// ── 4. 预设包导出与 bundle 接线 ─────────────────────────────
function checkPackageWiring(view) {
  if (!existsSync(PKG_FILE)) { add('pkg', '预设包 package.json', false, 'package.json 不存在'); return null; }
  const pkg = readJson(PKG_FILE);
  if (!pkg) { add('pkg', '预设包 package.json', false, 'package.json 不是合法 JSON'); return null; }
  add('pkg', '预设包 package.json', true, `${pkg.name || '(无 name)'} v${pkg.version || '?'}`);

  const exportsMap = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports : {};
  // bundle.patch 必须指向存在的文件
  const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (typeof patchRel !== 'string') {
    add('bundle-patch', 'bundle patch 声明', false, 'package.json 缺少 dsh.bundle.patch');
  } else {
    const patchPath = join(PRESET_SRC, patchRel);
    add('bundle-patch', 'bundle patch 声明', existsSync(patchPath), `${patchRel} ${existsSync(patchPath) ? '存在' : '不存在'}`);
  }

  // cordis.patch.yml 引用的每个包子路径都必须在 exports 里，且目标文件存在
  let allOk = true, checked = 0;
  for (const row of view.pluginRows) {
    if (!row.name || !row.name.startsWith(PRESET_PKG_NAME + '/')) continue;
    const sub = './' + row.name.slice(PRESET_PKG_NAME.length + 1);
    checked++;
    const target = exportsMap[sub];
    if (!target) {
      add('exports', `导出缺失: ${sub}`, false, `cordis.patch.yml 行 ${row.id} 引用 ${row.name}，但 package.json exports 无 ${sub}`);
      allOk = false;
    } else if (!existsSync(join(PRESET_SRC, target))) {
      add('exports', `导出目标不存在: ${sub}`, false, `${sub} → ${target} 文件不存在`);
      allOk = false;
    }
  }
  if (allOk) add('exports', '预设包导出覆盖 patch 引用', true, `${checked} 个包子路径引用全部有导出且目标存在`);

  // 技能根由 createRequire(baseUrl).resolve('<包>/package.json') 定位，故 ./package.json 必须可导出
  const hasSelfExport = exportsMap['./package.json'] === './package.json';
  add('exports-self', '导出 ./package.json（技能根解析依据）', hasSelfExport,
    hasSelfExport ? 'skill-filesystem 可经 createRequire 定位本包' : 'package.json exports 缺少 "./package.json"，技能根将无法解析');
  add('skills-dir', 'skills/ 目录存在', existsSync(SKILLS_DIR),
    existsSync(SKILLS_DIR) ? SKILLS_DIR : 'skills/ 不存在，技能根解析后为空');

  // 本地相对插件名是已知的挂载失败模式
  const relRows = view.pluginRows.filter(r => r.name && /^\.\//.test(r.name));
  if (relRows.length > 0) {
    add('exports-relative', '无相对路径插件名', false,
      `发现相对插件名: ${relRows.map(r => `${r.id}(${r.name})`).join(', ')}——声明行 baseUrl 是 profile 目录，会 ERR_MODULE_NOT_FOUND`);
  } else {
    add('exports-relative', '无相对路径插件名', true, '本地插件均经包子路径导出');
  }
  return pkg;
}

// ── 5. cordis.patch.yml 结构（声明行形态） ───────────────────
function checkPatch(view) {
  if (!existsSync(PATCH_FILE)) { add('patch', 'cordis.patch.yml', false, 'cordis.patch.yml 不存在'); return; }
  add('patch', 'cordis.patch.yml 存在', true, `${view.pluginRows.length} 个插件行`);

  const d = view.declaration;
  const declOk = !!(d && d.configId && d.hasPluginsKey && d.pluginCount > 0);
  add('patch-decl', '预设声明行完整', declOk, declOk
    ? `id=${d.configId}, plugins=${d.pluginCount} 行`
    : `声明行缺失或不完整（configId=${d && d.configId}, plugins=${d && d.hasPluginsKey}, count=${d && d.pluginCount}）`);

  const noName = (d && d.rowsWithoutName) || [];
  add('patch-rows', '插件行均有 name', noName.length === 0,
    noName.length === 0 ? '所有插件行都有 name' : `缺 name 的行: ${noName.join(', ')}`);

  if (view.hasJsExpressions) {
    addWarn('patch-js-boundary', 'patch 静态检查边界',
      '含 !!js 表达式，本脚本只做结构扫描、不求值；表达式语义与 Loader 挂载结果须在重启后用运行时验收确认');
  }
  if (view.toolWebFetch !== null) {
    addWarn('web-fetch', 'tool-web 网页读取',
      view.toolWebFetch
        ? 'fetch: true（配置已启用；实际注册 web_fetch 须重启后在预设会话确认）'
        : 'fetch: false（该预设不注册 web_fetch，仅 web_search）');
  }

  // 退役形态回归保护：旧 agent.cordis.yml / preset.yml 不应回到预设包内
  const retired = ['agent.cordis.yml', 'preset.yml'].filter(n => existsSync(join(PRESET_SRC, n)));
  if (retired.length > 0) {
    addWarn('retired-form', '已退役预设形态文件',
      `预设包内仍有 ${retired.join('、')}——rc.2 不读取它们，应归档到 .backups（见 docs/geography-question-generation-m0-baseline.md §3.2）`);
  } else {
    add('retired-form', '已退役预设形态文件已归档', true, '预设包内无 agent.cordis.yml / preset.yml');
  }
}

// ── 6. isolate 白名单 ───────────────────────────────────────
function checkIsolate(view) {
  const allKeys = new Set();
  for (const m of view.isolateMaps) for (const k of m.keys) allKeys.add(k);

  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  const provided = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /ctx\.provide\(\s*['"]([\w.]+)['"]/g;
    let m;
    while ((m = re.exec(src))) provided.add(m[1]);
  }

  let ok = true;
  for (const svc of provided) {
    if (!allKeys.has(svc)) {
      add('isolate', `isolate 白名单: ${svc}`, false, `ctx.provide('${svc}') 但 patch 中没有任何 isolate 声明该服务`);
      ok = false;
    }
  }
  if (provided.size === 0) add('isolate', 'isolate 白名单', true, '无 ctx.provide 调用');
  else if (ok) add('isolate', 'isolate 白名单', true, `${provided.size} 个服务均在 isolate 内（isolate 映射 ${view.isolateMaps.length} 个）`);
}

// ── 7. 路由静态扫描 ─────────────────────────────────────────
function checkRoutes() {
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  const routes = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /webServer\.register\(\s*\{[^}]*kind:\s*['"](\w+)['"][^}]*path:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) routes.push({ kind: m[1], path: m[2], file: basename(dirname(f)) + '/index.js' });
  }
  const seen = new Map();
  let ok = true;
  for (const r of routes) {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) {
      add('routes', `路由重复: ${r.path}`, false, `${r.file} 与 ${seen.get(key)} 冲突`);
      ok = false;
    } else seen.set(key, r.file);
  }
  if (ok) add('routes', '路由静态扫描', true, `${routes.length} 条路由，无源码内重复`);
}

// ── 8. 技能唯一性与结构 ─────────────────────────────────────
function readFrontmatter(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return null;
  const block = m[1];
  const fm = {};
  for (const line of block.split(/\r?\n/)) {
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (km) fm[km[1]] = km[2].trim();
  }
  // description: >- / | 跨行块
  if (!fm.description || /^[>|]-?$/.test(fm.description)) {
    const lines = block.split(/\r?\n/);
    const idx = lines.findIndex(l => /^description:\s*(?:[>|]-?)?\s*$/.test(l));
    if (idx >= 0) {
      const parts = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^\s+\S/.test(lines[i])) parts.push(lines[i].trim());
        else if (lines[i].trim() === '') continue;
        else break;
      }
      fm.description = parts.join(' ');
    }
  }
  fm.__body = text.slice(m[0].length);
  return fm;
}

function checkSkills() {
  if (!existsSync(SKILLS_DIR)) { add('skills', '技能目录', false, `${SKILLS_DIR} 不存在`); return; }
  const flat = new Map();
  const bundle = new Map();
  for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) flat.set(e.name.slice(0, -3), join(SKILLS_DIR, e.name));
    else if (e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'SKILL.md'))) {
      bundle.set(e.name, join(SKILLS_DIR, e.name, 'SKILL.md'));
    }
  }
  const dupes = [...flat.keys()].filter(n => bundle.has(n));
  add('skills-unique', '技能入口唯一（平铺与目录包不并存）', dupes.length === 0,
    dupes.length === 0
      ? `平铺 ${flat.size} 个 / 目录包 ${bundle.size} 个，无同名`
      : `同名两形态并存: ${dupes.join(', ')}——技能发现器会同时看到两个候选`);

  const entries = [...flat.entries(), ...bundle.entries()];
  if (entries.length === 0) { add('skills', '技能 frontmatter', false, '未发现任何技能入口'); return; }
  let allOk = true;
  const nameMismatch = [];
  const longDesc = [];
  const longBody = [];
  for (const [entryName, file] of entries) {
    const fm = readFrontmatter(readFileSync(file, 'utf8'));
    if (!fm) { add('skills-fm', `frontmatter 缺失: ${entryName}`, false, '无 YAML frontmatter'); allOk = false; continue; }
    if (!fm.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) {
      add('skills-fm', `frontmatter name 非法: ${entryName}`, false, `name=${JSON.stringify(fm.name)}（须小写 kebab-case）`);
      allOk = false;
    }
    if (!fm.description) {
      add('skills-fm', `frontmatter description 缺失: ${entryName}`, false, 'description 必填');
      allOk = false;
    }
    if (fm.name && fm.name !== entryName) nameMismatch.push(`${entryName}→${fm.name}`);
    if (fm.description && fm.description.length > 500) longDesc.push(`${entryName}(${fm.description.length})`);
    if (fm.__body && [...fm.__body].length > 6000) longBody.push(`${entryName}(${[...fm.__body].length})`);
  }
  if (allOk) add('skills-fm', '技能 frontmatter（name/description）', true, `${entries.length} 个技能入口`);

  // 以下两项是项目维护约定（M1 迁移后转为硬门禁），此处仅提示
  if (nameMismatch.length > 0) addWarn('skills-name-match', 'frontmatter name 与入口名一致', `不一致: ${nameMismatch.join(', ')}`);
  if (longDesc.length > 0) addWarn('skills-desc-budget', 'description ≤ 500 字符（目录渲染预算）', `超长: ${longDesc.join(', ')}`);
  if (longBody.length > 0) addWarn('skills-body-budget', '根正文 ≤ 6000 码点（工程预算）', `超长: ${longBody.join(', ')}`);
}

// ── 9. 讲题流水线纪律（源码断言，回归保护） ─────────────────
function checkPipelineDiscipline() {
  // (a) solver 不得含解析派生的 distractorClues（等于泄露答案）
  const coreSrc = readFileSync(join(PRESET_SRC, 'plugins', 'core', 'index.js'), 'utf8');
  const noClues = !/distractorClues/.test(coreSrc);
  add('solve-leak', 'solve 无解析派生泄漏 (distractorClues)', noClues,
    noClues ? 'solutionScaffold 无 distractorClues' : 'core/index.js 仍含 distractorClues');

  // (b) geo_solve 必须交付 DSH 原生图片，并显式表达图片交付状态
  const analysisSrc = readFileSync(join(PRESET_SRC, 'plugins', 'analysis', 'index.js'), 'utf8');
  const nativeImages = /attachments\.saveImage/.test(analysisSrc) && /type:\s*['"]image['"]/.test(analysisSrc) && /imageDelivery/.test(analysisSrc);
  add('native-images', 'geo_solve 原生图片附件契约', nativeImages,
    nativeImages ? 'saveImage + ImageBlock + imageDelivery' : 'analysis/index.js 缺少原生图片交付契约');
  const explicitDelivery = /'none'/.test(analysisSrc) && /'complete'/.test(analysisSrc) && /'partial'/.test(analysisSrc) && /'degraded'/.test(analysisSrc);
  add('image-degrade', '图片交付显式降级', explicitDelivery,
    explicitDelivery ? 'none / complete / partial / degraded 状态齐全' : 'imageDelivery 状态不完整');

  // (c) 活跃预设不得残留旧视觉服务、工具或路由
  const activeFiles = walkFiles(PRESET_SRC).filter(f => /\.(?:js|yml|md|html)$/.test(f));
  const activeText = activeFiles.map(f => readFileSync(f, 'utf8')).join('\n');
  const legacyPattern = /geoVision|dshVision|vision_inspect|vision_ocr|vision_locate|geo_extract_images|\/geo\/vision\//;
  const legacyRemoved = !legacyPattern.test(activeText) && !existsSync(join(PRESET_SRC, 'plugins', 'vision', 'index.js'));
  add('legacy-vision', '旧视觉链路已从活跃预设移除', legacyRemoved,
    legacyRemoved ? '无旧服务、工具、路由或 vision 插件' : '活跃预设仍含旧视觉引用');

  // (d) judge/explain 必须接收独立答案与核验结果（编排参数）
  const hasOrchestration = /independentAnswer/.test(analysisSrc);
  add('pipeline-orch', 'judge/explain 编排参数 (independentAnswer)', hasOrchestration,
    hasOrchestration ? 'geo_judge/geo_explain 接收独立答案' : 'analysis/index.js 无 independentAnswer');

  // (e) 数据/解析层修复断言（会话复盘-20260817 §五 1-4 / 修复方案-20260817 P0-P1，防回归）
  const qidQuoteOk = coreSrc.includes('question_id:\\s*["`]?([^"`]+)');
  add('parser-qid-quote', 'qid 正则兼容双引号 (["`]?[^"`]+)', qidQuoteOk,
    qidQuoteOk ? '引号类 + 非引号捕获' : 'core/index.js qid 正则未兼容双引号');
  const kmSkipOk = /inKm/.test(coreSrc) && /MANAGED-KM-START/.test(coreSrc);
  add('parser-km-skip', '主循环跳过 MANAGED-KM 块 (inKm)', kmSkipOk,
    kmSkipOk ? 'KM 行不按正文处理' : 'core/index.js 无 inKm 状态机');
  const stemOk = /stemMark\[2\]/.test(coreSrc);
  add('parser-stem', 'stem 取真实题干 (stemMark[2])', stemOk,
    stemOk ? 'stemMark[2]' : 'core/index.js 仍用 stemMark[1]（stem 恒为"题干"）');
  const mtimeOk = /mtime/.test(coreSrc);
  add('index-fresh', 'loadBank mtime 新鲜度检查', mtimeOk,
    mtimeOk ? '含 mtime 判断' : 'core/index.js loadBank 无 mtime 检查');

  const idxPath = join(PROJECT_ROOT, 'outputs', 'question-index.json');
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      const items = Array.isArray(idx.items) ? idx.items : [];
      const quoted = items.filter(i => typeof i.questionId === 'string' && i.questionId.includes('"'));
      const fakeStem = items.filter(i => i.stem === '题干');
      const noAnswer = items.filter(i => typeof i.answer !== 'string' || i.answer.trim() === '');
      const dataOk = idx.version === 3 && quoted.length === 0 && fakeStem.length === 0 && noAnswer.length === 0;
      add('index-data', '索引数据完整 (v3 / 无引号 qid / 无假 stem / 每项含答案)', dataOk,
        dataOk ? `${items.length} 小问 (v${idx.version})` : `v=${idx.version}, 引号qid=${quoted.length}, 假stem=${fakeStem.length}, 缺答案=${noAnswer.length}（旧版本产物，需重建索引）`);
    } catch (e) {
      add('index-data', '索引数据检查', false, '索引解析失败: ' + e.message);
    }
  } else {
    add('index-data', '索引数据检查', true, '索引不存在（首次 loadBank 将自动重建）');
  }
}

// ── 10. 部署形态（仅提示，不判源码失败） ─────────────────────
function checkDeployment() {
  const profilesDir = join(DSH_HOME, 'profiles');
  if (!existsSync(profilesDir)) {
    addWarn('deploy', '本机部署形态', `未找到 ${profilesDir}（源码检查不因此失败）`);
    return;
  }
  let found = 0;
  for (const e of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const manifest = join(profilesDir, e.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    const spec = pkg && pkg.dependencies && pkg.dependencies[PRESET_PKG_NAME];
    if (!spec) continue;
    found++;
    const listed = !!(pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) && pkg.dsh.profile.bundles.includes(PRESET_PKG_NAME));
    if (typeof spec === 'string' && spec.startsWith('link:')) {
      const rawTarget = spec.slice(5);
      const target = /^[A-Za-z]:[\\/]/.test(rawTarget) ? resolvePath(rawTarget) : resolvePath(profilesDir, e.name, rawTarget);
      const ok = existsSync(join(target, 'cordis.patch.yml')) && existsSync(join(target, 'skills'));
      addWarn('deploy', `profile ${e.name} 部署形态`,
        `link → ${target}${ok ? '（cordis.patch.yml 与 skills/ 可达）' : '（目标缺少 cordis.patch.yml 或 skills/）'}${listed ? '' : '；但未列入 dsh.profile.bundles'}`);
    } else {
      addWarn('deploy', `profile ${e.name} 部署形态`,
        `包安装 ${spec}${listed ? '' : '；未列入 dsh.profile.bundles'}——非 link 安装属正常部署，不作为源码失败`);
    }
  }
  if (found === 0) {
    addWarn('deploy', '本机部署形态', `未在任何 profile 发现 ${PRESET_PKG_NAME} 依赖声明（源码检查不因此失败）`);
  }
}

// ── 11. 运行时冒烟 ──────────────────────────────────────────
function httpGet(url, timeoutMs = 10000, collectBody = false) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? import('node:https') : import('node:http');
    mod.then(({ default: http }) => {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        if (!collectBody) { resolve({ status: res.statusCode }); res.resume(); return; }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });
        res.on('end', () => resolve({ status: res.statusCode, body: raw }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  });
}

async function checkRuntime() {
  const endpoints = [
    { path: '/geo/core/health', expect: 200, checkJson: true },
    { path: '/geo-teacher', expect: 200 },
  ];
  let allOk = true;
  for (const ep of endpoints) {
    try {
      const resp = await httpGet(`${DSH_WEB}${ep.path}`, 10000, !!ep.checkJson);
      let ok = resp.status === ep.expect;
      let detail = `HTTP ${resp.status}`;
      if (ok && ep.checkJson) {
        try {
          const data = JSON.parse(resp.body);
          if (data && data.status === 'success' && typeof data.bankQuestions === 'number') {
            detail += ` | JSON status=${data.status} bank=${data.bankQuestions}题 indexFromDisk=${!!data.indexFromDisk}`;
          } else {
            ok = false;
            detail += ` | 非健康 JSON（status=${data && data.status}）`;
          }
        } catch {
          ok = false;
          detail += ` | 非 JSON（疑似 SPA 兜底，geo-teacher 预设未挂载——请先在桌面打开一个 geo-teacher 会话触发挂载后重试）: ${resp.body.slice(0, 60)}`;
        }
      }
      add('runtime', `运行时冒烟 ${ep.path}`, ok, detail);
      if (!ok) allOk = false;
    } catch (e) {
      add('runtime', `运行时冒烟 ${ep.path}`, false, e.message);
      allOk = false;
    }
  }
  return allOk;
}

// ── 12. .backups 提示 ───────────────────────────────────────
function checkBackups() {
  const bakDir = join(PROJECT_ROOT, '.backups');
  if (!existsSync(bakDir)) {
    addWarn('backups', '.backups 目录', '不存在（建议改动前创建备份）');
    return;
  }
  const entries = readdirSync(bakDir).filter(e => statSync(join(bakDir, e)).isDirectory());
  if (entries.length === 0) addWarn('backups', '.backups 目录', '存在但为空');
  else addWarn('backups', '.backups 目录', `${entries.length} 个备份，最近: ${entries.sort().pop()}`);
}

// ── 主流程 ───────────────────────────────────────────────────
console.log('geo-verify: 地理教师 Agent 确定性检查\n');

if (flags.source) {
  console.log('── 源码静态检查（针对 rc.2 声明行形态，不依赖旧副本） ──');
  await checkSyntax();
  await checkImport();
  await checkApply();

  let view = null;
  if (existsSync(PATCH_FILE)) {
    view = parsePatchStructure(readFileSync(PATCH_FILE, 'utf8'));
  } else {
    add('patch', 'cordis.patch.yml', false, 'cordis.patch.yml 不存在');
  }
  if (view) {
    checkPatch(view);
    checkPackageWiring(view);
    checkIsolate(view);
  }
  checkRoutes();
  checkSkills();
  checkPipelineDiscipline();
  checkDeployment();
  checkBackups();
  console.log();
}

let runtimeOk = true;
if (flags.runtime) {
  console.log(`── 运行时冒烟（${DSH_WEB}；需确认桌面已完整重启） ──`);
  runtimeOk = await checkRuntime();
  console.log();
}

// ── 汇总 ─────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok && !r.warn);
const warns = results.filter(r => r.warn);

if (flags.json) {
  console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, warns: warns.length, results }, null, 2));
} else {
  console.log(`结果: ${failed.length} 项失败 / ${warns.length} 项提示 / ${results.length - failed.length - warns.length} 项通过`);
  if (failed.length > 0) {
    console.log('\n失败项：');
    for (const f of failed) console.log(`  ❌ [${f.id}] ${f.name}: ${f.detail}`);
  }
  console.log('\n提示：插件/组合改动须完整重启桌面后生效；仅改 references 等支持文件不刷新技能目录。');
}

// 退出码
if (failed.length > 0) process.exit(1);
if (flags.runtime && !runtimeOk) process.exit(3);
process.exit(0);
