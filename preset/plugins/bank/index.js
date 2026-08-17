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
              // 支持结构化参数：region/year/questionNumber/questionType/knowledgeId/keyword
              // 向后兼容旧的 kp/keyword 参数
              const sq = {
                region: query.region || '',
                year: query.year || '',
                questionNumber: query.questionNumber || query.qn || '',
                questionType: query.questionType || '',
                knowledgeId: query.knowledgeId || query.kp || '',
                keyword: query.keyword || ''
              };
              return sendJson(res, 200, await kernel.searchQuestions(sq));
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

    // 模型工具：真题检索（结构化查询 + 全文搜索，按小问拆分返回）
    ctx.tools.register({
      name: 'geo_search_questions',
      description: '检索本地真题库。支持结构化查询（省份/年份/题号/题型）和全文搜索（关键词/考点名称）。返回匹配的小问列表（每道小问独立），含题组标签、题干摘要、知识点。用于回答"某省某年某题有哪些真题""某个考点有哪些真题""某关键词相关的题目"。',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: '省份（如"安徽""广东"）' },
          year: { type: 'string', description: '年份（如"2025"）' },
          questionNumber: { type: 'string', description: '题号（如"17"），匹配 question_numbers 字段' },
          questionType: { type: 'string', description: '题型：single_choice_group（选择题组）或 comprehensive_group（综合题组）' },
          knowledgeId: { type: 'string', description: '考点 ID 或名称（如"KU-HUM-POP-001"或"产业转移"）' },
          keyword: { type: 'string', description: '全文关键词（在材料/题干/选项/知识点名称/省份/年份中匹配）' }
        },
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        // 传整个 args 对象给 kernel（新接口），内部自动归一化
        return { status: 'success', results: await kernel.searchQuestions(args) };
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
