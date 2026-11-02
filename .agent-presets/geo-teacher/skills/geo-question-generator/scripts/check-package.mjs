#!/usr/bin/env node
/**
 * check-package.mjs — 命题包确定性校验 / 渲染 CLI
 *
 * 归属：`docs/geography-question-generation-execution-plan.md` §7.2 的
 * `skills/geo-question-generator/scripts/check-package.mjs`（CLI 包装）。
 * 实现只有一份：`plugins/question/package.js`（插件工具 `geo_question_validate` 复用同一实现）。
 *
 * 用法：
 *   node .agent-presets/geo-teacher/skills/geo-question-generator/scripts/check-package.mjs --task <taskId> [选项]
 *   （路径相对仓库根；CLI 在预设包内，也可进预设包目录后按 skills/... 调用）
 *
 * 选项：
 *   --task <taskId>   必填。任务 id，形如 2026-1004-ecofragile-01
 *   --out <dir>       出题输出根（任务目录 = <out>/<taskId>）
 *   --render          生成 draft.md / student.json / teacher.json / validation.json
 *   --json            以 JSON 输出校验报告
 *   --quiet           只输出一行结论
 *   -h, --help        帮助
 *
 * 输出根解析顺序（与插件侧一致）：
 *   1) --out
 *   2) 环境变量 GEO_QUESTION_OUTPUT_ROOT
 *   3) 用户配置 <DSH_HOME>/geo-teacher/config.json 的 questionOutputRoot
 *   4) 同文件 outputPath + '/出题'
 *   5) 同文件 workspaceRoot + '/outputs/出题'
 *   6) 仓库内 <repo>/outputs/出题（预设包就在仓库里时的兜底）
 *
 * 退出码：0=结构通过  1=结构失败  2=用法错误  3=环境/读取错误
 *
 * 纪律：
 *   - 默认**不写任何文件**；只有显式 --render 才写盘，且只写任务目录内的四个产物。
 *   - 不接受任意目录：任务目录必须由输出根 + 合法 taskId 解析，且解析后不得越出输出根。
 *   - 结构失败时 --render 仍会写出（便于排查），但退出码为 1，且报告写明不得作为交付物。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = resolvePath(HERE, '..', '..', '..');           // <preset>/skills/<skill>/scripts → <preset>
const REPO_ROOT = resolvePath(PRESET_ROOT, '..', '..');
const QDIR = join(PRESET_ROOT, 'plugins', 'question');
const SCHEMA_FILE = join(QDIR, 'package.schema.json');
const MODULE_FILE = join(QDIR, 'package.js');
const CONFIG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'geo-teacher', 'config.json');

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const help = argv.includes('-h') || argv.includes('--help');
const opts = {
  task: null, out: null,
  render: argv.includes('--render'),
  json: argv.includes('--json'),
  quiet: argv.includes('--quiet'),
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--task' || a === '--out') {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error('缺少 ' + a + ' 的值'); process.exit(2); }
    opts[a === '--task' ? 'task' : 'out'] = v;
    i++;
  } else if (!['--render', '--json', '--quiet', '-h', '--help'].includes(a)) {
    console.error('未知参数: ' + a);
    console.error('用法: node .agent-presets/geo-teacher/skills/geo-question-generator/scripts/check-package.mjs --task <taskId> [--out <dir>] [--render] [--json] [--quiet]');
    process.exit(2);
  }
}
if (help || !opts.task) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(opts.task ? 0 : 2);
}

// ── 输出根解析 ──────────────────────────────────────────────────────────
function readUserConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function resolveOutputRoot() {
  if (opts.out) return { root: opts.out, from: '--out' };
  if (process.env.GEO_QUESTION_OUTPUT_ROOT) return { root: process.env.GEO_QUESTION_OUTPUT_ROOT, from: 'env GEO_QUESTION_OUTPUT_ROOT' };
  const cfg = readUserConfig();
  const cfgDir = dirname(CONFIG_PATH);
  const abs = (p) => (isAbsolute(p) ? p : join(cfgDir, p));
  if (cfg.questionOutputRoot) return { root: abs(cfg.questionOutputRoot), from: 'config.json:questionOutputRoot' };
  if (cfg.outputPath) return { root: join(abs(cfg.outputPath), '出题'), from: 'config.json:outputPath + /出题' };
  if (cfg.workspaceRoot) return { root: join(abs(cfg.workspaceRoot), 'outputs', '出题'), from: 'config.json:workspaceRoot + /outputs/出题' };
  return { root: join(REPO_ROOT, 'outputs', '出题'), from: '仓库兜底 <repo>/outputs/出题' };
}

// ── 载入实现（唯一实现，插件侧同源） ────────────────────────────────────
let impl;
try {
  impl = await import(pathToFileURL(MODULE_FILE).href);
} catch (e) {
  console.error('无法载入校验实现 ' + MODULE_FILE + '：' + ((e && e.message) || e));
  process.exit(3);
}

const { root, from } = resolveOutputRoot();
const resolved = impl.resolveTaskDir(root, opts.task);
if (!resolved.ok) {
  console.error('输出根/taskId 解析失败：' + resolved.error);
  process.exit(2);
}
const taskDir = resolved.dir;
const pkgFile = join(taskDir, 'package.json');
if (!existsSync(pkgFile)) {
  console.error('找不到命题包：' + pkgFile);
  console.error('（输出根来自：' + from + '；可用 --out 指定）');
  process.exit(3);
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error('package.json 不是合法 JSON：' + ((e && e.message) || e));
  process.exit(3);
}
let schema;
try {
  schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error('无法读取 schema：' + SCHEMA_FILE + '：' + ((e && e.message) || e));
  process.exit(3);
}

// 磁盘上能核实的项：附件存在性（相对任务目录）
const fileExists = (rel) => {
  try { return existsSync(isAbsolute(rel) ? rel : join(taskDir, rel)); } catch { return false; }
};

const findings = impl.validatePackage(pkg, { schema, fileExists });
const report = impl.buildValidationReport(pkg, findings, {
  validator: 'plugins/question/package.js',
  validatedAt: new Date().toISOString(),
});

// ── 输出 ────────────────────────────────────────────────────────────────
function printHuman() {
  const r = report;
  console.log('命题包校验：' + r.taskId + '（revision ' + r.packageRevision + '，题型 ' + (r.questionType || '(未声明)') + '）');
  console.log('结构：' + (r.structureOk ? '通过' : '不通过') + '（fail ' + r.summary.fail + ' / warn ' + r.summary.warn + ' / info ' + r.summary.info + '）');
  const claimText = r.readinessClaim === 'equal' ? '（一致）'
    : r.readinessClaim === 'over' ? '（**声明高于结构可支撑**）'
    : '（声明保守，低于结构可支撑）';
  console.log('完成度：声明 ' + r.declaredReadiness + '，结构可支撑 ' + r.effectiveReadiness + claimText);
  console.log('门禁：');
  for (const g of r.gates) {
    console.log('  ' + g.id + ' ' + g.name.padEnd(6, '　') + ' 结构 ' + g.structural.padEnd(14) + ' 语义 ' + g.semantic);
  }
  if (r.usableBlockers.length) {
    console.log('阻止「可使用」的项：');
    for (const b of r.usableBlockers) console.log('  - ' + b);
  }
  if (r.findings.length) {
    console.log('发现：');
    for (const f of r.findings) console.log('  [' + f.level + '] ' + f.gate + ' ' + f.pointer + '  ' + f.message);
  }
}
if (opts.json) console.log(JSON.stringify(report, null, 2));
else if (opts.quiet) console.log((report.structureOk ? 'PASS' : 'FAIL') + ' ' + report.taskId + ' r' + report.packageRevision + ' fail=' + report.summary.fail + ' warn=' + report.summary.warn);
else printHuman();

// ── 渲染（仅 --render） ─────────────────────────────────────────────────
if (opts.render) {
  const outputs = [
    ['draft.md', impl.renderMarkdown(pkg)],
    ['student.json', JSON.stringify(impl.buildStudentProjection(pkg), null, 2) + '\n'],
    ['teacher.json', JSON.stringify(impl.buildTeacherProjection(pkg), null, 2) + '\n'],
    ['validation.json', JSON.stringify(report, null, 2) + '\n'],
  ];
  try {
    mkdirSync(taskDir, { recursive: true });
    for (const [name, content] of outputs) writeFileSync(join(taskDir, name), content, 'utf8');
    if (!opts.quiet && !opts.json) console.log('已写出：' + outputs.map(([n]) => n).join('、') + ' → ' + taskDir);
    if (!report.structureOk) {
      console.error('注意：结构未通过，上述文件仅供排查，**不得作为交付物**。');
    }
  } catch (e) {
    console.error('写盘失败：' + ((e && e.message) || e));
    process.exit(3);
  }
} else if (!opts.quiet && !opts.json) {
  console.log('（只读校验，未写盘。加 --render 才生成 draft.md / student.json / teacher.json / validation.json）');
}

process.exit(report.structureOk ? 0 : 1);
