#!/usr/bin/env node
/**
 * modelcheck-verify.mjs —— ModelCheck 插件的确定性静态检查
 *
 * 用法：node scripts/modelcheck-verify.mjs [--tests] [--runtime] [--json]
 * 退出码：0=通过  1=失败  2=用法错误  3=运行时不可达
 *
 * 检查边界（如实声明）：
 *   · 只做静态与结构检查，不验证 Loader 实际挂载、槽位渲染、iframe 取证链路；
 *     后三者属于安装后的运行时验收（见 docs/modelcheck/实施记录.md）。
 *   · 语法检查使用当前解释器（process.execPath），不依赖 PATH 中存在 node。
 *   · `--runtime` 读取 DSH_WEB_URL（不写死端口），探测 /modelcheck/api 与预览路由是否在线。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PKG_DIR = join(ROOT, 'packages', 'dsh-modelcheck');
const PKG_JSON = join(PKG_DIR, 'package.json');
const PATCH = join(PKG_DIR, 'cordis.patch.yml');
const FIXTURE = join(PKG_DIR, 'fixtures', 'project', '.modelcheck');

const args = process.argv.slice(2);
const known = ['--tests', '--runtime', '--json'];
const flags = { tests: args.includes('--tests'), runtime: args.includes('--runtime'), json: args.includes('--json') };
for (const a of args) {
  if (!known.includes(a)) {
    console.error('未知参数: ' + a);
    console.error('用法: node scripts/modelcheck-verify.mjs [--tests] [--runtime] [--json]');
    process.exit(2);
  }
}

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.message) || error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

// ── 1. 包清单与 patch ─────────────────────────────────────────
check('package.json 清单完整', () => {
  const pkg = readJson(PKG_JSON);
  assert(pkg.name === '@geo-edu/dsh-modelcheck', 'name 必须是 @geo-edu/dsh-modelcheck');
  assert(pkg.type === 'module', 'type 必须为 module');
  assert(pkg.main === 'index.js', 'main 必须是 index.js');
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', '缺少 dsh.bundle.patch');
  assert(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', '缺少 dsh.client.platform');
  for (const exp of ['.', './client', './package.json']) {
    assert(pkg.exports[exp], '缺少 exports[' + exp + ']');
    const target = join(PKG_DIR, pkg.exports[exp]);
    assert(existsSync(target), 'exports 目标不存在: ' + pkg.exports[exp]);
  }
  for (const file of ['index.js', 'client.js', 'README.md']) {
    assert(existsSync(join(PKG_DIR, file)), '缺少文件: ' + file);
  }
  return 'name/type/exports/dsh 元数据一致';
});

check('cordis.patch.yml 插入行正确', () => {
  const raw = readFileSync(PATCH, 'utf8');
  assert(/^-\s+insert:\s*$/m.test(raw), 'patch 必须是顶层 insert 列表');
  assert(/name:\s*['"]?@geo-edu\/dsh-modelcheck['"]?/.test(raw), 'patch 未插入 @geo-edu/dsh-modelcheck');
  assert(/id:\s*modelcheck\b/.test(raw.replace(/\r/g, '')), 'patch 行 id 应为 modelcheck');
  return 'insert 行与包名一致';
});

// ── 2. 语法检查 ───────────────────────────────────────────────
check('全部 JS 语法可解析', () => {
  const files = walk(PKG_DIR).filter((f) => /\.(js|mjs)$/.test(f) && !f.includes(join('node_modules')));
  assert(files.length >= 8, '插件文件数量异常（' + files.length + '），疑似结构缺失');
  const failures = [];
  for (const file of files) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      failures.push(relative(ROOT, file) + ': ' + String((error.stderr || error.message)).slice(0, 400));
    }
  }
  assert(failures.length === 0, '语法错误:\n' + failures.join('\n'));
  return files.length + ' 个文件通过';
});

// ── 3. 依赖边界：不 import 宿主包、不写作者机器路径 ───────────
check('宿主半边不 import 宿主包', () => {
  const files = walk(PKG_DIR).filter((f) => /\.(js|mjs)$/.test(f));
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"]@deepseek-ai\//.test(text) || /require\(\s*['"]@deepseek-ai\//.test(text)) {
      violations.push(relative(ROOT, file));
    }
  }
  assert(violations.length === 0, '发现宿主包 import: ' + violations.join(', '));
  return '无 @deepseek-ai/* 依赖';
});

check('客户端只 require react', () => {
  const text = readFileSync(join(PKG_DIR, 'client.js'), 'utf8');
  const requires = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const allowed = new Set(['react', 'react/jsx-runtime']);
  const illegal = requires.filter((name) => !allowed.has(name));
  assert(illegal.length === 0, '客户端出现未允许的 require: ' + illegal.join(', '));
  assert(/window\.__ModuleLoader__\.load\(\{/.test(text), '缺少 window.__ModuleLoader__.load 注册');
  return 'require: ' + (requires.join(', ') || '无');
});

check('不含作者机器绝对路径', () => {
  const files = walk(PKG_DIR).filter((f) => /\.(js|mjs|json|yml|html|md)$/.test(f));
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/[A-Za-z]:\\\\Users\\\\|[A-Za-z]:\\Users\\|E:\\geo_edu_agent/.test(text)) violations.push(relative(ROOT, file));
  }
  assert(violations.length === 0, '发现机器绝对路径: ' + violations.join(', '));
  return '无硬编码用户路径';
});

// ── 4. 路由字面量 ─────────────────────────────────────────────
check('路由字面量唯一且限定在 /modelcheck 前缀', () => {
  const files = walk(join(PKG_DIR, 'server')).concat([join(PKG_DIR, 'index.js')]).filter(existsSync);
  const routes = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/path:\s*['"](\/[^'"]*)['"]/g)) routes.push({ file: relative(ROOT, file), path: m[1] });
  }
  const dup = routes.filter((r, i) => routes.findIndex((x) => x.path === r.path) !== i);
  assert(dup.length === 0, '重复路由: ' + dup.map((d) => d.path).join(', '));
  const outside = routes.filter((r) => !r.path.startsWith('/modelcheck'));
  assert(outside.length === 0, '越界路由: ' + outside.map((r) => r.path).join(', '));
  return routes.map((r) => r.path).join(' , ') || '（路由以常量拼接，静态扫描为空）';
});

// ── 5. 夹具与数据契约 ─────────────────────────────────────────
check('夹具项目可解析且契约字段齐全', () => {
  const config = readJson(join(FIXTURE, 'config.json'));
  const components = readJson(join(FIXTURE, 'components.json'));
  const contract = readJson(join(FIXTURE, 'contract.json'));
  assert(config.preview && typeof config.preview.entry === 'string', 'config.preview.entry 缺失');
  assert(['three', 'svg', 'dom', 'image'].includes(config.route), 'config.route 非法');
  assert(Array.isArray(components.components) && components.components.length > 0, 'components 为空');
  assert(contract.status === 'confirmed', '夹具契约应为 confirmed');
  assert(Array.isArray(contract.criteria) && contract.criteria.length >= 3, '判据不足 3 条');
  const ids = new Set();
  for (const c of contract.criteria) {
    assert(c.id && !ids.has(c.id), '判据 id 缺失或重复: ' + c.id);
    ids.add(c.id);
    assert(['P0', 'P1', 'P2'].includes(c.level), '判据级别非法: ' + c.id);
    assert(typeof c.blocking === 'boolean', '判据缺少 blocking: ' + c.id);
    assert(['auto', 'visual', 'manual'].includes(c.method), '判据 method 非法: ' + c.id);
    assert(Array.isArray(c.depends), '判据缺少 depends: ' + c.id);
    assert(c.claim && String(c.claim).length > 4, '判据 claim 过短: ' + c.id);
  }
  assert(contract.criteria.some((c) => c.level === 'P0' && c.blocking === true), '缺少 P0 阻塞判据');
  return contract.criteria.length + ' 条判据 / ' + components.components.length + ' 个组件';
});

check('夹具项目文件存在', () => {
  for (const rel of ['index.html', 'src/config.js']) {
    assert(existsSync(join(PKG_DIR, 'fixtures', 'project', rel)), '缺少夹具文件: ' + rel);
  }
  return 'index.html + src/config.js';
});

// ── 6. 文档与测试 ─────────────────────────────────────────────
check('README 声明能力边界', () => {
  const text = readFileSync(join(PKG_DIR, 'README.md'), 'utf8');
  for (const keyword of ['未验证', 'inconclusive', '模型自证']) {
    assert(text.includes(keyword), 'README 缺少能力边界关键词: ' + keyword);
  }
  return 'README 含能力边界声明';
});

check('单元测试文件存在', () => {
  const testDir = join(PKG_DIR, 'test');
  assert(existsSync(testDir), '缺少 test/ 目录');
  const tests = readdirSync(testDir).filter((f) => /\.test\.mjs$/.test(f));
  assert(tests.length >= 3, '测试文件不足（' + tests.length + '）');
  return tests.length + ' 个测试文件';
});

// ── 7. 可选：跑单测 ───────────────────────────────────────────
if (flags.tests) {
  check('node --test 通过', () => {
    try {
      const testFiles = readdirSync(join(PKG_DIR, 'test'))
        .filter((name) => /\.test\.mjs$/.test(name))
        .map((name) => join(PKG_DIR, 'test', name));
      assert(testFiles.length > 0, '没有找到测试文件');
      const out = execFileSync(process.execPath, ['--test', ...testFiles], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      const pass = (out.match(/^# pass (\d+)/m) || [])[1] || (out.match(/^ℹ pass (\d+)/m) || [])[1];
      const fail = (out.match(/^# fail (\d+)/m) || [])[1] || (out.match(/^ℹ fail (\d+)/m) || [])[1];
      assert(fail === '0' || fail === undefined, '测试失败 ' + fail + ' 项');
      return 'pass=' + (pass || '?') + ' fail=' + (fail || '0');
    } catch (error) {
      const out = String(error.stdout || '') + String(error.stderr || '');
      throw new Error('测试失败:\n' + out.slice(-3000));
    }
  });
}

// ── 8. 可选：运行时探测 ───────────────────────────────────────
if (flags.runtime) {
  const base = process.env.DSH_WEB_URL;
  if (!base) {
    results.push({ name: '运行时探测', ok: false, detail: '未设置 DSH_WEB_URL（端口由系统分配，不能用固定端口猜测）' });
  } else {
    const probes = [
      ['/modelcheck/assets/bridge.js', (text) => /mc:collect|modelcheck/.test(text)],
      ['/modelcheck/api', (text) => text.length > 0]
    ];
    for (const [path, accept] of probes) {
      try {
        const response = await fetch(new URL(path, base), { method: path.endsWith('/api') ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: path.endsWith('/api') ? '{"action":"status","sessionId":"probe"}' : undefined });
        const text = await response.text();
        results.push({ name: '运行时 ' + path, ok: response.ok || response.status === 404, detail: 'HTTP ' + response.status + ' ' + (accept(text) ? '内容符合' : '内容未匹配') });
      } catch (error) {
        results.push({ name: '运行时 ' + path, ok: false, detail: String((error && error.message) || error) });
      }
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
if (flags.json) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const r of results) console.log((r.ok ? '  OK  ' : ' FAIL ') + r.name + (r.detail ? ' — ' + r.detail : ''));
  console.log('');
  console.log(failed.length === 0 ? 'modelcheck-verify: 全部通过' : 'modelcheck-verify: ' + failed.length + ' 项失败');
}
process.exit(failed.length === 0 ? 0 : 1);
