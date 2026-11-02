// ModelCheck —— 预览壳：把项目内文件以同源方式提供给面板 iframe
//
//   GET /modelcheck/preview/<sessionId>/<relPath...>   项目内文件（带路径穿越防护）
//   GET /modelcheck/artifact/<sessionId>/<name>       .modelcheck/artifacts 下的取证产物
//
// 设计要点（设计 §3.3、§5）：
//   · sessionId 解析成项目根，绝不接受客户端传入的任意路径；目录请求（空路径/结尾斜杠）
//     映射到 config.preview.entry。
//   · 入口 HTML 默认注入 bridge.js；`?__VERIFY__=1` 强制注入，`?__VERIFY__=0` 或
//     config.preview.injectBridge === false 不注入（交付版剥离）。
//   · 只做静态文件服务：不列目录、不执行、不做任何“构建”；未知会话给可读的 404 页面。
//   · 只用 node: 内置模块，不 import 宿主包。
//
// 注入的 bridge 标签带两个数据属性：
//   data-mc-build    当前构建哈希（与 status.evidenceBuild.buildHash 一致，供取证回填比对）
//   data-mc-session  会话 id（面板侧校验消息归属用）

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export const PREVIEW_PREFIX = '/modelcheck/preview';
export const ARTIFACT_PREFIX = '/modelcheck/artifact';

/** 单文件预览大小上限（three.js 单文件包通常远小于此值）。 */
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;
/** 取证产物大小上限。 */
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 扩展名 → Content-Type。未知扩展一律 application/octet-stream（不能当 HTML 执行）。
export const PREVIEW_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const ARTIFACT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.json': 'application/json; charset=utf-8'
};

function sendText(res, status, contentType, body) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendInfoPage(res, status, title, detail) {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ModelCheck · ${escapeHtml(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    font:14px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
    background:#f7f7f8;color:#333}
  .box{max-width:560px;padding:28px 32px;background:#fff;border-radius:10px;
    box-shadow:0 2px 12px rgba(0,0,0,.08)}
  h1{margin:0 0 10px;font-size:17px}
  p{margin:6px 0;color:#666}
  code{background:#f0f0f2;padding:1px 5px;border-radius:4px}
</style></head>
<body><div class="box">
  <h1>ModelCheck · ${escapeHtml(title)}</h1>
  <p>${escapeHtml(detail)}</p>
  <p>这是插件提供的预览路由，不是模型文件。请从「建模判定」面板打开预览。</p>
</div></body></html>`;
  sendText(res, status, 'text/html; charset=utf-8', html);
}

/**
 * 把 URL 中的相对路径规范化。拒绝任何上跳（`..`）、空字节、反斜杠路径段。
 * 纯函数，供单测直接调用。
 * @param {string} raw 未解码的 URL 剩余路径
 * @returns {string|null} 规范化后的相对路径；非法返回 null
 */
export function normalizeRelPath(raw) {
  if (typeof raw !== 'string') return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Windows 上反斜杠同样是分隔符，统一成 / 再逐段检查。
  const segments = decoded.replace(/\\/g, '/').split('/');
  const out = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null; // 任何上跳都拒绝
    // 防御盘符/UNC 风格的分段（如 C:foo）。
    if (/^[A-Za-z]:$/.test(segment)) return null;
    out.push(segment);
  }
  return out.join('/');
}

/**
 * 在项目根内解析一个相对路径（纯字符串运算，不触碰文件系统）。
 * @param {string} rootDir 项目根
 * @param {string} relPath 相对路径
 * @returns {{ok: true, abs: string, rel: string} | {ok: false, reason: string}}
 */
export function resolveInsideRoot(rootDir, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === null) return { ok: false, reason: 'invalid-path' };
  if (!normalized) return { ok: false, reason: 'empty-path' };
  const root = resolve(rootDir);
  const abs = resolve(root, normalized);
  const prefix = root.endsWith(sep) ? root : root + sep;
  const same = abs.toLowerCase() === root.toLowerCase();
  const inside = abs.toLowerCase().startsWith(prefix.toLowerCase());
  if (!same && !inside) return { ok: false, reason: 'outside-root' };
  return { ok: true, abs, rel: normalized };
}

/**
 * 真实路径校验：解析符号链接后再确认仍在项目根内，挡住“软链跳出去”。
 * @param {string} rootDir
 * @param {string} abs
 * @returns {Promise<boolean>}
 */
async function realPathInside(rootDir, abs) {
  try {
    const realRoot = await realpath(resolve(rootDir));
    const realAbs = await realpath(abs);
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    const same = realAbs.toLowerCase() === realRoot.toLowerCase();
    return same || realAbs.toLowerCase().startsWith(prefix.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * 是否给入口 HTML 注入 bridge。纯函数。
 * @param {string|null} verifyQuery `?__VERIFY__` 的原始值
 * @param {object|null} config 项目 config
 * @returns {boolean}
 */
export function shouldInjectBridge(verifyQuery, config) {
  if (verifyQuery === '1') return true; // 显式要求取证
  if (verifyQuery === '0') return false; // 显式要求剥离
  return !config || config.preview?.injectBridge !== false;
}

/**
 * 生成注入的 bridge 脚本标签。
 * 没有构建哈希时不写 data-mc-build（写空串会让 bridge 回传空值，与 expected 不符）。
 * @param {{buildHash?: string|null, sessionId?: string|null}} options
 * @returns {string}
 */
export function bridgeTag(options = {}) {
  const build = String(options.buildHash || '').replace(/[^A-Za-z0-9:._-]/g, '');
  const session = String(options.sessionId || '').replace(/[^A-Za-z0-9._:-]/g, '');
  const buildAttr = build ? ` data-mc-build="${build}"` : '';
  return `<script src="/modelcheck/assets/bridge.js" data-mc-session="${session}"${buildAttr}></script>`;
}

/**
 * 在 `</body>` 前注入 bridge（没有 body 就追加到末尾）。纯函数。
 * @param {string} html
 * @param {{buildHash?: string|null, sessionId?: string|null}} options
 * @returns {string}
 */
export function injectBridge(html, options = {}) {
  const tag = bridgeTag(options);
  const index = html.search(/<\/body\s*>/i);
  if (index >= 0) return html.slice(0, index) + tag + html.slice(index);
  return html + tag;
}

function splitSessionPath(rawRemainder) {
  const rest = rawRemainder.replace(/^\/+/, '');
  const slash = rest.indexOf('/');
  if (slash < 0) return { rawSession: rest, rawPath: '' };
  return { rawSession: rest.slice(0, slash), rawPath: rest.slice(slash + 1) };
}

async function readConfigFile(rootDir) {
  try {
    const text = await readFile(join(rootDir, '.modelcheck', 'config.json'), 'utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function servePreview(req, res, host) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'text/plain; charset=utf-8', 'modelcheck: method not allowed');
  }
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendInfoPage(res, 400, '无效请求', 'URL 无法解析。');
  }
  const remainder = url.pathname.slice(PREVIEW_PREFIX.length);
  const { rawSession, rawPath } = splitSessionPath(remainder);
  let sessionId = '';
  try {
    sessionId = decodeURIComponent(rawSession);
  } catch {
    return sendInfoPage(res, 400, '无效的会话', '会话 id 无法解码。');
  }
  if (!SESSION_ID_RE.test(sessionId)) {
    return sendInfoPage(res, 400, '无效的会话', '缺少或非法的 sessionId。');
  }

  const project = await host.projectForSession(sessionId).catch(() => null);
  if (!project) {
    return sendInfoPage(res, 404, '当前会话没有可预览的项目',
      '未在该会话的工作目录中发现 .modelcheck/config.json。先让 agent 初始化 .modelcheck 目录，再打开预览。');
  }

  const config = project.config || (await readConfigFile(project.root));
  if (!config) {
    return sendInfoPage(res, 404, '项目配置不可读', '.modelcheck/config.json 存在但无法解析，请修复配置后刷新。');
  }

  // 交付版与校验版入口分离：面板取证用 verifyEntry（含 __MC_PREVIEW__ 的构建），
  // 交付检查用 deliveryEntry；两者缺省都回退 preview.entry。
  const verifyQuery = url.searchParams.get('__VERIFY__');
  const verifyMode = verifyQuery === '1' || verifyQuery === 'true';
  const deliveryEntry = normalizeRelPath(String(config.preview?.deliveryEntry || config.preview?.entry || 'index.html')) || 'index.html';
  const verifyEntry = config.preview?.verifyEntry ? normalizeRelPath(String(config.preview.verifyEntry)) : null;
  const entry = verifyMode && verifyEntry ? verifyEntry : deliveryEntry;
  const requested = rawPath === '' || rawPath.endsWith('/') ? entry : rawPath;
  if (rawPath.endsWith('/') && rawPath !== '') {
    // 子目录请求：显式说明只映射到配置的入口，不做目录列表。
    if (normalizeRelPath(rawPath) !== '') {
      return sendInfoPage(res, 404, '不提供目录列表', '预览路由只提供项目文件；目录请求请使用项目根入口。');
    }
  }
  const target = resolveInsideRoot(project.root, requested);
  if (!target.ok) {
    if (target.reason === 'outside-root' || target.reason === 'invalid-path') {
      return sendText(res, 403, 'text/plain; charset=utf-8', 'modelcheck: forbidden path');
    }
    return sendInfoPage(res, 404, '文件不存在', '请求的路径为空。');
  }
  if (!(await realPathInside(project.root, target.abs))) {
    return sendText(res, 403, 'text/plain; charset=utf-8', 'modelcheck: forbidden path');
  }

  let info;
  try {
    info = await stat(target.abs);
  } catch {
    info = null;
  }
  if (!info || !info.isFile()) {
    return sendInfoPage(res, 404, '文件不存在',
      info && info.isDirectory()
        ? '该路径是目录；预览路由不提供目录列表，请直接打开入口文件。'
        : `项目内没有文件：${target.rel}`);
  }
  if (info.size > MAX_PREVIEW_BYTES) {
    return sendText(res, 413, 'text/plain; charset=utf-8', 'modelcheck: file too large');
  }

  let bytes;
  try {
    bytes = await readFile(target.abs);
  } catch {
    return sendInfoPage(res, 404, '文件读取失败', `无法读取项目文件：${target.rel}`);
  }

  const ext = extname(target.abs).toLowerCase();
  let contentType = PREVIEW_MIME[ext];
  if (!contentType) contentType = 'application/octet-stream';
  let body = bytes;
  const isEntry = target.rel === entry || target.rel === deliveryEntry || (verifyEntry !== null && target.rel === verifyEntry);
  if (isEntry && (ext === '.html' || ext === '.htm') && shouldInjectBridge(url.searchParams.get('__VERIFY__'), config)) {
    const html = bytes.toString('utf8');
    const injected = injectBridge(html, {
      buildHash: project.hashes?.buildHash ?? null,
      sessionId
    });
    body = Buffer.from(injected, 'utf8');
    contentType = 'text/html; charset=utf-8';
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function serveArtifact(req, res, host) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendText(res, 405, 'text/plain; charset=utf-8', 'modelcheck: method not allowed');
  }
  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'modelcheck: bad request');
  }
  const rest = url.pathname.slice(ARTIFACT_PREFIX.length).replace(/^\/+/, '');
  const slash = rest.indexOf('/');
  if (slash < 0) return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: artifact not found');
  let sessionId = '';
  let name = '';
  try {
    sessionId = decodeURIComponent(rest.slice(0, slash));
    name = decodeURIComponent(rest.slice(slash + 1));
  } catch {
    return sendText(res, 400, 'text/plain; charset=utf-8', 'modelcheck: bad artifact path');
  }
  if (!SESSION_ID_RE.test(sessionId) || !ARTIFACT_NAME_RE.test(name)) {
    return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: artifact not found');
  }
  const dot = name.lastIndexOf('.');
  const contentType = dot > 0 ? ARTIFACT_MIME[name.slice(dot).toLowerCase()] : undefined;
  // 不提供 SVG：同源顶层 SVG 能执行脚本，取证产物里没有这个必要。
  if (!contentType) return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: unsupported artifact type');

  const project = await host.projectForSession(sessionId).catch(() => null);
  if (!project) return sendInfoPage(res, 404, '当前会话没有项目', '无法定位 .modelcheck/artifacts 目录。');
  const abs = join(project.root, '.modelcheck', 'artifacts', name);
  if (!(await realPathInside(project.root, abs))) {
    return sendText(res, 403, 'text/plain; charset=utf-8', 'modelcheck: forbidden path');
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) throw new Error('not a file');
    if (info.size > MAX_ARTIFACT_BYTES) {
      return sendText(res, 413, 'text/plain; charset=utf-8', 'modelcheck: artifact too large');
    }
    const bytes = await readFile(abs);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': bytes.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch {
    return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: artifact not found: ' + name);
  }
}

/**
 * 注册预览与取证产物路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ projectForSession: (sessionId: string) => Promise<any|null> }} host
 * @returns {() => void} 反注册 disposer
 */
export function registerPreview(ctx, host) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用');
  }
  const disposers = [];
  disposers.push(webServer.register({
    kind: 'prefix',
    path: PREVIEW_PREFIX,
    handler: (req, res) => servePreview(req, res, host).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendInfoPage(res, 500, '预览失败', String((error && error.message) || error));
    })
  }));
  disposers.push(webServer.register({
    kind: 'prefix',
    path: ARTIFACT_PREFIX,
    handler: (req, res) => serveArtifact(req, res, host).catch(() => {
      if (!res.headersSent) sendText(res, 500, 'text/plain; charset=utf-8', 'modelcheck: artifact error');
      else res.end();
    })
  }));
  return () => {
    for (const dispose of disposers) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        // 卸载阶段单个 disposer 失败不影响其它资源回收。
      }
    }
  };
}
