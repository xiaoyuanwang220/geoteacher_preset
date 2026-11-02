// ModelCheck —— /modelcheck/api JSON 接口（面板与工具共用）
//
// 约定（设计 §3.3）：
//   · 只接受 POST JSON，请求体上限 1 MiB，响应一律 Cache-Control: no-store。
//   · 所有 action 都带 sessionId；服务端把 sessionId 解析成项目根，绝不接受客户端传入的路径。
//   · 无项目的会话返回 404 {status:'inactive', reason:'no-project'}，不报错、不干预。
//   · 用户确认边界：只有 contract/confirm 与 annotations/accept 写 confirmedBy:'user'；
//     两者只由面板（真实用户点击）调用，没有任何模型工具能触达这两个字段。
//   · 所有异常转成结构化错误，不让宿主因为一次请求崩掉。
//
// 只用 node: 内置模块与包内相对路径。

import { readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import {
  contractContentHash,
  diffContracts,
  criteriaOf,
  normalizeContract
} from '../lib/contract.js';
import { componentById, componentFingerprints } from '../lib/registry.js';
import {
  createBatch,
  pendingRequests,
  sendBatch,
  setRequestState
} from '../lib/annotations.js';
import { certificationValid, evaluateCompletion, renderReportPage } from '../lib/completion.js';
import { budgetSummary } from '../lib/budget.js';
import { attachUserConfirmation } from '../lib/evidence.js';
import { nowIso } from '../lib/util.js';
import { applyScaffold, buildComponents, buildConfig, discoverCandidates, isProjectDir, scanProject } from '../lib/scaffold.js';
import { computeReadiness } from '../lib/readiness.js';
import { loadProject } from '../lib/project.js';
import { ADAPTER_VERSION } from './evidence-queue.js';

export const API_PREFIX = '/modelcheck/api';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ANNOTATION_ITEMS = 50;
const MAX_USER_TEXT = 4000;
const MAX_SCREENSHOT_BYTES = 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** 结构化 API 错误：status + 完整响应体。 */
export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error && body.error.message) || 'API error');
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (error) {
    console.error('modelcheck: 计算失败（已降级）:', error);
    return fallback;
  }
}

/**
 * completion 模块读取的 project 形状与 loadProject 返回值略有差异：
 * completion 从 project.buildHash / sourceHash / contractVersion 取版本键，
 * loadProject 把它们放在 hashes 里。宿主在这里补齐，避免两边各自猜测。
 * @param {object} project
 * @returns {object}
 */
export function completionInput(project) {
  const safe = project || {};
  const hashes = safe.hashes || {};
  return {
    ...safe,
    buildHash: hashes.buildHash ?? safe.buildHash ?? null,
    sourceHash: hashes.sourceHash ?? safe.sourceHash ?? null,
    contractVersion: (safe.contract && safe.contract.contractVersion) ?? safe.contractVersion ?? null,
    adapterVersion: ADAPTER_VERSION
  };
}

/**
 * 过滤“已确认但残留的草稿”：契约确认后 contract.proposed.json 仍留在盘上，
 * 若其内容哈希等于已确认契约就不再视为“待确认草稿”，否则面板会一直显示待确认提示条。
 */
export function pendingProposed(proposed, project) {
  if (!proposed) return null;
  const contractHash = project ? project.contractHash ?? null : null;
  if (contractHash && proposed.contentHash === contractHash) return null;
  return proposed;
}

/** 轮次列表：loadProject 给 {schemaVersion, rounds:[]} 文档，budget 模块吃数组。 */
export function roundsOf(project) {
  if (!project) return [];
  if (Array.isArray(project)) return project;
  if (Array.isArray(project.rounds)) return project.rounds;
  return Array.isArray(project.rounds && project.rounds.rounds) ? project.rounds.rounds : [];
}

function sendJson(res, status, data) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function errorBody(code, message, extra = {}) {
  return { ok: false, status: 'error', error: { code, message, ...extra } };
}

/**
 * 同源校验：浏览器 POST 会带 Origin；Origin 的 host 必须等于 Host 头。
 * 无 Origin（本地脚本/同源导航）放行——路由本身与 Web GUI 同源监听在本机。
 * @param {string|undefined} origin
 * @param {string|undefined} hostHeader
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, hostHeader) {
  if (origin === undefined || origin === null || origin === '') return true;
  if (origin === 'null') return false;
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.host.toLowerCase() === hostHeader.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * 浏览器会话鉴权：自定义路由不会被 webserver 自动鉴权，必须自己调 connection.admit。
 * 返回 HTTP 拒绝码（401/403）或 null（放行 / 服务不可用）。
 * 说明：admit 只证明“某个已认证浏览器会话”，不证明“真人逐次点击”——确认记录按该边界声明。
 */
function connectionRejection(ctx, req) {
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    if (!connection || typeof connection.admit !== 'function') return null;
    const admission = connection.admit(req);
    if (admission && typeof admission === 'object' && 'rejection' in admission) {
      const status = admission.rejection;
      return status === 401 || status === 403 ? status : 403;
    }
  } catch (error) {
    console.error('modelcheck: connection.admit 异常（按未鉴权处理）:', error);
    return 403;
  }
  return null;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflow) {
        reject(new ApiError(413, errorBody('payload-too-large', '请求体超过 1 MiB 上限')));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => reject(error));
  });
}

function requireSessionId(body) {
  const sessionId = body && body.sessionId;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
    throw new ApiError(400, errorBody('invalid-session', '缺少或非法的 sessionId'));
  }
  return sessionId;
}

async function requireProject(host, sessionId) {
  let project;
  try {
    project = await host.projectForSession(sessionId);
  } catch (error) {
    throw new ApiError(500, errorBody('project-load-failed', `项目读取失败：${String((error && error.message) || error)}`));
  }
  if (!project) {
    throw new ApiError(404, { ok: false, status: 'inactive', reason: 'no-project', error: { code: 'no-project', message: '当前会话未发现 .modelcheck 目录，插件不干预' } });
  }
  return project;
}

function countStatuses(rows) {
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  return byStatus;
}

export function summarizeRequest(request) {
  return {
    id: request.id,
    batchId: request.batchId ?? null,
    state: request.state,
    userText: request.userText ?? '',
    claim: request.claim ?? null,
    criteriaIds: Array.isArray(request.criteriaIds) ? request.criteriaIds : [],
    acceptance: request.acceptance ?? null,
    level: request.level ?? null,
    componentId: request.componentId ?? null,
    reason: request.reason ?? null,
    history: Array.isArray(request.history) ? request.history.slice(-6) : []
  };
}

export function findRequest(annotations, requestId) {
  const doc = annotations || {};
  const requests = Array.isArray(doc.requests) ? doc.requests : [];
  return requests.find((item) => item.id === requestId) || null;
}

/**
 * 按 lib 的状态机把请求推进到目标状态（annotations.js 不允许跳步）。
 * 返回 { annotations, state }；路径不存在时 state 保持原值。
 */
function advanceRequestState(annotations, requestId, desired, reason) {
  const pathToEditing = { sent: ['triaged', 'editing'], triaged: ['editing'], editing: [], review: [] };
  const pathToClosed = {
    sent: ['triaged', 'review', 'closed'],
    triaged: ['review', 'closed'],
    editing: ['review', 'closed'],
    review: ['closed'],
    closed: []
  };
  let doc = annotations;
  const current = findRequest(doc, requestId);
  const currentState = current ? current.state : null;
  const path = desired === 'editing' ? pathToEditing[currentState] : pathToClosed[currentState];
  if (!Array.isArray(path)) return { annotations: doc, state: currentState };
  for (const step of path) {
    doc = setRequestState(doc, requestId, step, step === desired ? reason : undefined);
  }
  const updated = findRequest(doc, requestId);
  return { annotations: doc, state: updated ? updated.state : currentState };
}

function annotationCounts(annotations) {
  const doc = annotations || {};
  const requests = Array.isArray(doc.requests) ? doc.requests : [];
  const batches = Array.isArray(doc.batches) ? doc.batches : [];
  const byState = {};
  for (const request of requests) byState[request.state] = (byState[request.state] || 0) + 1;
  return { batches: batches.length, requests: requests.length, byState };
}

/**
 * 判据表行：契约判据 + 当前证据状态。面板与工具共用同一份投影。
 * @param {object} project loadProject 的返回值
 * @returns {object[]}
 */
export function criterionRows(project) {
  const criteria = project && project.contract ? criteriaOf(project.contract) : [];
  const entries = (project && project.evidence && project.evidence.entries) || {};
  return criteria.map((criterion) => {
    const entry = entries[criterion.id] || null;
    return {
      id: criterion.id,
      level: criterion.level,
      blocking: criterion.blocking === true,
      claim: criterion.claim,
      method: criterion.method,
      acceptance: criterion.acceptance ?? null,
      requiredEvidence: criterion.requiredEvidence ?? entry?.evidenceKind ?? null,
      component: criterion.component ?? null,
      status: entry?.status || criterion.status || 'unverified',
      measured: entry?.measured ?? null,
      assertion: entry?.assertion ?? null,
      detail: entry?.detail ?? null,
      evidenceKind: entry?.evidenceKind ?? null,
      capturedAt: entry?.capturedAt ?? null,
      evidenceKey: entry?.key ?? null,
      artifacts: Array.isArray(entry?.artifacts) ? entry.artifacts : [],
      source: criterion.source ?? null
    };
  });
}

function buildNextSteps(project, rows, completion, pending) {
  const steps = [];
  if (!project.contract) {
    steps.push('尚未建立契约：先让 agent 调用 modelcheck_contract(action:"propose")，再由用户在面板确认。');
  } else if (project.contract.status !== 'confirmed') {
    steps.push('契约尚未确认：请在「建模判定」面板顶部确认 proposed 契约（agent 不能自行确认）。');
  }
  const runtimeOpen = rows.filter((row) => row.requiredEvidence === 'runtime'
    && ['unverified', 'inconclusive', 'stale'].includes(row.status));
  if (runtimeOpen.length > 0) {
    steps.push(`有 ${runtimeOpen.length} 条运行时判据待取证：打开面板预览页后调用 modelcheck_verify。`);
  }
  const blockingOpen = rows.filter((row) => row.blocking && row.status !== 'pass');
  if (project.contract && project.contract.status === 'confirmed' && blockingOpen.length > 0) {
    steps.push(`阻塞判据未通过 ${blockingOpen.length} 条：按各自的 remedy 修复后重新 modelcheck_verify。`);
  }
  if (pending.length > 0) {
    steps.push(`有 ${pending.length} 条已发送标注待处理：用 modelcheck_annotations 整理或关闭。`);
  }
  if (completion && completion.certified) {
    steps.push('已获得完成认证：交付前按设计 §5 剥离 .modelcheck、标注层与验证入口。');
  } else if (project.contract && project.contract.status === 'confirmed' && blockingOpen.length === 0 && pending.length === 0) {
    steps.push('契约判据均无阻塞项：可调用 modelcheck_complete 申请完成认证。');
  }
  return steps;
}

export async function readProposed(store) {
  try {
    const raw = await store.readJson(store.paths.contractProposed, null);
    if (!raw || !isPlainObject(raw)) return null;
    let contentHash = raw.contentHash;
    if (!contentHash) {
      try {
        contentHash = contractContentHash(normalizeContract(raw));
      } catch {
        contentHash = null;
      }
    }
    return { contract: raw, contentHash };
  } catch {
    return null;
  }
}

async function persistScreenshot(store, item) {
  const dataUrl = item && item.screenshot;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return {};
  }
  const base64 = dataUrl.slice('data:image/png;base64,'.length).replace(/\s+/g, '');
  let bytes;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return { warning: '截图无法解码，已忽略' };
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return { warning: `截图为空或超过 ${MAX_SCREENSHOT_BYTES} 字节，已忽略` };
  }
  try {
    const artifact = await store.writeArtifact(bytes, 'png');
    return { screenshot: `artifacts/${artifact.name}`, screenshotHash: artifact.hash };
  } catch (error) {
    return { warning: `截图写入 artifacts 失败（已忽略）：${String((error && error.message) || error)}` };
  }
}

async function normalizeAnnotationItems(project, store, rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiError(400, errorBody('invalid-items', 'items 必须是非空数组'));
  }
  if (rawItems.length > MAX_ANNOTATION_ITEMS) {
    throw new ApiError(400, errorBody('invalid-items', `一次最多 ${MAX_ANNOTATION_ITEMS} 条标注`));
  }
  const warnings = [];
  const items = [];
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) throw new ApiError(400, errorBody('invalid-items', 'items 中存在非对象项'));
    const componentId = typeof raw.componentId === 'string' ? raw.componentId : '';
    if (!componentId) throw new ApiError(400, errorBody('invalid-items', '每条标注都需要 componentId'));
    const component = safeCall(() => componentById(project.components, componentId), null);
    if (!component) {
      throw new ApiError(400, errorBody('unknown-component', `组件未注册：${componentId}；请先用 modelcheck_components 登记后再标注`));
    }
    const userText = typeof raw.userText === 'string' ? raw.userText.trim() : '';
    if (!userText) throw new ApiError(400, errorBody('invalid-items', `组件 ${componentId} 缺少 userText`));
    if (userText.length > MAX_USER_TEXT) {
      throw new ApiError(400, errorBody('invalid-items', `userText 超过 ${MAX_USER_TEXT} 字`));
    }
    const item = {
      componentId,
      label: component.label || componentId,
      locator: component.locator || null,
      userText
    };
    if (raw.acceptance === 'auto' || raw.acceptance === 'manual' || raw.acceptance === 'visual') {
      item.acceptance = raw.acceptance;
    } else if (raw.acceptance === 'user') {
      // 兼容面板/文档里的 "user" 说法：lib 的验收枚举是 auto/visual/manual。
      item.acceptance = 'manual';
    }
    if (raw.level === 'P0' || raw.level === 'P1' || raw.level === 'P2') item.level = raw.level;
    const shot = await persistScreenshot(store, raw);
    if (shot.screenshot) item.screenshot = shot.screenshot;
    if (shot.screenshotHash) item.screenshotHash = shot.screenshotHash;
    if (shot.warning) warnings.push(shot.warning);
    items.push(item);
  }
  return { items, warnings };
}

// ── actions ────────────────────────────────────────────────────────────

async function actionStatus(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const store = host.storeFor(project.root);
  const rows = criterionRows(project);
  const pending = safeCall(() => pendingRequests(project.annotations), []);
  const completion = safeCall(() => evaluateCompletion(completionInput(project)), null);
  const budget = safeCall(() => budgetSummary(project, roundsOf(project)), null);
  const proposed = pendingProposed(await readProposed(store), project);
  const contract = project.contract;
  const certification = project.certification || null;
  const certValid = certification
    ? safeCall(() => certificationValid(certification, {
      contractVersion: contract && contract.contractVersion,
      buildHash: project.hashes && project.hashes.buildHash,
      sourceHash: project.hashes && project.hashes.sourceHash
    }), false)
    : false;
  const config = project.config || {};
  const statusCounts = countStatuses(rows);
  const contractCounts = {
    total: rows.length,
    P0: rows.filter((row) => row.level === 'P0').length,
    P1: rows.filter((row) => row.level === 'P1').length,
    P2: rows.filter((row) => row.level === 'P2').length,
    blocking: rows.filter((row) => row.blocking).length,
    pass: statusCounts.pass || 0,
    fail: statusCounts.fail || 0,
    inconclusive: statusCounts.inconclusive || 0,
    unverified: statusCounts.unverified || 0,
    stale: statusCounts.stale || 0
  };
  return {
    status: 200,
    body: {
      ok: true,
      status: 'active',
      project: {
        projectId: config.projectId ?? null,
        title: config.title ?? null,
        route: config.route ?? null,
        root: project.root,
        previewEntry: (config.preview && (config.preview.verifyEntry || config.preview.entry)) || 'index.html',
        deliveryEntry: (config.preview && (config.preview.deliveryEntry || config.preview.entry)) || 'index.html',
        verifyEntry: (config.preview && config.preview.verifyEntry) || null,
        unitToPx: (config.preview && typeof config.preview.unitToPx === 'number') ? config.preview.unitToPx : null,
        viewport: (config.preview && config.preview.viewport) || null
      },
      selection: {
        root: host.selectedRootForSession(sessionId),
        selected: Boolean(host.selectedRootForSession(sessionId))
      },
      contract: {
        version: contract ? contract.contractVersion : null,
        status: contract ? contract.status : 'missing',
        confirmed: Boolean(contract && contract.status === 'confirmed'),
        contentHash: project.contractHash ?? (contract && contract.contentHash) ?? null,
        counts: contractCounts,
        proposed: Boolean(proposed),
        proposedHash: proposed ? proposed.contentHash : null
      },
      criteria: rows,
      annotations: {
        pending: pending.map(summarizeRequest),
        counts: annotationCounts(project.annotations)
      },
      budget,
      certification: certification
        ? {
          certified: certification.certified === true,
          valid: certValid,
          contractVersion: certification.contractVersion ?? null,
          buildHash: certification.buildHash ?? null,
          sourceHash: certification.sourceHash ?? null,
          at: certification.certifiedAt ?? certification.at ?? null
        }
        : { certified: false, valid: false, contractVersion: null, buildHash: null, sourceHash: null, at: null },
      completion: completion
        ? {
          certified: Boolean(completion.certified),
          reasons: Array.isArray(completion.reasons) ? completion.reasons : [],
          blocking: Array.isArray(completion.blocking) ? completion.blocking.slice(0, 20) : []
        }
        : null,
      evidenceBuild: {
        buildHash: (project.hashes && project.hashes.buildHash) ?? null,
        sourceHash: (project.hashes && project.hashes.sourceHash) ?? null,
        adapterVersion: ADAPTER_VERSION
      },
      hashes: {
        buildHash: (project.hashes && project.hashes.buildHash) ?? null,
        sourceHash: (project.hashes && project.hashes.sourceHash) ?? null,
        configHash: project.configHash ?? null
      },
      server: {
        panelOnline: host.evidence.panelOnline(sessionId),
        evidencePending: host.evidence.pendingCount(sessionId)
      },
      nextSteps: buildNextSteps(project, rows, completion, pending),
      note: '只读摘要；模型自证不算验证结果。'
    }
  };
}

async function actionCriteriaList(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const rows = criterionRows(project);
  return {
    status: 200,
    body: {
      ok: true,
      criteria: rows,
      counts: countStatuses(rows),
      hashes: project.hashes ?? null,
      selfCheck: (project.evidence && project.evidence.selfCheck) ?? null
    }
  };
}

async function actionComponentsList(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const registry = project.components || { schemaVersion: 1, components: [] };
  const fingerprints = safeCall(() => componentFingerprints(registry), {});
  const components = (registry.components || []).map((component) => ({
    ...component,
    fingerprint: fingerprints[component.id] ?? null
  }));
  const ids = new Set(components.map((component) => component.id));
  const warnings = [];
  for (const component of components) {
    for (const related of component.related || []) {
      if (!ids.has(related)) warnings.push(`组件 ${component.id} 的 related 引用了不存在的 id：${related}`);
    }
  }
  return { status: 200, body: { ok: true, components, warnings } };
}

async function actionAnnotationsList(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const doc = project.annotations || {};
  return {
    status: 200,
    body: {
      ok: true,
      schemaVersion: doc.schemaVersion ?? 1,
      batches: Array.isArray(doc.batches) ? doc.batches : [],
      requests: (Array.isArray(doc.requests) ? doc.requests : []).map(summarizeRequest),
      pending: safeCall(() => pendingRequests(doc), []).map(summarizeRequest),
      counts: annotationCounts(doc)
    }
  };
}

async function actionAnnotationsCreate(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const store = host.storeFor(project.root);
  const { items, warnings } = await normalizeAnnotationItems(project, store, body.items);
  const config = project.config || {};
  let created;
  try {
    created = createBatch(project.annotations, {
      projectId: config.projectId ?? null,
      modelVersion: {
        buildHash: (project.hashes && project.hashes.buildHash) ?? null,
        sourceHash: (project.hashes && project.hashes.sourceHash) ?? null
      },
      items
    });
  } catch (error) {
    throw new ApiError(400, errorBody('create-batch-failed', `生成标注批次失败：${String((error && error.message) || error)}`));
  }
  await store.writeJson(store.paths.annotations, created.annotations);
  return { status: 200, body: { ok: true, batch: created.batch, warnings } };
}

async function actionAnnotationsSend(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const batchId = typeof body.batchId === 'string' ? body.batchId : '';
  if (!batchId) throw new ApiError(400, errorBody('invalid-batch', '缺少 batchId'));
  let prepared;
  try {
    prepared = sendBatch(project.annotations, batchId);
  } catch (error) {
    throw new ApiError(409, errorBody('send-batch-failed', `批次状态异常：${String((error && error.message) || error)}`));
  }
  if (prepared.idempotent || (prepared.batch && prepared.batch.status === 'sent' && !prepared.idempotent && !prepared.message)) {
    // 已经发送过：不重复创建请求，也不重复投递。
    return {
      status: 200,
      body: {
        ok: true,
        delivered: false,
        idempotent: true,
        batchId,
        message: prepared.message || prepared.batch?.message || null,
        note: '该批次此前已发送，本次未重复投递'
      }
    };
  }
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.prompt !== 'function') {
    throw new ApiError(502, errorBody('delivery-unavailable', '宿主未提供 sessionController.prompt，无法投递到会话；批次仍为草稿，可重试', { retryable: true }));
  }
  const message = prepared.message;
  if (typeof message !== 'string' || !message.trim()) {
    throw new ApiError(500, errorBody('empty-message', '发送文本为空（内部错误）；批次仍为草稿'));
  }
  // 注意：SessionController.prompt 的实现会调用 signal.throwIfAborted()，必须传真实 AbortSignal。
  // requestId 用批次 ID 的稳定派生值：投递失败重试时同一 requestId 会被 prompt 去重，
  // 不会因为“上次其实已投递、只是本地落盘失败”而重复发消息（见 DSH-API-notes §f.4）。
  const abort = new AbortController();
  try {
    await controller.prompt({
      requestId: `mc-annot-${batchId}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: message }]
    }, abort.signal);
  } catch (error) {
    throw new ApiError(502, errorBody('delivery-failed', `投递到会话失败：${String((error && error.message) || error)}；批次仍为草稿，可重试`, { retryable: true }));
  }
  // 投递成功后才落盘 sent 状态；失败时保持 draft，重试不会生成新请求。
  const store = host.storeFor(project.root);
  await store.writeJson(store.paths.annotations, prepared.annotations);
  return {
    status: 200,
    body: { ok: true, delivered: true, idempotent: false, batchId, message }
  };
}

async function actionAnnotationsWithdraw(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!requestId) throw new ApiError(400, errorBody('invalid-request', '缺少 requestId'));
  if (!reason) throw new ApiError(400, errorBody('withdraw-requires-reason', '撤回必须写明原因'));
  let annotations;
  try {
    annotations = setRequestState(project.annotations, requestId, 'withdrawn', reason);
  } catch (error) {
    throw new ApiError(409, errorBody('withdraw-failed', String((error && error.message) || error)));
  }
  const store = host.storeFor(project.root);
  await store.writeJson(store.paths.annotations, annotations);
  return { status: 200, body: { ok: true, request: summarizeRequest(findRequest(annotations, requestId)) } };
}

async function actionAnnotationsAccept(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const requestId = typeof body.requestId === 'string' ? body.requestId : '';
  if (!requestId) throw new ApiError(400, errorBody('invalid-request', '缺少 requestId'));
  if (typeof body.accepted !== 'boolean') {
    throw new ApiError(400, errorBody('invalid-acceptance', 'accepted 必须是布尔值'));
  }
  const request = findRequest(project.annotations, requestId);
  if (!request) throw new ApiError(404, errorBody('unknown-request', `未找到标注请求：${requestId}`));
  const acceptanceKind = request.acceptance || 'auto';
  if (acceptanceKind === 'auto') {
    throw new ApiError(400, errorBody('not-manual-acceptance', '该请求是自动验收项：请用 modelcheck_verify 验证，人工验收不适用'));
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const store = host.storeFor(project.root);
  const criteriaIds = Array.isArray(request.criteriaIds) ? request.criteriaIds.filter(Boolean) : [];
  const contract = project.contract;
  const hashes = project.hashes || {};
  const at = nowIso();
  let evidence = project.evidence || { schemaVersion: 1, entries: {} };
  const evidenceEntries = evidence.entries || evidence;
  const confirmedCriteria = [];

  if (!body.accepted) {
    if (!reason) throw new ApiError(400, errorBody('rejection-requires-reason', '不通过必须写明原因'));
    // 不通过：若已有证据条目，顺带记录“用户不认可”并把该条记为 fail；再回到修改中。
    let evidenceChanged = false;
    for (const criterionId of criteriaIds) {
      const entry = evidenceEntries ? evidenceEntries[criterionId] : null;
      if (!entry) continue;
      try {
        evidence = attachUserConfirmation(evidence, {
          criterionId,
          evidenceKey: entry.key ?? null,
          confirmedBy: 'user',
          confirmedAt: at,
          accepted: false,
          reason
        });
        evidenceChanged = true;
      } catch (error) {
        console.error('modelcheck: 记录用户不通过失败（已忽略）:', error);
      }
    }
    let annotations;
    let advanced;
    try {
      advanced = advanceRequestState(project.annotations, requestId, 'editing', reason);
      annotations = advanced.annotations;
    } catch (error) {
      throw new ApiError(409, errorBody('accept-failed', String((error && error.message) || error)));
    }
    if (evidenceChanged) await store.writeJson(store.paths.evidence, evidence);
    await store.writeJson(store.paths.annotations, annotations);
    return {
      status: 200,
      body: {
        ok: true,
        request: summarizeRequest(findRequest(annotations, requestId)),
        confirmation: null,
        note: advanced.state === 'editing'
          ? '已记录不通过原因并回到修改中。'
          : `已记录不通过原因；当前状态为 ${advanced.state}（状态机不允许直接回到修改中，下一轮修改后重新验收）。`
      }
    };
  }

  // 通过：写绑定当前证据版本的确认，再关闭请求。只有面板能到这里（agent 工具没有该动作）。
  if (criteriaIds.length === 0) {
    throw new ApiError(400, errorBody('no-criteria', '该请求尚未关联任何判据：请先让 agent 用 modelcheck_annotations(triage) 生成判据草案并由用户确认契约，再验收'));
  }
  for (const criterionId of criteriaIds) {
    const entry = evidenceEntries ? evidenceEntries[criterionId] : null;
    if (!entry) {
      throw new ApiError(400, errorBody('evidence-missing', `判据 ${criterionId} 还没有证据条目：请先 modelcheck_verify 生成当前版本的证据，再人工验收`));
    }
    try {
      evidence = attachUserConfirmation(evidence, {
        criterionId,
        evidenceKey: entry.key ?? null,
        confirmedBy: 'user',
        confirmedAt: at,
        accepted: true
      });
      confirmedCriteria.push({ criterionId, evidenceKey: entry.key ?? null });
    } catch (error) {
      throw new ApiError(500, errorBody('confirmation-failed', `写入用户确认失败：${String((error && error.message) || error)}`));
    }
  }
  let annotations;
  let advanced;
  try {
    advanced = advanceRequestState(project.annotations, requestId, 'closed', reason || '用户验收通过');
    annotations = advanced.annotations;
  } catch (error) {
    throw new ApiError(409, errorBody('close-failed', String((error && error.message) || error)));
  }
  if (advanced.state !== 'closed') {
    throw new ApiError(409, errorBody('close-failed', `请求当前状态为 ${advanced.state}，无法关闭（可能已是终态或状态机不允许）`));
  }
  await store.writeJson(store.paths.evidence, evidence);
  await store.writeJson(store.paths.annotations, annotations);
  return {
    status: 200,
    body: {
      ok: true,
      request: summarizeRequest(findRequest(annotations, requestId)),
      confirmation: {
        requestId,
        confirmedBy: 'user',
        at,
        criteria: confirmedCriteria,
        contractVersion: contract ? contract.contractVersion : null,
        buildHash: hashes.buildHash ?? null,
        sourceHash: hashes.sourceHash ?? null
      }
    }
  };
}

async function actionContractRead(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const store = host.storeFor(project.root);
  const proposed = pendingProposed(await readProposed(store), project);
  return {
    status: 200,
    body: {
      ok: true,
      contract: project.contract ?? null,
      contractHash: project.contractHash ?? null,
      proposed: proposed ? { contract: proposed.contract, contentHash: proposed.contentHash } : null
    }
  };
}

async function actionContractConfirm(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const store = host.storeFor(project.root);
  const raw = await store.readJson(store.paths.contractProposed, null);
  if (!raw || !isPlainObject(raw)) {
    throw new ApiError(404, errorBody('no-proposed-contract', '没有待确认的契约草稿（contract.proposed.json）'));
  }
  let normalized;
  try {
    normalized = normalizeContract({ ...raw, status: 'confirmed', confirmedBy: 'user', confirmedAt: nowIso() });
  } catch (error) {
    throw new ApiError(422, errorBody('invalid-contract', `契约草稿不合法：${String((error && error.message) || error)}`));
  }
  const contentHash = contractContentHash(normalized);
  if (typeof body.contractHash !== 'string' || body.contractHash !== contentHash) {
    throw new ApiError(409, {
      ok: false,
      status: 'error',
      error: {
        code: 'hash-mismatch',
        message: '确认哈希与当前草稿不一致（草稿可能已更新），请刷新面板后重试',
        expected: contentHash,
        retryable: true
      }
    });
  }
  const stored = { ...normalized, contentHash };
  const previous = project.contract;
  await store.writeJson(store.paths.contract, stored);

  let diff = null;
  if (previous) {
    diff = safeCall(() => diffContracts(previous, normalized), null);
  }
  // 契约变更审计：确认动作留痕（不参与完成门禁，不放进 reports/，避免污染最新报告）。
  try {
    const logPath = join(store.paths.dir, 'contract-log.json');
    const existing = await store.readJson(logPath, []);
    const entries = Array.isArray(existing) ? existing : [];
    entries.push({
      at: stored.confirmedAt,
      action: 'confirm',
      contractVersion: stored.contractVersion,
      contentHash,
      previousVersion: previous ? previous.contractVersion : null,
      previousHash: project.contractHash ?? null,
      confirmedBy: 'user',
      diff
    });
    await store.writeJson(logPath, entries.slice(-50));
  } catch (error) {
    console.error('modelcheck: 契约变更审计写入失败（不影响确认）:', error);
  }
  return {
    status: 200,
    body: {
      ok: true,
      contract: {
        version: stored.contractVersion,
        contractVersion: stored.contractVersion,
        contentHash,
        confirmedAt: stored.confirmedAt,
        confirmedBy: stored.confirmedBy
      },
      diff
    }
  };
}

async function actionReportLatest(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const store = host.storeFor(project.root);
  const artifactBase = `/modelcheck/artifact/${encodeURIComponent(sessionId)}/`;
  let names = [];
  try {
    names = await readdir(store.paths.reportsDir);
  } catch {
    names = [];
  }
  let newest = null;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const info = await stat(join(store.paths.reportsDir, name));
      if (!info.isFile()) continue;
      if (!newest || info.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: info.mtimeMs };
    } catch {
      // 单个报告读不到不影响其它候选。
    }
  }
  if (!newest) {
    return { status: 200, body: { ok: true, report: null, record: null, at: null, path: null, artifactBase } };
  }
  let record = null;
  try {
    record = await store.readJson(join(store.paths.reportsDir, newest.name), null);
  } catch {
    record = null;
  }
  let reportText = null;
  if (record && typeof record.report === 'string') {
    reportText = record.report;
  } else if (record) {
    reportText = safeCall(() => renderReportPage(record), null);
  }
  return {
    status: 200,
    body: {
      ok: true,
      report: reportText,
      record,
      at: newest.name,
      path: `reports/${newest.name}`,
      artifactBase
    }
  };
}

async function actionEvidencePoll(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const waitMs = typeof body.waitMs === 'number' ? body.waitMs : 0;
  const result = await host.evidence.poll(sessionId, waitMs);
  return {
    status: 200,
    body: {
      ok: true,
      request: result.request,
      panelOnline: result.panelOnline,
      pending: host.evidence.pendingCount(sessionId)
    }
  };
}

async function actionEvidenceSubmit(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const response = body.response;
  if (!isPlainObject(response)) {
    throw new ApiError(400, errorBody('invalid-response', '缺少 response 对象'));
  }
  const result = host.evidence.submit(sessionId, response);
  if (!result.ok) {
    // 校验失败：丢弃该响应（判据将被 evaluate 记为 inconclusive）。
    // HTTP 200 + accepted:false，让面板能读到原因并停止重试同一份过期证据。
    return {
      status: 200,
      body: {
        ok: false,
        accepted: false,
        requestId: result.requestId ?? response.requestId ?? null,
        reason: result.reason || '证据未采信',
        error: { code: result.code || 'evidence-rejected', message: result.reason || '证据未采信' }
      }
    };
  }
  return { status: 200, body: { ok: true, accepted: true, requestId: result.requestId } };
}

// ── 初始化 / 项目选择（多模型工作区）──────────────────────────────────────
//
// 痛点：已有模型项目通常是一个工作区下多个模型目录（三圈环流/水循环/…），会话 cwd 是
// 工作区根，向上找不到 .modelcheck；手工写 config/components 又慢又易错。
// 这里提供：扫描候选 → 一键生成 scaffold → 把选中项目根绑定到会话。

function ensureInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return;
  if (rel.startsWith('..') || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) {
    throw new ApiError(403, errorBody('outside-workdir', '目标路径必须位于当前会话工作目录内'));
  }
}

async function sessionCwd(host, sessionId) {
  const cwd = await host.cwdForSession(sessionId);
  if (typeof cwd !== 'string' || !cwd) {
    throw new ApiError(409, errorBody('no-workdir', '无法确定当前会话工作目录；请在会话中打开项目目录后重试'));
  }
  return cwd;
}

async function resolveInitTarget(host, sessionId, pathArg) {
  const cwd = await sessionCwd(host, sessionId);
  const target = pathArg ? resolve(cwd, String(pathArg)) : cwd;
  ensureInside(cwd, target);
  return { cwd, target };
}

async function pathIsDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function summarizeScan(scan, cwd) {
  return {
    root: scan.root,
    relativeRoot: cwd ? relative(cwd, scan.root).split(sep).join('/') || '.' : null,
    projectId: scan.projectId,
    title: scan.title,
    route: scan.route,
    previewEntry: scan.previewEntry,
    deliveryEntry: scan.deliveryEntry || scan.previewEntry,
    verifyEntry: scan.verifyEntry || null,
    sources: scan.sources,
    buildOutputs: scan.buildOutputs,
    components: scan.components,
    docs: scan.docs,
    warnings: scan.warnings,
    notes: scan.notes,
    // 空目录/半成品/坏 JSON 都不是“已初始化”。
    modelcheck: scan.modelcheck
  };
}

async function actionInitScan(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const { cwd, target } = await resolveInitTarget(host, sessionId, body.path);
  const selected = host.selectedRootForSession(sessionId);
  if (await isProjectDir(target)) {
    const scan = await scanProject(target);
    // 已初始化项目要以磁盘上的真实 config/components/contract 为准，
    // 否则 readiness 会把“已有契约”误报成未建立。
    let readinessInput;
    if (scan.modelcheck && scan.modelcheck.state === 'ready') {
      try {
        const project = await loadProject(target);
        readinessInput = { config: project.config, components: project.components, contract: project.contract };
      } catch {
        readinessInput = { config: buildConfig(scan), components: buildComponents(scan), contract: null };
      }
    } else {
      readinessInput = { config: buildConfig(scan), components: buildComponents(scan), contract: null };
    }
    const readiness = await computeReadiness({ root: target, ...readinessInput, scan });
    return {
      status: 200,
      body: { ok: true, mode: 'project', target, scan: summarizeScan(scan, cwd), readiness, selected }
    };
  }
  const discovered = await discoverCandidates(target);
  return {
    status: 200,
    body: {
      ok: true,
      mode: 'workspace',
      target,
      cwd,
      selected,
      scannedDirs: discovered.scannedDirs,
      candidates: discovered.candidates
    }
  };
}

async function actionInitApply(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const { cwd, target } = await resolveInitTarget(host, sessionId, body.path);
  let targetDir = target;

  if (!(await isProjectDir(targetDir))) {
    const discovered = await discoverCandidates(target);
    const candidates = discovered.candidates;
    if (body.path) {
      const wanted = String(body.path).replace(/\\/g, '/');
      const match = candidates.find((item) => item.relativeRoot === wanted) ||
        candidates.find((item) => item.root === resolve(cwd, String(body.path)));
      if (!match) {
        throw new ApiError(404, errorBody('no-project-candidate', '指定路径下没有找到可初始化的模型项目', { candidates }));
      }
      targetDir = match.root;
    } else if (candidates.length === 1) {
      targetDir = candidates[0].root;
    } else if (candidates.length > 1) {
      throw new ApiError(409, errorBody('multiple-candidates', '工作目录下有多个模型项目，请选择要初始化哪一个', { candidates }));
    } else {
      throw new ApiError(404, errorBody('no-project-candidate', '工作目录下没有找到可初始化的模型项目（需要 index.html / dist/index.html / package.json）'));
    }
  }
  ensureInside(cwd, targetDir);

  const overrides = isPlainObject(body.overrides) ? body.overrides : {};
  if (typeof body.projectId === 'string') overrides.projectId = body.projectId;
  if (typeof body.title === 'string') overrides.title = body.title;
  if (typeof body.route === 'string') overrides.route = body.route;
  if (typeof body.previewEntry === 'string') overrides.previewEntry = body.previewEntry;
  if (typeof body.unitToPx === 'number') overrides.unitToPx = body.unitToPx;

  let result;
  try {
    result = await applyScaffold(targetDir, { force: body.force === true, overrides });
  } catch (error) {
    throw new ApiError(422, errorBody('scaffold-failed', String((error && error.message) || error), {
      issues: Array.isArray(error && error.issues) ? error.issues : []
    }));
  }
  host.setProjectForSession(sessionId, targetDir);
  let readinessInput = { config: result.config, components: result.components, contract: null };
  try {
    const project = await loadProject(targetDir);
    readinessInput = { config: project.config, components: project.components, contract: project.contract };
  } catch {
    // 刚写入的脚手架至少能用生成结果评估
  }
  const readiness = await computeReadiness({ root: targetDir, ...readinessInput, scan: result.scan });
  return {
    status: 200,
    body: {
      ok: true,
      root: targetDir,
      relativeRoot: relative(cwd, targetDir).split(sep).join('/') || '.',
      selected: true,
      state: result.state,
      written: result.written,
      skipped: result.skipped,
      notes: result.notes,
      nextSteps: result.nextSteps,
      scan: summarizeScan(result.scan, cwd),
      readiness,
      config: result.config
    }
  };
}

async function actionReadiness(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const project = await requireProject(host, sessionId);
  const scan = await scanProject(project.root);
  const readiness = await computeReadiness({
    root: project.root,
    config: project.config,
    components: project.components,
    contract: project.contract,
    scan
  });
  return { status: 200, body: { ok: true, readiness } };
}

async function actionProjectSelect(ctx, host, body) {
  const sessionId = requireSessionId(body);
  const { cwd, target } = await resolveInitTarget(host, sessionId, body.path);
  ensureInside(cwd, target);
  if (!(await pathIsDir(join(target, '.modelcheck')))) {
    throw new ApiError(404, errorBody('no-modelcheck', '该目录没有 .modelcheck；请先初始化（init/apply）', { target }));
  }
  host.setProjectForSession(sessionId, target);
  return { status: 200, body: { ok: true, root: target, selected: true } };
}

const ACTIONS = {
  status: actionStatus,
  'criteria/list': actionCriteriaList,
  'components/list': actionComponentsList,
  'annotations/list': actionAnnotationsList,
  'annotations/create': actionAnnotationsCreate,
  'annotations/send': actionAnnotationsSend,
  'annotations/withdraw': actionAnnotationsWithdraw,
  'annotations/accept': actionAnnotationsAccept,
  'contract/read': actionContractRead,
  'contract/confirm': actionContractConfirm,
  'report/latest': actionReportLatest,
  'evidence/poll': actionEvidencePoll,
  'evidence/submit': actionEvidenceSubmit,
  'init/scan': actionInitScan,
  'init/apply': actionInitApply,
  'project/select': actionProjectSelect,
  readiness: actionReadiness
};

async function handleRequest(req, res, ctx, host) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, errorBody('method-not-allowed', '只接受 POST'));
  }
  // 第一道：浏览器会话鉴权（自定义路由不会被 webserver 自动保护）。
  const rejection = connectionRejection(ctx, req);
  if (rejection !== null) {
    return sendJson(res, rejection, errorBody('unauthorized', '需要已认证的同源浏览器会话'));
  }
  const origin = req.headers && req.headers.origin;
  const hostHeader = req.headers && req.headers.host;
  if (!isAllowedOrigin(origin, hostHeader)) {
    return sendJson(res, 403, errorBody('origin-forbidden', '来源校验失败：只接受同源面板请求'));
  }
  const secFetchSite = req.headers && req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return sendJson(res, 403, errorBody('origin-forbidden', '跨站请求被拒绝'));
  }
  const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    return sendJson(res, 415, errorBody('unsupported-media-type', '请求体必须是 application/json'));
  }
  let raw;
  try {
    raw = await readRequestBody(req);
  } catch (error) {
    if (error instanceof ApiError) return sendJson(res, error.status, error.body);
    throw error;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    return sendJson(res, 400, errorBody('invalid-json', '请求体不是合法 JSON'));
  }
  if (!isPlainObject(body)) {
    return sendJson(res, 400, errorBody('invalid-body', '请求体必须是 JSON 对象'));
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const handler = ACTIONS[action];
  if (!handler) {
    return sendJson(res, 400, errorBody('unknown-action', `未知 action：${action || '(空)'}`));
  }
  try {
    const outcome = await handler(ctx, host, body);
    if (outcome) sendJson(res, outcome.status ?? 200, outcome.body);
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, error.body);
      return;
    }
    console.error(`modelcheck: API action "${action}" 异常:`, error);
    sendJson(res, 500, errorBody('internal', `内部错误：${String((error && error.message) || error)}`));
  }
}

/**
 * 注册 /modelcheck/api 精确路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} host index.js 组装的宿主门面
 * @returns {() => void} 反注册 disposer
 */
export function registerApi(ctx, host) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用');
  }
  return webServer.register({
    kind: 'exact',
    path: API_PREFIX,
    handler(req, res) {
      handleRequest(req, res, ctx, host).catch((error) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        console.error('modelcheck: API 处理器异常:', error);
        sendJson(res, 500, errorBody('internal', '内部错误'));
      });
    }
  });
}
