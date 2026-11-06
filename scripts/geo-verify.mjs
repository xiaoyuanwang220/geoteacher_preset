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

// ── 12. 命题包校验器（M3 确定性检查实现） ────────────────────
// 这条检查的意义是「校验器自己不能坏」：两份样例作为正例，任何一份被判 fail 即说明
// 实现或 schema 被改坏。反例（逐条证明能检出）由 test/question-package.test.mjs 覆盖。
async function checkQuestionPackage() {
  const QDIR = join(PRESET_SRC, 'plugins', 'question');
  const SCHEMA_FILE = join(QDIR, 'package.schema.json');
  const MODULE_FILE = join(QDIR, 'package.js');
  const samples = [
    join(PROJECT_ROOT, 'docs', 'examples', 'question-package.sample.json'),
    join(PROJECT_ROOT, 'docs', 'examples', 'question-package-comprehensive.sample.json'),
  ];
  if (!existsSync(MODULE_FILE) || !existsSync(SCHEMA_FILE)) {
    add('question-package', '命题包校验器（M3）', false,
      `${MODULE_FILE} 或 ${SCHEMA_FILE} 不存在——校验/渲染实现缺失，命题包无法自动校验`);
    return;
  }
  let impl, schema;
  try {
    impl = await import(pathToFileURL(MODULE_FILE).href);
    schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    add('question-package', '命题包校验器可加载', false, (e && e.message) || String(e));
    return;
  }
  const API = ['validatePackage', 'buildValidationReport', 'buildStudentProjection', 'buildTeacherProjection', 'renderMarkdown', 'resolveTaskDir'];
  const missing = API.filter((k) => typeof impl[k] !== 'function');
  if (missing.length) {
    add('question-package', '命题包校验器导出 API', false, '缺导出: ' + missing.join(', '));
    return;
  }
  const schemaVer = schema.properties && schema.properties.schemaVersion && schema.properties.schemaVersion.const;
  if (schemaVer !== impl.SCHEMA_VERSION) {
    add('question-package', 'schema 版本与实现一致', false,
      `schema.properties.schemaVersion.const=${schemaVer}，实现 SCHEMA_VERSION=${impl.SCHEMA_VERSION}`);
    return;
  }
  const bad = [];
  for (const f of samples) {
    if (!existsSync(f)) { bad.push(basename(f) + ' 不存在'); continue; }
    let pkg;
    try { pkg = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); }
    catch (e) { bad.push(basename(f) + ' 不是合法 JSON'); continue; }
    const fails = impl.validatePackage(pkg, { schema }).filter((x) => x.level === 'fail');
    if (fails.length) bad.push(basename(f) + '：' + fails.map((x) => `${x.pointer} ${x.message}`).join(' | '));
  }
  if (bad.length) {
    add('question-package', '命题包样例零 fail（校验器正例回归）', false, bad.join('；'));
  } else {
    add('question-package', '命题包样例零 fail（校验器正例回归）', true,
      `${samples.length} 份样例（选择题组/综合题）结构校验全部通过；schemaVersion ${schemaVer}`);
  }
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

// 预算按「消费方式」分档，不按字数一刀切。两个硬上限都是运行时事实，不是自定口味：
//   · description：运行时按 catalogDescriptionMaxLength（默认 500）**静默截断**，切掉的正是
//     "什么时候不该用我"这段路由边界 → 超限必须是失败。
//   · 正文：skill 工具返回的正文属工具结果，压缩触发时会被 tool-result-pruner 按
//     thresholdChars 8192 裁成 head 4096 + tail 1024，中段直接消失 → 8192 是硬上限。
const DESC_MAX = 500;
const BODY_HARD_MAX = 8192;
const SECTION_MAX = 2500;
const NAV_MIN_BODY = 3000;
const NAV_MIN_HEADINGS = 3;

const SKILL_TIERS = {
  workflow: { max: 5000, hint: '每次任务都加载，正文只留决策与步骤（目标 4000）' },
  reference: { max: Infinity, hint: '查表用，可长，但须可跳读' },
  normative: { max: 8000, hint: '人明确要求才加载，条目应可清单化' },
};

// 新增技能必须在此申报消费方式；未申报即失败——否则预算会静默失效（6000 时代的毛病）。
const SKILL_TIER = {
  'geo-solver': 'workflow',
  'geo-question-explainer': 'workflow',
  'geo-question-generator': 'workflow',
  'cn-high-school-geography-lesson-planning': 'reference',
  'geo-code-review': 'normative',
  'geo-dev-checklist': 'normative',
  'geo-doc-writing': 'normative',
};

const SKILL_ROOTS = [
  { label: '预设技能根', dir: SKILLS_DIR },
  { label: '开发技能根', dir: join(PROJECT_ROOT, '.agents', 'skills') },
];

function collectSkills() {
  const out = [];
  for (const root of SKILL_ROOTS) {
    if (!existsSync(root.dir)) continue;
    for (const e of readdirSync(root.dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const file = join(root.dir, e.name, 'SKILL.md');
        if (existsSync(file)) out.push({ root, name: e.name, file, base: join(root.dir, e.name) });
      } else if (e.name.endsWith('.md')) {
        out.push({ root, name: e.name.slice(0, -3), file: join(root.dir, e.name), base: root.dir });
      }
    }
  }
  return out;
}

// 单节高度：一个二级标题下的正文码点数，用来发现"该节该拆进 references/"。
function sectionHeights(body) {
  const out = [];
  let cur = null;
  let buf = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^## /.test(line)) {
      if (cur !== null) out.push({ title: cur, len: [...buf.join('\n')].length });
      cur = line.slice(3).trim();
      buf = [];
    } else if (cur !== null) buf.push(line);
  }
  if (cur !== null) out.push({ title: cur, len: [...buf.join('\n')].length });
  return out;
}

function checkSkills() {
  const skills = collectSkills();
  if (skills.length === 0) { add('skills', '技能目录', false, '两个技能根下均未发现技能入口'); return; }

  // (a) 入口唯一：同一根内平铺与目录包并存、以及跨根同名，都会让目录出现两个候选
  const byName = new Map();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const sameRoot = [];
  const crossRoot = [];
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    if (new Set(list.map(s => s.root.label)).size > 1) crossRoot.push(name);
    else sameRoot.push(name);
  }
  add('skills-unique', '技能入口唯一（平铺与目录包不并存）', sameRoot.length === 0,
    sameRoot.length === 0
      ? `${skills.length} 个入口（${SKILL_ROOTS.map(r => r.label).join(' + ')}）`
      : `同名两形态并存: ${sameRoot.join(', ')}——技能发现器会同时看到两个候选`);
  add('skills-unique-root', '跨技能根无同名', crossRoot.length === 0,
    crossRoot.length === 0 ? '两个根之间无重名' : `跨根重名: ${crossRoot.join(', ')}——目录里会出现两个同名技能`);

  // (b) frontmatter / 预算 / 结构 / 引用
  const badFm = [];
  const nameMismatch = [];
  const colonTrap = [];
  const descOver = [];
  const bodyHard = [];
  const tierOver = [];
  const undeclared = [];
  const noNav = [];
  const heavySection = [];
  const dangling = [];
  let maxDesc = 0;
  let maxBody = 0;
  let maxSection = 0;
  let refCount = 0;

  for (const s of skills) {
    const fm = readFrontmatter(readFileSync(s.file, 'utf8'));
    if (!fm) { badFm.push(`${s.name}: 无 YAML frontmatter`); continue; }
    const desc = String(fm.description || '').replace(/^["']|["']$/g, '').trim();
    if (!fm.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fm.name)) badFm.push(`${s.name}: name=${JSON.stringify(fm.name)} 须小写 kebab-case`);
    if (!desc) badFm.push(`${s.name}: description 缺失`);
    if (fm.name && fm.name !== s.name) nameMismatch.push(`${s.name}→${fm.name}`);
    if (desc && /:\s/.test(desc)) colonTrap.push(s.name);

    const dLen = [...desc].length;
    if (dLen > maxDesc) maxDesc = dLen;
    if (dLen > DESC_MAX) descOver.push(`${s.name}(${dLen})`);

    const body = fm.__body || '';
    const bLen = [...body].length;
    if (bLen > maxBody) maxBody = bLen;
    if (bLen > BODY_HARD_MAX) bodyHard.push(`${s.name}(${bLen})`);

    const tier = SKILL_TIER[s.name];
    if (!tier) undeclared.push(s.name);
    else if (bLen > SKILL_TIERS[tier].max) tierOver.push(`${s.name}[${tier}](${bLen}>${SKILL_TIERS[tier].max})`);

    const h2Count = (body.match(/^## /gm) || []).length;
    if (bLen > NAV_MIN_BODY && h2Count < NAV_MIN_HEADINGS) noNav.push(`${s.name}(## ×${h2Count})`);

    for (const sec of sectionHeights(body)) {
      if (sec.len > maxSection) maxSection = sec.len;
      if (sec.len > SECTION_MAX) heavySection.push(`${s.name}「${sec.title}」(${sec.len})`);
    }

    for (const m of body.matchAll(/`((?:references|scripts)\/[^`\s]+)`/g)) {
      const rel = m[1];
      if (/[<>]/.test(rel)) continue; // 文档占位符（如 references/<文件>），不是真实路径
      refCount++;
      if (!existsSync(join(s.base, rel))) dangling.push(`${s.name}: ${rel}`);
    }
  }

  add('skills-fm', '技能 frontmatter（name kebab-case / description 必填）', badFm.length === 0,
    badFm.length === 0 ? `${skills.length} 个入口全部合规` : badFm.join('；'));

  if (nameMismatch.length > 0) addWarn('skills-name-match', 'frontmatter name 与入口名一致', `不一致: ${nameMismatch.join(', ')}`);
  if (colonTrap.length > 0) addWarn('skills-desc-yaml', 'description 不含「: 」（YAML 会当映射键，技能被静默剔除）', `命中: ${colonTrap.join(', ')}`);

  add('skills-desc-budget', `description ≤ ${DESC_MAX} 字符（运行时静默截断，切掉的是路由边界）`, descOver.length === 0,
    descOver.length === 0 ? `最长 ${maxDesc}` : `超限: ${descOver.join(', ')}`);

  add('skills-body-hard', `正文 ≤ ${BODY_HARD_MAX} 码点（压缩裁剪阈值，超出中段被砍）`, bodyHard.length === 0,
    bodyHard.length === 0 ? `最长 ${maxBody}` : `超限: ${bodyHard.join(', ')}`);

  add('skills-tier-declared', '技能消费方式已申报（预算分档依据）', undeclared.length === 0,
    undeclared.length === 0 ? `${skills.length} 项全部申报` : `未申报: ${undeclared.join(', ')}——在 SKILL_TIER 中补类型`);

  if (tierOver.length > 0) {
    const tiers = [...new Set(tierOver.map(x => x.slice(x.indexOf('[') + 1, x.indexOf(']'))))];
    addWarn('skills-body-tier', '正文按消费方式的软上限',
      `超档: ${tierOver.join(', ')}；${tiers.map(t => `${t}: ${SKILL_TIERS[t].hint}`).join('；')}`);
  } else {
    add('skills-body-tier', '正文在消费方式的软上限内', true, `最长 ${maxBody}（workflow ≤ ${SKILL_TIERS.workflow.max}）`);
  }

  if (heavySection.length > 0) addWarn('skills-section', `单节 ≤ ${SECTION_MAX} 码点（超出宜拆进 references/）`, `过重: ${heavySection.join(', ')}`);
  else add('skills-section', `单节 ≤ ${SECTION_MAX} 码点`, true, `最重 ${maxSection}`);

  if (noNav.length > 0) addWarn('skills-nav', `正文 > ${NAV_MIN_BODY} 码点须有 ≥${NAV_MIN_HEADINGS} 个二级标题（可跳读）`, noNav.join(', '));
  else add('skills-nav', '长正文可跳读', true, `> ${NAV_MIN_BODY} 码点的技能均有 ≥${NAV_MIN_HEADINGS} 个二级标题`);

  add('skills-refs', 'references/scripts 引用可达', dangling.length === 0,
    dangling.length === 0 ? `${refCount} 处引用全部可达` : `悬空: ${dangling.join('; ')}`);
}

// ── 9. 讲题流水线纪律（源码 + 行为断言，回归保护） ───────────
// 契约 §7：题答分离、隔离执行、作答绑定与门禁、核验状态、工具描述预算、
// 索引版本与题面图片字段同步。可 import 的契约直接 import 后断言行为，
// 无导出面的契约用源码 token 断言；不把"字符串还在"当作唯一证据。
const TOOL_DESC_BUDGET = 350; // 三个讲题工具 description 的字符预算（教学细则移入技能）
async function checkPipelineDiscipline() {
  const coreFile = join(PRESET_SRC, 'plugins', 'core', 'index.js');
  const analysisFile = join(PRESET_SRC, 'plugins', 'analysis', 'index.js');
  const coreSrc = readFileSync(coreFile, 'utf8');
  const analysisSrc = readFileSync(analysisFile, 'utf8');

  let coreMod = null;
  try { coreMod = await import(pathToFileURL(coreFile).href); } catch (e) { /* checkImport 已报错 */ }
  let analysisMod = null;
  try { analysisMod = await import(pathToFileURL(analysisFile).href); } catch (e) { /* checkImport 已报错 */ }

  const missingOf = (src, tokens) => tokens.filter(t => !src.includes(t));

  // (a) solver 不得含解析派生的 distractorClues（等于泄露答案）
  const noClues = !/distractorClues/.test(coreSrc);
  add('solve-leak', 'solve 无解析派生泄漏 (distractorClues)', noClues,
    noClues ? 'solutionScaffold 无 distractorClues' : 'core/index.js 仍含 distractorClues');

  // (b) 题答分离：core 解析层必须给出题面图片 / 解析图 / 边界检测三类输出
  const sepTokens = ['questionImages', 'analysisImages', 'boundaryIssues', 'QUESTION_BOUNDARY_UNCERTAIN', 'stripImageMarkdown'];
  const sepMissing = missingOf(coreSrc, sepTokens);
  add('solve-separation', '题答分离（题面图片 / 解析图 / 边界不明指题）', sepMissing.length === 0,
    sepMissing.length === 0
      ? 'questionImages / analysisImages / boundaryIssues / QUESTION_BOUNDARY_UNCERTAIN / stripImageMarkdown 齐全'
      : '缺: ' + sepMissing.join(', '));

  // (c) 解题 prompt 只含题面：用插件导出的构造器实测，答案/解析/知识点/qid/路径一律不进入
  if (analysisMod && typeof analysisMod.buildSolvePrompt === 'function') {
    const S = { qid: 'QID-SENTINEL', run: 'RUN-SENTINEL', file: 'FILE-SENTINEL.md', answer: 'ANSWER-SENTINEL', analysis: 'ANALYSIS-SENTINEL', ku: 'KNOWLEDGE-SENTINEL', fp: 'FP-SENTINEL' };
    const prompt = analysisMod.buildSolvePrompt({
      questionId: S.qid,
      runId: S.run,
      questionFingerprint: S.fp,
      file: S.file,
      material: '材料正文',
      questions: [{ questionId: S.qid, stem: '题干正文？', options: ['A 甲', 'B 乙'] }],
      questionImages: [{ caption: '图1 图注', rel: 'sentinel.png' }],
      answer: S.answer,
      analysis: S.analysis,
      knowledgePoints: [{ knowledge_unit: S.ku }]
    });
    const leaks = [S.qid, S.run, S.file, S.fp, S.answer, S.analysis, S.ku, '.png'].filter(t => prompt.includes(t));
    const keeps = ['材料正文', '题干正文？', 'A 甲', '图1 图注', '## 答案', '## 关键依据', '## 推理过程'].filter(t => !prompt.includes(t));
    add('solve-prompt-isolation', '解题 prompt 只含题面（无 qid/路径/答案/解析/知识点）',
      leaks.length === 0 && keeps.length === 0,
      leaks.length ? '泄漏: ' + leaks.join(', ') : keeps.length ? '缺题面字段或输出格式: ' + keeps.join(', ') : '题面与图片图注齐全，答案/解析/知识点/qid/路径 0 泄漏');
  } else {
    add('solve-prompt-isolation', '解题 prompt 只含题面（buildSolvePrompt 可导入）', false, 'analysis/index.js 未导出 buildSolvePrompt');
  }

  // (d) 旧解题路径已删除：geo_solve 不再组合 questionData + solutionScaffold 自解
  const legacyCompose = ['questionData', 'solutionScaffold'].filter(t => analysisSrc.includes(t));
  add('solve-no-legacy-compose', 'geo_solve 不再组合 questionData/solutionScaffold 取答案', legacyCompose.length === 0,
    legacyCompose.length === 0 ? '解题输入只来自 prepareSolve（题面口径）' : 'analysis/index.js 仍含旧组合: ' + legacyCompose.join(', '));

  // (e) 隔离执行：内部预设 + spawn 子会话 + caller 交付 + 明确失败码
  const isoTokens = ['subagents.startActivation', 'agentPreset', "delivery: 'caller'", 'SOLVER_ISOLATION_UNAVAILABLE', 'SOLVER_RUN_FAILED', 'INTERNAL_SOLVER_PRESET_ID'];
  const isoMissing = missingOf(analysisSrc, isoTokens);
  add('solve-isolation', '隔离执行（startActivation / agentPreset / caller / 失败不回落）', isoMissing.length === 0,
    isoMissing.length === 0
      ? 'startActivation + agentPreset + delivery:caller + SOLVER_ISOLATION_UNAVAILABLE + SOLVER_RUN_FAILED + INTERNAL_SOLVER_PRESET_ID'
      : '缺: ' + isoMissing.join(', '));

  // (f) 内部预设：bundle 声明（cordis.patch.yml）+ 唯一插件行 solver-isolation
  const patchSrc = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : '';
  const internalPresetOk = /id:\s*geo-solver-internal\b/.test(patchSrc)
    && /plugins\/solver-isolation/.test(patchSrc)
    && !/id:\s*geo-solver-internal[\s\S]{0,4000}name:\s*'@deepseek-ai\/dsh-persona'/.test(patchSrc);
  add('solver-preset', '内部解题预设：bundle 声明且插件行只有 solver-isolation（无静态 persona/工具）', internalPresetOk,
    internalPresetOk
      ? 'cordis.patch.yml → id=geo-solver-internal，plugins=[@geo-edu/.../plugins/solver-isolation]'
      : '缺少内部预设声明，或仍引用静态 persona 行（persona 只应来自 skills/geo-solver.md）');

  // (g) 隔离插件：persona 来自技能（单一来源）+ 工具锁（restrict 隐藏 + guard 兜底）
  const isolationFile = join(PRESET_SRC, 'plugins', 'solver-isolation', 'index.js');
  const isolationSrc = existsSync(isolationFile) ? readFileSync(isolationFile, 'utf8') : '';
  let isolationMod = null;
  try { isolationMod = await import(pathToFileURL(isolationFile).href); } catch (e) { /* checkImport 已报错 */ }
  const lockTokens = ['tools.restrict', 'tools.guard', 'lockFailed', 'geo-solver.md', 'deployment:persona-prefix'];
  const lockMissing = missingOf(isolationSrc, lockTokens);
  add('solver-lock', '隔离子会话工具锁（restrict 隐藏 + guard 兜底，persona 从技能读取）', lockMissing.length === 0,
    lockMissing.length === 0
      ? 'restrict + guard + skills/geo-solver.md + persona section（隐藏并拒绝宿主全局工具）'
      : '缺: ' + lockMissing.join(', '));

  // Cordis 对未 inject 的服务属性会抛 `cannot get property "timer" without inject`，
  // 这一异常会直接把 preset 挂载打挂（真实故障：solver-isolation 的 ctx.timer）。
  // 只检查代码，忽略注释里对故障的说明。
  const isolationCode = isolationSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const injectViolation = /ctx\.timer\b/.test(isolationCode);
  add('solver-inject-discipline', '隔离插件只访问已 inject 的服务（不触碰 ctx.timer 等）', !injectViolation,
    injectViolation ? '仍访问未 inject 的 ctx.timer，会导致 preset 加载失败' : '仅访问 tools/systemPrompt（已 inject）与 ctx.get/ctx.effect');

  if (isolationMod && typeof isolationMod.readSolverPersona === 'function') {
    const loaded = isolationMod.readSolverPersona() || {};
    const body = String(loaded.text || '');
    const personaOk = loaded.source === 'skill'
      && [...body].length >= 1000
      && !/\{\{[^}]*\}\}/.test(body)
      && body.includes('## 答案') && body.includes('## 关键依据');
    add('solver-persona', '解题 persona 来自 skills/geo-solver.md（无模板变量 / 含固定三段输出）', personaOk,
      personaOk ? `来源 skill，正文 ${[...body].length} 码点` : `source=${loaded.source}, 正文 ${[...body].length} 码点`);
  } else {
    add('solver-persona', '解题 persona 可校验（readSolverPersona 可导出）', false, 'solver-isolation/index.js 未导出 readSolverPersona');
  }

  // (h) 作答绑定与门禁（core 源码 + 状态机实测）
  const gateTokens = ['SOLVE_NOT_SUBMITTED', 'JUDGE_NOT_OPENED', 'EXPLAIN_NOT_VERIFIED', 'QUESTION_NOT_IN_GROUP', 'conclusions', 'questionFingerprint', 'solve-runs.json'];
  const gateMissing = missingOf(coreSrc, gateTokens);
  add('solve-gates', '作答绑定与门禁（门禁码 / 题面指纹 / run 持久化）', gateMissing.length === 0,
    gateMissing.length === 0
      ? 'SOLVE_NOT_SUBMITTED / JUDGE_NOT_OPENED / EXPLAIN_NOT_VERIFIED / questionFingerprint / solve-runs.json'
      : '缺: ' + gateMissing.join(', '));

  if (coreMod) {
    const needExports = ['parseQuestionFileFull', 'questionFingerprint', 'createSolveRegistry', 'SOLVE_STATES', 'rankSimilarQuestions', 'buildExplainerReport', 'EXPLAIN_CONTENT_REQUIREMENTS', 'EXPLAIN_RULESET_VERSION'];
    const lostExports = needExports.filter(k => coreMod[k] === undefined);
    add('solve-exports', 'core 讲题契约导出齐全', lostExports.length === 0,
      lostExports.length === 0 ? needExports.join(', ') : '缺导出: ' + lostExports.join(', '));

    const reg = coreMod.createSolveRegistry({});
    const qid = 'verify-group';
    const fp = coreMod.questionFingerprint({ questionId: qid, material: '材料', stems: ['题干'], options: [], images: [] });
    const run = reg.ensureRun({ questionId: qid, questionIds: [qid], questionFingerprint: fp }).run;
    const openBeforeSubmit = reg.openReference(run.runId);
    const verifyBeforeOpen = reg.recordVerification(run.runId, qid, { verdict: 'consistent' });
    const submitted = reg.submit(run.runId, { answerText: '## 答案\nB', keyEvidence: '依据' });
    const opened = reg.openReference(run.runId);
    const badVerdict = reg.recordVerification(run.runId, qid, { verdict: 'maybe' });
    const verified = reg.recordVerification(run.runId, qid, { verdict: 'consistent', matched: ['B'] });
    const stateMachineOk = openBeforeSubmit.ok === false && openBeforeSubmit.code === 'SOLVE_NOT_SUBMITTED'
      && verifyBeforeOpen.ok === false && verifyBeforeOpen.code === 'JUDGE_NOT_OPENED'
      && submitted.ok === true && submitted.run.state === coreMod.SOLVE_STATES.SUBMITTED
      && opened.ok === true
      && badVerdict.ok === false && badVerdict.code === 'CONCLUSION_INVALID'
      && verified.ok === true && verified.run.state === coreMod.SOLVE_STATES.VERIFIED;
    add('solve-state-machine', 'run 状态机门禁（未提交不给答案 / 未开答案不能归档 / verdict 校验）', stateMachineOk,
      stateMachineOk
        ? 'question_ready → submitted → verified；三道门禁按序生效'
        : `open前=${openBeforeSubmit.code}, 归档前=${verifyBeforeOpen.code}, 非法verdict=${badVerdict.code}, 最终=${verified.ok}`);

    // 题组按小问分别归档：只有全部小问都有结论才算 verified，且不能张冠李戴。
    const groupReg = coreMod.createSolveRegistry({});
    const groupFp = coreMod.questionFingerprint({ questionId: 'verify-g1', material: '材料', stems: ['一', '二'], options: [], images: [] });
    const groupRun = groupReg.ensureRun({ questionId: 'verify-g1', questionIds: ['verify-g1', 'verify-g2'], questionFingerprint: groupFp }).run;
    groupReg.submit(groupRun.runId, { answerText: '## 答案\n一、二' });
    groupReg.openReference(groupRun.runId);
    const firstArchive = groupReg.recordVerification(groupRun.runId, 'verify-g1', { verdict: 'partially_consistent' });
    const wrongQid = groupReg.recordVerification(groupRun.runId, 'verify-other', { verdict: 'consistent' });
    const secondArchive = groupReg.recordVerification(groupRun.runId, 'verify-g2', { verdict: 'consistent' });
    const groupOk = firstArchive.run.state === coreMod.SOLVE_STATES.SUBMITTED
      && firstArchive.pending.length === 1
      && wrongQid.code === 'QUESTION_NOT_IN_GROUP'
      && secondArchive.run.state === coreMod.SOLVE_STATES.VERIFIED
      && secondArchive.run.conclusions['verify-g1'].verdict === 'partially_consistent'
      && secondArchive.run.conclusions['verify-g2'].verdict === 'consistent';
    add('solve-group-verification', '题组核验按小问归档（未全归档不算 verified，跨题组 qid 拒绝）', groupOk,
      groupOk
        ? 'g1 归档后仍为 submitted（pending g2）；g2 归档后才 verified；结论按 qid 分开保存'
        : `第一次=${firstArchive.run.state}, 待归档=${JSON.stringify(firstArchive.pending || [])}, 跨题组=${wrongQid.code}, 最终=${secondArchive.run.state}`);
  }

  // (i) geo_judge 两阶段：无 conclusion 开答案，有 conclusion 归档
  const judgeStart = analysisSrc.indexOf("name: 'geo_judge'");
  const explainStart = analysisSrc.indexOf("name: 'geo_explain'");
  const judgeBlock = judgeStart >= 0 && explainStart > judgeStart ? analysisSrc.slice(judgeStart, explainStart) : '';
  const judgeTwoPhase = judgeBlock.includes('openReferenceAnswer') && judgeBlock.includes('recordVerification');
  add('judge-two-phase', 'geo_judge 两阶段（开放答案 → 归档核验结论）', judgeTwoPhase,
    judgeTwoPhase ? 'openReferenceAnswer + recordVerification 均在 geo_judge 分支内' : 'geo_judge 未同时接 openReferenceAnswer 与 recordVerification');

  // (j) 核验状态只来自服务端记录：旧"提供材料待核验"路径与编排参数已删除
  const removedVerification = ['self_reported_material', 'buildVerification', 'toJudgeReportJson', 'judgeReport'].filter(t => analysisSrc.includes(t));
  add('verification-state', '核验状态来自服务端运行记录（无 self_reported_material/buildVerification/toJudgeReportJson/judgeReport）',
    removedVerification.length === 0,
    removedVerification.length === 0 ? '旧待核验路径与 judgeReport 编排参数均已移除' : '仍含: ' + removedVerification.join(', '));

  const explainBlock = explainStart >= 0
    ? analysisSrc.slice(explainStart, positionOf(analysisSrc, "name: 'geo_export_analysis'", explainStart))
    : '';
  const explainParams = explainBlock.slice(explainBlock.indexOf('parameters:'), explainBlock.indexOf('output:'));
  const explainContractOk = analysisSrc.includes('assembleExplanation')
    && coreSrc.includes('server_run_record')
    && /qid/.test(explainParams) && /audience/.test(explainParams)
    && !/independentAnswer|judgeReport|conclusion/.test(explainParams);
  add('explain-verified-only', 'geo_explain 只读服务端核验记录（assembleExplanation + server_run_record）', explainContractOk,
    explainContractOk
      ? 'geo_explain 参数只剩 qid/audience；核验证据由 core 写入 server_run_record'
      : 'geo_explain 仍接收模型自报材料或缺 server_run_record 证据（参数: ' + (explainParams.replace(/\s+/g, ' ').slice(0, 80) || '(未找到)') + '）');

  // (k) 工具描述预算：三个讲题工具 ≤ 350 字符，教学细则归技能
  const toolDefs = new Map();
  if (analysisMod && analysisMod.default && typeof analysisMod.default.apply === 'function') {
    const mockCtx = {
      webServer: { register() {} },
      tools: { register(def) { if (def && def.name) toolDefs.set(def.name, def); return () => {}; } },
      geoKernel: {},
      get() { return undefined; },
      effect(cb) { try { return cb(); } catch (e) { return () => {}; } }
    };
    try { analysisMod.default.apply(mockCtx, {}); } catch (e) { /* apply 冒烟另有检查 */ }
  }
  const talkingTools = ['geo_solve', 'geo_judge', 'geo_explain'];
  const toolLens = talkingTools.map(name => {
    const def = toolDefs.get(name) || {};
    return {
      name,
      len: [...String(def.description || '')].length,
      params: Object.keys((def.parameters && def.parameters.properties) || {})
    };
  });
  const overBudget = toolLens.filter(t => t.len === 0 || t.len > TOOL_DESC_BUDGET);
  add('tool-desc-budget', `讲题工具 description ≤ ${TOOL_DESC_BUDGET} 字符`, overBudget.length === 0,
    overBudget.length === 0
      ? toolLens.map(t => `${t.name} ${t.len}`).join(' / ')
      : '超限/缺失: ' + overBudget.map(t => `${t.name}(${t.len})`).join(', '));
  const expectParams = { geo_solve: 'qid', geo_judge: 'qid,conclusion', geo_explain: 'qid,audience' };
  const badParams = toolLens.filter(t => t.params.join(',') !== expectParams[t.name]);
  add('tool-params', '讲题工具参数只留入口参数（qid / conclusion / audience）', badParams.length === 0,
    badParams.length === 0
      ? talkingTools.map(n => `${n}(${expectParams[n]})`).join(' / ')
      : badParams.map(t => `${t.name}(${t.params.join(',') || '空'})`).join(', '));

  // (l) 讲稿骨架契约（规则版本 3 / 四项内容要求 / knowledgeRole / comparison / transfer）
  if (coreMod && typeof coreMod.buildExplainerReport === 'function') {
    const sample = {
      questionId: 'verify-q1',
      file: 'verify.md',
      material: '该地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。',
      stem: '分析该地气温高于同纬度的原因。',
      options: [],
      answer: '受暖流影响',
      analysis: '暖流增温',
      knowledgePoints: [
        { role: 'core_exam_point', knowledge_unit: '洋流对地理环境的影响', weight: '1.0' },
        { role: 'supporting_knowledge', knowledge_unit: '海水的性质', weight: '0.5' }
      ],
      meta: { year: 2025, region: '安徽', question_numbers: '1' }
    };
    const report = coreMod.buildExplainerReport(sample, false, [], 'student', { basis: [], insufficient: true, gap: '题库不足' }) || {};
    const structure = report.structure || {};
    const fourOk = Array.isArray(report.contentRequirements) && report.contentRequirements.length === 4
      && report.contentRequirements.map(c => c.item).join(',') === '考查知识,解题过程,同类问题,迁移运用';
    const knowledgeRoleOk = !!(structure.locate && structure.locate.knowledgeRole
      && 'roleInSolving' in structure.locate.knowledgeRole
      && Array.isArray(structure.locate.knowledgeRole.supporting));
    const comparison = structure.solve && structure.solve.comparison;
    const comparisonOk = !!(comparison
      && Array.isArray(comparison.basis)
      && 'insufficient' in comparison
      && typeof comparison.citationRule === 'string'
      && comparison.citationRule.includes('缺口'));
    const transfer = structure.reflect && structure.reflect.transfer;
    const transferOk = !!(transfer && typeof transfer.student === 'string' && typeof transfer.teacher === 'string');
    const versionOk = report.schemaVersion === 3
      && coreMod.EXPLAIN_RULESET_VERSION === 3
      && typeof report.cacheKey === 'string' && report.cacheKey.includes('#rules3');
    const skeletonProblems = [];
    if (!fourOk) skeletonProblems.push('contentRequirements 非四项');
    if (!knowledgeRoleOk) skeletonProblems.push('locate.knowledgeRole 缺失');
    if (!comparisonOk) skeletonProblems.push('solve.comparison 字段或 citationRule 缺失');
    if (!transferOk) skeletonProblems.push('reflect.transfer 缺失');
    if (!versionOk) skeletonProblems.push('schemaVersion/cacheKey 规则版本非 3');
    add('explain-skeleton', '讲稿骨架契约（规则 3 / 四项内容要求 / knowledgeRole / comparison / transfer）', skeletonProblems.length === 0,
      skeletonProblems.length === 0 ? '四项内容要求 + knowledgeRole + comparison(citationRule) + transfer + cacheKey#rules3' : skeletonProblems.join('；'));

    // (m) 同类题检索：同题组不算同类，按设问任务/材料检索，不足时标 insufficient
    const cur = { questionId: 'SIM-CUR', file: 'A.md', material: '该地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。', stem: '分析该地气温高于同纬度的原因。', options: [], knowledgePoints: [] };
    const sibling = { ...cur, questionId: 'SIM-SIB', file: 'A.md' };
    const near = { questionId: 'SIM-NEAR', file: 'B.md', material: '乙地位于沿海，受沿岸暖流影响，气温较高，降水较多，地形以平原为主。', stem: '分析乙地气温高于同纬度的原因。', options: [], knowledgePoints: [] };
    const near2 = { questionId: 'SIM-NEAR2', file: 'D.md', material: '丙地位于沿海，受暖流影响，气温较高，降水偏多，地形以平原为主。', stem: '分析丙地气温高于同纬度的原因。', options: [], knowledgePoints: [] };
    const far = { questionId: 'SIM-FAR', file: 'C.md', stem: '该地服务业发展的主导区位条件是（　）', material: '当地商业金融发达，市场需求大，销售渠道完善。', options: ['A 甲', 'B 乙', 'C 丙', 'D 丁'], knowledgePoints: [] };
    const ranked = coreMod.rankSimilarQuestions([cur, sibling, near, near2, far], cur, 5) || { basis: [] };
    const rankedIds = (ranked.basis || []).map(b => b.questionId);
    const similarOk = !rankedIds.includes('SIM-SIB') && rankedIds.includes('SIM-NEAR') && rankedIds.includes('SIM-NEAR2')
      && !rankedIds.includes('SIM-FAR')
      && ranked.insufficient === false && (ranked.basis || []).every(b => typeof b.sharedTask === 'string' && typeof b.differences === 'string');
    add('similar-questions', '同类题检索（同题组不算同类 / 按设问任务与材料检索）', similarOk,
      similarOk ? `候选 ${rankedIds.join(', ')}；同文件题组已排除` : `候选 ${rankedIds.join(', ') || '(空)'}；同题组应为排除项、同类题应命中`);
    const sparse = coreMod.rankSimilarQuestions([cur, sibling, near], cur, 5) || {};
    const sparseOk = sparse.insufficient === true && typeof sparse.gap === 'string' && sparse.gap.includes('不足 2 道');
    add('similar-insufficient', '同类题不足 2 道时标 insufficient 并给出缺口', sparseOk,
      sparseOk ? 'insufficient=true + gap 指明缺口' : `insufficient=${sparse.insufficient}, gap=${sparse.gap || '(空)'}`);
  }

  // (m2) 工作台聚合：安装器、随仓库数据、/geo-status
  const setupFile = join(PROJECT_ROOT, 'scripts', 'setup.mjs');
  add('setup-script', '一键安装器存在（scripts/setup.mjs）', existsSync(setupFile),
    existsSync(setupFile) ? '安装/卸载/静态校验入口就位' : '缺少 scripts/setup.mjs');
  const statusRegistered = analysisSrc.includes("name: 'geo-status'")
    && analysisSrc.includes('commands.register')
    && analysisSrc.includes("name: 'geo_status'");
  add('status-command', '/geo-status 命令与 geo_status 工具已注册（只读，不调模型）', statusRegistered,
    statusRegistered ? 'analysis 注册 geo-status 命令与 geo_status 工具' : 'analysis 未同时注册 /geo-status 与 geo_status');
  const dataRoot = join(PROJECT_ROOT, 'data');
  const dataYaml = existsSync(join(dataRoot, 'config'))
    ? readdirSync(join(dataRoot, 'config')).filter((name) => /\.ya?ml$/i.test(name)).length
    : 0;
  const dataBankDir = join(dataRoot, 'obsidian_vault', '04_题目');
  const dataBankMd = existsSync(dataBankDir)
    ? walkFiles(dataBankDir).filter((file) => file.endsWith('.md')).length
    : 0;
  add('packaged-data', `随仓库数据（考点库 ${dataYaml} YAML / 题库 ${dataBankMd} md）`,
    dataYaml > 0 && dataBankMd > 0,
    dataYaml > 0 && dataBankMd > 0
      ? `${dataRoot}：knowledge=packaged、questionBank=packaged`
      : `缺失：请检查 data/config 与 data/obsidian_vault/04_题目（当前 ${dataYaml} / ${dataBankMd}）`);

  // (n) 数据/解析层修复断言（会话复盘-20260817 §五 1-4 / 修复方案-20260817 P0-P1，防回归）
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

  const nativeImages = /attachments\.saveImage/.test(analysisSrc) && /type:\s*['"]image['"]/.test(analysisSrc) && /imageDelivery/.test(analysisSrc);
  add('native-images', 'geo_solve 原生图片附件契约', nativeImages,
    nativeImages ? 'saveImage + ImageBlock + imageDelivery' : 'analysis/index.js 缺少原生图片交付契约');
  const explicitDelivery = /'none'/.test(analysisSrc) && /'complete'/.test(analysisSrc) && /'partial'/.test(analysisSrc) && /'degraded'/.test(analysisSrc);
  add('image-degrade', '图片交付显式降级', explicitDelivery,
    explicitDelivery ? 'none / complete / partial / degraded 状态齐全' : 'imageDelivery 状态不完整');

  // (o) 活跃预设不得残留旧视觉服务、工具或路由
  const activeFiles = walkFiles(PRESET_SRC).filter(f => /\.(?:js|yml|md|html)$/.test(f));
  const activeText = activeFiles.map(f => readFileSync(f, 'utf8')).join('\n');
  const legacyPattern = /geoVision|dshVision|vision_inspect|vision_ocr|vision_locate|geo_extract_images|\/geo\/vision\//;
  const legacyRemoved = !legacyPattern.test(activeText) && !existsSync(join(PRESET_SRC, 'plugins', 'vision', 'index.js'));
  add('legacy-vision', '旧视觉链路已从活跃预设移除', legacyRemoved,
    legacyRemoved ? '无旧服务、工具、路由或 vision 插件' : '活跃预设仍含旧视觉引用');

  // (p) 索引版本与题面图片字段同步（v4：questionImages / analysisImages / boundaryIssues）
  const idxPath = join(PROJECT_ROOT, 'outputs', 'question-index.json');
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      const items = Array.isArray(idx.items) ? idx.items : [];
      const quoted = items.filter(i => typeof i.questionId === 'string' && i.questionId.includes('"'));
      const fakeStem = items.filter(i => i.stem === '题干');
      const noAnswer = items.filter(i => typeof i.answer !== 'string' || i.answer.trim() === '');
      const badShape = items.filter(i => !Array.isArray(i.questionImages) || !Array.isArray(i.analysisImages) || !Array.isArray(i.boundaryIssues));
      const withQuestionImages = items.filter(i => Array.isArray(i.questionImages) && i.questionImages.length > 0).length;
      const withAnalysisImages = items.filter(i => Array.isArray(i.analysisImages) && i.analysisImages.length > 0).length;
      const withBoundaryIssues = items.filter(i => Array.isArray(i.boundaryIssues) && i.boundaryIssues.length > 0).length;
      const dataOk = idx.version === 4 && badShape.length === 0
        && quoted.length === 0 && fakeStem.length === 0 && noAnswer.length === 0;
      add('index-data', '索引数据完整 (v4 / 题面图片·解析图·边界字段 / 无引号 qid / 无假 stem / 每项含答案)', dataOk,
        dataOk
          ? `${items.length} 小问 (v4)；含题面图片 ${withQuestionImages}、含解析图 ${withAnalysisImages}、含边界问题 ${withBoundaryIssues}`
          : `v=${idx.version}（须为 4，旧版本产物需重建索引）, 缺字段=${badShape.length}, 引号qid=${quoted.length}, 假stem=${fakeStem.length}, 缺答案=${noAnswer.length}`);
    } catch (e) {
      add('index-data', '索引数据检查', false, '索引解析失败: ' + e.message);
    }
  } else {
    add('index-data', '索引数据检查', true, '索引不存在（首次 loadBank 将自动重建）');
  }
}

function positionOf(text, needle, from) {
  const idx = text.indexOf(needle, from || 0);
  return idx >= 0 ? idx : text.length;
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
  await checkPipelineDiscipline();
  await checkQuestionPackage();
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
