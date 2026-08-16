// GeoTeacher Agent — 真题库功能插件（geo-bank）
// 路由：/geo/bank/search?kp=&keyword=、/geo/bank/detail?qid=
// 模型工具：geo_search_questions、geo_question_detail
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

function renderJson(args, value) {
  const text = JSON.stringify(value, null, 2);
  const capped = text.length > 16000 ? text.slice(0, 16000) + '\n...[截断，总长 ' + text.length + ']' : text;
  return [{ type: 'text', text: capped }];
}

export default {
  name: 'geo-bank',
  inject: ['webServer', 'geoKernel', 'tools'],
  apply(ctx) {
    const webServer = ctx.webServer;
    const kernel = ctx.geoKernel;

    webServer.register({
      kind: 'prefix',
      path: '/geo/bank',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo\/bank\/?/, '') || 'index';
          switch (action) {
            case 'search':
              return sendJson(res, 200, await kernel.searchQuestions(query.kp || '', query.keyword || ''));
            case 'detail':
              return sendJson(res, 200, await kernel.getQuestionDetail(query.qid || ''));
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    // 模型工具：真题检索
    ctx.tools.register({
      name: 'geo_search_questions',
      description: '按考点 ID 或关键词检索本地真题库，返回题组索引（年份/省份/题型/题号 + 题目 ID 列表）。用于回答“这个考点有哪些真题”“某省某年考了什么”。',
      parameters: {
        type: 'object',
        properties: {
          kp: { type: 'string', description: '考点 ID（knowledge_unit_id 或 theme_id，如 KU-HUM-POP-001）' },
          keyword: { type: 'string', description: '关键词（在材料/题干中匹配，如“港口”）' }
        },
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return { status: 'success', groups: await kernel.searchQuestions(args.kp || '', args.keyword || '') };
      }
    });

    // 模型工具：题组详情
    ctx.tools.register({
      name: 'geo_question_detail',
      description: '按题目 ID 获取题组详情（共用材料 + 全部小题题干/选项）。题目 ID 可从 geo_search_questions 的结果取得。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID（如 2025-广东-地理-...-Q1）' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.getQuestionDetail(args.qid);
      }
    });

    console.log('geo-bank: /geo/bank 路由与 geo_search_questions / geo_question_detail 工具已注册');
  }
};
