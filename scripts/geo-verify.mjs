#!/usr/bin/env node
/**
 * geo-verify.mjs — 地理教师 Agent 确定性检查程序
 *
 * 用法：node scripts/geo-verify.mjs [--source] [--runtime] [--skip-runtime] [--json]
 * 退出码：0=通过  1=失败  2=用法错误  3=运行时冒烟不可达
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ── 路径（环境计算，不写死用户名） ────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const PRESET_SRC = join(PROJECT_ROOT, '.agent-presets', 'geo-teacher');
const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
const PRESET_RT = join(DSH_HOME, '.agent-presets', 'geo-teacher');
const DSH_WEB = process.env.DSH_WEB_URL || 'http://127.0.0.1:3080';

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
function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

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
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const sub = join(base, e.name);
    for (const f of readdirSync(sub, { withFileTypes: true })) {
      if (!f.isDirectory() && f.name === pattern) results.push(join(sub, f.name));
    }
  }
  return results;
}

// ── YAML 加载（渐进降级） ────────────────────────────────────
async function loadYamlParse() {
  // 1. 项目本地 node_modules
  try { return (await import('yaml')).parse; } catch {}
  // 2. DSH 内嵌 yaml
  try {
    const { createRequire } = await import('node:module');
    const r = createRequire(import.meta.url);
    return r('yaml').parse;
  } catch {}
  // 3. npm cache 路径里的 DSH
  try {
    const cache = process.env.npm_config_cache || join(process.env.USERPROFILE || process.env.HOME || '', '.npm');
    const dshYaml = join(cache, '..', '_npx', '1e7f6d9597241db0', 'node_modules', 'yaml');
    const { createRequire } = await import('node:module');
    const r = createRequire(import.meta.url);
    return r(dshYaml).parse;
  } catch {}
  return null;
}

function yamlFallback(raw) {
  // 降级：正则提取 geo group 的 isolate 块和插件行
  const m = raw.match(/isolate:\s*\n([\s\S]*?)(?=\n\S|\n$)/);
  const isolates = [];
  if (m) {
    for (const line of m[1].split('\n')) {
      const im = line.match(/^\s+(\w[\w.]*):\s*(true|false)/);
      if (im) isolates.push(im[1]);
    }
  }
  return { isolates, raw };
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
  let allOk = true;
  for (const f of files) {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`node --check "${f}"`, { stdio: 'ignore', timeout: 10000 });
    } catch {
      add('syntax', `语法: ${basename(f)}`, false, 'node --check 失败');
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
      add('import', `ESM 导入: ${basename(f)}`, false, e.message);
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
    tools: { register(def) { registered.push(def && def.name); return () => {}; } },
    webServer: { register() {}, registerUpgrade() {}, registerFallback() {}, tapIndex() { return () => {}; } },
    geoKernel: {},
    get(name) { return undefined; },
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
        add('apply', `apply 冒烟: ${basename(f)}`, false, '无 default.apply');
        allOk = false; continue;
      }
      const cfg = {};
      // 给 core 特定 config
      if (f.includes('/core/')) {
        cfg.knowledgeBasePath = 'E:/知识图谱/config';
        cfg.questionBankPath = 'E:/知识图谱/obsidian_vault/04_题目';
        cfg.outputPath = 'E:/geo_edu_agent/outputs';
        cfg.workspaceRoot = 'E:/geo_edu_agent';
      }
      // 给 vision 特定 config
      if (f.includes('/vision/')) { cfg.enabled = false; cfg.cacheDir = 'E:/geo_edu_agent/outputs/visionCache'; cfg.workspaceRoot = 'E:/geo_edu_agent'; }
      plugin.apply(ctx, cfg);
    } catch (e) {
      add('apply', `apply 冒烟: ${basename(f)}`, false, e.message);
      allOk = false;
    }
  }
  if (allOk) add('apply', '插件 apply 冒烟 (mock ctx)', true, `${files.length} 个插件，注册 ${registered.length} 工具，提供 ${provided.length} 服务`);
}

// ── 4. 双副本一致性 ─────────────────────────────────────────
function checkDualCopy() {
  if (!existsSync(PRESET_RT)) { add('dual', '双副本一致性', false, '运行时副本不存在'); return; }
  const srcFiles = walkFiles(PRESET_SRC);
  let ok = true, count = 0;
  for (const sf of srcFiles) {
    const rel = relative(PRESET_SRC, sf);
    const rt = join(PRESET_RT, rel);
    if (!existsSync(rt)) { add('dual', `双副本: ${rel}`, false, '运行时缺失'); ok = false; continue; }
    const h1 = sha256File(sf), h2 = sha256File(rt);
    if (h1 !== h2) { add('dual', `双副本: ${rel}`, false, '哈希不一致'); ok = false; }
    count++;
  }
  if (ok) add('dual', '双副本一致性 (E: vs C:)', true, `${count} 个文件哈希一致`);
}

// ── 5. YAML 结构 ────────────────────────────────────────────
async function checkYaml(yamlParse) {
  const agentFile = join(PRESET_SRC, 'agent.cordis.yml');
  if (!existsSync(agentFile)) { add('yaml', 'YAML 结构', false, 'agent.cordis.yml 不存在'); return null; }
  const raw = readFileSync(agentFile, 'utf8');
  let parsed = null;
  if (yamlParse) {
    try {
      parsed = yamlParse(raw);
      add('yaml', 'YAML 结构 (yaml 解析)', true, 'agent.cordis.yml 可解析');
    } catch (e) {
      add('yaml', 'YAML 结构', false, `解析失败: ${e.message}`);
    }
  } else {
    const fb = yamlFallback(raw);
    parsed = fb;
    add('yaml', 'YAML 结构 (降级正则)', true, 'yaml 包不可用，正则检查基本结构');
  }
  return parsed;
}

// ── 6. isolate 白名单 ───────────────────────────────────────
function checkIsolate(yamlParsed) {
  // 提取 isolate 白名单
  const isolates = new Set();
  if (yamlParsed && Array.isArray(yamlParsed)) {
    // 解析后的 YAML：找 geo group 的 isolate
    for (const row of yamlParsed) {
      if (row && row.id === 'geo' && row.isolate) {
        for (const k of Object.keys(row.isolate)) isolates.add(k);
      }
    }
  } else if (yamlParsed && yamlParsed.isolates) {
    // 降级 fallback
    for (const k of yamlParsed.isolates) isolates.add(k);
  }
  // 扫描插件的 ctx.provide 调用
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  const provided = new Set();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /ctx\.provide\(\s*['"]([\w.]+)['"]/g;
    let m;
    while ((m = re.exec(src))) provided.add(m[1]);
  }
  // 检查每个 provide 的服务是否在 isolate 白名单里
  let ok = true;
  for (const svc of provided) {
    if (!isolates.has(svc)) {
      add('isolate', `isolate 白名单: ${svc}`, false, `ctx.provide('${svc}') 但不在 isolate 白名单中`);
      ok = false;
    }
  }
  if (ok && provided.size > 0) add('isolate', 'isolate 白名单', true, `${provided.size} 个服务均在白名单内`);
  else if (provided.size === 0) add('isolate', 'isolate 白名单', true, '无 ctx.provide 调用');
}

// ── 7. 路由静态扫描 ─────────────────────────────────────────
function checkRoutes() {
  const files = globPattern(join(PRESET_SRC, 'plugins'), 'index.js');
  const routes = []; // [{path, kind, file}]
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /webServer\.register\(\s*\{[^}]*kind:\s*['"](\w+)['"][^}]*path:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) routes.push({ kind: m[1], path: m[2], file: basename(dirname(f)) + '/index.js' });
  }
  // 检查重复
  const seen = new Map();
  let ok = true;
  for (const r of routes) {
    const key = `${r.kind}:${r.path}`;
    if (seen.has(key)) {
      add('routes', `路由重复: ${r.path}`, false, `${r.file} 与 ${seen.get(key)} 冲突`);
      ok = false;
    } else seen.set(key, r.file);
  }
  if (ok) add('routes', '路由静态扫描', true, `${routes.size || routes.length} 条路由，无源码内重复`);
}

// ── 7.5 讲题流水线纪律（源码断言） ──────────────────────────
function checkPipelineDiscipline() {
  // (a) solver 不得含解析派生的 distractorClues（等于泄露答案）
  const coreSrc = readFileSync(join(PRESET_SRC, 'plugins', 'core', 'index.js'), 'utf8');
  const noClues = !/distractorClues/.test(coreSrc);
  add('solve-leak', 'solve 无解析派生泄漏 (distractorClues)', noClues,
    noClues ? 'solutionScaffold 无 distractorClues' : 'core/index.js 仍含 distractorClues');

  // (b) vision 降级必须显式（visionOk），且独立读图工具已移除（读图统一走 geo_solve 自动带图）
  const visionSrc = readFileSync(join(PRESET_SRC, 'plugins', 'vision', 'index.js'), 'utf8');
  const hasVisionOk = /visionOk/.test(visionSrc);
  add('vision-degrade', 'vision 显式降级 (visionOk)', hasVisionOk,
    hasVisionOk ? 'extract 返回 visionOk' : 'vision/index.js 无 visionOk 标记');
  const toolRemoved = !/name:\s*['"]geo_extract_images['"]/.test(visionSrc);
  add('vision-tool', 'geo_extract_images 已移除', toolRemoved,
    toolRemoved ? '读图统一由 geo_solve 自动带图' : 'vision/index.js 仍注册 geo_extract_images');

  // (c) judge/explain 必须接收独立答案与核验结果（编排参数）
  const analysisSrc = readFileSync(join(PRESET_SRC, 'plugins', 'analysis', 'index.js'), 'utf8');
  const hasOrchestration = /independentAnswer/.test(analysisSrc);
  add('pipeline-orch', 'judge/explain 编排参数 (independentAnswer)', hasOrchestration,
    hasOrchestration ? 'geo_judge/geo_explain 接收独立答案' : 'analysis/index.js 无 independentAnswer');

  // (d) 数据/解析层修复断言（会话复盘-20260817 §五 1-4 / 修复方案-20260817 P0-P1，防回归）
  // qid 正则须兼容引号类（["`]? ... [^"`]+），不再允许双引号混入 id（字面匹配，避免正则转义歧义）
  const qidQuoteOk = coreSrc.includes('question_id:\\s*["`]?([^"`]+)');
  add('parser-qid-quote', 'qid 正则兼容双引号 (["`]?[^"`]+)', qidQuoteOk,
    qidQuoteOk ? '引号类 + 非引号捕获' : 'core/index.js qid 正则未兼容双引号');
  // 主循环须跳过 MANAGED-KM 块（inKm 状态机），KM 行不得污染 questionId
  const kmSkipOk = /inKm/.test(coreSrc) && /MANAGED-KM-START/.test(coreSrc);
  add('parser-km-skip', '主循环跳过 MANAGED-KM 块 (inKm)', kmSkipOk,
    kmSkipOk ? 'KM 行不按正文处理' : 'core/index.js 无 inKm 状态机');
  // stem 须取捕获组 2（真实题干内容），而非 marker 文本
  const stemOk = /stemMark\[2\]/.test(coreSrc);
  add('parser-stem', 'stem 取真实题干 (stemMark[2])', stemOk,
    stemOk ? 'stemMark[2]' : 'core/index.js 仍用 stemMark[1]（stem 恒为"题干"）');
  // loadBank 须含 mtime 新鲜度检查（任一文件晚于 builtAt 即重建）
  const mtimeOk = /mtime/.test(coreSrc);
  add('index-fresh', 'loadBank mtime 新鲜度检查', mtimeOk,
    mtimeOk ? '含 mtime 判断' : 'core/index.js loadBank 无 mtime 检查');
  // 数据断言：索引若存在，不得含引号 qid / "题干" stem（旧 parser 产物）
  const idxPath = join(PROJECT_ROOT, 'outputs', 'question-index.json');
  if (existsSync(idxPath)) {
    try {
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      const items = Array.isArray(idx.items) ? idx.items : [];
      const quoted = items.filter(i => typeof i.questionId === 'string' && i.questionId.includes('"'));
      const fakeStem = items.filter(i => i.stem === '题干');
      const dataOk = quoted.length === 0 && fakeStem.length === 0;
      add('index-data', '索引数据无引号 qid / "题干" stem', dataOk,
        dataOk ? `${items.length} 小问` : `引号 qid ${quoted.length} 个，假 stem ${fakeStem.length} 个（旧 parser 产物，需重建索引）`);
    } catch (e) {
      add('index-data', '索引数据检查', false, '索引解析失败: ' + e.message);
    }
  } else {
    add('index-data', '索引数据检查', true, '索引不存在（首次 loadBank 将自动重建）');
  }
}

// ── 8. 运行时冒烟 ───────────────────────────────────────────
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
    // /geo/core/health 必须返回健康 JSON；SPA 兜底页也回 200，仅查状态码会假阳性
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
        } catch (e) {
          ok = false;
          detail += ` | 非 JSON（疑似 SPA 兜底，geo-teacher 预设未挂载——请先在 Web 打开一个 geo-teacher 会话触发挂载后重试）: ${resp.body.slice(0, 60)}`;
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

// ── 9. .backups 提示 ────────────────────────────────────────
function checkBackups() {
  const bakDir = join(PROJECT_ROOT, '.backups');
  if (!existsSync(bakDir)) {
    addWarn('backups', '.backups 目录', '不存在（建议改动前创建备份）');
    return;
  }
  const entries = readdirSync(bakDir).filter(e => statSync(join(bakDir, e)).isDirectory());
  if (entries.length === 0) {
    addWarn('backups', '.backups 目录', '存在但为空');
  } else {
    addWarn('backups', '.backups 目录', `${entries.length} 个备份，最近: ${entries.sort().pop()}`);
  }
}

// ── 主流程 ───────────────────────────────────────────────────
function basename(p) { return p.split(/[\\/]/).pop(); }

console.log('geo-verify: 地理教师 Agent 确定性检查\n');

const yamlParse = await loadYamlParse();

if (flags.source) {
  console.log('── 源码静态检查 ──');
  await checkSyntax();
  await checkImport();
  await checkApply();
  checkDualCopy();
  const y = await checkYaml(yamlParse);
  checkIsolate(y);
  checkRoutes();
  checkPipelineDiscipline();
  checkBackups();
  console.log();
}

let runtimeOk = true;
if (flags.runtime) {
  console.log('── 运行时冒烟（需确认 DSH 已重启） ──');
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
}

// 退出码
if (failed.length > 0) process.exit(1);
if (flags.runtime && !runtimeOk) process.exit(3);
process.exit(0);
