#!/usr/bin/env node
/**
 * scripts/setup.mjs — 地理教师辅助 · 一键安装/卸载器
 *
 * 用法：
 *   node scripts/setup.mjs --check         只读检查，不写任何文件
 *   node scripts/setup.mjs --dry-run       展示将要写入的清单差异，不落盘
 *   node scripts/setup.mjs --yes           执行安装（备份 → 写 profile 清单 → pnpm 安装 → 静态校验）
 *   node scripts/setup.mjs --uninstall --yes  卸载（移除本项目的依赖与 bundle 项）
 *   node scripts/setup.mjs --profile <name>   目标 profile（默认 desktop）
 *
 * 设计约束（见 docs/工作台聚合与一键安装方案.md）：
 *   - Desktop profile 由 Electron 应用独占，外部 `dsh plugin --profile desktop` 会被拒绝，
 *     因此这里直接操作 profile 目录（与桌面插件管理器底层一致）。
 *   - 只写清单不会加载：必须用运行时自带 pnpm 在 profile 目录安装一次，生成 node_modules 链接。
 *   - DSH 启动不会自动安装依赖，安装动作必须显式完成。
 *   - 只增/删本项目的两个依赖与两个 bundle 项；不重排既有顺序，不覆盖用户配置与数据。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(join(HERE, '..'));
const PROJECTS = [
  {
    name: '@geo-edu/dsh-geo-teacher-preset',
    dir: join(REPO_ROOT, '.agent-presets', 'geo-teacher')
  },
  {
    name: '@geo-edu/dsh-geo-teacher-ui',
    dir: join(REPO_ROOT, 'packages', 'dsh-geo-teacher-ui')
  }
];
const DATA_DIR = join(REPO_ROOT, 'data');
const BANK_DIR = join(DATA_DIR, 'obsidian_vault', '04_题目');
const CONFIG_DIR = join(DATA_DIR, 'config');
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const LEGACY_RUNTIME_ROOT = join(DSH_HOME, 'dsh-runtimes');
const RUNTIME_DIR = join(LEGACY_RUNTIME_ROOT, 'dsh-primary-runtime');
const VERIFIED_VERSION = '0.2.2-rc.1';
const MINIMUM_VERSION = '0.2.1';

const args = process.argv.slice(2);
const flags = {
  check: args.includes('--check'),
  dryRun: args.includes('--dry-run'),
  yes: args.includes('--yes'),
  uninstall: args.includes('--uninstall'),
  help: args.includes('--help') || args.includes('-h')
};
const profileFlagIndex = args.indexOf('--profile');
const profileName = profileFlagIndex >= 0 && args[profileFlagIndex + 1] ? args[profileFlagIndex + 1] : 'desktop';
const known = ['--check', '--dry-run', '--yes', '--uninstall', '--help', '-h', '--profile'];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--profile') { i++; continue; }
  if (!known.includes(arg)) {
    console.error(`未知参数: ${arg}`);
    console.error('用法: node scripts/setup.mjs [--check|--dry-run|--yes] [--uninstall] [--profile <name>]');
    process.exit(2);
  }
}

const colors = { ok: '\u001b[32m', warn: '\u001b[33m', err: '\u001b[31m', dim: '\u001b[2m', reset: '\u001b[0m' };
const ok = (s) => `${colors.ok}✓${colors.reset} ${s}`;
const warn = (s) => `${colors.warn}!${colors.reset} ${s}`;
const fail = (s) => `${colors.err}✗${colors.reset} ${s}`;
const dim = (s) => `${colors.dim}${s}${colors.reset}`;
const say = (s = '') => console.log(s);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseVersion(version) {
  const m = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] || '', raw: String(version).trim() };
}

function compareVersion(a, b) {
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

/** Windows 安装信息：卸载注册项里的 DisplayVersion 与 InstallLocation。
 * 桌面就地自动更新不会改写 $DSH_HOME 下的旧 runtime.json，安装注册信息才是现行版本来源。 */
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
    // `/f` 只返回数据命中的值，DisplayVersion/InstallLocation 不含搜索词，需按命中的键名再查一次。
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

/** 可能的 runtime 来源：桌面安装内置 runtime 优先，其次 $DSH_HOME/dsh-runtimes 下的旧副本。 */
function runtimeCandidates() {
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
  if (existsSync(LEGACY_RUNTIME_ROOT)) {
    for (const entry of readdirSync(LEGACY_RUNTIME_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(LEGACY_RUNTIME_ROOT, entry.name);
      const info = runtimeInfo(join(dir, 'runtime.json'));
      if (info) candidates.push({ ...info, dir, source: '$DSH_HOME/dsh-runtimes（旧版副本）' });
    }
  }
  return candidates;
}

/** 选版本最高的 runtime；旧副本可能是升级前的缓存，不能让它覆盖现行版本。 */
function resolveRuntime() {
  let best = null;
  for (const candidate of runtimeCandidates()) {
    if (best === null) {
      best = candidate;
      continue;
    }
    const order = compareVersion(candidate.version, best.version);
    if (!Number.isNaN(order) && order > 0) best = candidate;
  }
  return best;
}

function pnpmCommand() {
  const runtime = resolveRuntime();
  const roots = [];
  if (runtime && runtime.dir) roots.push(runtime.dir);
  roots.push(RUNTIME_DIR);
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

function runPnpm(profileDir, pnpmArgs) {
  const pnpm = pnpmCommand();
  const spawnArgs = pnpm.kind === 'runtime' ? [pnpm.file, ...pnpmArgs] : pnpmArgs;
  const command = pnpm.kind === 'runtime' ? process.execPath : pnpm.file;
  say(dim(`$ ${command} ${spawnArgs.join(' ')}    (cwd: ${profileDir})`));
  const result = spawnSync(command, spawnArgs, {
    cwd: profileDir,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    shell: process.platform === 'win32' && pnpm.kind === 'path',
    env: process.env
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const tail = (text, lines = 12) => text.split('\n').slice(-lines).join('\n');
  if (stdout) say(tail(stdout));
  if (stderr) console.error(tail(stderr));
  return { status: result.status === null ? 1 : result.status, error: result.error ? String(result.error.message || result.error) : '' };
}

function countFiles(dir, predicate) {
  if (!existsSync(dir)) return 0;
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

function dataSummary() {
  return {
    knowledgeYaml: countFiles(CONFIG_DIR, (file) => file.endsWith('.yaml') || file.endsWith('.yml')),
    bankMarkdown: countFiles(BANK_DIR, (file) => file.endsWith('.md')),
    bankImages: countFiles(join(DATA_DIR, 'obsidian_vault', '90_附件'), (file) => /\.(png|jpe?g|webp|gif)$/i.test(file))
  };
}

function desiredManifest(manifest) {
  const next = JSON.parse(JSON.stringify(manifest || {}));
  next.dependencies = { ...(next.dependencies || {}) };
  for (const project of PROJECTS) {
    next.dependencies[project.name] = 'link:' + project.dir.replace(/\\/g, '/');
  }
  next.dsh = { ...(next.dsh || {}) };
  next.dsh.profile = { ...(next.dsh.profile || {}) };
  const bundles = Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : [];
  for (const project of PROJECTS) {
    if (!bundles.includes(project.name)) bundles.push(project.name);
  }
  next.dsh.profile.bundles = bundles;
  return next;
}

function manifestDiff(before, after) {
  const lines = [];
  const beforeDeps = (before && before.dependencies) || {};
  const afterDeps = (after && after.dependencies) || {};
  for (const project of PROJECTS) {
    if (beforeDeps[project.name] !== afterDeps[project.name]) {
      lines.push(`  + dependencies["${project.name}"] = "${afterDeps[project.name]}"`);
    }
  }
  const beforeBundles = (((before || {}).dsh || {}).profile || {}).bundles || [];
  const afterBundles = (((after || {}).dsh || {}).profile || {}).bundles || [];
  for (const project of PROJECTS) {
    if (!beforeBundles.includes(project.name) && afterBundles.includes(project.name)) {
      lines.push(`  + dsh.profile.bundles += "${project.name}"`);
    }
  }
  return lines;
}

function restoreBackup(backupDir, profileDir) {
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const source = join(backupDir, name);
    if (existsSync(source)) copyFileSync(source, join(profileDir, name));
  }
}

function verifyStatic(profileDir) {
  const problems = [];
  const manifestFile = join(profileDir, 'package.json');
  let manifest = null;
  try {
    manifest = readJson(manifestFile);
  } catch (error) {
    problems.push(`profile/package.json 无法解析：${error.message}`);
    return { problems, manifest: null };
  }
  const bundles = (((manifest.dsh || {}).profile || {}).bundles) || [];
  for (const project of PROJECTS) {
    const dep = (manifest.dependencies || {})[project.name];
    if (!dep) problems.push(`依赖缺失：${project.name}`);
    else if (!String(dep).startsWith('link:')) problems.push(`依赖不是 link：${project.name} = ${dep}`);
    if (!bundles.includes(project.name)) problems.push(`bundles 未列入：${project.name}`);
    if (!existsSync(join(project.dir, 'cordis.patch.yml'))) problems.push(`包目录或 cordis.patch.yml 不存在：${project.dir}`);
    if (!existsSync(join(project.dir, 'package.json'))) problems.push(`包目录或 package.json 不存在：${project.dir}`);
  }
  // 链接与模块解析：只写清单不安装时，这里会失败。
  const require = createRequire(manifestFile);
  for (const project of PROJECTS) {
    try {
      require.resolve(project.name + '/package.json');
    } catch (error) {
      problems.push(`node_modules 解析失败（未安装或链接未生成）：${project.name} — 运行 pnpm install 后重试`);
    }
  }
  if (problems.length === 0) {
    for (const project of PROJECTS) {
      const linkPath = join(profileDir, 'node_modules', project.name);
      if (!existsSync(linkPath)) {
        problems.push(`缺少 node_modules 链接：${linkPath}`);
        continue;
      }
      try {
        const info = lstatSync(linkPath);
        if (!info.isSymbolicLink()) {
          problems.push(`node_modules 条目不是符号链接：${linkPath}`);
          continue;
        }
        const target = realpathSync(linkPath);
        if (resolve(target).toLowerCase() !== resolve(project.dir).toLowerCase()) {
          problems.push(`链接指向错误：${linkPath} → ${target}（期望 ${project.dir}）`);
        }
      } catch (error) {
        problems.push(`读取链接失败：${linkPath} — ${error.message}`);
      }
    }
  }
  return { problems, manifest };
}

function dataCheck() {
  const summary = dataSummary();
  const lines = [];
  let missing = false;
  if (summary.knowledgeYaml === 0) { missing = true; lines.push(warn(`data/config 未找到考点库 YAML：${CONFIG_DIR}`)); }
  else lines.push(ok(`随仓库考点库：${summary.knowledgeYaml} 个 YAML（${CONFIG_DIR}）`));
  if (summary.bankMarkdown === 0) { missing = true; lines.push(warn(`data/obsidian_vault/04_题目 未找到题库 Markdown：${BANK_DIR}`)); }
  else lines.push(ok(`随仓库题库：${summary.bankMarkdown} 份 Markdown、${summary.bankImages} 张图片（${BANK_DIR}）`));
  return { missing, lines, summary };
}

function checkVersion() {
  const runtime = resolveRuntime();
  if (!runtime) {
    return {
      ok: false,
      code: 'NO_RUNTIME',
      message: `未找到 DSH 运行时：已查找桌面安装目录的 resources/runtime/primary-runtime/runtime.json（Windows 安装注册信息）与 ${LEGACY_RUNTIME_ROOT}。请先安装/启动一次 DSH Desktop。`
    };
  }
  const version = runtime.version;
  const parsed = parseVersion(version);
  const minimum = parseVersion(MINIMUM_VERSION);
  if (!parsed || !minimum) {
    return { ok: false, code: 'BAD_VERSION', message: `无法解析 DSH 版本：${version}` };
  }
  // 最低版本比较只看主/次/补丁号：0.2.1-rc.5 属于 0.2.1 系列，不应因预发布标记被判为“低于 0.2.1”。
  const older = parsed.major < minimum.major
    || (parsed.major === minimum.major && parsed.minor < minimum.minor)
    || (parsed.major === minimum.major && parsed.minor === minimum.minor && parsed.patch < minimum.patch);
  if (older) {
    return { ok: false, code: 'TOO_OLD', message: `DSH 版本 ${version} 低于 ${MINIMUM_VERSION}，缺少本项目依赖的接口。请先升级 DSH Desktop（已验证版本 ${VERIFIED_VERSION}）。` };
  }
  const verified = version === VERIFIED_VERSION
    || compareVersion(version, VERIFIED_VERSION) === 0;
  return {
    ok: true,
    version,
    source: runtime.source,
    warning: verified ? '' : `当前 DSH 版本 ${version} 尚未完整验证；本项目在 ${VERIFIED_VERSION} 上验证通过。安装会继续，但遇到异常请优先回退到该版本。`
  };
}

function printHeader() {
  say(`地理教师辅助 · 安装器`);
  say(dim(`仓库：${REPO_ROOT}`));
  say(dim(`DSH_HOME：${DSH_HOME}`));
  say(dim(`profile：${profileName}`));
  say();
}

function printSummary(profileDir, check) {
  const data = dataCheck();
  for (const line of data.lines) say(line);
  if (check.warning) say(warn(check.warning));
  say();
  say(`下一步：`);
  say(`  1. 完全退出 DSH Desktop 后重新启动（关闭窗口可能只是隐藏，请确认进程已退出）`);
  say(`  2. 新建一个「地理教师辅助」会话`);
  say(`  3. 输入 /geo-status 确认版本、数据来源与题库题数`);
  say(dim(`  （profile 目录：${profileDir}）`));
}

function install(profileDir) {
  say(`== 安装 ==`);
  const version = checkVersion();
  if (!version.ok) throw new Error(version.message);
  if (version.warning) say(warn(version.warning));
  const manifestFile = join(profileDir, 'package.json');
  if (!existsSync(manifestFile)) {
    throw new Error(`profile 清单不存在：${manifestFile}。请先启动一次 DSH Desktop 让 profile 初始化。`);
  }
  const before = readJson(manifestFile);
  const after = desiredManifest(before);
  const diff = manifestDiff(before, after);
  if (diff.length === 0) {
    say(ok('profile 清单已是最新（依赖与 bundles 均已就位）'));
  } else {
    say('将写入以下差异：');
    for (const line of diff) say(line);
  }
  if (flags.dryRun) {
    say();
    say(dim('--dry-run：未写入任何文件。'));
    return 0;
  }
  if (!flags.yes) {
    say();
    say(fail('未加 --yes，未写入任何文件。确认无误后运行：node scripts/setup.mjs --yes'));
    return 1;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(profileDir, '.geo-teacher-setup', timestamp);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(manifestFile, join(backupDir, 'package.json'));
  const lockFile = join(profileDir, 'pnpm-lock.yaml');
  const hadLock = existsSync(lockFile);
  if (hadLock) copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml'));
  say(ok(`已备份到 ${backupDir}`));

  writeJson(manifestFile, after);
  say(ok('已写入 profile 清单'));

  // 只写清单不会加载：必须在 profile 目录安装一次，生成 node_modules 链接。
  const installed = runPnpm(profileDir, ['install', '--prefer-offline', '--no-frozen-lockfile']);
  if (installed.status !== 0) {
    console.error(fail('pnpm install 失败，正在从备份恢复清单并重装…'));
    restoreBackup(backupDir, profileDir);
    const repairArgs = hadLock ? ['install', '--frozen-lockfile'] : ['install', '--config.lockfile=false'];
    runPnpm(profileDir, repairArgs);
    throw new Error('安装失败，已尝试恢复安装前的清单与 lockfile（不保证 pnpm store 完全还原）。');
  }

  const { problems } = verifyStatic(profileDir);
  if (problems.length > 0) {
    console.error(fail('安装后静态校验未通过：'));
    for (const problem of problems) console.error(`  - ${problem}`);
    throw new Error('静态校验失败；请检查上面的问题后重试。');
  }
  say(ok('profile 清单、bundles、node_modules 链接与包导出均已校验'));
  const data = dataCheck();
  if (data.missing) {
    throw new Error('随仓库数据缺失（data/config 或 data/obsidian_vault/04_题目）。请确认仓库完整后重试。');
  }
  say();
  say(ok(`已安装：${PROJECTS.map((project) => project.name).join('、')}`));
  say(dim(`安装备份保留在 ${backupDir}（可自行删除）`));
  say();
  printSummary(profileDir, checkVersion());
  return 0;
}

function uninstall(profileDir) {
  say(`== 卸载 ==`);
  const manifestFile = join(profileDir, 'package.json');
  if (!existsSync(manifestFile)) throw new Error(`profile 清单不存在：${manifestFile}`);
  const before = readJson(manifestFile);
  const after = JSON.parse(JSON.stringify(before));
  let changed = false;
  for (const project of PROJECTS) {
    if (after.dependencies && Object.hasOwn(after.dependencies, project.name)) {
      delete after.dependencies[project.name];
      changed = true;
    }
  }
  const bundles = ((((after.dsh || {}).profile) || {}).bundles) || [];
  const kept = bundles.filter((name) => !PROJECTS.some((project) => project.name === name));
  if (kept.length !== bundles.length) {
    after.dsh.profile.bundles = kept;
    changed = true;
  }
  if (!changed) {
    say(ok('未发现本项目依赖与 bundle 项，无需卸载'));
    return 0;
  }
  say('将移除：');
  for (const project of PROJECTS) say(`  - dependencies["${project.name}"] 与 bundles 中的同名项`);
  if (flags.dryRun) {
    say(dim('--dry-run：未写入任何文件。'));
    return 0;
  }
  if (!flags.yes) {
    say(fail('未加 --yes，未写入任何文件。确认后运行：node scripts/setup.mjs --uninstall --yes'));
    return 1;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(profileDir, '.geo-teacher-setup', timestamp + '-uninstall');
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(manifestFile, join(backupDir, 'package.json'));
  const lockFile = join(profileDir, 'pnpm-lock.yaml');
  if (existsSync(lockFile)) copyFileSync(lockFile, join(backupDir, 'pnpm-lock.yaml'));

  writeJson(manifestFile, after);
  say(ok('已从 profile 清单移除本项目'));
  const installed = runPnpm(profileDir, ['install', '--prefer-offline', '--no-frozen-lockfile']);
  if (installed.status !== 0) {
    console.error(fail('pnpm install 失败，正在恢复清单…'));
    restoreBackup(backupDir, profileDir);
    throw new Error('卸载时依赖同步失败，已恢复清单；请手动运行 pnpm install 后检查。');
  }
  // pnpm 在部分 nodeLinker 配置下会保留已移除依赖的符号链接；只清理指向本项目目录的那两个链接。
  for (const project of PROJECTS) {
    const linkPath = join(profileDir, 'node_modules', project.name);
    try {
      if (!existsSync(linkPath) || !lstatSync(linkPath).isSymbolicLink()) continue;
      let target = '';
      try { target = realpathSync(linkPath); } catch { target = ''; }
      if (!target || resolve(target).toLowerCase() === resolve(project.dir).toLowerCase()) {
        rmSync(linkPath, { recursive: true, force: true });
      }
    } catch { /* 清理失败会在下面统一报告 */ }
  }
  try {
    const scopeDir = join(profileDir, 'node_modules', '@geo-edu');
    if (existsSync(scopeDir) && readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  const manifest = readJson(manifestFile);
  const require = createRequire(manifestFile);
  const leftovers = [];
  for (const project of PROJECTS) {
    if (manifest.dependencies && Object.hasOwn(manifest.dependencies, project.name)) leftovers.push(`依赖仍存在：${project.name}`);
    try {
      require.resolve(project.name + '/package.json');
      leftovers.push(`包仍可解析（node_modules 链接残留）：${project.name}`);
    } catch { /* 期望失败 */ }
  }
  if (leftovers.length) {
    for (const item of leftovers) console.error(fail(item));
    throw new Error('卸载后仍有残留，请检查 profile 的 node_modules 与 package.json。');
  }
  say();
  say(ok('已移除本项目的两个包与 bundle 项。'));
  say('保留（未删除）：');
  say(`  - 数据与配置：${join(DSH_HOME, 'geo-teacher', 'config.json')}（若存在）`);
  say(`  - 仓库数据：${DATA_DIR}`);
  say(`  - 讲题运行记录与产物：profile 之外，见 outputs/`);
  say(dim(`备份：${backupDir}`));
  say(dim('说明：lockfile 的解析结果与 pnpm store 可能与安装前不同，不承诺“恢复原状”。'));
  return 0;
}

function checkOnly(profileDir) {
  say(`== 检查（只读） ==`);
  const version = checkVersion();
  if (!version.ok) {
    console.error(fail(version.message));
    return 1;
  }
  say(ok(`DSH 版本：${version.version}${version.warning ? '（未完整验证）' : '（已验证）'}${version.source ? dim(` · 来源：${version.source}`) : ''}`));
  if (version.warning) say(warn(version.warning));
  if (!existsSync(profileDir)) {
    console.error(fail(`profile 目录不存在：${profileDir}`));
    return 1;
  }
  say(ok(`profile：${profileDir}`));
  const manifest = readJson(join(profileDir, 'package.json'));
  const { problems } = verifyStatic(profileDir);
  const bundles = (((manifest.dsh || {}).profile || {}).bundles) || [];
  for (const project of PROJECTS) {
    const dep = (manifest.dependencies || {})[project.name];
    const listed = bundles.includes(project.name);
    say(`${dep && listed ? ok('已接线') : warn('未接线')} ${project.name}${dep ? `（${dep}）` : ''}${listed ? '' : ' — bundles 未列入'}`);
  }
  say(problems.length === 0
    ? ok('静态接线、node_modules 链接与包解析均正常')
    : warn(`静态校验问题 ${problems.length} 项：`));
  for (const problem of problems) say(`  - ${problem}`);
  const data = dataCheck();
  if (problems.length > 0 || data.missing) {
    say();
    say(`修复：node scripts/setup.mjs --yes`);
    return problems.length > 0 || data.missing ? 1 : 0;
  }
  printSummary(profileDir, version);
  return 0;
}

function main() {
  printHeader();
  if (flags.help) {
    say('用法：');
    say('  node scripts/setup.mjs --check                 只读检查');
    say('  node scripts/setup.mjs --dry-run               展示将写入的差异');
    say('  node scripts/setup.mjs --yes                   安装');
    say('  node scripts/setup.mjs --uninstall --yes       卸载');
    say('  node scripts/setup.mjs --profile <name>         指定 profile（默认 desktop）');
    return 0;
  }
  const profileDir = join(DSH_HOME, 'profiles', profileName);
  if (flags.uninstall) return uninstall(profileDir);
  if (flags.check) return checkOnly(profileDir);
  return install(profileDir);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(fail((error && error.message) || String(error)));
  process.exitCode = 1;
}
