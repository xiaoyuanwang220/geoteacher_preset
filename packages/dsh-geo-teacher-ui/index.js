// geo-edu / dsh-geo-teacher-ui —— 宿主半边
//
// 职责：为客户端半边提供本插件自带的静态资源。
//   GET /geo-teacher-ui/assets/<name>   只发栅格图
//
// 客户端半边见 client.js（由 dsh-client-modules 依 package.json 的 `dsh.client` 发现，
// 经 /plugins 提供 bundle，浏览器端 window.__ModuleLoader__.load({id, factory}) 注册）。
//
// 约束：
//   · 路由前缀与预设内的 /geo-teacher、/geo-teacher/assets 不冲突——同一路径只能由一个插件
//     注册，重复注册会让整个 preset 挂载失败。
//   · 只使用 node: 内置模块，不 import 宿主包（用户根无 node_modules，裸 import 会失败）。
//   · 素材只从本包 assets/ 取；不引用仓库内的开发目录，安装形态下那些路径不存在。
//   · 不提供 image/svg+xml：本路由与 DSH Web API 同源，顶层 SVG 能执行脚本，
//     同源脚本执行不该由"往素材目录放一个 .svg"换来。

import { statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = join(HERE, 'assets');

const ASSET_PREFIX = '/geo-teacher-ui/assets';
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function sendText(res, status, contentType, body) {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export default {
  name: 'geo-teacher-ui',
  inject: ['webServer'],
  apply(ctx) {
    ctx.webServer.register({
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
    });
  }
};
