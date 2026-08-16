// GeoTeacher Agent — 考点树功能插件（geo-taxonomy）
// 路由：/geo/taxonomy/tree、/geo/taxonomy/node?id=
// 模型工具：geo_taxonomy
// 消费 geoKernel 服务。
// 注意：不 import 宿主包（C: 用户根无 node_modules，裸 import 会失败），工具定义直接构造对象。

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function parseQuery(url) {
  const q = url.indexOf('?');
  const out = {};
  if (q >= 0) {
    for (const pair of url.slice(q + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) out[decodeURIComponent(pair)] = '';
      else out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

// 在树中查找节点并返回其祖先路径
function findNodePath(nodes, id, path) {
  for (const n of nodes) {
    const next = path.concat(n);
    if (n.id === id) return { node: n, path: next };
    if (n.children && n.children.length) {
      const found = findNodePath(n.children, id, next);
      if (found) return found;
    }
  }
  return null;
}

function renderJson(args, value) {
  const text = JSON.stringify(value, null, 2);
  const capped = text.length > 16000 ? text.slice(0, 16000) + '\n...[截断，总长 ' + text.length + ']' : text;
  return [{ type: 'text', text: capped }];
}

export default {
  name: 'geo-taxonomy',
  inject: ['webServer', 'geoKernel', 'tools'],
  apply(ctx) {
    const webServer = ctx.webServer;
    const kernel = ctx.geoKernel;

    webServer.register({
      kind: 'prefix',
      path: '/geo/taxonomy',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo\/taxonomy\/?/, '') || 'index';
          switch (action) {
            case 'tree':
              return sendJson(res, 200, await kernel.getTaxonomyTree());
            case 'node': {
              const tree = await kernel.getTaxonomyTree();
              const found = findNodePath(tree, query.id || '', []);
              if (!found) return sendJson(res, 404, { status: 'error', message: '未找到考点：' + query.id });
              return sendJson(res, 200, {
                status: 'success',
                node: found.node,
                path: found.path.map(n => ({ id: n.id, name: n.name, level: n.level }))
              });
            }
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    // 模型工具：考点树
    ctx.tools.register({
      name: 'geo_taxonomy',
      description: '获取高中地理三级考点树（领域→主题→知识单元），每个节点含 id、name、level、definition。用于定位考点、查询考点结构与编号（如 KU-HUM-POP-001）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute() {
        return { status: 'success', roots: await kernel.getTaxonomyTree() };
      }
    });

    console.log('geo-taxonomy: /geo/taxonomy 路由与 geo_taxonomy 工具已注册');
  }
};
