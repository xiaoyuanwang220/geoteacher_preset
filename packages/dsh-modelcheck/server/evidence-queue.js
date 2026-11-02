// ModelCheck —— 运行时取证请求/响应队列（M1）
//
// 面板在 `evidence/poll` 长轮询取走请求，交给预览 iframe 的 bridge.js 采集，
// 再通过 `evidence/submit` 回填。本模块只做四件事：
//   · 按项目 + 会话排队，一次请求只允许一条有效响应（single-use）；
//   · 校验 requestId / 会话 / 项目 / 构建哈希 / 源码哈希 / 上下文 / 结构 / 大小；
//   · 超时返回 null（判据 inconclusive，绝不伪造证据）；
//   · 记录面板在线时间（来自 poll），从不伪造“面板已打开”。
//
// 只用 node: 内置模块；纯内存，插件卸载时 dispose 清空。

import { randomUUID } from 'node:crypto';

/** 证据适配器版本：与 lib/evidence.js 的 adapterVersion 约定一致。 */
export const ADAPTER_VERSION = 'modelcheck-adapter/1';

/** 单条证据响应大小上限（1 MiB），与设计 §3.5 单条消息上限一致。 */
export const MAX_EVIDENCE_BYTES = 1024 * 1024;

/** 默认取证超时；可由 config.preview.timeoutMs 覆盖。 */
export const DEFAULT_EVIDENCE_TIMEOUT_MS = 8000;

/** evidence/poll 单次最长挂起时间。 */
export const MAX_POLL_WAIT_MS = 30000;

/** 面板心跳有效期：超过视为离线（不伪造在线）。 */
export const PANEL_PRESENCE_TTL_MS = 15000;

/** 同一会话同时挂起的请求上限，避免面板长期离线时无限堆积。 */
const MAX_PENDING_PER_SESSION = 8;

/** 已投递给面板但尚未回填的请求，超过该时间允许重新投递（面板可能重载了 iframe）。 */
const REDELIVER_AFTER_MS = 2000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 稳定 JSON：键排序、无空白；用于上下文与哈希类字段的深比较。 */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function byteLengthOf(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * 校验一条证据响应是否属于该请求，并把可安全落盘的规范形返回。
 * 纯函数；不修改入参。失败原因给中文，直接进判据 detail 与面板。
 * @param {unknown} response 面板回填的响应对象
 * @param {object} request 队列中的请求（含 requestId/sessionId/projectId/expected/context）
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
export function validateEvidenceResponse(response, request) {
  if (!isPlainObject(response)) return { ok: false, reason: '响应不是 JSON 对象' };
  if (typeof response.requestId !== 'string' || !response.requestId) {
    return { ok: false, reason: '响应缺少 requestId' };
  }
  if (response.requestId !== request.requestId) {
    return { ok: false, reason: 'requestId 与当前请求不一致（旧响应已丢弃）' };
  }
  if (typeof response.sessionId !== 'string' || response.sessionId !== request.sessionId) {
    return { ok: false, reason: 'sessionId 与请求会话不一致' };
  }
  if (request.projectId !== null && request.projectId !== undefined) {
    if (typeof response.projectId !== 'string' || response.projectId !== request.projectId) {
      return { ok: false, reason: 'projectId 与请求项目不一致' };
    }
  }

  const expected = request.expected || {};
  for (const field of ['buildHash', 'sourceHash']) {
    const want = expected[field];
    if (typeof want !== 'string' || !want) continue; // 没有构建/源码哈希时不做比对
    if (typeof response[field] !== 'string' || response[field] !== want) {
      return { ok: false, reason: `${field} 与请求不符（响应属于其它构建，已丢弃）` };
    }
  }

  if (typeof response.adapterVersion !== 'string' || !response.adapterVersion) {
    return { ok: false, reason: '响应缺少 adapterVersion' };
  }
  if (!isPlainObject(response.components)) {
    return { ok: false, reason: '响应缺少 components 运行时属性' };
  }
  if (!isPlainObject(response.context)) {
    return { ok: false, reason: '响应缺少 context 运行上下文' };
  }

  // 上下文必须覆盖请求要求的每一项（允许响应附带额外字段，但要求项必须一致）。
  // 例外：单状态静态页（route !== 'three'，无状态机/动画）观测不到也控制不了
  // step/mode/view 这类运行状态；bridge 若显式声明 static:true 且把这些键列入
  // unobservable，则视为“该要求对静态页恒成立”而采信——但绝不允许动态页面用这条豁免
  // 假装到达了某状态（three 路线 static 必须为 false，否则仍判不符）。
  const requestedContext = isPlainObject(request.context) ? request.context : {};
  const responseContext = response.context;
  const unobservable = Array.isArray(responseContext.unobservable) ? responseContext.unobservable : [];
  const staticPage = responseContext.static === true;
  for (const key of Object.keys(requestedContext)) {
    const want = requestedContext[key];
    const got = responseContext[key];
    if (want === null || want === undefined) continue;
    if (stableJson(got) === stableJson(want)) continue;
    if (staticPage && unobservable.includes(key)) continue;
    return { ok: false, reason: `context.${key} 与请求不符（未到达约定状态，不采信）` };
  }

  const capturedAt = response.capturedAt;
  if (typeof capturedAt !== 'string' && typeof capturedAt !== 'number') {
    return { ok: false, reason: '响应缺少 capturedAt' };
  }

  if (byteLengthOf(response) > MAX_EVIDENCE_BYTES) {
    return { ok: false, reason: `证据响应超过 ${MAX_EVIDENCE_BYTES} 字节上限` };
  }

  const coverage = Array.isArray(response.coverage) ? response.coverage.slice(0, 200) : [];
  const errors = Array.isArray(response.errors) ? response.errors.slice(0, 200) : [];
  const artifacts = Array.isArray(response.artifacts) ? response.artifacts.slice(0, 50) : [];
  return {
    ok: true,
    value: {
      requestId: response.requestId,
      projectId: response.projectId,
      sessionId: response.sessionId,
      buildHash: typeof response.buildHash === 'string' ? response.buildHash : null,
      sourceHash: typeof response.sourceHash === 'string' ? response.sourceHash : null,
      adapterVersion: response.adapterVersion,
      evidenceKind: typeof response.evidenceKind === 'string' ? response.evidenceKind : 'runtime',
      context: response.context,
      components: response.components,
      coverage,
      errors,
      artifacts,
      capturedAt,
      receivedAt: new Date().toISOString()
    }
  };
}

export class EvidenceQueue {
  #pending = new Map(); // sessionId -> request[]
  #waiters = new Set(); // 长轮询挂起者
  #presence = new Map(); // sessionId -> 最近一次 poll 的时间戳
  #disposed = false;
  #log;

  /** @param {{ log?: (...args: any[]) => void }} [options] */
  constructor(options = {}) {
    this.#log = typeof options.log === 'function' ? options.log : () => {};
  }

  /** 面板是否在线（近期轮询过）。 */
  panelOnline(sessionId) {
    const last = this.#presence.get(sessionId);
    return typeof last === 'number' && Date.now() - last <= PANEL_PRESENCE_TTL_MS;
  }

  /** 任一会话的面板是否在线。 */
  anyPanelOnline() {
    const now = Date.now();
    for (const last of this.#presence.values()) {
      if (now - last <= PANEL_PRESENCE_TTL_MS) return true;
    }
    return false;
  }

  pendingCount(sessionId) {
    const list = this.#pending.get(sessionId);
    return Array.isArray(list) ? list.length : 0;
  }

  /**
   * 创建一条取证请求，等待面板回填或超时。
   * @param {object} spec
   * @param {string} spec.sessionId 会话 id
   * @param {string|null} [spec.projectId] 项目 id
   * @param {{buildHash?: string|null, sourceHash?: string|null}} [spec.expected]
   * @param {object[]} [spec.components]
   * @param {object} [spec.context]
   * @param {object} [spec.props]
   * @param {number} [spec.timeoutMs]
   * @returns {Promise<object|null>} 校验通过的证据对象；超时/参数非法为 null
   */
  createRequest(spec) {
    if (this.#disposed) return Promise.resolve(null);
    if (!spec || typeof spec.sessionId !== 'string' || !spec.sessionId) {
      this.#log('取证请求缺少 sessionId，已忽略');
      return Promise.resolve(null);
    }
    const timeoutMs = clampInt(spec.timeoutMs, 1000, 60000, DEFAULT_EVIDENCE_TIMEOUT_MS);
    const list = this.#pending.get(spec.sessionId) || [];
    const request = {
      requestId: `mc-${randomUUID()}`,
      sessionId: spec.sessionId,
      projectId: typeof spec.projectId === 'string' && spec.projectId ? spec.projectId : null,
      expected: {
        buildHash: typeof spec.expected?.buildHash === 'string' ? spec.expected.buildHash : null,
        sourceHash: typeof spec.expected?.sourceHash === 'string' ? spec.expected.sourceHash : null
      },
      components: Array.isArray(spec.components) ? spec.components.slice(0, 64) : [],
      context: isPlainObject(spec.context) ? spec.context : {},
      props: isPlainObject(spec.props) ? spec.props : {},
      timeoutMs,
      createdAt: new Date().toISOString(),
      deliveredAt: 0,
      _timer: null,
      _resolve: null
    };

    // 队列过长时丢弃最旧请求（面板离线期间不无限堆积）。
    while (list.length >= MAX_PENDING_PER_SESSION) {
      const dropped = list.shift();
      this.#settle(dropped, null, '队列超出上限，丢弃最旧请求');
    }
    list.push(request);
    this.#pending.set(spec.sessionId, list);

    return new Promise((resolve) => {
      request._resolve = resolve;
      request._timer = setTimeout(() => {
        this.#remove(request);
        this.#settle(request, null, '取证超时');
      }, timeoutMs);
      // 立刻唤醒正在长轮询的面板。
      this.#wakeWaiters(spec.sessionId);
    });
  }

  /**
   * 长轮询取一条待处理请求。返回 null 表示等待期内没有请求。
   * @param {string} sessionId
   * @param {number} [waitMs] 挂起时间，0 表示立即返回
   * @returns {Promise<{request: object|null, panelOnline: boolean}>}
   */
  poll(sessionId, waitMs = 0) {
    if (typeof sessionId === 'string' && sessionId) this.#presence.set(sessionId, Date.now());
    const immediate = this.#takePollable(sessionId);
    if (immediate) {
      return Promise.resolve({ request: this.#publicRequest(immediate), panelOnline: true });
    }
    const wait = clampInt(waitMs, 0, MAX_POLL_WAIT_MS, 0);
    if (wait === 0 || this.#disposed) {
      return Promise.resolve({ request: null, panelOnline: this.panelOnline(sessionId) });
    }
    return new Promise((resolve) => {
      const waiter = {
        sessionId,
        done: false,
        timer: null,
        finish: (value) => {
          if (waiter.done) return;
          waiter.done = true;
          if (waiter.timer) clearTimeout(waiter.timer);
          this.#waiters.delete(waiter);
          resolve(value);
        }
      };
      waiter.timer = setTimeout(() => {
        waiter.finish({ request: null, panelOnline: this.panelOnline(sessionId) });
      }, wait);
      this.#waiters.add(waiter);
      // 注册后立刻再取一次，避免 createRequest 与 poll 交错时丢失唤醒。
      const again = this.#takePollable(sessionId);
      if (again) waiter.finish({ request: this.#publicRequest(again), panelOnline: true });
    });
  }

  /**
   * 面板回填证据。成功后该请求销毁（single-use），再次提交同一 requestId 会失败。
   * @param {string} sessionId
   * @param {unknown} response
   * @returns {{ok: boolean, accepted?: boolean, requestId?: string, reason?: string, code?: string}}
   */
  submit(sessionId, response) {
    if (typeof sessionId === 'string' && sessionId) this.#presence.set(sessionId, Date.now());
    if (!isPlainObject(response)) {
      return { ok: false, accepted: false, code: 'malformed-response', reason: '响应不是 JSON 对象' };
    }
    const requestId = typeof response.requestId === 'string' ? response.requestId : '';
    const list = this.#pending.get(sessionId) || [];
    const request = list.find((item) => item.requestId === requestId);
    if (!request) {
      // 找不到说明：从未发出 / 已超时 / 已被使用 / 属于其它会话。全部拒绝，绝不张冠李戴。
      return {
        ok: false,
        accepted: false,
        code: 'unknown-request',
        requestId: requestId || undefined,
        reason: '请求不存在、已超时或已使用（证据单次有效，请重新取证）'
      };
    }
    const checked = validateEvidenceResponse(response, request);
    if (!checked.ok) {
      this.#remove(request);
      this.#settle(request, null, checked.reason);
      return { ok: false, accepted: false, code: 'evidence-rejected', requestId, reason: checked.reason };
    }
    this.#remove(request);
    this.#settle(request, checked.value, null);
    return { ok: true, accepted: true, requestId };
  }

  /** 插件卸载：清空定时器并让所有等待方得到 null（不保留半截证据）。 */
  dispose() {
    this.#disposed = true;
    for (const waiter of [...this.#waiters]) {
      waiter.finish({ request: null, panelOnline: false });
    }
    for (const list of this.#pending.values()) {
      for (const request of [...list]) {
        this.#settle(request, null, '插件已卸载');
      }
    }
    this.#pending.clear();
    this.#presence.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  #takePollable(sessionId) {
    const list = this.#pending.get(sessionId);
    if (!Array.isArray(list) || list.length === 0) return null;
    const now = Date.now();
    for (const request of list) {
      if (!request.deliveredAt || now - request.deliveredAt >= REDELIVER_AFTER_MS) {
        request.deliveredAt = now;
        return request;
      }
    }
    return null;
  }

  #remove(request) {
    const list = this.#pending.get(request.sessionId);
    if (!Array.isArray(list)) return;
    const index = list.indexOf(request);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) this.#pending.delete(request.sessionId);
  }

  #settle(request, value, reason) {
    if (!request) return;
    if (request._timer) {
      clearTimeout(request._timer);
      request._timer = null;
    }
    if (reason) this.#log(`取证请求未采信：${reason}`);
    const resolve = request._resolve;
    request._resolve = null;
    if (typeof resolve === 'function') resolve(value);
  }

  #wakeWaiters(sessionId) {
    for (const waiter of [...this.#waiters]) {
      if (waiter.sessionId !== sessionId) continue;
      const request = this.#takePollable(sessionId);
      if (request) waiter.finish({ request: this.#publicRequest(request), panelOnline: true });
    }
  }

  #publicRequest(request) {
    return {
      requestId: request.requestId,
      projectId: request.projectId,
      sessionId: request.sessionId,
      expected: { ...request.expected },
      components: request.components,
      context: request.context,
      props: request.props,
      timeoutMs: request.timeoutMs,
      createdAt: request.createdAt
    };
  }
}
