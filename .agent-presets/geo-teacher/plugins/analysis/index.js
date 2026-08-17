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

// ========== 讲题工具专用 render：紧凑 Markdown 摘要（替代 JSON dump，降低上下文体积） ==========
function renderSolve(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  const p = d.problem || {};
  lines.push(`# 题目 ${d.questionId || ''}`);
  lines.push(`- 题组：${(p.group && p.group.label) || p.file || ''}`);
  lines.push('');
  lines.push('## 材料');
  lines.push((p.material || '(无文字材料)').slice(0, 4000));
  lines.push('');
  lines.push('## 小问');
  for (const q of p.questions || []) {
    lines.push(`### ${q.questionId}`);
    lines.push((q.stem || '').slice(0, 1500));
    for (const o of q.options || []) lines.push(`- ${o}`);
  }
  const s = d.scaffold || {};
  if (s.questionFramework) lines.push(`\n## 审题骨架\n- 设问类型：${s.questionFramework.name}（${s.questionFramework.hint}）`);
  if (Array.isArray(s.focusElements) && s.focusElements.length) lines.push(`- 焦点要素：${s.focusElements.join('、')}`);
  if (s.dimensionScan && typeof s.dimensionScan === 'object') {
    const keys = Object.keys(s.dimensionScan);
    if (keys.length) {
      lines.push('- 维度扫描（材料证据）：');
      for (const k of keys) {
        const dim = s.dimensionScan[k];
        lines.push(`  - ${dim.name}：${(dim.evidence || []).join('、')}`);
      }
    }
  }
  const v = d.vision;
  if (v && v.status === 'success') {
    lines.push('\n## 图像转录（给定事实，非结论）');
    if (v.usable && v.markdown) lines.push(v.markdown.slice(0, 6000));
    else lines.push('（该题涉图，但图像转录失败：' + ((v.degraded || []).map(x => x.imageId + ':' + x.error).join('；') || '未知原因') + ' —— 按图注处理，不虚构图信息）');
  }
  lines.push('\n> 以上不含答案/解析。独立完成 审题→证据→知识→推理链→作答。');
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderJudge(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  lines.push(`# 核验材料 ${d.questionId || ''}`);
  if (d.independent) { lines.push('\n## 你的独立答案'); lines.push(d.independent); }
  const sc = d.standard || {};
  lines.push('\n## 标准答案'); lines.push(sc.standardAnswer || '(无)');
  lines.push('\n## 解析（仅核验用，不得在 solve 阶段提前读取）'); lines.push((sc.analysis || '(无)').slice(0, 4000));
  lines.push('\n## 倒推采分点');
  for (const pt of sc.scorePoints || []) {
    if (pt.type === 'choice') lines.push(`- [选择题] 正确项 ${pt.option || ''}：${pt.answer || ''}（考点：${pt.knowledgeUnit || '—'}，权重 ${pt.weight || '—'}）`);
    else lines.push(`- ${pt.point || ''}（维度：${(pt.dimension || []).join('、') || '—'}）`);
  }
  if ((sc.coverageGrid || []).length) {
    lines.push('\n## 覆盖网格（逐点核验：hit=完全命中/部分/遗漏）');
    for (const g of sc.coverageGrid) lines.push(`- ${g.match || ''} → hit=… note=…`);
  }
  lines.push('\n> 逐点核验后输出：得分点覆盖（对/漏/部分）、推理错误、干扰项解释质量、遗漏分析。');
  return [{ type: 'text', text: lines.join('\n') }];
}

function renderExplain(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  const r = d.report || {};
  lines.push(`# 讲题稿重组骨架 ${d.questionId || ''}`);
  const b = r.basic || {};
  lines.push(`- 题型：${b.type || '—'} · 难度：${b.difficulty || '—'} · 素养：${b.literacy || '—'} · 设问类型：${b.questionType || '—'} · 焦点要素：${(b.focusElements || []).join('、') || '—'} · 涉图：${b.hasImage ? '是' : '否'}`);
  const st = r.structure || {};
  if (st.locate && st.locate.fields) {
    lines.push('\n## 题目定位');
    for (const k of Object.keys(st.locate.fields)) {
      const val = st.locate.fields[k];
      if (val) lines.push(`- ${k}：${val}`);
    }
  }
  if (st.examine) lines.push(`\n## 审题提示\n${st.examine.hint || ''}`);
  if (st.solve) {
    lines.push(`\n## 破题\n${st.solve.choiceNote || ''}`);
    const scan = st.solve.dimensionScan || {};
    const keys = Object.keys(scan);
    if (keys.length) {
      lines.push('维度扫描：');
      for (const k of keys) { const dim = scan[k]; lines.push(`  - ${dim.name}：${(dim.evidence || []).join('、')}`); }
    }
  }
  if (st.reflect) {
    lines.push(`\n## 反思与迁移\n核心考点：${st.reflect.coreKnowledgeUnit || '—'}`);
    if ((d.variants || []).length) {
      lines.push('同考点变式候选：');
      for (const vv of d.variants.slice(0, 5)) lines.push(`  - ${vv.file}：${(vv.stem || '').slice(0, 60)}`);
    } else lines.push('（题库暂无同考点变式）');
  }
  if (r.judgeSummary) lines.push(`\n## 核验摘要\n采分点 ${(r.judgeSummary.scorePoints || []).length} 条 · 覆盖网格 ${(r.judgeSummary.coverageGrid || []).length} 项`);
  lines.push('\n> 教学化重组为「题目定位—审题—破题—反思迁移」四段式讲题稿，不重新解题、不照抄解析。');
  return [{ type: 'text', text: lines.join('\n') }];
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

    // 模型工具：讲题 Solver（P1）——独立解题（讲题流水线第 1 步，唯一解题入口）
    ctx.tools.register({
      name: 'geo_solve',
      description: '讲题流水线第 1 步（Solver）· 独立解题入口：返回题面（材料/题干/选项/小问）+ 审题骨架（设问类型框架/思维模式/焦点要素/维度扫描/图像转录），不含答案、解析或任何解析派生的干扰项错因。模型据此独立完成"审题→证据提取→知识激活→推理链→作答"。铁律：完成作答前不得读取答案/解析；读图由本工具自动带图（vision 字段），无独立读图工具。',
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
        render: renderSolve
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
            if (v && v.status === 'success') {
              const markdown = (v.markdown || '').trim();
              // usable=true 仅当确有转录内容；全部图降级时 markdown 为空，明确标记不可用（不静默）
              vision = { ...v, markdown, usable: markdown.length > 0 && v.visionOk !== false };
            } else if (v && v.status !== 'disabled') {
              vision = { status: 'degraded', questionId: args.qid, error: v.error || v.message || 'vision degraded' };
            }
          }
        } catch (e) { vision = null; }
        return { status: 'success', problem: data, scaffold, vision };
      }
    });

    // 模型工具：讲题 Judge（P2）——开放答案并核验（讲题流水线第 2 步）
    ctx.tools.register({
      name: 'geo_judge',
      description: '讲题流水线第 2 步（Judge）· 核验入口：传入你在 geo_solve 阶段独立完成的答案（independentAnswer），开放标准答案/解析 + 倒推采分点 + 覆盖网格 + 干扰项目标，据此客观核验自己的独立答案：得分点覆盖（对/漏/部分）、推理错误、干扰项解释质量、遗漏分析。必须先完成同题 geo_solve。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' },
          independentAnswer: { type: 'string', description: '你在 geo_solve 阶段独立完成的答案（建议传入，供逐点对照）' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJudge
      },
      async execute(args) {
        const data = await kernel.answerData(args.qid);
        if (data.status !== 'success') return data;
        return { status: 'success', questionId: args.qid, standard: data.scaffold, independent: args.independentAnswer || '' };
      }
    });

    // 模型工具：讲题 Explainer（P3）——重组讲题稿（讲题流水线第 3 步）
    ctx.tools.register({
      name: 'geo_explain',
      description: '讲题流水线第 3 步（Explainer）· 讲题稿重组入口：传入独立答案（independentAnswer）与 judge 核验结果（judgeReport，即 geo_judge 的返回内容 JSON），输出「题目定位—审题—破题—反思迁移」四段式讲题稿重组骨架（含要素维度排查、变式候选、核验摘要）。教学化重组，不重新解题、不直接拿解析推导讲法。必须先完成同题 geo_solve → geo_judge。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' },
          independentAnswer: { type: 'string', description: '你的独立答案（可选）' },
          judgeReport: { type: 'string', description: 'geo_judge 工具返回的完整内容 JSON（可选；提供时骨架内嵌核验摘要）' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderExplain
      },
      async execute(args) {
        let judge = null;
        const raw = args.judgeReport;
        if (raw) {
          try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            judge = { scaffold: (parsed && (parsed.standard || parsed.scaffold)) || null };
          } catch (e) { judge = null; }
        }
        return await kernel.explainerData(args.qid, args.independentAnswer || null, judge);
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
