// GeoTeacher Agent — 工作台插件（geo-panel）
// 路由：/geo-teacher（工作台页面）、/geo-teacher/assets/*（页面静态资源）
//
// 页面是「讲题 / 出题 / 课程方案」三功能的**任务受理台**：教师选功能、填需求、选参数，
// 页面把需求整理成一段可直接粘贴到对话的提示词（纯前端，不写盘、不调模型）。
// 依此设计，本插件不消费 geoKernel，也不注册模型工具——它只交付界面。
//
// 注意：不 import 宿主包（C: 用户根无 node_modules，裸 import 会失败）；
// 只使用 node: 内置模块，且插件自身不做任何耗时 I/O，页面在请求时才读取。

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = join(HERE, 'page.html');

// 主视觉「地球仪与书本」取图：只从本插件 assets\ 取，与部署形态无关（放进即生效）。
// 找不到就 404，页面只是缺一张插图，功能不受影响。
const ASSET_DIRS = [join(HERE, 'assets')];

// 与下方 register 的 path 字面量必须一致：geo-verify 的路由静态扫描只识别字面量，
// 用变量会让该路由在检查里隐形。
const ASSET_PREFIX = '/geo-teacher/assets';
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// 只列栅格图：素材目录落在工作区内（可写），而本路由与 DSH Web API 同源，
// 顶层 SVG 能执行脚本——同源脚本执行不该由"往素材目录放一个 .svg"换来，故不提供 image/svg+xml。
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
  name: 'geo-panel',
  inject: ['fs', 'webServer'],
  apply(ctx) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;

    // 工作台页面
    webServer.register({
      kind: 'exact',
      path: '/geo-teacher',
      handler: (req, res) => {
        fsService.resolve(PAGE_PATH)
          .then(target => fsService.readText(target))
          .then(html => {
            // 固定 URL：不设 Cache-Control 时浏览器会启发式缓存，插件更新后可能仍拿到旧页
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(html || '<h1>geo-panel: page not found</h1>');
          })
          .catch(() => {
            // 头已发出（例如 res.end 途中失败）时不能再 writeHead，否则 ERR_HTTP_HEADERS_SENT
            if (res.writableEnded) return;
            if (res.headersSent) { res.end(); return; }
            sendText(res, 500, 'text/plain; charset=utf-8', 'geo-panel: failed to load page');
          });
      }
    });

    // 页面静态资源（只按文件名取，逐个候选目录尝试）
    webServer.register({
      kind: 'prefix',
      path: '/geo-teacher/assets',
      handler: async (req, res) => {
        const pathname = (req.url || '/').split('?')[0];
        let name = '';
        try {
          name = decodeURIComponent(pathname.slice(ASSET_PREFIX.length).replace(/^\/+/, ''));
        } catch {
          return sendText(res, 400, 'text/plain; charset=utf-8', 'geo-panel: bad asset name');
        }
        if (!name || !ASSET_NAME_RE.test(name)) {
          return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-panel: asset not found');
        }
        const dot = name.lastIndexOf('.');
        const contentType = dot > 0 ? MIME[name.slice(dot).toLowerCase()] : undefined;
        if (!contentType) {
          return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-panel: unsupported asset type');
        }
        for (const dir of ASSET_DIRS) {
          try {
            const target = await fsService.resolve(join(dir, name));
            const bytes = await fsService.readBytes(target, undefined, MAX_ASSET_BYTES);
            res.writeHead(200, {
              'Content-Type': contentType,
              'Content-Length': bytes.byteLength,
              'Cache-Control': 'no-cache',
              'X-Content-Type-Options': 'nosniff'
            });
            res.end(Buffer.from(bytes));
            return;
          } catch {
            // 该候选目录没有这个文件（或读不到），继续下一个
          }
        }
        return sendText(res, 404, 'text/plain; charset=utf-8', 'geo-panel: asset not found: ' + name);
      }
    });

    console.log('geo-panel: /geo-teacher 工作台已注册');
  }
};
