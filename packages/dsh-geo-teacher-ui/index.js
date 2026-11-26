// geo-edu / dsh-geo-teacher-ui —— 宿主半边
//
// 职责：
//   1. 静态资源：GET /geo-teacher-ui/assets/<name>（只发栅格图，禁 SVG）
//   2. 会话输入区状态同步：POST/GET /geo-teacher-ui/state
//      接收客户端（client.js）按 sessionId 上报的「讲题／课程方案」及参数选择，
//      通过 DSH 原生 `systemPrompt.context` 注册动态运行时上下文，使 dsh-agent-loop
//      在每轮请求准入（refreshContext）时将教师当前选定的功能、讲解对象、年级与授课时间
//      直接送达模型，不污染原生输入框文本、不破坏 @文件 引用胶囊，且对隔离解题子会话
//      （独立 childSessionId）与非 geo-teacher 会话返回空串（零泄漏）。
//
// 约束：
//   · 只使用 node: 内置模块，不裸 import @deepseek-ai/* 宿主包（profile 目录无宿主包链接）。
//   · 路由统一经 ctx.effect 注册清理函数，支持重挂载幂等回收。

import { statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(HERE, 'assets');

const PRESET_ID = 'geo-teacher';
const ASSET_PREFIX = '/geo-teacher-ui/assets';
export const UI_STATE_PATH = '/geo-teacher-ui/state';
export const UI_CONTEXT_NAME = 'geo-teacher-ui:selection';
const UI_CONTEXT_ORDER = 150;

const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BODY_BYTES = 4096;
const MAX_SESSIONS = 256;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

export const VALID_MODES = ['explain', 'lesson'];
export const VALID_AUDIENCES = {
  学生: 'student',
  教师: 'teacher',
  命题人: 'setter'
};
export const VALID_GRADES = ['高一', '高二', '高三'];
export const VALID_DURATIONS = ['45分钟', '10分钟'];

export const DEFAULT_UI_SELECTION = Object.freeze({
  active: 'explain',
  values: Object.freeze({
    audience: '学生',
    grade: '高一',
    duration: '45分钟'
  })
});

export function normalizeUiSelection(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const active = VALID_MODES.includes(input.active) ? input.active : DEFAULT_UI_SELECTION.active;
  const rawValues = input.values && typeof input.values === 'object' ? input.values : {};
  const audience = Object.hasOwn(VALID_AUDIENCES, rawValues.audience)
    ? rawValues.audience
    : DEFAULT_UI_SELECTION.values.audience;
  const grade = VALID_GRADES.includes(rawValues.grade)
    ? rawValues.grade
    : DEFAULT_UI_SELECTION.values.grade;
  const duration = VALID_DURATIONS.includes(rawValues.duration)
    ? rawValues.duration
    : DEFAULT_UI_SELECTION.values.duration;
  return {
    active,
    values: { audience, grade, duration }
  };
}

export function formatSelectionContext(selection) {
  if (!selection || typeof selection !== 'object') return '';
  const norm = normalizeUiSelection(selection);
  if (norm.active === 'lesson') {
    return [
      '[地理教师辅助 · 会话输入区当前选项]',
      '- 输入区选中功能：课程方案',
      `- 授课年级（学段）：${norm.values.grade}`,
      `- 授课时间（课时）：${norm.values.duration}`,
      `使用规则：当教师本轮消息未明确指定其他功能时，按「课程方案」流程处理；进入课程方案流程且教师未在消息正文中另行指定年级或课时时，直接将上述已选定的「${norm.values.grade}、${norm.values.duration}」作为确认输入写入任务简报，严禁再次向教师询问授课时间/课时或年级/学段（若教师消息正文明确写了其他功能、年级或时长，以消息正文为准）。`
    ].join('\n');
  }
  const audienceCode = VALID_AUDIENCES[norm.values.audience] || 'student';
  return [
    '[地理教师辅助 · 会话输入区当前选项]',
    '- 输入区选中功能：讲题',
    `- 讲解对象：${norm.values.audience}（调用 geo_explain 时 audience="${audienceCode}"）`,
    `使用规则：当教师消息属于讲题且未在正文中另行指定讲解对象时，直接采用输入区选定的「${norm.values.audience}」（audience="${audienceCode}"），无需重复询问讲解对象；若教师消息明确要求其他任务（如设计课程方案、润色模拟题、检索考点真题）或明确指定其他讲解对象，以教师消息正文为准。`
  ].join('\n');
}

export function createUiStateRegistry(maxEntries = MAX_SESSIONS) {
  const map = new Map();
  return {
    set(sessionId, selection) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!id || id.length > 200) return null;
      const normalized = normalizeUiSelection(selection);
      if (map.has(id)) map.delete(id);
      map.set(id, normalized);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      return normalized;
    },
    get(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      return id ? (map.get(id) || null) : null;
    },
    delete(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      return id ? map.delete(id) : false;
    },
    contextTextFor(promptContext) {
      const agent = promptContext && promptContext.agent;
      const sessionId = agent
        ? (agent.id || (agent.session && agent.session.id) || '')
        : '';
      if (!sessionId) return '';
      const found = map.get(sessionId);
      return found ? formatSelectionContext(found) : '';
    },
    size() {
      return map.size;
    }
  };
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function isSameOriginRequest(req) {
  const origin = req && req.headers && req.headers.origin;
  if (!origin) return true;
  const host = req && req.headers && req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid json'), { statusCode: 400 }));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export default {
  name: 'geo-teacher-ui',
  inject: ['webServer', 'systemPrompt'],
  apply(ctx) {
    const registry = createUiStateRegistry();
    const registerEffect = typeof ctx.effect === 'function'
      ? (fn) => ctx.effect(fn)
      : (fn) => fn();

    const systemPrompt = ctx.systemPrompt || (ctx.get && ctx.get('systemPrompt'));
    if (systemPrompt && typeof systemPrompt.context === 'function') {
      registerEffect(() => systemPrompt.context({
        name: UI_CONTEXT_NAME,
        order: UI_CONTEXT_ORDER,
        interpolate: false,
        text: (promptContext) => registry.contextTextFor(promptContext)
      }));
    }

    registerEffect(() => ctx.webServer.register({
      kind: 'exact',
      path: UI_STATE_PATH,
      handler: async (req, res) => {
        const method = String(req.method || 'GET').toUpperCase();
        if (method === 'GET') {
          const url = new URL(req.url || '/', 'http://localhost');
          const sessionId = (url.searchParams.get('sessionId') || '').trim();
          return sendJson(res, 200, { ok: true, state: registry.get(sessionId) });
        }
        if (method !== 'POST') {
          return sendJson(res, 405, { ok: false, error: 'method not allowed' });
        }
        if (!isSameOriginRequest(req)) {
          return sendJson(res, 403, { ok: false, error: 'cross-origin forbidden' });
        }
        try {
          const body = await readJsonBody(req, MAX_STATE_BODY_BYTES);
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
          if (!sessionId || sessionId.length > 200) {
            return sendJson(res, 400, { ok: false, error: 'invalid sessionId' });
          }
          if (body.preset !== PRESET_ID) {
            registry.delete(sessionId);
            return sendJson(res, 200, { ok: true, cleared: true });
          }
          const saved = registry.set(sessionId, body);
          return sendJson(res, 200, { ok: true, state: saved });
        } catch (err) {
          const status = (err && err.statusCode) || 400;
          return sendJson(res, status, { ok: false, error: (err && err.message) || 'bad request' });
        }
      }
    }));

    registerEffect(() => ctx.webServer.register({
      kind: 'prefix',
      path: ASSET_PREFIX,
      handler: (req, res) => {
        const pathname = (req.url || '/').split('?')[0];
        let name = '';
        try {
          name = decodeURIComponent(pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, ''));
        } catch {
          return sendText(res, 400, 'text/plain; charset=utf-8', 'geo-teacher-ui: bad asset name');
        }
        if (!name || !ASSET_NAME_RE.test(name)) {
          return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-teacher-ui: asset not found');
        }
        const dot = name.lastIndexOf('.');
        const contentType = dot > 0 ? MIME[name.slice(dot).toLowerCase()] : undefined;
        if (!contentType) {
          return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-teacher-ui: unsupported asset type');
        }
        const target = join(ASSET_DIR, name);
        try {
          const info = statSync(target);
          if (!info.isFile()) throw new Error('not a file');
          if (info.size > MAX_ASSET_BYTES) {
            return sendText(res, 413, 'text/plain; charset=utf-8', 'geo-teacher-ui: asset too large');
          }
          const bytes = readFileSync(target);
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': bytes.byteLength,
            // 固定 URL：不设 Cache-Control 时浏览器会启发式缓存，插件更新后可能仍拿到旧图
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff'
          });
          res.end(bytes);
        } catch {
          return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-teacher-ui: asset not found: ' + name);
        }
      }
    }));
  }
};
