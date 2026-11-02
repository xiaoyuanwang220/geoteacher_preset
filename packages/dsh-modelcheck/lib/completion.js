/**
 * ModelCheck 完成门禁模块（设计文档 §2.10）
 *
 * 职责：
 * - 依据契约、证据、标注请求、人工验收与认证记录判定项目是否可认证；
 * - 生成一页式判定报告（工具结果用）；
 * - 校验 certification.json 是否对当前版本仍然有效。
 *
 * project 形状（由 evaluate.js / 宿主组装，本模块只读）：
 * {
 *   contract: {...},            // .modelcheck/contract.json
 *   components: [...],          // 组件注册表快照（本模块不依赖其内部字段）
 *   evidence: { entries },      // .modelcheck/evidence.json
 *   annotations: { batches, requests }, // .modelcheck/annotations.json
 *   certification: {...}|null,  // .modelcheck/certification.json
 *   config: {...},              // 插件配置快照
 *   currentKeys?: { [criterionId]: 'sha256:…' }, // 可选的当前证据键（便于确定性测试）
 *   buildHash?: string, sourceHash?: string, contractVersion?: string
 * }
 *
 * 约束：纯 ESM、只用 node: 内置模块、不修改入参。
 */
import { sha256, stableStringify, nowIso, isPlainObject } from './util.js';
import {
  evidenceKey,
  summarizeEvidence,
  DEFAULT_ADAPTER_VERSION
} from './evidence.js';

/** 视为「不参与判定」的判据状态（已移除/搁置）。 */
const INACTIVE_CRITERION_STATES = new Set(['removed', 'dropped', 'inactive']);
/** 无论是否阻塞都必须解决的状态。 */
const HARD_BLOCK_STATUSES = new Set(['stale', 'unverified', 'inconclusive']);

/** 非阻塞时允许进 knownFailures 的状态。 */
const KNOWN_FAILURE_STATUSES = new Set(['fail', 'unknown', 'error']);

/** 已发送但未终结的标注请求状态。 */
const PENDING_REQUEST_STATES = new Set(['sent', 'triaged', 'editing', 'review']);

/** 取第一个非空字符串。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** 归一化证据文档为 entries 映射。 */
function entriesOf(project) {
  const evidence = isPlainObject(project?.evidence) ? project.evidence : {};
  if (isPlainObject(evidence.entries)) return evidence.entries;
  return evidence;
}

/** 取契约判据列表。 */
function criteriaOf(contract) {
  return Array.isArray(contract?.criteria) ? contract.criteria : [];
}

/** 过滤出仍生效的判据（与 contract.isActive 对齐：supersededBy / withdrawn 不参与）。 */
function activeCriteria(project) {
  const contract = isPlainObject(project?.contract) ? project.contract : {};
  return criteriaOf(contract).filter((criterion) => {
    if (!isPlainObject(criterion) || typeof criterion.id !== 'string') return false;
    if (criterion.active === false) return false;
    if (criterion.supersededBy) return false;
    if (criterion.withdrawn === true) return false;
    const state = String(criterion.status ?? '').toLowerCase();
    return !INACTIVE_CRITERION_STATES.has(state);
  });
}

/** 是否为阻塞判据（默认阻塞）。 */
function isBlocking(criterion) {
  return criterion?.blocking !== false;
}

/** 从证据条目里取实际取证版本（运行时证据的真实 buildHash 只存在于 keyParts）。 */
function versionFromEvidence(project, field) {
  const entries = entriesOf(project);
  for (const entry of Object.values(entries)) {
    const parts = isPlainObject(entry?.keyParts) ? entry.keyParts : null;
    const value = parts ? parts[field] : null;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** 从项目 / 证据 / 认证记录里收集版本信息。 */
function versionContext(project) {
  const evidence = isPlainObject(project?.evidence) ? project.evidence : {};
  const meta = isPlainObject(evidence.meta) ? evidence.meta : {};
  const artifacts = isPlainObject(project?.artifacts) ? project.artifacts : {};
  const hashes = isPlainObject(project?.hashes) ? project.hashes : {};
  const cert = isPlainObject(project?.certification) ? project.certification : null;
  const contract = isPlainObject(project?.contract) ? project.contract : {};

  // 项目登记版本（严格来自项目产物/源码清单），认证记录只绑定这一层；
  // 它与宿主 certificationValid 调用传入的 project.hashes 同源，避免占位值造成假失效。
  const explicitBuildHash = firstString(hashes.buildHash, project?.buildHash, artifacts.buildHash);
  const explicitSourceHash = firstString(hashes.sourceHash, project?.sourceHash, artifacts.sourceHash);

  return {
    contractVersion: firstString(
      contract.contractVersion,
      project?.contractVersion,
      meta.contractVersion,
      cert?.contractVersion
    ),
    // 项目没有登记构建产物（hashes.buildHash=null）时，退回证据里实际记录的版本：
    // 运行时证据带真实 buildHash，静态路线带 'static' 占位值。二者都真实绑定了取证版本。
    buildHash:
      explicitBuildHash ??
      firstString(evidence.buildHash, meta.buildHash, cert?.buildHash) ??
      versionFromEvidence(project, 'buildHash'),
    sourceHash:
      explicitSourceHash ??
      firstString(evidence.sourceHash, meta.sourceHash, cert?.sourceHash) ??
      versionFromEvidence(project, 'sourceHash'),
    explicitBuildHash,
    explicitSourceHash,
    adapterVersion: firstString(project?.adapterVersion, evidence.adapterVersion, DEFAULT_ADAPTER_VERSION)
  };
}

/** 取判据的规则哈希（未提供时按规则内容现算）。 */
function ruleHashOf(criterion) {
  if (typeof criterion?.ruleHash === 'string' && criterion.ruleHash.length > 0) return criterion.ruleHash;
  if (criterion?.rule === undefined) return null;
  return sha256(stableStringify(criterion.rule));
}

/** 依据当前版本重算证据键（用于与旧证据比对）。 */
function currentKeyOf(criterion, entry, ctx) {
  if (isPlainObject(ctx.currentKeys) && Object.prototype.hasOwnProperty.call(ctx.currentKeys, criterion.id)) {
    const provided = ctx.currentKeys[criterion.id];
    return typeof provided === 'string' && provided.length > 0 ? provided : null;
  }
  const parts = isPlainObject(entry?.keyParts) ? entry.keyParts : null;
  if (!parts) return null;
  // 只有项目登记了真实产物/源码哈希才强制替换；否则沿用证据自带的取证版本（'static' 或运行时真实哈希）。
  return evidenceKey({
    contractVersion: ctx.contractVersion ?? parts.contractVersion,
    ruleHash: parts.ruleHash ?? ruleHashOf(criterion),
    deps: isPlainObject(parts.deps) ? parts.deps : {},
    adapterVersion: parts.adapterVersion ?? ctx.adapterVersion,
    context: isPlainObject(parts.context) ? parts.context : {},
    buildHash: ctx.explicitBuildHash ?? parts.buildHash,
    sourceHash: ctx.explicitSourceHash ?? parts.sourceHash
  });
}

/**
 * 判断证据是否对应当前版本（fresh）。
 * 返回 { fresh:boolean, reason:string }。
 */
function freshness(criterion, entry, ctx) {
  if (!isPlainObject(entry)) return { fresh: false, reason: '缺少证据' };
  const status = typeof entry.status === 'string' ? entry.status : 'unverified';
  if (status === 'stale') return { fresh: false, reason: '证据已过期' };

  if (isPlainObject(ctx.currentKeys) && Object.prototype.hasOwnProperty.call(ctx.currentKeys, criterion.id)) {
    const provided = ctx.currentKeys[criterion.id];
    if (typeof provided !== 'string' || provided.length === 0) {
      return { fresh: false, reason: '证据键不可计算' };
    }
  }

  const key = currentKeyOf(criterion, entry, ctx);
  if (!key) return { fresh: false, reason: '证据缺少完整的键组成字段' };
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    return { fresh: false, reason: '证据缺少键' };
  }
  if (entry.key !== key) return { fresh: false, reason: '证据键与当前版本不一致' };
  return { fresh: true, reason: '' };
}

/** 判断判据是否属于人工/视觉验收。 */
function isManualCriterion(criterion) {
  const marks = [criterion?.acceptance, criterion?.method, criterion?.requiredEvidence];
  return marks.some((mark) => mark === 'manual' || mark === 'visual');
}

/**
 * 校验人工/视觉验收的用户确认。
 * 只有 entries[id].userConfirmation 为 { confirmedBy:'user', accepted:true }，
 * 且 evidenceKey 与当前键一致（无当前键时退化为与记录键一致）才算通过。
 */
function manualConfirmation(criterion, entry, currentKey) {
  const confirmation = isPlainObject(entry?.userConfirmation) ? entry.userConfirmation : null;
  if (!confirmation) return { ok: false, reason: '缺少用户确认' };
  if (confirmation.confirmedBy !== 'user') return { ok: false, reason: '确认方不是用户' };
  if (confirmation.accepted !== true) return { ok: false, reason: '用户未通过该项验收' };
  const boundKey = typeof confirmation.evidenceKey === 'string' && confirmation.evidenceKey.length > 0
    ? confirmation.evidenceKey
    : null;
  if (currentKey) {
    if (!boundKey) return { ok: false, reason: '用户确认未绑定证据键' };
    if (boundKey !== currentKey) return { ok: false, reason: '用户确认绑定的是旧版本证据' };
    return { ok: true, reason: '' };
  }
  const storedKey = typeof entry?.key === 'string' && entry.key.length > 0 ? entry.key : null;
  if (storedKey && boundKey !== storedKey) return { ok: false, reason: '用户确认绑定的是旧版本证据' };
  return { ok: true, reason: '' };
}

/** 状态 → 修复建议。 */
function remedyFor(status) {
  switch (status) {
    case 'pass':
      return '';
    case 'stale':
      return '依赖或版本已变化，运行 modelcheck_evaluate 重新取证';
    case 'unverified':
      return '运行 modelcheck_evaluate 采集该判据证据';
    case 'fail':
      return '按判据要求修复后重新取证';
    case 'unknown':
      return '补充证据或缩小判定范围后重新取证';
    case 'inconclusive':
      return '证据不足以判定，补充取证后重新运行';
    case 'error':
      return '检查规则配置与取证通道后重新运行';
    default:
      return '重新运行判定并补齐证据';
  }
}

/** 提取测量值的简短展示文本。 */
function displayMeasured(measured) {
  if (measured === null || measured === undefined) return '—';
  if (typeof measured === 'string') return measured;
  if (typeof measured === 'number' || typeof measured === 'boolean') return String(measured);
  try {
    const text = JSON.stringify(measured);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch {
    return '—';
  }
}

/** 证据展示文本：类型 + 键前缀 + 采集时间。 */
function displayEvidence(entry) {
  if (!isPlainObject(entry)) return '无证据';
  const kind = typeof entry.evidenceKind === 'string' ? entry.evidenceKind : 'auto';
  const key = typeof entry.key === 'string' ? entry.key : '';
  const shortKey = key.length > 20 ? `${key.slice(0, 19)}…` : key || '无键';
  const at = typeof entry.capturedAt === 'string' ? entry.capturedAt : '—';
  return `${kind} · ${shortKey} · ${at}`;
}

/** 统计标注请求。 */
function requestStats(project) {
  const annotations = isPlainObject(project?.annotations) ? project.annotations : {};
  const requests = Array.isArray(annotations.requests) ? annotations.requests : [];
  const pending = requests.filter((request) => PENDING_REQUEST_STATES.has(request?.state));
  const drafts = requests.filter((request) => request?.state === 'draft');
  return { total: requests.length, pending, drafts };
}

/**
 * 非阻塞判据中的已知缺陷（进入 report.knownFailures，允许交付但必须列出）。
 */
export function knownFailures(project) {
  const entries = entriesOf(project);
  const failures = [];
  for (const criterion of activeCriteria(project)) {
    if (isBlocking(criterion)) continue;
    const entry = entries[criterion.id];
    const status = isPlainObject(entry) && typeof entry.status === 'string' ? entry.status : 'unverified';
    if (!KNOWN_FAILURE_STATUSES.has(status)) continue;
    failures.push({
      id: criterion.id,
      level: criterion.level ?? 'P2',
      claim: typeof criterion.claim === 'string' ? criterion.claim : '',
      status,
      blocking: false,
      measured: entry?.measured === undefined ? null : entry.measured,
      detail: typeof entry?.detail === 'string' ? entry.detail : '',
      remedy: remedyFor(status)
    });
  }
  return failures;
}

/** 版本值比对：当前项目没有登记该版本（null）时无法比对，保留认证；
 *  'static' 占位值与 null 语义等价；两端都是真实哈希时必须相等。 */
function versionMatches(certValue, currentValue) {
  if (currentValue === null || currentValue === undefined) return true;
  if (certValue === currentValue) return true;
  const certStatic = certValue === null || certValue === 'static';
  const currentStatic = currentValue === 'static';
  return certStatic && currentStatic;
}

/** 认证记录是否对当前版本有效。 */
export function certificationValid(cert, { contractVersion, buildHash, sourceHash } = {}) {
  if (!isPlainObject(cert)) return false;
  if (cert.certified !== true) return false;
  if (cert.invalidatedAt) return false;
  if (contractVersion !== undefined && cert.contractVersion !== contractVersion) return false;
  if (buildHash !== undefined && !versionMatches(cert.buildHash, buildHash)) return false;
  if (sourceHash !== undefined && !versionMatches(cert.sourceHash, sourceHash)) return false;
  return true;
}

/**
 * 完成门禁主入口。
 * 返回 Completion：{ certified, contractVersion, buildHash, sourceHash, at, blocking, report, reasons }
 */
export function evaluateCompletion(project) {
  const safeProject = isPlainObject(project) ? project : {};
  const contract = isPlainObject(safeProject.contract) ? safeProject.contract : null;
  const ctx = {
    ...versionContext(safeProject),
    currentKeys: isPlainObject(safeProject.currentKeys) ? safeProject.currentKeys : null
  };
  const entries = entriesOf(safeProject);
  const criteria = activeCriteria(safeProject);
  const reasons = [];
  const blocking = [];
  const rows = [];

  // 1. 契约前提
  if (!contract) {
    reasons.push('缺少契约：.modelcheck/contract.json 不存在或无法解析');
  } else {
    const status = typeof contract.status === 'string' ? contract.status : 'unknown';
    if (status !== 'confirmed') reasons.push(`契约状态为「${status}」，需用户确认后才能认证`);
    if (criteriaOf(contract).length === 0) reasons.push('契约没有判据，无法认证');
    if (criteriaOf(contract).length > 0 && criteria.length === 0) reasons.push('契约判据全部处于移除/搁置状态');
  }
  if (!ctx.contractVersion && contract) reasons.push('契约缺少 contractVersion');
  if (!ctx.buildHash) reasons.push('缺少构建哈希 buildHash，证据无法绑定版本');
  if (!ctx.sourceHash) reasons.push('缺少源码哈希 sourceHash，证据无法绑定版本');

  // 2. 逐判据判定
  const known = knownFailures(safeProject);
  for (const criterion of criteria) {
    const entry = entries[criterion.id];
    const blockingFlag = isBlocking(criterion);
    const storedStatus =
      isPlainObject(entry) && typeof entry.status === 'string' ? entry.status : 'unverified';
    const key = currentKeyOf(criterion, entry, ctx);
    const fresh = freshness(criterion, entry, ctx);
    const confirmation = isManualCriterion(criterion)
      ? manualConfirmation(criterion, entry, key)
      : { ok: true, reason: '' };

    let rowStatus = storedStatus;
    let rowRemedy = '';

    if (!fresh.fresh) {
      rowStatus = isPlainObject(entry) ? 'stale' : 'unverified';
      rowRemedy = fresh.reason === '缺少证据' ? remedyFor('unverified') : remedyFor('stale');
    } else if (isManualCriterion(criterion) && !confirmation.ok) {
      rowStatus = 'unconfirmed';
      rowRemedy = `人工/视觉验收未确认：${confirmation.reason}；请在面板确认该项`;
    } else if (isManualCriterion(criterion) && confirmation.ok) {
      // 规格 §7.4：manual/visual 只能由用户确认；确认通过即视为满足，
      // 不因规则结果为 inconclusive 而再次阻塞（插件不能自证，但用户可以验收）。
      rowStatus = 'confirmed';
    } else if (blockingFlag && storedStatus !== 'pass') {
      rowStatus = storedStatus;
      rowRemedy = remedyFor(storedStatus);
    } else if (!blockingFlag && HARD_BLOCK_STATUSES.has(storedStatus)) {
      rowStatus = storedStatus;
      rowRemedy = remedyFor(storedStatus);
    }

    const blocks = rowRemedy.length > 0;
    if (blocks) {
      blocking.push({ id: criterion.id, status: rowStatus, remedy: rowRemedy });
    }

    rows.push({
      id: criterion.id,
      level: criterion.level ?? 'P2',
      blocking: blockingFlag,
      status: rowStatus,
      measured: displayMeasured(isPlainObject(entry) ? entry.measured : null),
      evidence: displayEvidence(entry),
      remedy: rowRemedy
    });
  }

  // 3. 标注请求必须全部关闭/撤回
  const { pending } = requestStats(safeProject);
  if (pending.length > 0) {
    reasons.push(`还有 ${pending.length} 条标注请求未关闭：${pending.map((item) => item.id).join('、')}`);
  }

  // 4. 认证记录自身的有效性（只对「曾经认证过、后来被作废」的历史记录提示；
  //    失败判定写下的 certified:false 记录不应反过来毒化下一次认证）。
  const existingCert = isPlainObject(safeProject.certification) ? safeProject.certification : null;
  if (existingCert && existingCert.certified === true && existingCert.invalidatedAt) {
    reasons.push('既有认证已被作废，需重新判定');
  }

  const certified = reasons.length === 0 && blocking.length === 0;

  const passCount = rows.filter(
    (row) => (row.status === 'pass' || row.status === 'confirmed') && row.remedy === ''
  ).length;
  const summary = {
    total: rows.length,
    pass: passCount,
    fail: rows.filter((row) => row.status === 'fail').length,
    blocking: blocking.length,
    knownFailures: known.length,
    pendingRequests: pending.length,
    manualPending: rows.filter((row) => row.status === 'unconfirmed').length
  };

  const at = nowIso();
  const report = {
    title: 'ModelCheck 完成判定报告',
    generatedAt: at,
    contractVersion: ctx.contractVersion,
    buildHash: ctx.buildHash,
    sourceHash: ctx.sourceHash,
    rows,
    knownFailures: known,
    summary
  };

  return {
    certified,
    contractVersion: ctx.contractVersion,
    buildHash: ctx.buildHash,
    sourceHash: ctx.sourceHash,
    at,
    blocking,
    report,
    reasons,
    summary
  };
}

/** 渲染一页式中文报告文本（工具结果用）。 */
export function renderReportPage(completion) {
  const result = isPlainObject(completion) ? completion : {};
  const report = isPlainObject(result.report) ? result.report : {};
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const known = Array.isArray(report.knownFailures) ? report.knownFailures : [];
  const summary = isPlainObject(report.summary) ? report.summary : {};
  const issues = Array.isArray(result.reasons) ? result.reasons : [];
  const at = firstString(report.generatedAt, result.at) ?? '—';

  const lines = [];
  lines.push(report.title ?? 'ModelCheck 完成判定报告');
  lines.push(`生成时间：${at}`);
  lines.push(
    result.certified ? '结论：通过完成门禁，可以交付。' : '结论：未通过完成门禁，请按下列待办处理。'
  );
  lines.push(
    `契约版本：${result.contractVersion ?? '—'}｜构建哈希：${result.buildHash ?? '—'}｜源码哈希：${result.sourceHash ?? '—'}`
  );
  lines.push(
    `判据统计：共 ${summary.total ?? rows.length} 条，通过 ${summary.pass ?? 0} 条，阻塞 ${summary.blocking ?? 0} 条，已知缺陷 ${summary.knownFailures ?? known.length} 条，待关闭请求 ${summary.pendingRequests ?? 0} 条。`
  );
  lines.push('');
  lines.push('— 判定明细 —');
  if (rows.length === 0) {
    lines.push('（无判据）');
  }
  for (const row of rows) {
    const flag = row.blocking ? '阻塞' : '非阻塞';
    const tail = row.remedy ? `｜待办：${row.remedy}` : '';
    lines.push(
      `[${row.level}] ${row.id}｜${flag}｜${row.status}｜测量：${row.measured}｜证据：${row.evidence}${tail}`
    );
  }
  lines.push('');
  lines.push('— 已知缺陷（非阻塞，允许交付但需记录） —');
  if (known.length === 0) {
    lines.push('（无）');
  }
  for (const failure of known) {
    lines.push(`- ${failure.id}（${failure.level}）：${failure.claim || '—'}｜${failure.detail || '—'}`);
  }
  if (issues.length > 0) {
    lines.push('');
    lines.push('— 其他待办 —');
    issues.forEach((issue, index) => lines.push(`${index + 1}. ${issue}`));
  }
  return lines.join('\n');
}

/**
 * 计算并落盘认证记录（宿主的 modelcheck_complete 工具用）。
 * 认证绑定契约版本 + 构建哈希 + 源码哈希；未通过时写入 certified:false 并作废旧认证。
 * 无 store 时只返回认证对象，便于单测与面板预览。
 */
export async function applyCertification(project, { store } = {}) {
  const completion = evaluateCompletion(project);
  const at = completion.at ?? nowIso();
  const certified = completion.certified === true;
  const summary = isPlainObject(completion.report?.summary) ? completion.report.summary : null;

  const certification = {
    schemaVersion: 1,
    certified,
    contractVersion: completion.contractVersion ?? null,
    buildHash: completion.buildHash ?? null,
    sourceHash: completion.sourceHash ?? null,
    adapterVersion: versionContext(isPlainObject(project) ? project : {}).adapterVersion,
    at,
    certifiedAt: certified ? at : null,
    invalidatedAt: certified ? null : at,
    summary,
    blocking: completion.blocking.slice(),
    reasons: completion.reasons.slice()
  };

  if (store && typeof store.writeJson === 'function') {
    const path = isPlainObject(store.paths) ? store.paths.certification : null;
    if (!path) throw new Error('Store 缺少 certification 路径，无法写入认证记录');
    await store.writeJson(path, certification);
  }

  return {
    ...completion,
    certification,
    report: { ...completion.report, certification }
  };
}
