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
            case 'meta': {
              const res = await kernel.getTaxonomy({});
              return sendJson(res, res.status === 'error' ? 503 : 200, {
                status: res.status,
                message: res.message || null,
                meta: res.meta,
                sources: res.sources,
                errors: res.errors
              });
            }
            case 'query': {
              const ids = query.ids ? query.ids.split(',').map((s) => s.trim()).filter(Boolean) : null;
              const res = await kernel.getTaxonomy({
                query: query.q || query.query || '',
                ids,
                limit: query.limit
              });
              return sendJson(res, res.status === 'error' ? 503 : 200, res);
            }
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    // 模型工具：考点树。无参数时兼容旧行为（status + roots）；给定 query/ids 时只返回相关节点 + 版本元数据。
    ctx.tools.register({
      name: 'geo_taxonomy',
      description: '定位与查询高中地理三级考点（领域→主题→知识单元）。给定 query 或 ids 时只返回相关节点（含 definition、includes、excludes、needs_review）与 taxonomy 版本元数据，避免整树输出被截断；不传参数时返回完整树（roots）。用于确认考点编号、知识边界与版本状态。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '考点名称或关键词，如“热力环流”。与节点 name/id 精确一致时 matchKind=exact，否则返回 candidates 候选供判断' },
          ids: { type: 'array', items: { type: 'string' }, description: '按考点 id 精确查询，如 ["KU-NAT-ATM-HEAT-005"]' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回的候选节点数，默认 20' }
        },
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        const a = args || {};
        const hasTarget = (Array.isArray(a.ids) && a.ids.filter(Boolean).length > 0) || String(a.query || '').trim();
        const res = await kernel.getTaxonomy({ query: a.query, ids: a.ids, limit: a.limit });
        if (res.status === 'error') return res;
        if (!hasTarget) {
          // 兼容旧调用：仍返回 status + roots；版本元数据前置，不埋在大树末尾
          return { status: 'success', meta: res.meta, sources: res.sources, errors: res.errors, roots: res.roots };
        }
        return res;
      }
    });

    console.log('geo-taxonomy: /geo/taxonomy 路由与 geo_taxonomy 工具已注册');
  }
};
