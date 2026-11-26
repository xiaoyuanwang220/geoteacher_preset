#!/usr/bin/env node
/**
 * geospark-ai — GeoSparkAI（高中地理教师辅助 Agent）一键安装 / 升级 / 检查 / 卸载 CLI
 *
 * 面向普通用户（npm 远程模式，无需 Git 与源码仓库）：
 *   npx geospark-ai@latest install --yes            一键安装（含预设 + UI + 独立真题数据包）
 *   npx geospark-ai@latest install --mirror --yes   使用国内 npmmirror 镜像加速安装
 *   npx geospark-ai@latest update --yes             一键升级到最新版本
 *   npx geospark-ai@latest check                    只读检查版本、接线与数据完整性
 *   npx geospark-ai@latest uninstall --yes          干净卸载（保留个人配置与产物）
 *
 * 面向本地源码开发（符号链接模式，由 scripts/setup.mjs 默认启用）：
 *   npx geospark-ai install --link <repoDir> --yes
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERIFIED_VERSION = '0.2.2-rc.5';
export const MINIMUM_VERSION = '0.2.1';
export const MIRROR_REGISTRY = 'https://registry.npmmirror.com';

export const MANAGED_PACKAGES = [
  {
    key: 'preset',
    name: 'geospark-ai-preset',
    relDir: join('.agent-presets', 'geo-teacher'),
    bundle: true
  },
  {
    key: 'ui',
    name: 'geospark-ai-ui',
    relDir: join('packages', 'dsh-geo-teacher-ui'),
    bundle: true
  },
  {
    key: 'data',
    name: 'geospark-ai-data',
    relDir: join('packages', 'dsh-geo-teacher-data'),
    bundle: false,
    optionalData: true
  }
];

// 历史开发期旧包名：升级或卸载时自动清理，但绝不触碰其它 @geo-edu/* 私有包（如 dsh-modelcheck）。
export const LEGACY_PACKAGE_NAMES = [
  '@geo-edu/dsh-geo-teacher-preset',
  '@geo-edu/dsh-geo-teacher-ui',
  '@geo-edu/dsh-geo-teacher-data'
];

const colors = {
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  err: '\u001b[31m',
  dim: '\u001b[2m',
  reset: '\u001b[0m'
};
const ok = (s) => `${colors.ok}✓${colors.reset} ${s}`;
const warn = (s) => `${colors.warn}!${colors.reset} ${s}`;
const fail = (s) => `${colors.err}✗${colors.reset} ${s}`;
const dim = (s) => `${colors.dim}${s}${colors.reset}`;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

export function parseVersion(version) {
  const m = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || '',
    raw: String(version).trim()
  };
}

export function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return NaN;
  for (const key of ['major', 'minor', 'patch']) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  return x.prerelease.localeCompare(y.prerelease, 'en', { numeric: true });
}

function runtimeInfo(file) {
  try {
    const info = readJson(file);
    return info && info.desktopVersion ? { version: String(info.desktopVersion), file } : null;
  } catch {
    return null;
  }
}

function desktopInstallInfo() {
  if (process.platform !== 'win32') return null;
  const uninstallKeys = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ];
  for (const key of uninstallKeys) {
    let output;
    try {
      output = execFileSync('reg.exe', ['query', key, '/s', '/f', 'DeepSeek Harness', '/d'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      continue;
    }
    const block = output.split(/\r?\n\r?\n/).find((part) => /DisplayName\s+REG_SZ\s+DeepSeek Harness/i.test(part));
    if (!block) continue;
    const keyLine = (block.match(/^(HKEY_[^\r\n]+)$/m) || [])[1];
    if (!keyLine) continue;
    let full;
    try {
      full = execFileSync('reg.exe', ['query', keyLine], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      continue;
    }
    const version = (full.match(/DisplayVersion\s+REG_SZ\s+(\S+)/i) || [])[1] || null;
    const location = (full.match(/InstallLocation\s+REG_SZ\s+(.+?)\s*$/im) || [])[1] || null;
    if (version || location) return { version, location };
  }
  return null;
}

export function resolveRuntime(dshHome) {
  const candidates = [];
  const install = desktopInstallInfo();
  if (install && install.location) {
    const dir = join(install.location, 'resources', 'runtime', 'primary-runtime');
    const info = runtimeInfo(join(dir, 'runtime.json'));
    if (info) candidates.push({ ...info, dir, source: '安装包内置 runtime' });
  }
  if (candidates.length === 0 && install && install.version) {
    candidates.push({ version: install.version, file: null, dir: null, source: 'Windows 安装注册信息' });
  }
  const legacyRoot = join(dshHome, 'dsh-runtimes');
  if (existsSync(legacyRoot)) {
    for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(legacyRoot, entry.name);
      const info = runtimeInfo(join(dir, 'runtime.json'));
      if (info) candidates.push({ ...info, dir, source: '$DSH_HOME/dsh-runtimes（旧版副本）' });
    }
  }
  let best = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const order = compareVersion(candidate.version, best.version);
    if (!Number.isNaN(order) && order > 0) best = candidate;
  }
  return best;
}

function pnpmCommand(dshHome) {
  const runtime = resolveRuntime(dshHome);
  const roots = [];
  if (runtime && runtime.dir) roots.push(runtime.dir);
  roots.push(join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime'));
  for (const root of roots) {
    const candidates = [
      join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
      join(root, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { kind: 'runtime', file: candidate };
    }
  }
  return { kind: 'path', file: 'pnpm' };
}

function countFiles(dir, predicate) {
  if (!dir || !existsSync(dir)) return 0;
  let count = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (predicate(full)) count += 1;
    }
  };
  walk(dir);
  return count;
}

export function parseCliArgs(rawArgs, defaults = {}) {
  const opts = {
    action: 'install',
    check: false,
    dryRun: false,
    yes: false,
    uninstall: false,
    update: false,
    noData: false,
    help: false,
    profile: defaults.profile || 'desktop',
    linkDir: defaults.linkDir || '',
    tarballDir: '',
    tag: 'latest',
    registry: ''
  };

  let explicitAction = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (!explicitAction && ['install', 'update', 'upgrade', 'check', 'status', 'uninstall', 'remove', 'help'].includes(arg)) {
      explicitAction = true;
      if (arg === 'upgrade') opts.action = 'update';
      else if (arg === 'status') opts.action = 'check';
      else if (arg === 'remove') opts.action = 'uninstall';
      else if (arg === 'help') opts.help = true;
      else opts.action = arg;
      continue;
    }
    if (arg === '--check') { opts.check = true; opts.action = 'check'; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === '--yes' || arg === '-y') { opts.yes = true; continue; }
    if (arg === '--uninstall') { opts.uninstall = true; opts.action = 'uninstall'; continue; }
    if (arg === '--update') { opts.update = true; opts.action = 'update'; continue; }
    if (arg === '--no-data') { opts.noData = true; continue; }
    if (arg === '--npm') { opts.linkDir = ''; continue; }
    if (arg === '--mirror') { opts.registry = MIRROR_REGISTRY; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--profile') {
      const val = rawArgs[i + 1];
      if (!val || val.startsWith('--')) throw new Error('参数 --profile 缺少名称');
      opts.profile = val;
      i++;
      continue;
    }
    if (arg === '--link') {
      const next = rawArgs[i + 1];
      if (next && !next.startsWith('-')) {
        opts.linkDir = resolve(next);
        i++;
      } else {
        opts.linkDir = resolve(process.cwd());
      }
      continue;
    }
    if (arg === '--tarball-dir') {
      const val = rawArgs[i + 1];
      if (!val || val.startsWith('--')) throw new Error('参数 --tarball-dir 缺少目录路径');
      opts.tarballDir = resolve(val);
      i++;
      continue;
    }
    if (arg === '--tag') {
      const val = rawArgs[i + 1];
      if (!val || val.startsWith('--')) throw new Error('参数 --tag 缺少版本或 dist-tag');
      opts.tag = val;
      i++;
      continue;
    }
    if (arg === '--registry') {
      const val = rawArgs[i + 1];
      if (!val || val.startsWith('--')) throw new Error('参数 --registry 缺少镜像地址');
      opts.registry = val;
      i++;
      continue;
    }
    throw new Error(`未知参数: ${arg}\n运行 npx geospark-ai --help 查看用法。`);
  }
  return opts;
}

function findTarballFor(tarballDir, pkgName) {
  if (!existsSync(tarballDir)) throw new Error(`tarball 目录不存在：${tarballDir}`);
  const prefix = pkgName.replace(/^@/, '').replace(/\//g, '-') + '-';
  const matches = readdirSync(tarballDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.tgz'))
    .sort();
  if (!matches.length) throw new Error(`在 ${tarballDir} 中未找到 ${pkgName} 的 .tgz 包`);
  return 'file:' + join(tarballDir, matches[matches.length - 1]).replace(/\\/g, '/');
}

function targetSpecFor(pkg, opts) {
  if (opts.linkDir) {
    return 'link:' + join(opts.linkDir, pkg.relDir).replace(/\\/g, '/');
  }
  if (opts.tarballDir) {
    return findTarballFor(opts.tarballDir, pkg.name);
  }
  return opts.tag || 'latest';
}

export function buildDesiredManifest(manifest, opts) {
  const next = JSON.parse(JSON.stringify(manifest || {}));
  next.dependencies = { ...(next.dependencies || {}) };

  // 清理旧版 @geo-edu/dsh-geo-teacher-* 遗留项（保留用户其它依赖）
  for (const legacy of LEGACY_PACKAGE_NAMES) {
    delete next.dependencies[legacy];
  }
  if (opts.noData) {
    delete next.dependencies['geospark-ai-data'];
  }

  const activePkgs = MANAGED_PACKAGES.filter((pkg) => !(opts.noData && pkg.optionalData));
  for (const pkg of activePkgs) {
    next.dependencies[pkg.name] = targetSpecFor(pkg, opts);
  }

  next.dsh = { ...(next.dsh || {}) };
  next.dsh.profile = { ...(next.dsh.profile || {}) };
  // DSH 规范：仅声明 dsh.bundle 的组合包入 bundles；纯数据包绝不入 bundles。
  const nonBundleOrRemoved = new Set([
    ...LEGACY_PACKAGE_NAMES,
    ...MANAGED_PACKAGES.filter((pkg) => !pkg.bundle).map((pkg) => pkg.name)
  ]);
  const bundles = (Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : [])
    .filter((name) => !nonBundleOrRemoved.has(name));
  for (const pkg of activePkgs) {
    if (pkg.bundle && !bundles.includes(pkg.name)) bundles.push(pkg.name);
  }
  next.dsh.profile.bundles = bundles;
  return next;
}

function manifestDiff(before, after) {
  const lines = [];
  const beforeDeps = (before && before.dependencies) || {};
  const afterDeps = (after && after.dependencies) || {};
  for (const legacy of LEGACY_PACKAGE_NAMES) {
    if (Object.hasOwn(beforeDeps, legacy) && !Object.hasOwn(afterDeps, legacy)) {
      lines.push(`  - dependencies["${legacy}"]（迁移清理旧包名）`);
    }
  }
  for (const pkg of MANAGED_PACKAGES) {
    if (beforeDeps[pkg.name] !== afterDeps[pkg.name]) {
      if (afterDeps[pkg.name] === undefined) {
        lines.push(`  - dependencies["${pkg.name}"]`);
      } else {
        lines.push(`  + dependencies["${pkg.name}"] = "${afterDeps[pkg.name]}"`);
      }
    }
  }
  const beforeBundles = (((before || {}).dsh || {}).profile || {}).bundles || [];
  const afterBundles = (((after || {}).dsh || {}).profile || {}).bundles || [];
  for (const legacy of LEGACY_PACKAGE_NAMES) {
    if (beforeBundles.includes(legacy) && !afterBundles.includes(legacy)) {
      lines.push(`  - dsh.profile.bundles -= "${legacy}"`);
    }
  }
  for (const pkg of MANAGED_PACKAGES) {
    if (pkg.bundle && !beforeBundles.includes(pkg.name) && afterBundles.includes(pkg.name)) {
      lines.push(`  + dsh.profile.bundles += "${pkg.name}"`);
    }
  }
  return lines;
}

function readInstalledVersions(profileDir) {
  const manifestFile = join(profileDir, 'package.json');
  const out = {};
  if (!existsSync(manifestFile)) return out;
  const req = createRequire(manifestFile);
  for (const pkg of MANAGED_PACKAGES) {
    try {
      const pkgJsonPath = req.resolve(pkg.name + '/package.json');
      const info = readJson(pkgJsonPath);
      out[pkg.name] = { version: info.version || 'unknown', dir: dirname(pkgJsonPath) };
    } catch {
      out[pkg.name] = null;
    }
  }
  return out;
}

export function verifyProfileInstallation(profileDir, opts = {}) {
  const problems = [];
  const manifestFile = join(profileDir, 'package.json');
  let manifest = null;
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    problems.push(`profile/package.json 无法解析：${error.message}`);
    return { problems, manifest: null, resolvedDirs: {} };
  }

  const deps = manifest.dependencies || {};
  const bundles = (((manifest.dsh || {}).profile || {}).bundles) || [];
  const expectData = opts.noData ? false : Boolean(deps['geospark-ai-data'] || !opts.allowMissingData);
  const activePkgs = MANAGED_PACKAGES.filter((pkg) => !(pkg.optionalData && !expectData));

  for (const legacy of LEGACY_PACKAGE_NAMES) {
    if (Object.hasOwn(deps, legacy)) problems.push(`存在待迁移的旧依赖项：${legacy}`);
    if (bundles.includes(legacy)) problems.push(`bundles 仍含旧包名：${legacy}`);
  }

  for (const pkg of activePkgs) {
    const dep = deps[pkg.name];
    if (!dep) problems.push(`依赖缺失：${pkg.name}`);
    else if (opts.linkDir && !String(dep).startsWith('link:')) {
      problems.push(`开发模式依赖不是 link：${pkg.name} = ${dep}`);
    }
    if (pkg.bundle && !bundles.includes(pkg.name)) problems.push(`bundles 未列入：${pkg.name}`);
    if (!pkg.bundle && bundles.includes(pkg.name)) problems.push(`非 bundle 数据包误列入 bundles：${pkg.name}`);
    if (opts.linkDir) {
      const localDir = join(opts.linkDir, pkg.relDir);
      if (!existsSync(join(localDir, 'package.json'))) problems.push(`本地包目录缺少 package.json：${localDir}`);
      if (pkg.bundle && !existsSync(join(localDir, 'cordis.patch.yml'))) {
        problems.push(`本地包目录缺少 cordis.patch.yml：${localDir}`);
      }
    }
  }

  const resolvedDirs = {};
  const req = createRequire(manifestFile);
  for (const pkg of activePkgs) {
    try {
      const pkgJsonFile = req.resolve(pkg.name + '/package.json');
      const pkgRoot = dirname(pkgJsonFile);
      resolvedDirs[pkg.key] = pkgRoot;
      if (pkg.bundle && !existsSync(join(pkgRoot, 'cordis.patch.yml'))) {
        problems.push(`已安装包缺少 cordis.patch.yml：${pkg.name}（${pkgRoot}）`);
      }
    } catch {
      problems.push(`node_modules 解析失败（尚未安装或链接未生成）：${pkg.name}`);
    }
  }

  if (opts.linkDir && problems.length === 0) {
    for (const pkg of activePkgs) {
      const expectedDir = join(opts.linkDir, pkg.relDir);
      const linkPath = join(profileDir, 'node_modules', pkg.name);
      if (!existsSync(linkPath)) {
        problems.push(`缺少 node_modules 符号链接：${linkPath}`);
        continue;
      }
      try {
        const info = lstatSync(linkPath);
        if (!info.isSymbolicLink()) {
          problems.push(`node_modules 条目不是符号链接：${linkPath}`);
          continue;
        }
        const target = realpathSync(linkPath);
        if (resolve(target).toLowerCase() !== resolve(expectedDir).toLowerCase()) {
          problems.push(`符号链接指向错误：${linkPath} → ${target}（期望 ${expectedDir}）`);
        }
      } catch (error) {
        problems.push(`读取符号链接失败：${linkPath} — ${error.message}`);
      }
    }
  }

  return { problems, manifest, resolvedDirs };
}

function summarizeDataDirs(resolvedDirs, opts) {
  const presetRoot = resolvedDirs.preset
    || (opts.linkDir ? join(opts.linkDir, '.agent-presets', 'geo-teacher') : '');
  const dataRoot = resolvedDirs.data
    || (opts.linkDir ? join(opts.linkDir, 'packages', 'dsh-geo-teacher-data') : '');

  const configDir = presetRoot ? join(presetRoot, 'data', 'config') : '';
  const bankDir = dataRoot ? join(dataRoot, 'obsidian_vault', '04_题目') : '';
  const imgDir = dataRoot ? join(dataRoot, 'obsidian_vault', '90_附件') : '';

  const knowledgeYaml = countFiles(configDir, (f) => /\.ya?ml$/i.test(f));
  const bankMarkdown = countFiles(bankDir, (f) => f.endsWith('.md'));
  const bankImages = countFiles(imgDir, (f) => /\.(png|jpe?g|webp|gif)$/i.test(f));

  const lines = [];
  let missing = false;
  if (knowledgeYaml === 0) {
    missing = true;
    lines.push(warn(`预设包未找到随附考点库 YAML${configDir ? '：' + configDir : ''}`));
  } else {
    lines.push(ok(`内置考点库：${knowledgeYaml} 个 YAML（${configDir}）`));
  }

  if (opts.noData && !dataRoot) {
    lines.push(dim(`  （已指定 --no-data：跳过默认真题数据包，请在 ~/.dsh/geo-teacher/config.json 配置自有 questionBankPath）`));
  } else if (bankMarkdown === 0) {
    missing = true;
    lines.push(warn(`未找到真题数据包 Markdown${bankDir ? '：' + bankDir : ''}`));
  } else {
    lines.push(ok(`独立真题数据包：${bankMarkdown} 份 Markdown、${bankImages} 张图片（${bankDir}）`));
  }

  return { missing, lines, summary: { knowledgeYaml, bankMarkdown, bankImages } };
}

function checkDshVersion(dshHome) {
  const runtime = resolveRuntime(dshHome);
  if (!runtime) {
    return {
      ok: false,
      code: 'NO_RUNTIME',
      message: `未找到 DSH 运行时：已查找桌面安装目录 resources/runtime/primary-runtime/runtime.json 与 ${join(dshHome, 'dsh-runtimes')}。请先安装并启动一次 DSH Desktop。`
    };
  }
  const version = runtime.version;
  const parsed = parseVersion(version);
  const minimum = parseVersion(MINIMUM_VERSION);
  if (!parsed || !minimum) {
    return { ok: false, code: 'BAD_VERSION', message: `无法解析 DSH 版本：${version}` };
  }
  const older = parsed.major < minimum.major
    || (parsed.major === minimum.major && parsed.minor < minimum.minor)
    || (parsed.major === minimum.major && parsed.minor === minimum.minor && parsed.patch < minimum.patch);
  if (older) {
    return {
      ok: false,
      code: 'TOO_OLD',
      message: `DSH 版本 ${version} 低于最低要求 ${MINIMUM_VERSION}。请先升级 DSH Desktop（推荐已验证版本 ${VERIFIED_VERSION}）。`
    };
  }
  const verified = version === VERIFIED_VERSION || compareVersion(version, VERIFIED_VERSION) === 0;
  return {
    ok: true,
    version,
    source: runtime.source,
    warning: verified
      ? ''
      : `当前 DSH 版本 ${version} 尚未完整回归；本项目现行验证基线为 ${VERIFIED_VERSION}。安装将继续，如遇异常请核对版本基线。`
  };
}

function restoreBackup(backupDir, profileDir) {
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const source = join(backupDir, name);
    if (existsSync(source)) copyFileSync(source, join(profileDir, name));
  }
}

function removeStaleLinks(profileDir, names) {
  for (const pkgName of names) {
    const linkPath = join(profileDir, 'node_modules', ...pkgName.split('/'));
    try {
      if (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch { /* ignore */ }
  }
  try {
    const legacyScope = join(profileDir, 'node_modules', '@geo-edu');
    if (existsSync(legacyScope) && readdirSync(legacyScope).length === 0) {
      rmSync(legacyScope, { recursive: true, force: true });
    }
  } catch { /* ignore */ }
}

function printHelp(say) {
  say('用法：');
  say('  npx geospark-ai@latest install --yes              一键安装（预设 + 输入区 UI + 真题数据包）');
  say('  npx geospark-ai@latest install --mirror --yes     使用国内 npmmirror 镜像加速安装');
  say('  npx geospark-ai@latest install --no-data --yes    仅安装预设与 UI（不装默认真题包）');
  say('  npx geospark-ai@latest update --yes               一键拉取并升级到最新版本');
  say('  npx geospark-ai@latest check                      只读检查版本、接线与数据状态');
  say('  npx geospark-ai@latest uninstall --yes            干净卸载（保留个人配置与产物）');
  say();
  say('高级与开发选项：');
  say('  --profile <name>         指定目标 DSH profile（默认 desktop）');
  say('  --registry <url>         指定 npm/pnpm 下载源地址');
  say('  --tag <tag|semver>       指定安装的 dist-tag 或版本范围（默认 latest）');
  say('  --tarball-dir <dir>      从本地目录离线安装 .tgz 包');
  say('  --link <repoDir>         本地仓库符号链接开发模式');
  say('  --dry-run                仅预览将写入 profile/package.json 的差异，不落盘');
}

export function runCli(rawArgs = process.argv.slice(2), envOptions = {}) {
  const say = envOptions.stdout || ((s = '') => console.log(s));
  const errSay = envOptions.stderr || ((s = '') => console.error(s));
  const dshHome = envOptions.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh');

  let opts;
  try {
    opts = parseCliArgs(rawArgs, { linkDir: envOptions.defaultLinkDir || '' });
  } catch (err) {
    errSay(fail(err.message || String(err)));
    return 2;
  }

  say('GeoSparkAI · 地理教师辅助安装器');
  say(dim(`模式：${opts.linkDir ? '本地仓库 link (' + opts.linkDir + ')' : opts.tarballDir ? '离线 tarball (' + opts.tarballDir + ')' : 'npm 远程包 (' + opts.tag + ')'}`));
  say(dim(`DSH_HOME：${dshHome}  ｜  profile：${opts.profile}`));
  say();

  if (opts.help) {
    printHelp(say);
    return 0;
  }

  const profileDir = join(dshHome, 'profiles', opts.profile);

  function runPnpm(pnpmArgs) {
    const pnpm = envOptions.pnpmBin
      ? { kind: 'custom', file: envOptions.pnpmBin }
      : pnpmCommand(dshHome);
    const fullArgs = [...pnpmArgs];
    if (opts.registry) fullArgs.push(`--registry=${opts.registry}`);
    const spawnArgs = pnpm.kind === 'runtime' ? [pnpm.file, ...fullArgs] : fullArgs;
    const command = pnpm.kind === 'runtime' ? process.execPath : pnpm.file;
    say(dim(`$ ${command} ${spawnArgs.join(' ')}    (cwd: ${profileDir})`));
    const result = spawnSync(command, spawnArgs, {
      cwd: profileDir,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      shell: process.platform === 'win32' && pnpm.kind !== 'runtime',
      env: { ...process.env, DSH_HOME: dshHome }
    });
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    const tail = (text, lines = 12) => text.split('\n').slice(-lines).join('\n');
    if (stdout) say(tail(stdout));
    if (stderr) errSay(tail(stderr));
    return { status: result.status === null ? 1 : result.status };
  }

  // ── 1. 只读检查（check） ───────────────────────────────────────────────
  if (opts.action === 'check') {
    say('== 检查（只读） ==');
    const ver = envOptions.skipVersionCheck
      ? { ok: true, version: VERIFIED_VERSION, source: 'test', warning: '' }
      : checkDshVersion(dshHome);
    if (!ver.ok) {
      errSay(fail(ver.message));
      return 1;
    }
    say(ok(`DSH 版本：${ver.version}${ver.warning ? '（未完整验证）' : '（已验证）'}${ver.source ? dim(` · 来源：${ver.source}`) : ''}`));
    if (ver.warning) say(warn(ver.warning));
    if (!existsSync(join(profileDir, 'package.json'))) {
      errSay(fail(`profile 清单不存在：${join(profileDir, 'package.json')}`));
      return 1;
    }
    say(ok(`profile：${profileDir}`));

    const { problems, manifest, resolvedDirs } = verifyProfileInstallation(profileDir, {
      ...opts,
      allowMissingData: true
    });
    const versions = readInstalledVersions(profileDir);
    const bundles = (((manifest || {}).dsh || {}).profile || {}).bundles || [];
    const deps = (manifest && manifest.dependencies) || {};

    for (const pkg of MANAGED_PACKAGES) {
      const dep = deps[pkg.name];
      const installedVer = versions[pkg.name] ? `v${versions[pkg.name].version}` : '未安装';
      if (pkg.bundle) {
        const listed = bundles.includes(pkg.name);
        say(`${dep && listed && versions[pkg.name] ? ok('已就绪') : warn('未就绪')} ${pkg.name}（${installedVer}${dep ? ' · ' + dep : ''}）${listed ? '' : ' — 未列入 bundles'}`);
      } else if (!dep && opts.noData) {
        say(dim(`  - ${pkg.name}：已跳过（--no-data）`));
      } else {
        const notInBundles = !bundles.includes(pkg.name);
        say(`${dep && notInBundles && versions[pkg.name] ? ok('已就绪（数据包）') : warn('未安装（可选数据包）')} ${pkg.name}（${installedVer}${dep ? ' · ' + dep : ''}）${notInBundles ? '' : ' — 不应列入 bundles'}`);
      }
    }

    say(problems.length === 0
      ? ok('静态接线、node_modules 解析与包结构全部正常')
      : warn(`发现待处理项 ${problems.length} 项：`));
    for (const p of problems) say(`  - ${p}`);

    const data = summarizeDataDirs(resolvedDirs, {
      ...opts,
      noData: !deps['geospark-ai-data'] && !opts.linkDir
    });
    for (const line of data.lines) say(line);

    if (problems.length > 0 || data.missing) {
      say();
      say(`修复命令：${opts.linkDir ? 'node scripts/setup.mjs --yes' : 'npx geospark-ai@latest install --yes'}`);
      return 1;
    }
    return 0;
  }

  // ── 2. 卸载（uninstall） ───────────────────────────────────────────────
  if (opts.action === 'uninstall') {
    say('== 卸载 ==');
    const manifestFile = join(profileDir, 'package.json');
    if (!existsSync(manifestFile)) throw new Error(`profile 清单不存在：${manifestFile}`);
    const before = readJson(manifestFile);
    const after = JSON.parse(JSON.stringify(before));
    const allTargets = [...MANAGED_PACKAGES.map((p) => p.name), ...LEGACY_PACKAGE_NAMES];
    let changed = false;

    for (const name of allTargets) {
      if (after.dependencies && Object.hasOwn(after.dependencies, name)) {
        delete after.dependencies[name];
        changed = true;
      }
    }
    const bundles = ((((after.dsh || {}).profile) || {}).bundles) || [];
    const kept = bundles.filter((name) => !allTargets.includes(name));
    if (kept.length !== bundles.length) {
      after.dsh.profile.bundles = kept;
      changed = true;
    }

    if (!changed) {
      say(ok('未发现 GeoSparkAI 相关依赖与 bundle 项，无需卸载'));
      return 0;
    }
    say('将从 profile 移除：');
    for (const pkg of MANAGED_PACKAGES) say(`  - ${pkg.name}`);
    if (opts.dryRun) {
      say(dim('--dry-run：未写入任何文件。'));
      return 0;
    }
    if (!opts.yes) {
      errSay(fail('未加 --yes，未写入任何文件。确认后请加 --yes 执行卸载。'));
      return 1;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(profileDir, '.geo-teacher-setup', timestamp + '-uninstall');
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(manifestFile, join(backupDir, 'package.json'));
    const lockFile = join(profileDir, 'pnpm-lock.yaml');
    if (existsSync(lockFile)) copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml'));

    writeJson(manifestFile, after);
    const installed = runPnpm(['install', '--prefer-offline', '--no-frozen-lockfile']);
    if (installed.status !== 0) {
      errSay(fail('pnpm install 同步失败，正在恢复备份清单…'));
      restoreBackup(backupDir, profileDir);
      throw new Error('卸载同步失败，已恢复备份清单。');
    }
    removeStaleLinks(profileDir, allTargets);

    const checkReq = createRequire(manifestFile);
    const leftovers = [];
    for (const pkg of MANAGED_PACKAGES) {
      try {
        checkReq.resolve(pkg.name + '/package.json');
        leftovers.push(`包仍可解析：${pkg.name}`);
      } catch { /* expected */ }
    }
    if (leftovers.length) {
      throw new Error('卸载后仍有残留：' + leftovers.join('；'));
    }

    say();
    say(ok('已干净卸载 GeoSparkAI 组件。'));
    say(`个人配置与历史产物已保留在：${join(dshHome, 'geo-teacher')}`);
    say('请完全退出并重启 DSH Desktop 使卸载生效。');
    return 0;
  }

  // ── 3. 安装 / 升级（install | update） ─────────────────────────────────
  const isUpdate = opts.action === 'update';
  say(isUpdate ? '== 一键升级 ==' : '== 一键安装 ==');
  const ver = envOptions.skipVersionCheck
    ? { ok: true, version: VERIFIED_VERSION, source: 'test', warning: '' }
    : checkDshVersion(dshHome);
  if (!ver.ok) throw new Error(ver.message);
  if (ver.warning) say(warn(ver.warning));

  const manifestFile = join(profileDir, 'package.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`profile 清单不存在：${manifestFile}。请先启动一次 DSH Desktop 完成初始化。`);
  }

  const beforeManifest = readJson(manifestFile);
  // update 模式下若用户此前未安装 geospark-ai-data 且未显式要求，沿用其是否安装数据包的偏好
  const effectiveOpts = { ...opts };
  if (isUpdate && !opts.noData && beforeManifest.dependencies) {
    const hadPreset = Boolean(beforeManifest.dependencies['geospark-ai-preset']);
    const hadData = Boolean(beforeManifest.dependencies['geospark-ai-data']);
    if (hadPreset && !hadData && !opts.linkDir && !opts.tarballDir) {
      effectiveOpts.noData = true;
    }
  }

  const beforeVersions = readInstalledVersions(profileDir);
  const afterManifest = buildDesiredManifest(beforeManifest, effectiveOpts);
  const diff = manifestDiff(beforeManifest, afterManifest);

  if (diff.length === 0) {
    say(ok(isUpdate ? 'profile 清单依赖项已就位，准备拉取并核对最新版本…' : 'profile 清单已是目标状态'));
  } else {
    say('将更新 profile 清单：');
    for (const line of diff) say(line);
  }

  if (opts.dryRun) {
    say();
    say(dim('--dry-run：未写入任何文件。'));
    return 0;
  }
  if (!opts.yes) {
    say();
    errSay(fail(`未加 --yes，未写入任何文件。确认无误后请附加 --yes 执行。`));
    return 1;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(profileDir, '.geo-teacher-setup', timestamp);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(manifestFile, join(backupDir, 'package.json'));
  const lockFile = join(profileDir, 'pnpm-lock.yaml');
  const hadLock = existsSync(lockFile);
  if (hadLock) copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml'));
  say(ok(`已备份原清单至 ${backupDir}`));

  writeJson(manifestFile, afterManifest);
  removeStaleLinks(profileDir, LEGACY_PACKAGE_NAMES);

  // update 在线模式不加 --prefer-offline，确保从远端拉取最新包版本
  const pnpmArgs = (isUpdate && !effectiveOpts.linkDir && !effectiveOpts.tarballDir)
    ? ['up', ...MANAGED_PACKAGES.filter((p) => !(effectiveOpts.noData && p.optionalData)).map((p) => p.name), '--latest']
    : ['install', ...(effectiveOpts.linkDir || effectiveOpts.tarballDir ? ['--prefer-offline'] : []), '--no-frozen-lockfile'];

  // 若升级前尚未安装过，先走 install 再确保最新
  const needInitialInstall = MANAGED_PACKAGES
    .filter((p) => !(effectiveOpts.noData && p.optionalData))
    .some((p) => !beforeVersions[p.name]);
  const finalPnpmArgs = needInitialInstall
    ? ['install', '--no-frozen-lockfile']
    : pnpmArgs;

  const installed = runPnpm(finalPnpmArgs);
  if (installed.status !== 0) {
    errSay(fail('pnpm 安装失败，正在从备份恢复清单…'));
    restoreBackup(backupDir, profileDir);
    const repairArgs = hadLock ? ['install', '--frozen-lockfile'] : ['install', '--config.lockfile=false'];
    runPnpm(repairArgs);
    throw new Error('安装或升级失败，已恢复原清单（国内网络超时可附加 --mirror 使用镜像重试）。');
  }

  const { problems, resolvedDirs } = verifyProfileInstallation(profileDir, effectiveOpts);
  if (problems.length > 0) {
    errSay(fail('安装后静态校验未通过：'));
    for (const p of problems) errSay(`  - ${p}`);
    throw new Error('安装后静态校验失败。');
  }

  const data = summarizeDataDirs(resolvedDirs, effectiveOpts);
  for (const line of data.lines) say(line);
  if (data.missing) {
    throw new Error('数据包或内置考点库校验缺失，请检查安装包完整性。');
  }

  const afterVersions = readInstalledVersions(profileDir);
  say();
  say(ok(isUpdate ? '升级完成，当前组件版本：' : '安装完成，当前组件版本：'));
  for (const pkg of MANAGED_PACKAGES) {
    if (effectiveOpts.noData && pkg.optionalData) continue;
    const prev = beforeVersions[pkg.name] ? beforeVersions[pkg.name].version : null;
    const curr = afterVersions[pkg.name] ? afterVersions[pkg.name].version : 'unknown';
    const changeLabel = prev && prev !== curr ? `${prev} → ${curr}` : `${curr}${prev ? '（最新）' : ''}`;
    say(`  · ${pkg.name}：${changeLabel}`);
  }
  say();
  say('下一步：');
  say('  1. 完全退出 DSH Desktop 后重新启动（请确认托盘进程已退出）');
  say('  2. 新建「地理教师辅助」会话');
  say('  3. 输入 /geo-status 确认版本与题库状态');
  return 0;
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(fail((error && error.message) || String(error)));
    process.exitCode = 1;
  }
}
