/**
 * ModelCheck 组件标注模块（设计文档 §2.11）
 *
 * 职责：
 * - 维护标注批次（B-0001…）与用户请求（USR-0001…）的编号、状态与历史；
 * - 状态机：draft → sent → triaged → editing → review → closed，任一非 closed 状态可 withdrawn；
 * - 生成发送给用户的批次文本（规格 §8.3）；
 * - 关联判据全部通过时推进请求（review/closed）。
 *
 * 约束：纯 ESM、只用 node: 内置模块、不可变返回（不修改入参对象）。
 */
import { nowIso, isPlainObject } from './util.js';

/** 请求状态机取值。 */
export const REQUEST_STATES = ['draft', 'sent', 'triaged', 'editing', 'review', 'closed', 'withdrawn'];

/** 允许的状态迁移（closed / withdrawn 为终态）。 */
const TRANSITIONS = {
  draft: ['sent', 'withdrawn'],
  sent: ['triaged', 'withdrawn'],
  triaged: ['editing', 'review', 'withdrawn'],
  editing: ['review', 'withdrawn'],
  review: ['closed', 'withdrawn'],
  closed: [],
  withdrawn: []
};

/** 终态集合。 */
const TERMINAL_STATES = new Set(['closed', 'withdrawn']);

/** 已发送但未终结（完成门禁的待办）。 */
const PENDING_STATES = new Set(['sent', 'triaged', 'editing', 'review']);

/** 生成 USR-0001 / B-0001 形式的编号。 */
function formatId(prefix, seq) {
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

/** 从 B-0003 解析出批次序号；解析失败时返回 fallback。 */
function batchSeqOf(batchId, fallback = 1) {
  const match = typeof batchId === 'string' ? /^B-(\d+)$/.exec(batchId) : null;
  if (!match) return fallback;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 创建空的标注文档。 */
function emptyAnnotations() {
  return {
    schemaVersion: 1,
    nextRequestSeq: 1,
    nextBatchSeq: 1,
    batches: [],
    requests: []
  };
}

/** 归一化入参为安全的标注文档（浅拷贝数组，元素仍共享；改写时再复制元素）。 */
function normalize(annotations) {
  const base = isPlainObject(annotations) ? annotations : emptyAnnotations();
  return {
    ...emptyAnnotations(),
    ...base,
    batches: Array.isArray(base.batches) ? base.batches.slice() : [],
    requests: Array.isArray(base.requests) ? base.requests.slice() : []
  };
}

/** 复制定位信息（不共享引用）。 */
function copyLocator(locator) {
  if (!isPlainObject(locator)) return null;
  const next = {};
  for (const [key, value] of Object.entries(locator)) {
    if (value !== undefined) next[key] = Array.isArray(value) ? value.slice() : value;
  }
  return next;
}

/** 复制字符串数组。 */
function copyStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item.length > 0).slice();
}

/**
 * 创建标注批次与对应请求（状态 draft）。
 * items: [{ componentId, label, locator, userText, acceptance, level, blocking, screenshot, criteriaIds }]
 * 返回 { batch, annotations }。
 */
export function createBatch(annotations, { projectId, modelVersion, items } = {}) {
  const base = normalize(annotations);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('createBatch 需要至少一条标注项');
  }

  const at = nowIso();
  const batchId = formatId('B', base.nextBatchSeq);
  const requests = [];
  const batchItems = [];

  items.forEach((item, index) => {
    const source = isPlainObject(item) ? item : {};
    const requestId = formatId('USR', base.nextRequestSeq + index);
    const criteriaIds = copyStringArray(source.criteriaIds);
    const request = {
      id: requestId,
      batchId,
      state: 'draft',
      userText: typeof source.userText === 'string' ? source.userText : '',
      claim: null,
      criteriaIds,
      acceptance: typeof source.acceptance === 'string' ? source.acceptance : 'auto',
      allowedChanges: [],
      level: typeof source.level === 'string' ? source.level : 'P1',
      blocking: source.blocking !== false,
      reason: null,
      history: [{ state: 'draft', at, reason: null }]
    };
    requests.push(request);
    batchItems.push({
      requestId,
      componentId: typeof source.componentId === 'string' ? source.componentId : null,
      label: typeof source.label === 'string' ? source.label : '',
      locator: copyLocator(source.locator),
      userText: request.userText,
      acceptance: request.acceptance,
      level: request.level,
      blocking: request.blocking,
      screenshot: typeof source.screenshot === 'string' ? source.screenshot : null,
      criteriaIds: criteriaIds.slice()
    });
  });

  const batch = {
    id: batchId,
    projectId: typeof projectId === 'string' ? projectId : null,
    createdAt: at,
    status: 'draft',
    modelVersion: isPlainObject(modelVersion) ? { ...modelVersion } : {},
    items: batchItems
  };

  return {
    batch,
    annotations: {
      ...base,
      nextRequestSeq: base.nextRequestSeq + items.length,
      nextBatchSeq: base.nextBatchSeq + 1,
      batches: [...base.batches, batch],
      requests: [...base.requests, ...requests]
    }
  };
}

/** 在 registry 中查组件的代码位置（兼容数组 / 映射两种注册表形态）。 */
function locatorFromRegistry(componentId, registry) {
  if (!componentId || !isPlainObject(registry)) return null;
  const container = registry.components ?? registry.items ?? registry;
  if (Array.isArray(container)) {
    const found = container.find((item) => isPlainObject(item) && item.id === componentId);
    return isPlainObject(found) ? { file: found.file, symbol: found.symbol } : null;
  }
  if (isPlainObject(container)) {
    const found = container[componentId];
    if (isPlainObject(found)) {
      if (isPlainObject(found.locator)) return { file: found.locator.file, symbol: found.locator.symbol };
      return { file: found.file, symbol: found.symbol };
    }
  }
  return null;
}

/** 生成「代码: file:symbol」一行需要的位置信息。 */
function resolveLocator(item, registry) {
  const direct = isPlainObject(item?.locator) ? item.locator : {};
  const fallback = locatorFromRegistry(item?.componentId, registry) ?? {};
  const file = typeof direct.file === 'string' && direct.file.length > 0
    ? direct.file
    : typeof fallback.file === 'string' && fallback.file.length > 0
      ? fallback.file
      : '—';
  const symbol = typeof direct.symbol === 'string' && direct.symbol.length > 0
    ? direct.symbol
    : typeof fallback.symbol === 'string' && fallback.symbol.length > 0
      ? fallback.symbol
      : '';
  return { file, symbol };
}

/**
 * 渲染发送给用户的批次文本（规格 §8.3）。
 */
export function renderBatchMessage(batch, registry) {
  if (!isPlainObject(batch)) return '';
  const number = batchSeqOf(batch.id, 1);
  const items = Array.isArray(batch.items) ? batch.items : [];
  const lines = [`【组件标注 · 第 ${number} 批】`];

  const buildHash =
    typeof batch.modelVersion?.buildHash === 'string' ? batch.modelVersion.buildHash : null;
  if (buildHash) lines.push(`构建：${buildHash}`);
  if (typeof batch.projectId === 'string' && batch.projectId.length > 0) {
    lines.push(`项目：${batch.projectId}`);
  }

  items.forEach((item, index) => {
    if (index > 0) lines.push('');
    const requestId = typeof item?.requestId === 'string' ? item.requestId : `USR-${index + 1}`;
    const label = typeof item?.label === 'string' && item.label.length > 0
      ? item.label
      : typeof item?.componentId === 'string'
        ? item.componentId
        : '未命名组件';
    const locator = resolveLocator(item, registry);
    const criteriaIds = Array.isArray(item?.criteriaIds) && item.criteriaIds.length > 0
      ? item.criteriaIds.join('、')
      : '—';

    lines.push(`${index + 1}. ${requestId}（${label}）`);
    lines.push(`   代码: ${locator.file}${locator.symbol ? `:${locator.symbol}` : ''}`);
    lines.push(`   关联判据: ${criteriaIds}`);
    lines.push(`   用户要求: "${typeof item?.userText === 'string' ? item.userText : ''}"`);
    if (typeof item?.screenshot === 'string' && item.screenshot.length > 0) {
      lines.push(`   截图: ${item.screenshot}`);
    }
  });

  return lines.join('\n');
}

/**
 * 发送批次（幂等）：只有 status==='draft' 才生成消息并置 sent；
 * 重复调用返回同一 message，并标记 idempotent:true。
 */
export function sendBatch(annotations, batchId) {
  const base = normalize(annotations);
  const index = base.batches.findIndex((batch) => batch?.id === batchId);
  if (index < 0) throw new Error(`未知批次：${batchId}`);

  const batch = base.batches[index];
  if (batch.status !== 'draft') {
    const message = typeof batch.message === 'string' ? batch.message : renderBatchMessage(batch, {});
    return { batch, message, idempotent: true, annotations: base };
  }

  const at = nowIso();
  const sentBatch = { ...batch, status: 'sent', sentAt: at };
  sentBatch.message = renderBatchMessage(sentBatch, {});

  const requests = base.requests.map((request) => {
    if (request?.batchId !== batchId || request.state !== 'draft') return request;
    return {
      ...request,
      state: 'sent',
      history: [...(Array.isArray(request.history) ? request.history : []), { state: 'sent', at, reason: null }]
    };
  });

  const batches = base.batches.map((item, i) => (i === index ? sentBatch : item));

  return {
    batch: sentBatch,
    message: sentBatch.message,
    idempotent: false,
    annotations: { ...base, batches, requests }
  };
}

/** 查找请求下标；找不到抛错。 */
function requestIndex(requests, requestId) {
  const index = requests.findIndex((request) => request?.id === requestId);
  if (index < 0) throw new Error(`未知标注请求：${requestId}`);
  return index;
}

/**
 * 分诊：补充模型对用户要求的理解与允许改动范围，状态 sent → triaged。
 */
export function triageRequest(
  annotations,
  requestId,
  { claim, criteriaIds, acceptance, allowedChanges, level } = {}
) {
  const base = normalize(annotations);
  const index = requestIndex(base.requests, requestId);
  const request = base.requests[index];

  if (TERMINAL_STATES.has(request.state)) {
    throw new Error(`请求 ${requestId} 已处于 ${request.state}，不能分诊`);
  }
  if (!['sent', 'triaged'].includes(request.state)) {
    throw new Error(`请求 ${requestId} 状态为 ${request.state}，需先发送（sent）才能分诊`);
  }

  const at = nowIso();
  const nextState = request.state === 'sent' ? 'triaged' : request.state;
  const nextRequest = {
    ...request,
    claim: claim === undefined ? (request.claim ?? null) : claim,
    criteriaIds: criteriaIds === undefined ? request.criteriaIds : copyStringArray(criteriaIds),
    acceptance: typeof acceptance === 'string' ? acceptance : request.acceptance,
    allowedChanges: allowedChanges === undefined ? request.allowedChanges : copyStringArray(allowedChanges),
    level: typeof level === 'string' ? level : request.level,
    state: nextState,
    history: [...(Array.isArray(request.history) ? request.history : [])]
  };
  if (nextState !== request.state) {
    nextRequest.history.push({ state: nextState, at, reason: null });
  }

  const requests = base.requests.slice();
  requests[index] = nextRequest;
  return { ...base, requests };
}

/**
 * 状态迁移（带合法性校验）；同状态重复调用视为幂等空操作。
 */
export function setRequestState(annotations, requestId, state, reason) {
  const base = normalize(annotations);
  if (!REQUEST_STATES.includes(state)) {
    throw new Error(`非法请求状态：${state}`);
  }
  const index = requestIndex(base.requests, requestId);
  const request = base.requests[index];

  if (request.state === state) return base;
  const allowed = TRANSITIONS[request.state] ?? [];
  if (!allowed.includes(state)) {
    throw new Error(`非法状态迁移：${request.state} → ${state}（请求 ${requestId}）`);
  }

  const at = nowIso();
  const nextRequest = {
    ...request,
    state,
    reason: reason === undefined ? (request.reason ?? null) : reason,
    history: [
      ...(Array.isArray(request.history) ? request.history : []),
      { state, at, reason: reason === undefined ? null : reason }
    ]
  };

  const requests = base.requests.slice();
  requests[index] = nextRequest;
  return { ...base, requests };
}

/**
 * 待处理请求：已发送且未 closed / withdrawn。
 */
export function pendingRequests(annotations) {
  const base = normalize(annotations);
  return base.requests.filter((request) => PENDING_STATES.has(request?.state));
}

/** 判据状态查询：兼容 'pass' 字符串与 { status:'pass' } 两种形态。 */
function isCriterionPassed(criteriaStatus, criterionId) {
  if (!isPlainObject(criteriaStatus)) return false;
  const value = criteriaStatus[criterionId];
  if (typeof value === 'string') return value === 'pass';
  if (isPlainObject(value)) return value.status === 'pass';
  return false;
}

/**
 * 关联判据全部通过时推进请求：sent/triaged/editing → review；review → closed。
 */
export function closeByCriteria(annotations, criteriaStatus) {
  const base = normalize(annotations);
  const at = nowIso();
  let changed = false;

  const requests = base.requests.map((request) => {
    const criteriaIds = Array.isArray(request?.criteriaIds) ? request.criteriaIds : [];
    if (criteriaIds.length === 0) return request;
    if (!['sent', 'triaged', 'editing', 'review'].includes(request.state)) return request;
    const allPassed = criteriaIds.every((id) => isCriterionPassed(criteriaStatus, id));
    if (!allPassed) return request;

    const nextState = request.state === 'review' ? 'closed' : 'review';
    changed = true;
    return {
      ...request,
      state: nextState,
      reason: '关联判据全部通过',
      history: [
        ...(Array.isArray(request.history) ? request.history : []),
        { state: nextState, at, reason: '关联判据全部通过' }
      ]
    };
  });

  if (!changed) return base;
  return { ...base, requests };
}
