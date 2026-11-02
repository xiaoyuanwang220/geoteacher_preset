/**
 * ModelCheck 证据模块（设计文档 §2.8）
 *
 * 职责：
 * - 生成证据键（规范 JSON 的 sha256），字段缺失即视为不稳定、不得复用；
 * - 判断旧证据能否复用（reuse / rerun / stale）；
 * - 把规则执行结果构造成 evidence.json 中的一条记录；
 * - 依赖文件变化时把相关证据标记为 stale；
 * - 汇总证据状态。
 *
 * 约束：纯 ESM、只用 node: 内置模块、不修改入参、不读全局状态。
 */
import { sha256, stableStringify, nowIso, isPlainObject } from './util.js';

/** 证据键的全部组成字段（顺序即规范顺序，实际哈希由 stableStringify 排序）。 */
export const EVIDENCE_KEY_PARTS = [
  'contractVersion',
  'ruleHash',
  'deps',
  'adapterVersion',
  'context',
  'buildHash',
  'sourceHash'
];

/** 证据状态取值。 */
export const EVIDENCE_STATUSES = [
  'pass',
  'fail',
  'unknown',
  'inconclusive',
  'error',
  'unverified',
  'stale'
];

/** 默认适配器版本（evaluate 未显式传入时兜底）。 */
export const DEFAULT_ADAPTER_VERSION = 'modelcheck-adapter/1';

/** 判断是否非空字符串。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** 把路径规范成 posix 风格、去掉 ./ 前缀，便于依赖比对。 */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^(\.\.\/)+/, '')
    .trim();
}

/** 只挑出合法的键组成字段，其余字段不参与键计算。 */
function pickKeyParts(parts) {
  const picked = {};
  if (!isPlainObject(parts)) return picked;
  for (const name of EVIDENCE_KEY_PARTS) {
    if (Object.prototype.hasOwnProperty.call(parts, name) && parts[name] !== undefined) {
      picked[name] = parts[name];
    }
  }
  return picked;
}

/**
 * 计算证据键。
 * 七个必需字段（contractVersion/ruleHash/deps/adapterVersion/context/buildHash/sourceHash）
 * 任一缺失、类型不符或为空字符串 → 返回 null（表示不可复用）。
 * deps 与 context 必须是普通对象（可为空对象），字符串字段必须非空。
 */
export function evidenceKey(parts) {
  if (!isPlainObject(parts)) return null;
  const normalized = {};
  for (const name of EVIDENCE_KEY_PARTS) {
    const value = parts[name];
    if (name === 'deps' || name === 'context') {
      if (!isPlainObject(value)) return null;
      normalized[name] = value;
      continue;
    }
    if (!nonEmptyString(value)) return null;
    normalized[name] = value;
  }
  return sha256(stableStringify(normalized));
}

/**
 * 判断旧证据的处理方式。
 * - 键不可计算 / 无旧证据 → 'rerun'；
 * - 旧证据存在但键不同（或旧证据没有键）→ 'stale'；
 * - 键相同且 status==='pass' → 'reuse'；
 * - 键相同但未通过 → 'rerun'（状态仍需显式写入）。
 */
export function reuseDecision(stored, key) {
  if (!nonEmptyString(key)) return 'rerun';
  if (!isPlainObject(stored)) return 'rerun';
  const storedKey = nonEmptyString(stored.key) ? stored.key : null;
  if (!storedKey) return 'stale';
  if (storedKey !== key) return 'stale';
  return stored.status === 'pass' ? 'reuse' : 'rerun';
}

/** 归一化 errors：接受字符串、数组、对象。 */
function normalizeErrors(errors) {
  if (errors === undefined || errors === null) return [];
  if (Array.isArray(errors)) return errors.slice();
  if (typeof errors === 'string') return errors.length > 0 ? [errors] : [];
  return [errors];
}

/** 归一化 artifacts 名称数组（保留字符串，去掉空值）。 */
function normalizeArtifacts(artifacts) {
  if (!Array.isArray(artifacts)) return [];
  return artifacts.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * 构造一条证据记录（写入 evidence.json 的 entries[criterionId]）。
 * 不修改 criterion / result / keyParts。
 */
export function buildEvidenceRecord(criterion, result, keyParts) {
  const criterionObj = isPlainObject(criterion) ? criterion : {};
  const res = isPlainObject(result) ? result : {};
  const parts = pickKeyParts(keyParts);

  const status = EVIDENCE_STATUSES.includes(res.status) ? res.status : 'fail';
  const capturedAt = nonEmptyString(res.capturedAt) ? res.capturedAt : nowIso();

  return {
    criterionId: typeof criterionObj.id === 'string' ? criterionObj.id : null,
    status,
    measured: res.measured === undefined ? null : res.measured,
    assertion:
      typeof res.assertion === 'string'
        ? res.assertion
        : typeof criterionObj.claim === 'string'
          ? criterionObj.claim
          : '',
    evidenceKind:
      typeof res.evidenceKind === 'string'
        ? res.evidenceKind
        : typeof criterionObj.requiredEvidence === 'string'
          ? criterionObj.requiredEvidence
          : 'auto',
    key: evidenceKey(parts),
    keyParts: parts,
    buildHash: nonEmptyString(parts.buildHash) ? parts.buildHash : null,
    sourceHash: nonEmptyString(parts.sourceHash) ? parts.sourceHash : null,
    context: isPlainObject(parts.context)
      ? parts.context
      : isPlainObject(criterionObj.context)
        ? criterionObj.context
        : {},
    capturedAt,
    artifacts: normalizeArtifacts(res.artifacts),
    coverage: Array.isArray(res.coverage) ? res.coverage.slice() : [],
    errors: normalizeErrors(res.errors),
    detail: typeof res.detail === 'string' ? res.detail : '',
    reused: res.reused === true
  };
}

/** 拆出 entries 映射；兼容 { entries } 包装与裸映射两种形态。 */
function entriesView(evidence) {
  if (!isPlainObject(evidence)) return { wrapped: false, entries: {} };
  if (isPlainObject(evidence.entries)) return { wrapped: true, entries: evidence.entries };
  return { wrapped: false, entries: evidence };
}

/** 从证据记录里取依赖哈希表。 */
function depsOf(entry) {
  if (!isPlainObject(entry)) return null;
  if (isPlainObject(entry.keyParts) && isPlainObject(entry.keyParts.deps)) return entry.keyParts.deps;
  if (isPlainObject(entry.deps)) return entry.deps;
  return null;
}

/**
 * 依赖文件变化时把相关证据标记为 stale。
 * 只做浅拷贝，不改原对象；返回新 evidence 与受影响清单。
 */
export function invalidateByDependency(evidence, changedFiles) {
  const view = entriesView(evidence);
  const changedList = Array.isArray(changedFiles) ? changedFiles : [];
  const normalizedFiles = [];
  const seen = new Set();
  for (const file of changedList) {
    const normalized = normalizePath(file);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      normalizedFiles.push(normalized);
    }
  }

  const staleIds = [];
  const matchedFiles = [];
  const matchedSeen = new Set();
  const entries = {};
  const now = nowIso();

  for (const [id, entry] of Object.entries(view.entries)) {
    const deps = depsOf(entry);
    if (!deps) {
      entries[id] = entry;
      continue;
    }
    const matched = Object.keys(deps).filter((dep) => seen.has(normalizePath(dep)));
    if (matched.length === 0) {
      entries[id] = entry;
      continue;
    }
    staleIds.push(id);
    for (const file of matched) {
      const normalized = normalizePath(file);
      if (!matchedSeen.has(normalized)) {
        matchedSeen.add(normalized);
        matchedFiles.push(normalized);
      }
    }
    entries[id] = {
      ...entry,
      status: 'stale',
      staleAt: now,
      staleReason: `依赖文件变化：${matched.map((item) => normalizePath(item)).join('、')}`
    };
  }

  const nextEvidence = view.wrapped
    ? { ...evidence, entries, updatedAt: now }
    : entries;

  return { changed: normalizedFiles, matched: matchedFiles, staleIds, evidence: nextEvidence };
}

/**
 * 写入用户人工/视觉验收确认（不可变，返回新的 evidence 文档）。
 * - 判据条目不存在 → 抛错（caller 捕获后返回 4xx）；
 * - accepted === true：只写确认，不改 status；
 * - accepted === false：同时把该条记为 status:'fail' + detail:reason（下一轮修改）。
 */
export function attachUserConfirmation(
  evidence,
  { criterionId, evidenceKey: currentKey, confirmedBy = 'user', confirmedAt, reason = null, accepted = true } = {}
) {
  if (typeof criterionId !== 'string' || criterionId.length === 0) {
    throw new Error('attachUserConfirmation 需要 criterionId');
  }
  const view = entriesView(evidence);
  const entry = view.entries[criterionId];
  if (!isPlainObject(entry)) {
    throw new Error(`未知判据：${criterionId}`);
  }
  const at = nonEmptyString(confirmedAt) ? confirmedAt : nowIso();
  const userConfirmation = {
    confirmedBy: nonEmptyString(confirmedBy) ? confirmedBy : 'user',
    confirmedAt: at,
    evidenceKey: nonEmptyString(currentKey) ? currentKey : (nonEmptyString(entry.key) ? entry.key : null),
    accepted: accepted !== false,
    reason: reason === undefined ? null : reason
  };

  let nextEntry = { ...entry, userConfirmation };
  if (accepted === false) {
    nextEntry = {
      ...nextEntry,
      status: 'fail',
      detail: typeof reason === 'string' && reason.length > 0 ? reason : '用户人工验收未通过'
    };
  }

  const entries = { ...view.entries, [criterionId]: nextEntry };
  const nextEvidence = view.wrapped ? { ...evidence, entries, updatedAt: at } : entries;
  return nextEvidence;
}

/**
 * 汇总证据：状态计数、过期项、失败项、缺失项。
 */
export function summarizeEvidence(evidence) {
  const { entries } = entriesView(evidence);
  const byStatus = {};
  for (const status of EVIDENCE_STATUSES) byStatus[status] = 0;
  const staleIds = [];
  const failingIds = [];
  const unknownIds = [];
  const unverifiedIds = [];

  let total = 0;
  for (const [id, entry] of Object.entries(entries)) {
    total += 1;
    const status = isPlainObject(entry) && EVIDENCE_STATUSES.includes(entry.status) ? entry.status : 'error';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (status === 'stale') staleIds.push(id);
    if (status === 'fail') failingIds.push(id);
    if (status === 'unknown' || status === 'inconclusive') unknownIds.push(id);
    if (status === 'unverified') unverifiedIds.push(id);
  }

  return {
    total,
    byStatus,
    staleIds,
    failingIds,
    unknownIds,
    unverifiedIds,
    passed: byStatus.pass,
    stale: byStatus.stale,
    failing: byStatus.fail
  };
}
