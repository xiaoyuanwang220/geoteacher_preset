// ModelCheck —— /modelcheck/assets 静态资源
//
// 只发本包 assets/ 目录里的白名单文件：bridge.js、icon.svg 与栅格图。
// 约束（与既有插件同形）：
//   · 不 import 宿主包，只用 node: 内置模块；素材只从本包取，不引用仓库内开发目录。
//   · 只接受单段文件名（无路径分隔符），天然挡掉路径穿越。
//   · 不提供任意 SVG：本路由与 DSH Web API 同源，顶层 SVG 能执行脚本；icon.svg 是
//     本包自制且文件名精确放行，别处放一个 .svg 不会被当成可执行文档发出去。
//   · bridge.js 是普通脚本，按 text/javascript 下发（不是 module，注入到模型页后立即执行）。

import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 本模块位于 <包>/server/，素材在 <包>/assets/。
export const ASSET_DIR = join(HERE, '..', 'assets');

// 与下方 registerStatic 的 path 字面量保持一致（静态检查只识别字面量）。
export const ASSET_PREFIX = '/modelcheck/assets';

const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 扩展名 → Content-Type。只列本插件真的会发的类型。
const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

/**
 * 判定一个素材名是否允许下发，并给出 Content-Type。
 * 纯函数，便于单测；不在白名单返回 null。
 * @param {string} name 单段文件名（调用方已保证不含路径分隔符）
 * @returns {{ contentType: string, path: string } | null}
 */
export function resolveAsset(name) {
  if (typeof name !== 'string' || !ASSET_NAME_RE.test(name)) return null;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot).toLowerCase();
  const contentType = MIME[ext];
  if (!contentType) return null;
  // 只放行本包自制的 icon.svg 与 bridge.js；其它 SVG/JS 一律拒绝。
  if (ext === '.svg' && name !== 'icon.svg') return null;
  if (ext === '.js' && name !== 'bridge.js') return null;
  return { contentType, path: join(ASSET_DIR, name) };
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 注册 /modelcheck/assets 前缀路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主插件上下文
 * @returns {() => void} 反注册 disposer
 */
export function registerStatic(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('webServer 服务不可用');
  }

  return webServer.register({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler(req, res) {
      const pathname = (req.url || '/').split('?')[0];
      let name = '';
      try {
        name = decodeURIComponent(pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, ''));
      } catch {
        return sendText(res, 400, 'text/plain; charset=utf-8', 'modelcheck: bad asset name');
      }
      // 只接受单段文件名：带分隔符、编码后的分隔符都会落到这里被拒。
      const asset = resolveAsset(name);
      if (!asset) {
        return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: asset not found');
      }
      try {
        const info = statSync(asset.path);
        if (!info.isFile()) throw new Error('not a file');
        if (info.size > MAX_ASSET_BYTES) {
          return sendText(res, 413, 'text/plain; charset=utf-8', 'modelcheck: asset too large');
        }
        const bytes = readFileSync(asset.path);
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Length': bytes.byteLength,
          // 插件更新后旧缓存可能继续生效，这里显式禁用缓存。
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch {
        return sendText(res, 404, 'text/plain; charset=utf-8', 'modelcheck: asset not found: ' + name);
      }
    }
  });
}
