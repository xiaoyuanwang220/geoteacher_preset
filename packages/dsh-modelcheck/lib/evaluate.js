/**
 * ModelCheck 判据编排模块（设计文档 §2.9）
 *
 * 职责（一次 evaluate 的完整闭环）：
 *   筛选生效判据 → 计算 depends 文件哈希 → 组证据键 → 键一致且上次 pass 则复用
 *   → 运行时类判据统一向 ctxFactory 取证（一次/上下文）→ 逐条执行规则
 *   → 每次执行前跑元判据自检（按 ruleHash 缓存）→ 写 evidence.entries
 *   → 把最新状态镜像回 contract.criteria[].status/evidence → 返回结果与 currentKeys。
 *
 * 约束（设计 §2 / 规格 §5–§7、§17）：
 *   · 纯 ESM，只用 node: 内置模块；不 import 宿主包，不读环境全局。
 *   · fail-closed：无契约/无证据/自检未过/取证版本不符 → inconclusive，绝不 pass。
 *   · 证据键必须包含 contractVersion/ruleHash/deps/adapterVersion/context/buildHash/sourceHash；
 *     缺失字段不生成可复用键（evidence.evidenceKey 返回 null）。
 *   · 静态路线（没有构建产物）用 'static' 作为 buildHash/sourceHash 的稳定占位值：
 *     版本约束此时由 contractVersion + ruleHash + deps 承担，绝不拿旧产物冒充新构建。
 *   · 不执行任意表达式；规则执行全部交给 rules.js 的结构化执行器。
 */

import { access, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { criteriaOf, isActive, ruleHash } from './contract.js';
import {
  DEFAULT_ADAPTER_VERSION,
  buildEvidenceRecord,
  evidenceKey,
  normalizePath,
  reuseDecision,
} from './evidence.js';
import { executeRule, requiredEvidenceKind } from './rules.js';
import { selfCheckRule } from './selfcheck.js';
import { isPlainObject, nowIso, sha256, stableStringify } from './util.js';

/** 静态版本占位值：项目没有构建产物/源码清单时用它，保证证据键稳定且不冒充旧产物。 */
const STATIC_VERSION = 'static';

/** 文件读取上限（规格 §9：限制输入大小），超过即按 fail-closed 处理。 */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 契约状态集合（与 contract.js STATUSES 一致；不 import 是为了避免循环依赖，值由测试锁定）。 */
const CONTRACT_STATUSES = new Set(['unverified', 'pass', 'fail', 'inconclusive', 'stale']);

/** evaluate 的结构化错误。 */
export class EvaluateError extends Error {
  /**
   * @param {'no-project'|'no-contract'|'invalid-options'|'unknown-ids'|'invalid-path'} code
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EvaluateError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** 空证据文档（evidence.json 规范形）。 */
function emptyEvidenceDoc() {
  return { schemaVersion: 1, adapterVersion: null, entries: {} };
}

/** 把 evidence.json（或裸 entries 映射）归一化成 { schemaVersion, adapterVersion, entries }。 */
function evidenceDocOf(evidence) {
  if (!isPlainObject(evidence)) return emptyEvidenceDoc();
  if (isPlainObject(evidence.entries)) {
    return {
      schemaVersion: Number.isInteger(evidence.schemaVersion) ? evidence.schemaVersion : 1,
      adapterVersion: typeof evidence.adapterVersion === 'string' ? evidence.adapterVersion : null,
      entries: { ...evidence.entries },
      ...(typeof evidence.updatedAt === 'string' ? { updatedAt: evidence.updatedAt } : {}),
    };
  }
  return { schemaVersion: 1, adapterVersion: null, entries: { ...evidence } };
}

/** 取第一个非空字符串。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** 归一化 logger：接受对象（info/warn/error/debug）或函数。 */
function normalizeLogger(logger) {
  const noop = () => {};
  if (typeof logger === 'function') return { info: logger, warn: logger, error: logger, debug: noop };
  if (!isPlainObject(logger)) return { info: noop, warn: noop, error: noop, debug: noop };
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : noop,
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : noop,
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : noop,
    debug: typeof logger.debug === 'function' ? logger.debug.bind(logger) : noop,
  };
}

/** 项目根内的文件读取器（供规则执行与依赖哈希用；拒绝任何越出项目根的路径）。 */
export function createFilesAdapter(rootDir) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new EvaluateError('no-project', 'createFilesAdapter 需要项目根目录');
  }
  const root = resolve(rootDir);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;

  function toAbsolute(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
      throw new EvaluateError('invalid-path', '文件路径必须是非空字符串');
    }
    const normalized = relPath.replace(/\\/g, '/');
    if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
      throw new EvaluateError('invalid-path', `只允许项目内相对路径：${relPath}`, { path: relPath });
    }
    const abs = resolve(root, normalized);
    if (abs !== root && !abs.startsWith(prefix)) {
      throw new EvaluateError('invalid-path', `路径越出项目根：${relPath}`, { path: relPath });
    }
    return abs;
  }

  return {
    /** 读 UTF-8 文本；超限/缺失直接抛结构化错误（由规则执行器转 inconclusive）。 */
    async read(relPath) {
      const abs = toAbsolute(relPath);
      const bytes = await readFile(abs);
      if (bytes.length > MAX_FILE_BYTES) {
        throw new EvaluateError('invalid-path', `文件超过 ${MAX_FILE_BYTES} 字节上限：${relPath}`, { path: relPath });
      }
      return bytes.toString('utf8');
    },
    /** 内容哈希（按原始字节），与宿主 tools.js 的 projectFiles().hash 同形。 */
    async hash(relPath) {
      const abs = toAbsolute(relPath);
      const bytes = await readFile(abs);
      return sha256(bytes);
    },
    async exists(relPath) {
      try {
        await access(toAbsolute(relPath));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 优先用注入的 files 适配器；缺失的方法按 read 派生；都没有时退回 node:fs 实现。 */
function normalizeFilesAdapter(files, rootDir) {
  if (isPlainObject(files) && typeof files.read === 'function') {
    const read = files.read.bind(files);
    const hash = typeof files.hash === 'function' ? files.hash.bind(files) : async (rel) => sha256(await read(rel));
    const exists =
      typeof files.exists === 'function'
        ? files.exists.bind(files)
        : async (rel) => {
            try {
              await read(rel);
              return true;
            } catch {
              return false;
            }
          };
    return { read, hash, exists };
  }
  if (typeof rootDir !== 'string' || !rootDir.trim()) {
    throw new EvaluateError('no-project', 'project.root 缺失，且未注入 files 适配器，无法读取依赖文件');
  }
  // 统一用本模块的字节哈希实现，保证依赖哈希与宿主 projectFiles().hash 同形（'sha256:<hex>'）。
  return createFilesAdapter(rootDir);
}

/** 只接受契约允许的状态；unknown/error 一律降级为 inconclusive（fail-closed）。 */
function normalizeStatus(raw) {
  if (CONTRACT_STATUSES.has(raw)) return raw;
  return 'inconclusive';
}

/** 状态 → 可执行补救指令（与 completion.js 的措辞保持一致，便于工具直接拼提示）。 */
function remedyFor(status) {
  switch (status) {
    case 'pass':
      return '';
    case 'stale':
      return '依赖或版本已变化，重新运行 modelcheck_verify 取证';
    case 'unverified':
      return '运行 modelcheck_verify 采集该判据证据';
    case 'fail':
      return '按判据要求修复后重新取证';
    case 'inconclusive':
      return '证据不足以判定，补充取证（打开预览面板/核对上下文）后重新运行';
    default:
      return '重新运行判定并补齐证据';
  }
}

/** 运行时取证是否与当前版本/上下文一致（规格 §17.1/§17.2）。 */
function checkRuntimeEvidence(evidence, criterion, expectedBuildHash) {
  if (!isPlainObject(evidence)) {
    return { ok: false, reason: '未取得运行时取证（面板未打开/超时），运行时判据不能由配置值替代' };
  }
  if (!isPlainObject(evidence.components)) {
    return { ok: false, reason: '运行时取证缺少 components，不能用配置值替代几何证据' };
  }
  const buildHash = firstString(evidence.buildHash);
  if (!buildHash) {
    return { ok: false, reason: '运行时取证缺少 buildHash，无法绑定被测版本' };
  }
  if (expectedBuildHash && buildHash !== expectedBuildHash) {
    return { ok: false, reason: '运行时取证属于旧构建（buildHash 与当前产物不一致），已丢弃' };
  }
  const actualContext = isPlainObject(evidence.context) ? evidence.context : {};
  const requiredContext = isPlainObject(criterion.context) ? criterion.context : {};
  for (const [key, value] of Object.entries(requiredContext)) {
    if (!isPlainObject(actualContext) || !Object.prototype.hasOwnProperty.call(actualContext, key)) {
      return { ok: false, reason: `运行时取证的上下文缺少「${key}」，与判据要求不符` };
    }
    if (stableStringify(actualContext[key]) !== stableStringify(value)) {
      return { ok: false, reason: `运行时取证的上下文「${key}」与判据要求不符` };
    }
  }
  return { ok: true, evidence, buildHash };
}

/** 从运行时证据里取 sourceHash/adapterVersion 等版本字段。 */
function runtimeVersions(evidence) {
  const safe = isPlainObject(evidence) ? evidence : {};
  return {
    buildHash: firstString(safe.buildHash),
    sourceHash: firstString(safe.sourceHash),
    adapterVersion: firstString(safe.adapterVersion),
  };
}

/**
 * 判据编排主入口。
 *
 * @param {object} project loadProject() 的返回值（只读；仅同步镜像 contract.criteria 状态）
 * @param {object} [options]
 * @param {string[]} [options.ids] 只执行这些判据 id（不存在/已失效 → EvaluateError('unknown-ids')）
 * @param {boolean} [options.full] true = 忽略复用，全部重跑
 * @param {Function|object} [options.ctxFactory] async (criteria, context) => evidence|null；
 *        或 { requestEvidence(criteria, context), getBuildHashes() }
 * @param {object} [options.store] Store 实例；提供时逐条落盘 evidence.json 并镜像 contract.json
 * @param {object} [options.files] 项目内文件适配器 { read, hash, exists }
 * @param {string} [options.adapterVersion] 取证适配器版本
 * @param {string} [options.buildHash] 覆盖项目构建哈希
 * @param {string} [options.sourceHash] 覆盖项目源码哈希
 * @param {string} [options.now] 固定时间戳（测试用）
 * @param {object} [options.logger]
 * @param {Function} [options.executeRule] 注入规则执行器（默认 rules.executeRule）
 * @param {Function} [options.selfCheckRule] 注入元判据执行器（默认 selfcheck.selfCheckRule）
 * @param {object|Function} [options.selfCheckFixtures] 按 kind 覆盖自检夹具，或 (criterion) => fixtures
 * @returns {Promise<object>} Evaluation
 */
export async function evaluateCriteria(project, options = {}) {
  if (!isPlainObject(project)) {
    throw new EvaluateError('no-project', 'evaluateCriteria 需要 project 对象（loadProject 的返回值）');
  }
  const contract = project.contract;
  if (!isPlainObject(contract)) {
    throw new EvaluateError('no-contract', '缺少契约：先建立并确认 .modelcheck/contract.json 再执行判定');
  }
  const opts = isPlainObject(options) ? options : {};
  const logger = normalizeLogger(opts.logger);
  const now = typeof opts.now === 'string' && opts.now ? opts.now : nowIso();
  const at = now;
  // Store 是 class 实例（不是 plain object），只按能力探测：有 paths 且能写 JSON 才落盘。
  const store =
    opts.store && opts.store.paths && typeof opts.store.writeJson === 'function' ? opts.store : null;
  const files = normalizeFilesAdapter(opts.files, project.root);
  const execute = typeof opts.executeRule === 'function' ? opts.executeRule : executeRule;
  const runSelfCheck = typeof opts.selfCheckRule === 'function' ? opts.selfCheckRule : selfCheckRule;
  const full = opts.full === true;

  const contractVersion = firstString(contract.contractVersion);
  if (!contractVersion) {
    throw new EvaluateError('no-contract', '契约缺少 contractVersion，证据无法绑定版本，拒绝执行');
  }

  const allCriteria = criteriaOf(contract);
  const activeCriteria = allCriteria.filter(isActive);
  const selection = selectCriteria(activeCriteria, opts.ids);

  const route = firstString(project.config && project.config.route);
  const unitToPx =
    project.config && isPlainObject(project.config.preview) && typeof project.config.preview.unitToPx === 'number'
      ? project.config.preview.unitToPx
      : null;
  const components = isPlainObject(project.components) && Array.isArray(project.components.components)
    ? project.components
    : { schemaVersion: 1, components: [] };

  const evidenceIn = evidenceDocOf(project.evidence);
  const adapterVersion =
    firstString(opts.adapterVersion, evidenceIn.adapterVersion, DEFAULT_ADAPTER_VERSION) || DEFAULT_ADAPTER_VERSION;

  // 版本哈希：项目登记产物优先，其次宿主覆盖值，再次取证通道提供的当前版本。
  const projectHashes = isPlainObject(project.hashes) ? project.hashes : {};
  let buildHashBase = firstString(projectHashes.buildHash, opts.buildHash);
  let sourceHashBase = firstString(projectHashes.sourceHash, opts.sourceHash);
  const hashProvider = typeof opts.ctxFactory === 'function' ? opts.ctxFactory.getBuildHashes : opts.ctxFactory && opts.ctxFactory.getBuildHashes;
  if (typeof hashProvider === 'function') {
    try {
      const extra = await hashProvider.call(opts.ctxFactory);
      if (isPlainObject(extra)) {
        buildHashBase = firstString(extra.buildHash, buildHashBase);
        sourceHashBase = firstString(extra.sourceHash, sourceHashBase);
      }
    } catch (error) {
      logger.warn(`读取当前构建哈希失败（继续按项目登记哈希）：${String(error && error.message ? error.message : error)}`);
    }
  }

  // 依赖哈希缓存：同一文件只读一次，读不到记为 null（键不可复用，运行结果按 fail-closed 处理）。
  const depHashCache = new Map();
  async function hashDependency(relPath) {
    const key = normalizePath(relPath);
    if (!depHashCache.has(key)) {
      let hash = null;
      try {
        const value = await files.hash(relPath);
        hash = typeof value === 'string' && value.length > 0 ? value : null;
      } catch (error) {
        logger.warn(`依赖文件不可读，相关判据不复用：${relPath}（${String(error && error.message ? error.message : error)}）`);
      }
      depHashCache.set(key, hash);
    }
    return depHashCache.get(key);
  }

  async function dependenciesOf(criterion) {
    const deps = {};
    let stable = true;
    const list = Array.isArray(criterion.depends) ? criterion.depends : [];
    for (const dep of list) {
      if (typeof dep !== 'string' || !dep.trim()) continue;
      const key = normalizePath(dep);
      const hash = await hashDependency(dep);
      deps[key] = hash;
      if (hash === null) stable = false;
    }
    return { deps, stable };
  }

  /** 证据键组成。缺失的版本字段用 'static' 占位，依赖缺失则直接放弃复用。 */
  function keyPartsOf(criterion, { deps, buildHash, sourceHash, context, adapter }) {
    return {
      contractVersion,
      ruleHash: ruleHash(criterion),
      deps,
      adapterVersion: adapter || adapterVersion,
      context: isPlainObject(context) ? context : {},
      buildHash: buildHash || STATIC_VERSION,
      sourceHash: sourceHash || STATIC_VERSION,
    };
  }

  // 1) 先算"暂定键"（用项目登记版本），能在不取证的前提下复用就不取证——这是增量验证省时间的关键。
  const entries = { ...evidenceIn.entries };
  const planned = []; // { criterion, deps, depsStable, provisionalKey, decision }
  for (const criterion of selection) {
    const { deps, stable } = await dependenciesOf(criterion);
    const parts = keyPartsOf(criterion, {
      deps,
      buildHash: buildHashBase || STATIC_VERSION,
      sourceHash: sourceHashBase || STATIC_VERSION,
      context: criterion.context,
    });
    const key = evidenceKey(parts);
    const stored = isPlainObject(entries[criterion.id]) ? entries[criterion.id] : null;
    const decision = full ? 'rerun' : reuseDecision(stored, key);
    planned.push({ criterion, deps, depsStable: stable, provisionalKey: key, parts, stored, decision });
  }

  // 2) 只对"不能复用"的运行时判据取证：按 context 分组，一个上下文一次请求（规格 §17.1）。
  const needsRuntime = planned.filter(
    (item) => item.decision !== 'reuse' && requiredEvidenceOf(item.criterion) === 'runtime',
  );
  const evidenceByContext = new Map();
  if (needsRuntime.length > 0) {
    if (typeof opts.ctxFactory !== 'function') {
      logger.warn('缺少运行时取证通道（ctxFactory）：运行时判据将记为 inconclusive');
    } else {
      const groups = new Map();
      for (const item of needsRuntime) {
        const context = isPlainObject(item.criterion.context) ? item.criterion.context : {};
        const contextKey = stableStringify(context);
        if (!groups.has(contextKey)) groups.set(contextKey, { context, criteria: [] });
        groups.get(contextKey).criteria.push(item.criterion);
      }
      for (const [contextKey, group] of groups) {
        let evidence = null;
        let failure = null;
        try {
          let outcome;
          if (typeof opts.ctxFactory === 'function') {
            outcome = await opts.ctxFactory(group.criteria, group.context);
          } else {
            outcome = await opts.ctxFactory.requestEvidence(group.criteria, group.context);
          }
          evidence = isPlainObject(outcome) ? outcome : null;
          if (outcome !== undefined && outcome !== null && !isPlainObject(outcome)) {
            failure = '取证通道返回了非对象结果，已按缺证据处理';
          }
        } catch (error) {
          failure = `取证通道异常（fail-closed）：${String(error && error.message ? error.message : error)}`;
        }
        evidenceByContext.set(contextKey, { evidence, failure });
      }
    }
  }

  const runtimeWarnings = [];
  const results = {};
  const currentKeys = {};
  const selfCheckByRuleHash = new Map();
  const selfCheckFailedIds = [];
  const byStatus = { pass: 0, fail: 0, inconclusive: 0, unverified: 0, stale: 0 };
  let reusedCount = 0;
  let evaluatedCount = 0;

  async function runMetaCheck(criterion) {
    if (criterion.method !== 'auto') {
      return { ran: false, ok: null, cases: [], issues: [], reason: '非自动判据不参与元判据自检', at: now };
    }
    const hash = ruleHash(criterion);
    if (selfCheckByRuleHash.has(hash)) return selfCheckByRuleHash.get(hash);
    let fixtures;
    try {
      if (typeof opts.selfCheckFixtures === 'function') {
        fixtures = await opts.selfCheckFixtures(criterion);
      } else if (isPlainObject(opts.selfCheckFixtures) && criterion.rule) {
        fixtures = opts.selfCheckFixtures[criterion.rule.kind];
      }
    } catch (error) {
      fixtures = undefined;
    }
    let record;
    try {
      const outcome = await runSelfCheck(criterion, fixtures);
      record = {
        ran: true,
        ok: Boolean(isPlainObject(outcome) && outcome.ok === true),
        cases: isPlainObject(outcome) && Array.isArray(outcome.cases) ? outcome.cases : [],
        issues: isPlainObject(outcome) && Array.isArray(outcome.issues) ? outcome.issues : [],
        at: now,
      };
    } catch (error) {
      record = {
        ran: true,
        ok: false,
        cases: [],
        issues: [`判据自检执行异常（fail-closed）：${String(error && error.message ? error.message : error)}`],
        at: now,
      };
    }
    selfCheckByRuleHash.set(hash, record);
    return record;
  }

  function requiredEvidenceOf(criterion) {
    if (typeof criterion.requiredEvidence === 'string' && criterion.requiredEvidence) return criterion.requiredEvidence;
    return requiredEvidenceKind(criterion.rule);
  }

  // 逐条判定并落盘（§2.13：逐条写入，崩溃后可续跑）。
  for (const item of planned) {
    const { criterion } = item;
    const requiredEvidence = requiredEvidenceOf(criterion);
    const stored = item.stored;
    const isRuntime = requiredEvidence === 'runtime';
    let result;

    if (item.decision === 'reuse' && isPlainObject(stored)) {
      // 复用：不重写证据（保留原始 capturedAt/artifacts），只回填结果视图。
      reusedCount += 1;
      const status = CONTRACT_STATUSES.has(stored.status) ? stored.status : 'inconclusive';
      result = {
        status,
        measured: stored.measured === undefined ? null : stored.measured,
        assertion: typeof stored.assertion === 'string' ? stored.assertion : typeof criterion.claim === 'string' ? criterion.claim : '',
        evidenceKind: typeof stored.evidenceKind === 'string' ? stored.evidenceKind : requiredEvidence,
        detail: '复用（证据键未变且上次为 pass）',
        reused: true,
        key: item.provisionalKey,
        remedy: remedyFor(status),
      };
      currentKeys[criterion.id] = item.provisionalKey;
      recordResult(criterion, result);
      continue;
    }

    // 键变了：先把旧结果显式标记为 stale（§2.9），再重新取证/执行，绝不静默留旧状态。
    if (isPlainObject(stored) && item.decision === 'stale') {
      const staleEntry = {
        ...stored,
        status: 'stale',
        staleAt: now,
        staleReason: '证据键变化（依赖文件、规则/阈值、契约版本或运行上下文发生变化）',
      };
      entries[criterion.id] = staleEntry;
      await persistRecords({ [criterion.id]: staleEntry }, now);
    }

    // 3) 运行时取证一致性（版本/上下文不符即 inconclusive，不回退到配置值）。
    let runtime = { ok: false, reason: '该判据不需要运行时取证', evidence: null };
    if (isRuntime) {
      if (typeof opts.ctxFactory !== 'function') {
        runtime = { ok: false, reason: '未配置运行时取证通道（ctxFactory），无法取得运行时证据', evidence: null };
      } else {
        const contextKey = stableStringify(isPlainObject(criterion.context) ? criterion.context : {});
        const group = evidenceByContext.get(contextKey);
        if (!group) {
          runtime = { ok: false, reason: '未取得运行时取证（取证分组缺失）', evidence: null };
        } else if (group.failure) {
          runtime = { ok: false, reason: group.failure, evidence: null };
        } else {
          runtime = checkRuntimeEvidence(group.evidence, criterion, buildHashBase);
        }
      }
      if (!runtime.ok) logger.warn(`判据 ${criterion.id} 的运行时证据不足：${runtime.reason}`);
    }

    // 4) 元判据：规则/阈值变化后（键变即视为变）必须在启用前自检通过。
    const selfCheckRecord = await runMetaCheck(criterion);
    if (selfCheckRecord.ran && selfCheckRecord.ok !== true) {
      selfCheckFailedIds.push(criterion.id);
      const reasons = Array.isArray(selfCheckRecord.issues) && selfCheckRecord.issues.length > 0
        ? selfCheckRecord.issues.slice(0, 3).join('；')
        : '自检用例未达到预期';
      result = {
        status: 'inconclusive',
        measured: null,
        assertion: typeof criterion.claim === 'string' ? criterion.claim : '',
        evidenceKind: requiredEvidence,
        detail: `元判据未通过，判据不可启用：${reasons}`,
        reused: false,
        remedy: remedyFor('inconclusive'),
        selfCheck: selfCheckRecord,
      };
    } else if (isRuntime && !runtime.ok) {
      result = {
        status: 'inconclusive',
        measured: null,
        assertion: typeof criterion.claim === 'string' ? criterion.claim : '',
        evidenceKind: requiredEvidence,
        detail: runtime.reason,
        reused: false,
        remedy: remedyFor('inconclusive'),
        selfCheck: selfCheckRecord,
      };
    } else {
      // 5) 规则执行：执行器异常/返回非法状态一律 inconclusive（fail-closed）。
      const ctx = {
        projectRoot: typeof project.root === 'string' ? project.root : null,
        route,
        unitToPx,
        files,
        components,
        evidence: isRuntime && runtime.ok ? runtime.evidence : null,
        now,
      };
      let outcome;
      try {
        outcome = await execute(criterion.rule, ctx);
      } catch (error) {
        outcome = {
          status: 'inconclusive',
          detail: `规则执行异常（fail-closed）：${String(error && error.message ? error.message : error)}`,
        };
      }
      const safeOutcome = isPlainObject(outcome) ? outcome : {};
      const status = normalizeStatus(safeOutcome.status);
      result = {
        status,
        measured: safeOutcome.measured === undefined ? null : safeOutcome.measured,
        assertion:
          typeof safeOutcome.assertion === 'string'
            ? safeOutcome.assertion
            : typeof criterion.claim === 'string'
              ? criterion.claim
              : '',
        evidenceKind:
          typeof safeOutcome.evidenceKind === 'string' ? safeOutcome.evidenceKind : requiredEvidence,
        detail: typeof safeOutcome.detail === 'string' ? safeOutcome.detail : '',
        reused: false,
        remedy: remedyFor(status),
        selfCheck: selfCheckRecord,
      };
      if (Array.isArray(safeOutcome.errors) && safeOutcome.errors.length > 0) result.errors = safeOutcome.errors;
      if (Array.isArray(safeOutcome.coverage) && safeOutcome.coverage.length > 0) result.coverage = safeOutcome.coverage;
      if (Array.isArray(safeOutcome.artifacts) && safeOutcome.artifacts.length > 0) result.artifacts = safeOutcome.artifacts;
    }

    // 6) 证据键：运行时判据用实际取证版本；静态判据用项目登记版本或 'static'。
    let buildHash = buildHashBase;
    let sourceHash = sourceHashBase;
    let adapter = adapterVersion;
    if (isRuntime && runtime.ok) {
      const versions = runtimeVersions(runtime.evidence);
      buildHash = versions.buildHash || buildHash || STATIC_VERSION;
      sourceHash = versions.sourceHash || sourceHash || STATIC_VERSION;
      adapter = versions.adapterVersion || adapter;
      if (versions.sourceHash && sourceHashBase && versions.sourceHash !== sourceHashBase) {
        const warning = `判据 ${criterion.id} 的取证 sourceHash 与项目登记源码哈希不一致，已按取证版本记录；请确认是否用了旧产物`;
        runtimeWarnings.push(warning);
        logger.warn(warning);
      }
    }
    const finalParts = keyPartsOf(criterion, {
      deps: item.deps,
      buildHash,
      sourceHash,
      context: criterion.context,
      adapter,
    });
    const finalKey = evidenceKey(finalParts);
    const record = buildEvidenceRecord(criterion, { ...result, capturedAt: now }, finalParts);
    record.reused = false;
    record.selfCheck = result.selfCheck || await runMetaCheck(criterion);
    // 人工/视觉验收：用户确认绑定具体证据版本（规格 §17.2）。
    // 同一证据键重跑时保留该确认（无关变化经依赖证明可保留）；键变化则丢弃，等待用户对新版本重新确认。
    if (
      isPlainObject(stored) &&
      isPlainObject(stored.userConfirmation) &&
      typeof stored.key === 'string' &&
      stored.key === finalKey
    ) {
      record.userConfirmation = stored.userConfirmation;
    }
    entries[criterion.id] = record;
    currentKeys[criterion.id] = finalKey;
    result.key = finalKey;
    await persistRecords({ [criterion.id]: record }, now);
    recordResult(criterion, result);
  }

  /** 汇总单条结果。 */
  function recordResult(criterion, result) {
    const status = CONTRACT_STATUSES.has(result.status) ? result.status : 'inconclusive';
    if (!Object.prototype.hasOwnProperty.call(byStatus, status)) byStatus[status] = 0;
    byStatus[status] += 1;
    if (!result.reused) evaluatedCount += 1;
    results[criterion.id] = result;
  }

  /** 合并证据文档并落盘；没有 store 时只更新内存文档。冲突时重读重试（§18：不静默覆盖）。 */
  async function persistRecords(changed, updatedAt) {
    if (!store) return;
    const merged = (current) => {
      const base = evidenceDocOf(current);
      return {
        ...base,
        schemaVersion: 1,
        adapterVersion,
        entries: { ...base.entries, ...changed },
        updatedAt,
      };
    };
    let attempt = 0;
    for (;;) {
      try {
        await store.updateJson(store.paths.evidence, merged);
        return;
      } catch (error) {
        if (error && error.code === 'conflict' && attempt < 2) {
          attempt += 1;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          continue;
        }
        throw error;
      }
    }
  }

  // 7) 状态镜像回契约（契约内容哈希不含 status/evidence，故确认后的内容哈希不受影响）。
  const mirrored = mirrorContractStatuses(project.contract, selection, entries, now);
  if (mirrored && store) {
    await persistContractMirror(store, selection, entries, now, logger);
  }

  const selectedIds = new Set(selection.map((criterion) => criterion.id));
  const evaluation = {
    results,
    summary: {
      total: selection.length,
      byStatus,
      reused: reusedCount,
      evaluated: evaluatedCount,
      skipped: activeCriteria.length - selectedIds.size,
      selfCheckFailed: selfCheckFailedIds.length,
      currentKeys: Object.keys(currentKeys).length,
    },
    selfCheckFailures: selfCheckFailedIds,
    runtimeWarnings,
    buildHash: buildHashBase || STATIC_VERSION,
    sourceHash: sourceHashBase || STATIC_VERSION,
    contractVersion,
    adapterVersion,
    at,
    currentKeys,
    evidence: {
      ...evidenceIn,
      schemaVersion: 1,
      adapterVersion,
      entries,
      updatedAt: now,
    },
  };
  // 宿主 tools 紧接着用 project.evidence / project.contract.criteria 读内存镜像：
  // 这里显式写回最新证据文档（契约状态镜像已在上面完成；两者都不触碰 contentHash 相关字段）。
  project.evidence = evaluation.evidence;

  if (selfCheckFailedIds.length > 0) {
    logger.warn(`以下判据自检未通过、结果不可用作通过：${selfCheckFailedIds.join('、')}`);
  }
  return evaluation;
}

/** ids 过滤：只允许生效判据；未知/已失效 id 明确报错，不静默跳过。 */
function selectCriteria(activeCriteria, ids) {
  if (ids === undefined || ids === null) return activeCriteria;
  if (!Array.isArray(ids)) {
    throw new EvaluateError('invalid-options', 'options.ids 必须是判据 id 数组');
  }
  const wanted = ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
  if (wanted.length === 0) return activeCriteria;
  const activeById = new Map(activeCriteria.map((criterion) => [criterion.id, criterion]));
  const missing = wanted.filter((id) => !activeById.has(id));
  if (missing.length > 0) {
    throw new EvaluateError('unknown-ids', `判据不存在或已失效：${missing.join('、')}`, { missing });
  }
  const wantedSet = new Set(wanted);
  return activeCriteria.filter((criterion) => wantedSet.has(criterion.id));
}

/** 把最新状态/证据摘要镜像到契约内存对象（不改规则、不改内容哈希相关字段）。 */
function mirrorContractStatuses(contract, criteria, entries, at) {
  if (!isPlainObject(contract) || !Array.isArray(contract.criteria)) return false;
  const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  let changed = false;
  for (const criterion of contract.criteria) {
    if (!isPlainObject(criterion) || !byId.has(criterion.id)) continue;
    const entry = entries[criterion.id];
    if (!isPlainObject(entry)) continue;
    const status = CONTRACT_STATUSES.has(entry.status) ? entry.status : 'inconclusive';
    criterion.status = status;
    criterion.evidence = {
      status,
      measured: entry.measured === undefined ? null : entry.measured,
      assertion: typeof entry.assertion === 'string' ? entry.assertion : '',
      evidenceKind: typeof entry.evidenceKind === 'string' ? entry.evidenceKind : null,
      key: typeof entry.key === 'string' ? entry.key : null,
      capturedAt: typeof entry.capturedAt === 'string' ? entry.capturedAt : at,
      detail: typeof entry.detail === 'string' ? entry.detail : '',
      selfCheckOk: isPlainObject(entry.selfCheck) ? entry.selfCheck.ok : null,
    };
    changed = true;
  }
  return changed;
}

/** 契约文件状态镜像落盘（contentHash 不重算：它不包含 status/evidence）。 */
async function persistContractMirror(store, criteria, entries, at, logger) {
  const contractPath = store.paths.contract;
  try {
    if (typeof store.exists === 'function' && !(await store.exists(contractPath))) return;
    const byId = new Map(criteria.map((criterion) => [criterion.id, criterion]));
    await store.updateJson(contractPath, (current) => {
      if (!isPlainObject(current) || !Array.isArray(current.criteria)) return undefined;
      let touched = false;
      const nextCriteria = current.criteria.map((criterion) => {
        if (!isPlainObject(criterion) || !byId.has(criterion.id)) return criterion;
        const entry = entries[criterion.id];
        if (!isPlainObject(entry)) return criterion;
        touched = true;
        return {
          ...criterion,
          status: CONTRACT_STATUSES.has(entry.status) ? entry.status : 'inconclusive',
          evidence: {
            status: CONTRACT_STATUSES.has(entry.status) ? entry.status : 'inconclusive',
            measured: entry.measured === undefined ? null : entry.measured,
            assertion: typeof entry.assertion === 'string' ? entry.assertion : '',
            evidenceKind: typeof entry.evidenceKind === 'string' ? entry.evidenceKind : null,
            key: typeof entry.key === 'string' ? entry.key : null,
            capturedAt: typeof entry.capturedAt === 'string' ? entry.capturedAt : at,
            detail: typeof entry.detail === 'string' ? entry.detail : '',
            selfCheckOk: isPlainObject(entry.selfCheck) ? entry.selfCheck.ok : null,
          },
        };
      });
      if (!touched) return undefined;
      return { ...current, criteria: nextCriteria };
    });
  } catch (error) {
    // 状态镜像失败不影响本次判定结论（evidence.json 才是权威）；但必须显式告警，不静默。
    logger.warn(`契约状态镜像写入失败（evidence.json 仍为权威）：${String(error && error.message ? error.message : error)}`);
  }
}
