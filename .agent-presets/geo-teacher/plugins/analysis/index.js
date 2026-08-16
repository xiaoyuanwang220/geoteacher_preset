// GeoTeacher Agent — 真题分析功能插件（geo-analysis）
// 路由：/geo/analysis/run?qid=、/geo/analysis/export?qid=
// 模型工具：geo_analyze、geo_export_analysis
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
  name: 'geo-analysis',
  inject: ['webServer', 'geoKernel', 'tools'],
  apply(ctx) {
    const webServer = ctx.webServer;
    const kernel = ctx.geoKernel;

    webServer.register({
      kind: 'prefix',
      path: '/geo/analysis',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo\/analysis\/?/, '') || 'index';
          switch (action) {
            case 'run':
              return sendJson(res, 200, await kernel.analyzeQuestion(query.qid || ''));
            case 'export':
              return sendJson(res, 200, await kernel.exportAnalysis(query.qid || ''));
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    // 模型工具：真题分析 + 命题蓝图
    ctx.tools.register({
      name: 'geo_analyze',
      description: '对一道真题做“为什么这样考”分析（题型/设问模式/情境类型/素养立意/能力层次/难度/考点映射/干扰项逻辑），并给出“下一道题怎么设计”的命题蓝图（情境换新/设问设计/选项设计）。',
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
        return await kernel.analyzeQuestion(args.qid);
      }
    });

    // 模型工具：讲题 Solver（P1）——独立解题
    ctx.tools.register({
      name: 'geo_solve',
      description: '讲题 Solver：给出一道真题的题面（材料/题干/选项/小问）与审题骨架（设问类型框架/思维模式/焦点要素/维度扫描/干扰项错因提示），不含答案与解析。模型据此独立完成"审题→证据提取→知识激活→推理链→作答"，供后续 judge 核验与 explainer 讲题。',
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
        const data = await kernel.questionData(args.qid);
        if (data.status !== 'success') return data;
        const scaffold = await kernel.solutionScaffold(args.qid);
        // 视觉预处理（若 geoVision 服务可用且启用）：只并入结构化转录，不作推理
        let vision = null;
        try {
          const geoVision = ctx.get('geoVision');
          if (geoVision && geoVision.enabled) {
            const v = await geoVision.extract(args.qid);
            if (v && v.status === 'success') vision = v;
          }
        } catch (e) { vision = null; }
        return { status: 'success', problem: data, scaffold, vision };
      }
    });

    // 模型工具：讲题 Judge（P2）——开放答案并核验
    ctx.tools.register({
      name: 'geo_judge',
      description: '讲题 Judge：在模型完成独立解题后，开放本题的标准答案/解析 + 倒推采分点 + 核验骨架（采分点覆盖网格、干扰项目标清单）。模型据此客观核验自己的独立答案：得分点覆盖（对/漏/部分）、推理错误、干扰项解释质量，产出可复核的偏差分析。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.answerData(args.qid);
      }
    });

    // 模型工具：讲题 Explainer（P3）——重组讲题稿
    ctx.tools.register({
      name: 'geo_explain',
      description: '讲题 Explainer：消费已验证的独立答案 + judge 核验结果 + 同考点变式，输出「题目定位—审题—破题—反思迁移」四段式讲题稿重组骨架（含选择题/综合题分述、要素维度排查、变式候选）。模型据此做教学化重组，不重新解题、不直接拿解析推导讲法。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.explainerData(args.qid, null, null);
      }
    });

    // 模型工具：导出分析报告
    ctx.tools.register({
      name: 'geo_export_analysis',
      description: '把真题分析 + 命题蓝图导出为 Markdown 报告文件（写入 outputs 目录），返回保存路径。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.exportAnalysis(args.qid);
      }
    });

    console.log('geo-analysis: /geo/analysis 路由与 geo_analyze / geo_export_analysis / geo_solve / geo_judge / geo_explain 工具已注册');
  }
};
