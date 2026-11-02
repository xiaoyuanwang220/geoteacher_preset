// ModelCheck 数据层 — 项目发现、载入与摘要
// 纯 ESM，只用 node: 内置模块（宿主 fs 服务通过参数注入，lib 不 import 宿主包）。
// 有 .modelcheck/config.json 的目录才算项目；载入时缺失的可选文件按安全缺省处理，坏契约才抛 ContractError。

import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { ContractError, contractContentHash, criteriaOf, isActive, normalizeContract, validateContract } from './contract.js';
import { normalizeRegistry, validateRegistry } from './registry.js';
import { Store, StoreError } from './store.js';
import { isPlainObject, nowIso, sha256, stableStringify } from './util.js';

const MAX_PROJECT_WALK = 40;

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  projectId: null,
  title: null,
  route: null,
  preview: { entry: null, viewport: null, unitToPx: null, injectBridge: true },
  build: { entry: null, outputs: [] },
  sources: [],
  budget: { maxRounds: {}, maxMinutes: null, stagnantRounds: null },
});

const DEFAULT_EVIDENCE = Object.freeze({ schemaVersion: 1, adapterVersion: null, entries: {} });
const DEFAULT_ANNOTATIONS = Object.freeze({
  schemaVersion: 1,
  nextRequestSeq: 1,
  nextBatchSeq: 1,
  batches: [],
  requests: [],
});
const DEFAULT_ROUNDS = Object.freeze({ schemaVersion: 1, rounds: [] });

// 自 startDir 向上找含 .modelcheck/config.json 的目录，最多 40 层。
// `{ fs }` 是宿主 fs 服务（ctx.fs）；不传时退回 node:fs/promises，单测可注入假实现。
export async function findProjectRoot(startDir, { fs: fsLike } = {}) {
  if (typeof startDir !== 'string' || !startDir.trim()) return null;
  const exists = makeExists(fsLike);
  let dir = resolve(startDir);
  for (let depth = 0; depth < MAX_PROJECT_WALK; depth += 1) {
    if (await exists(join(dir, '.modelcheck', 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// 载入项目全部数据。缺失的可选文件按缺省值处理；contract.json 非法 → ContractError。
// 返回 Project: { root, config, configHash, components, contract|null, contractProposed|null,
//   evidence, annotations, rounds, certification, hashes:{buildHash,sourceHash}, issues[], loadedAt }
export async function loadProject(rootDir, { store } = {}) {
  if ((typeof rootDir !== 'string' || !rootDir.trim()) && !store) {
    throw new StoreError('loadProject 需要项目根目录', 'io');
  }
  const root = resolve(rootDir || (store && store.rootDir) || '');
  const projectStore = store || new Store(root);
  const paths = projectStore.paths;
  const issues = [];

  const configRaw = await safeReadJson(projectStore, paths.config, null, issues, 'config.json');
  const config = normalizeConfig(configRaw);
  if (configRaw === null) issues.push('未找到 config.json，项目身份与预览配置按缺省值处理');
  else if (configRaw.route !== undefined && config.route === null) issues.push(`config.json 的 route 非法：${JSON.stringify(configRaw.route)}`);

  const componentsRaw = await safeReadJson(projectStore, paths.components, null, issues, 'components.json');
  const registryCheck = validateRegistry(componentsRaw === null ? {} : componentsRaw);
  let components;
  if (registryCheck.ok) {
    components = normalizeRegistry(componentsRaw === null ? {} : componentsRaw);
  } else {
    // 注册表有错不拖垮整个项目载入：保留原始组件，让面板/工具把问题展示出来再 upsert 修。
    const rawComponents = componentsRaw && Array.isArray(componentsRaw.components) ? componentsRaw.components : [];
    components = { schemaVersion: 1, components: rawComponents };
    for (const error of registryCheck.errors) issues.push(`组件注册表：${error.message}`);
  }
  const registryWarnings = registryCheck.warnings.map((warning) => warning.message);

  let contract = null;
  let contractRaw = null;
  try {
    contractRaw = await projectStore.readJson(paths.contract, null);
  } catch (error) {
    if (error instanceof StoreError && error.code === 'parse') {
      throw new ContractError(`contract.json 解析失败：${error.message}`, 'contract/parse', [
        { code: 'contract/parse', message: error.message, path: paths.contract },
      ]);
    }
    throw error;
  }
  if (contractRaw !== null) {
    const check = validateContract(contractRaw);
    if (!check.ok) {
      throw new ContractError(
        `contract.json 不合法（${check.errors.length} 项）：${check.errors.slice(0, 5).map((item) => item.message).join('；')}`,
        check.errors[0].code,
        check.errors,
      );
    }
    contract = normalizeContract(contractRaw);
  }

  let contractProposed = null;
  const proposedRaw = await safeReadJson(projectStore, paths.contractProposed, null, issues, 'contract.proposed.json');
  if (proposedRaw !== null) {
    const check = validateContract(proposedRaw);
    if (check.ok) contractProposed = normalizeContract(proposedRaw);
    else for (const error of check.errors.slice(0, 5)) issues.push(`待确认契约：${error.message}`);
  }

  const evidence = await safeReadJson(projectStore, paths.evidence, DEFAULT_EVIDENCE, issues, 'evidence.json');
  const annotations = await safeReadJson(projectStore, paths.annotations, DEFAULT_ANNOTATIONS, issues, 'annotations.json');
  const rounds = await safeReadJson(projectStore, paths.rounds, DEFAULT_ROUNDS, issues, 'rounds.json');
  const certification = await safeReadJson(projectStore, paths.certification, null, issues, 'certification.json');

  const configHash = sha256(stableStringify(config));
  const contractHash = contract ? contractContentHash(contract) : null;
  const hashes = await computeProjectHashes(root, config);

  return {
    root,
    config,
    configHash,
    components,
    registryWarnings,
    contract,
    contractHash,
    contractProposed,
    evidence,
    annotations,
    rounds,
    certification,
    hashes,
    issues,
    loadedAt: nowIso(),
  };
}

// 面板/工具共用摘要：只给"看板需要的计数与身份"，不塞整份契约。
export function projectSummary(project) {
  const p = isPlainObject(project) ? project : {};
  const config = isPlainObject(p.config) ? p.config : DEFAULT_CONFIG;
  const preview = isPlainObject(config.preview) ? config.preview : DEFAULT_CONFIG.preview;
  const components = p.components && Array.isArray(p.components.components) ? p.components.components : [];
  const contract = p.contract || null;
  const criteria = criteriaOf(contract);
  const active = criteria.filter(isActive);
  const byLevel = { P0: 0, P1: 0, P2: 0 };
  const byStatus = {};
  for (const criterion of active) {
    if (byLevel[criterion.level] !== undefined) byLevel[criterion.level] += 1;
    const status = typeof criterion.status === 'string' ? criterion.status : 'unverified';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  const annotationData = p.annotations && Array.isArray(p.annotations.requests) ? p.annotations : { batches: [], requests: [] };
  const batches = Array.isArray(annotationData.batches) ? annotationData.batches : [];
  const requests = Array.isArray(annotationData.requests) ? annotationData.requests : [];
  const pendingRequests = requests.filter((request) => request && request.state !== 'closed' && request.state !== 'withdrawn').length;

  const evidence = isPlainObject(p.evidence) ? p.evidence : DEFAULT_EVIDENCE;
  const rounds = p.rounds && Array.isArray(p.rounds.rounds) ? p.rounds.rounds : [];
  const hashes = isPlainObject(p.hashes) ? p.hashes : { buildHash: null, sourceHash: null };

  const proposed = p.contractProposed || null;
  return {
    schemaVersion: 1,
    root: typeof p.root === 'string' ? p.root : null,
    projectId: config.projectId || null,
    title: config.title || null,
    route: config.route || null,
    previewEntry: typeof preview.entry === 'string' ? preview.entry : null,
    unitToPx: typeof preview.unitToPx === 'number' ? preview.unitToPx : null,
    viewport: preview.viewport || null,
    configHash: p.configHash || null,
    contractHash: typeof p.contractHash === 'string' ? p.contractHash : null,
    contract: contract
      ? {
          version: contract.contractVersion || null,
          status: contract.status || null,
          confirmed: contract.status === 'confirmed',
          confirmedAt: contract.confirmedAt || null,
          confirmedBy: contract.confirmedBy || null,
          contentHash: typeof p.contractHash === 'string' ? p.contractHash : contractContentHash(contract),
          criteria: { total: criteria.length, active: active.length, byLevel, byStatus },
        }
      : null,
    contractProposed: proposed
      ? {
          contentHash: contractContentHash(proposed),
          criteria: criteriaOf(proposed).length,
        }
      : null,
    components: { total: components.length, issues: Array.isArray(p.registryWarnings) ? p.registryWarnings.length : 0 },
    evidence: {
      adapterVersion: typeof evidence.adapterVersion === 'string' ? evidence.adapterVersion : null,
      buildHash: hashes.buildHash || null,
      sourceHash: hashes.sourceHash || null,
      entries: isPlainObject(evidence.entries) ? Object.keys(evidence.entries).length : 0,
    },
    annotations: { batches: batches.length, requests: requests.length, pending: pendingRequests },
    rounds: { total: rounds.length },
    certification: p.certification
      ? {
          contractVersion: p.certification.contractVersion || null,
          buildHash: p.certification.buildHash || null,
          at: p.certification.at || p.certification.certifiedAt || null,
        }
      : null,
    issues: Array.isArray(p.issues) ? p.issues.slice() : [],
    loadedAt: typeof p.loadedAt === 'string' ? p.loadedAt : null,
  };
}

// 会话 → 项目：getSessionCwd 由宿主半边注入（lib 不碰 sessions/workingDirectory 服务）。
// 没有 cwd、cwd 不在项目内、或项目数据载入失败时返回 null；契约非法则向上抛（面板需要明确错误）。
export async function resolveSessionProject(sessionId, deps = {}) {
  const { getSessionCwd } = deps || {};
  if (typeof getSessionCwd !== 'function') {
    throw new TypeError('resolveSessionProject 缺少注入依赖 getSessionCwd(sessionId)');
  }
  if (!sessionId) return null;
  let cwd;
  try {
    cwd = await getSessionCwd(sessionId);
  } catch {
    return null;
  }
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const root = await findProjectRoot(cwd, { fs: deps.fs });
  if (!root) return null;
  return loadProject(root, { store: deps.store });
}

// 项目文件（config.sources / config.build.outputs）的哈希：只认项目内相对路径，缺文件不抛错。
// sourceHash 为 null 表示没有登记源文件；buildHash 为 null 表示没有现存构建产物（两者都不能冒充有效版本）。
async function computeProjectHashes(root, config) {
  const sourceMap = {};
  for (const relative of config.sources) {
    sourceMap[normalizeRelativeKey(relative)] = await hashProjectFile(root, relative);
  }
  const sourceHash = config.sources.length > 0 ? sha256(stableStringify(sourceMap)) : null;

  const outputMap = {};
  for (const relative of config.build.outputs) {
    const hash = await hashProjectFile(root, relative);
    if (hash !== 'missing') outputMap[normalizeRelativeKey(relative)] = hash;
  }
  const buildHash = Object.keys(outputMap).length > 0 ? sha256(stableStringify(outputMap)) : null;
  return { buildHash, sourceHash };
}

async function hashProjectFile(root, relative) {
  const abs = resolveProjectPath(root, relative);
  if (!abs) return 'missing';
  try {
    const bytes = await readFile(abs);
    return sha256(bytes);
  } catch {
    return 'missing';
  }
}

function resolveProjectPath(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) return null;
  if (isAbsolute(relative)) return null;
  const abs = resolve(root, relative);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)) return null;
  return abs;
}

function normalizeRelativeKey(relative) {
  return String(relative).replace(/\\/g, '/');
}

function normalizeConfig(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const config = { ...source };
  config.schemaVersion = Number.isInteger(source.schemaVersion) ? source.schemaVersion : 1;
  config.projectId = typeof source.projectId === 'string' && source.projectId.trim() ? source.projectId.trim() : null;
  config.title = typeof source.title === 'string' && source.title.trim() ? source.title.trim() : null;
  config.route = ['three', 'svg', 'dom', 'image'].includes(source.route) ? source.route : null;

  const preview = isPlainObject(source.preview) ? source.preview : {};
  config.preview = {
    ...preview,
    entry: typeof preview.entry === 'string' && preview.entry.trim() ? preview.entry.trim() : null,
    viewport: isPlainObject(preview.viewport) ? preview.viewport : null,
    unitToPx: Number.isFinite(preview.unitToPx) ? preview.unitToPx : null,
    injectBridge: preview.injectBridge !== false,
  };

  const build = isPlainObject(source.build) ? source.build : {};
  config.build = {
    ...build,
    entry: typeof build.entry === 'string' && build.entry.trim() ? build.entry.trim() : null,
    outputs: Array.isArray(build.outputs)
      ? build.outputs.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
  };

  config.sources = Array.isArray(source.sources)
    ? source.sources.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
    : [];

  const budget = isPlainObject(source.budget) ? source.budget : {};
  config.budget = {
    ...budget,
    maxRounds: isPlainObject(budget.maxRounds) ? budget.maxRounds : {},
    maxMinutes: Number.isFinite(budget.maxMinutes) ? budget.maxMinutes : null,
    stagnantRounds: Number.isFinite(budget.stagnantRounds) ? budget.stagnantRounds : null,
  };
  return config;
}

async function safeReadJson(store, path, fallback, issues, label) {
  try {
    return await store.readJson(path, fallback);
  } catch (error) {
    if (error instanceof StoreError && error.code === 'parse') {
      issues.push(`${label} 解析失败，已按缺省值处理：${error.message}`);
      return fallback;
    }
    throw error;
  }
}

// 宿主 fs 服务形状不固定：优先 exists，其次 access/stat/readFile；都没有时退回 node:fs/promises。
function makeExists(fsLike) {
  if (!fsLike || typeof fsLike !== 'object') {
    return async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    };
  }
  if (fsLike.promises && typeof fsLike.promises === 'object') return makeExists(fsLike.promises);
  if (typeof fsLike.exists === 'function') {
    return async (path) => {
      try {
        return Boolean(await fsLike.exists(path));
      } catch {
        return false;
      }
    };
  }
  if (typeof fsLike.access === 'function') {
    return async (path) => {
      try {
        return (await fsLike.access(path)) !== false;
      } catch {
        return false;
      }
    };
  }
  if (typeof fsLike.stat === 'function') {
    return async (path) => {
      try {
        await fsLike.stat(path);
        return true;
      } catch {
        return false;
      }
    };
  }
  if (typeof fsLike.readFile === 'function') {
    return async (path) => {
      try {
        await fsLike.readFile(path);
        return true;
      } catch {
        return false;
      }
    };
  }
  return async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  };
}
