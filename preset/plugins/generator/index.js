// GeoTeacher Agent — 出题支持功能插件（geo-generator）
// 路由：/geo/generator/style?region=&years=
// 模型工具：geo_style_profile
// 消费 geoKernel 服务；为出题技能 geo-question-generator 提供风格档案接口。
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

function renderJson(args, value) {
  const text = JSON.stringify(value, null, 2);
  const capped = text.length > 16000 ? text.slice(0, 16000) + '\n...[截断，总长 ' + text.length + ']' : text;
  return [{ type: 'text', text: capped }];
}

export default {
  name: 'geo-generator',
  inject: ['webServer', 'geoKernel', 'tools'],
  apply(ctx) {
    const webServer = ctx.webServer;
    const kernel = ctx.geoKernel;

    webServer.register({
      kind: 'prefix',
      path: '/geo/generator',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo\/generator\/?/, '') || 'index';
          switch (action) {
            case 'style': {
              const years = query.years ? query.years.split(',').filter(Boolean) : null;
              return sendJson(res, 200, await kernel.styleProfile(query.region || 'all', years));
            }
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    // 模型工具：风格档案（供出题技能锚定风格）
    ctx.tools.register({
      name: 'geo_style_profile',
      description: '从本地真题库现场抽取七维度风格档案（题组结构/材料特征/图表特征/设问特征/选项特征/解析特征/综合题特征），用于按“各省融合”或“某省卷”风格出题时锚定写法。',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: '省份（如“广东”）；留空或 all = 各省融合' },
          years: { type: 'array', items: { type: 'string' }, description: '年份列表，如 ["2025"]' }
        },
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.styleProfile(args.region || 'all', args.years && args.years.length ? args.years : null);
      }
    });

    console.log('geo-generator: /geo/generator 路由与 geo_style_profile 工具已注册');
  }
};
