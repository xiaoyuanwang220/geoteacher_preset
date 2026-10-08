// 讲题三对象（audience）行为测试。
// 覆盖：参数缺省/合法/非法、参数从工具到核心到渲染不丢失、三对象骨架差异、
// 综合题选项层不适用、缓存键随题目与对象变化、缺前置产物时不宣称已核验。
// 只断言结构与行为关系，不把提示词字符串当作唯一证据。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPLAIN_AUDIENCES,
  normalizeAudience,
  buildVerification,
  renderExplain,
  renderJudge,
  toJudgeReportJson
} from '../.agent-presets/geo-teacher/plugins/analysis/index.js';
import { buildExplainerReport, EXPLAIN_RULESET_VERSION } from '../.agent-presets/geo-teacher/plugins/core/index.js';

const QUESTION = {
  questionId: '2024-广东-地理-0009-Q1',
  file: '2024广东卷.md',
  material: '甲、乙两地均为高纬沿海峡湾。甲地峡湾几乎常被海冰或冰川覆盖，发育极地气候峡湾；乙地峡湾全年几乎没有海冰，发育温带气候峡湾。',
  stem: '乙地发育温带气候峡湾的主要原因是（　）',
  options: ['A 冬季白昼时长更长', 'B 受到暖流增温影响', 'C 经历更强构造运动', 'D 海平面上升幅度更大'],
  answer: 'B',
  analysis: '乙地受北大西洋暖流增温影响，海水温度偏高，全年几乎无海冰。',
  knowledgePoints: [{ role: 'core_exam_point', knowledge_unit: '洋流对地理环境的影响', weight: '1.0' }],
  meta: { year: 2024, region: '广东', question_numbers: '9' }
};

const COMPREHENSIVE = {
  ...QUESTION,
  options: [],
  stem: '分析乙地峡湾水温高于同纬度海区的原因。',
  knowledgePoints: [
    { role: 'core_exam_point', knowledge_unit: '洋流对地理环境的影响', weight: '1.0' },
    { role: 'supporting_knowledge', knowledge_unit: '海水的性质', weight: '0.5' }
  ]
};

test('audience 缺省按学生对象执行（旧调用兼容）', () => {
  for (const value of [undefined, null, '', '   ']) {
    const r = normalizeAudience(value);
    assert.equal(r.ok, true, String(value));
    assert.equal(r.audience, 'student');
    assert.equal(r.explicit, false);
  }
});

test('audience 三种合法值被接受并标记为显式传入', () => {
  for (const value of EXPLAIN_AUDIENCES) {
    const r = normalizeAudience(value);
    assert.equal(r.ok, true, value);
    assert.equal(r.audience, value);
    assert.equal(r.explicit, true);
  }
});

test('非法 audience 返回输入错误，不静默回退', () => {
  for (const value of ['Student', 'students', 'teacher2', '命题人', 'admin', 0]) {
    const r = normalizeAudience(value);
    assert.equal(r.ok, false, String(value));
    assert.equal(r.audience, null);
    assert.match(r.message, /非法输入/);
    assert.match(r.message, /student \| teacher \| setter/);
  }
});

test('核验状态：缺前置产物时不宣称已核验', () => {
  const nothing = buildVerification({ qid: 'Q1' }, null);
  assert.equal(nothing.status, 'missing_solve_and_judge');
  assert.equal(nothing.verified, false);
  assert.equal(nothing.evidence, 'self_reported_material');

  const noJudge = buildVerification({ qid: 'Q1', independentAnswer: 'B' }, null);
  assert.equal(noJudge.status, 'missing_judge_report');
  assert.equal(noJudge.verified, false);

  const broken = buildVerification({ qid: 'Q1', independentAnswer: 'B', judgeReport: '不是 JSON' }, null);
  assert.equal(broken.status, 'judge_report_invalid');
  assert.equal(broken.verified, false);

  const crossQuestion = buildVerification(
    { qid: 'Q1', independentAnswer: 'B', judgeReport: '{"standard":{}}' },
    { questionId: 'Q9', scaffold: {} }
  );
  assert.equal(crossQuestion.status, 'judge_qid_mismatch');
  assert.equal(crossQuestion.verified, false);

  const provided = buildVerification(
    { qid: 'Q1', independentAnswer: 'B', judgeReport: '{"standard":{}}' },
    { questionId: 'Q1', scaffold: {} }
  );
  assert.equal(provided.status, 'material_provided_pending_review');
  assert.equal(provided.verified, false);
  assert.match(provided.message, /不得表述为「已核验」/);
});

test('学生与教师对象保留四段式，命题人对象改用自己的设计评价结构', () => {
  const student = buildExplainerReport(QUESTION, true, null, [], undefined);
  assert.equal(student.audience, 'student');
  assert.equal(student.schemaVersion, EXPLAIN_RULESET_VERSION);
  for (const key of ['locate', 'examine', 'solve', 'reflect']) {
    assert.ok(student.structure[key], `学生对象缺少 ${key}`);
  }
  assert.equal(student.structure.solve.title, '破题');

  const teacher = buildExplainerReport(QUESTION, true, null, [], 'teacher');
  assert.equal(teacher.audience, 'teacher');
  for (const key of ['locate', 'examine', 'solve', 'reflect']) {
    assert.ok(teacher.structure[key], `教师对象缺少 ${key}`);
  }
  assert.equal(teacher.audiencePlan.nodeTemplate.length, 6);

  const setter = buildExplainerReport(QUESTION, true, null, [], 'setter');
  assert.equal(setter.audience, 'setter');
  assert.equal(setter.structure.sections.length, 7);
  assert.deepEqual(
    setter.structure.sections.map(s => s.key),
    ['examTarget', 'context', 'interference', 'cognitionPath', 'answerConditions', 'transferDesign', 'qualityReview']
  );
  assert.equal(setter.structure.locate, undefined, '命题人对象不应套用四段式');
  assert.equal(setter.audiencePlan.interferenceLayers.length, 3);
  assert.deepEqual(setter.audiencePlan.interferenceLayers.map(l => l.layer), ['设问', '材料（含图表）', '选项']);
});

test('对象决定正文取舍：语言指导与计划随对象变化，不是同一份稿换称呼', () => {
  const student = buildExplainerReport(QUESTION, true, null, [], 'student');
  const teacher = buildExplainerReport(QUESTION, true, null, [], 'teacher');
  const setter = buildExplainerReport(QUESTION, true, null, [], 'setter');

  assert.notEqual(student.languageGuide.voice, teacher.languageGuide.voice);
  assert.notEqual(teacher.languageGuide.voice, setter.languageGuide.voice);
  assert.notEqual(student.audienceDeliverable, teacher.audienceDeliverable);
  assert.notEqual(student.structure.locate.audienceEmphasis, teacher.structure.locate.audienceEmphasis);
  assert.ok(student.structure.locate.audienceEmphasis.includes('要解决什么问题'));
  assert.ok(teacher.structure.locate.audienceEmphasis.includes('教学价值'));
  assert.ok(teacher.audiencePlan.guidance.some(item => item.includes('待验证障碍')));
  assert.ok(teacher.audiencePlan.scaffoldRemoval && 'signal' in teacher.audiencePlan.scaffoldRemoval);
  assert.ok(setter.audiencePlan.constraints.some(item => item.includes('依据题面推断')));
  assert.ok(setter.audiencePlan.constraints.some(item => item.includes('不生成正确率')));
});

test('综合题把选项层标为不适用，且不虚构选项', () => {
  const setter = buildExplainerReport(COMPREHENSIVE, false, null, [], 'setter');
  const optionLayer = setter.audiencePlan.interferenceLayers[2];
  assert.equal(optionLayer.applicable, false);
  assert.match(optionLayer.note, /不得虚构选项/);
  assert.equal(setter.basic.type, '综合题');
  assert.match(setter.languageGuide.answerPresentation, /答案成立条件与错误路径/);
});

test('非法 audience 传入骨架时按学生对象兜底，不抛错', () => {
  const r = buildExplainerReport(QUESTION, true, null, [], 'bogus');
  assert.equal(r.audience, 'student');
  assert.ok(r.structure.locate);
});

test('跨学科状态由讲题阶段判定，工具只给 pending，不做关键词关联', () => {
  for (const audience of EXPLAIN_AUDIENCES) {
    const r = buildExplainerReport(QUESTION, true, null, [], audience);
    assert.equal(r.interdisciplinary.status, 'pending');
    assert.deepEqual(r.interdisciplinary.allowedStatus, ['applicable', 'not_applicable', 'pending']);
    assert.deepEqual(r.interdisciplinary.chain, ['地理解释需要', '学科工具', '情境对应', '解释贡献', '适用限制']);
  }
});

test('缓存键区分题目指纹、讲解对象与讲稿规则版本', () => {
  const student = buildExplainerReport(QUESTION, true, null, [], 'student');
  const teacher = buildExplainerReport(QUESTION, true, null, [], 'teacher');
  assert.notEqual(student.cacheKey, teacher.cacheKey);
  assert.ok(student.cacheKey.includes('#student#rules'));
  assert.ok(student.cacheKey.includes(`#rules${EXPLAIN_RULESET_VERSION}`));

  const revised = buildExplainerReport({ ...QUESTION, stem: QUESTION.stem + '（改）' }, true, null, [], 'student');
  assert.notEqual(student.cacheKey, revised.cacheKey, '题面变化必须换缓存键');
});

test('参数从核心到渲染不丢失：渲染层显示对象与核验状态', () => {
  const setterValue = {
    status: 'success',
    questionId: QUESTION.questionId,
    audience: 'setter',
    report: buildExplainerReport(QUESTION, true, null, [], 'setter'),
    variants: [],
    verification: buildVerification({ qid: QUESTION.questionId }, null)
  };
  const setterText = renderExplain({ qid: QUESTION.questionId }, setterValue)[0].text;
  assert.match(setterText, /讲解对象：命题人（setter）/);
  assert.match(setterText, /三层干扰辨析/);
  assert.match(setterText, /核验状态/);
  assert.match(setterText, /missing_solve_and_judge/);
  assert.doesNotMatch(setterText, /题目定位/);

  const studentValue = {
    status: 'success',
    questionId: QUESTION.questionId,
    audience: 'student',
    report: buildExplainerReport(QUESTION, true, null, [], 'student'),
    variants: [],
    verification: buildVerification(
      { qid: QUESTION.questionId, independentAnswer: 'B', judgeReport: '{"standard":{}}' },
      { questionId: QUESTION.questionId, scaffold: {} }
    )
  };
  const studentText = renderExplain({ qid: QUESTION.questionId }, studentValue)[0].text;
  assert.match(studentText, /讲解对象：学生（student）/);
  assert.match(studentText, /题目定位/);
  assert.match(studentText, /反思与迁移/);
  assert.match(studentText, /提供材料待核验/);
});

test('渲染层对非成功结果回退为 JSON，不假装成功', () => {
  const text = renderExplain({ qid: 'Q1' }, { status: 'error', code: 'INVALID_AUDIENCE', message: '非法输入' })[0].text;
  assert.match(text, /INVALID_AUDIENCE/);
  assert.doesNotMatch(text, /讲题稿重组骨架/);
});

// ========== 工具边界回归（geo_explain.execute 的返回值必须是无损 JSON）==========
// 背景：judgeReport 的 scaffold 缺 scorePoints/coverageGrid 时，buildExplainerReport 旧实现
// 产出 {scorePoints: undefined, coverageGrid: undefined}；JSON 往返会丢掉这两个键，DSH
// 工具边界判为 "value is not lossless JSON"，整个 geo_explain 调用失败——而核验材料本身
// 是合法的。上面各例都直接调用 buildExplainerReport / renderExplain，绕过了 execute() 与
// 边界检查，所以没能发现该缺陷；这组用例专门补上这一层。

function assertLossless(value, path = 'result', seen = new Set()) {
  if (value === undefined) throw new Error(`${path} 是 undefined`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} 不是有限数字`);
  if (typeof value === 'function') throw new Error(`${path} 是函数`);
  if (typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${path} 是 ${typeof value}`);
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} 存在循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLossless(item, `${path}[${i}]`, seen));
    return;
  }
  for (const key of Object.keys(value)) assertLossless(value[key], `${path}.${key}`, seen);
  const roundTrip = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTrip, value, `${path} 不能无损通过 JSON 往返`);
}

// 用与 geo-verify 相同形状的 mock ctx 触发插件 apply，取回真实注册的工具定义。
async function loadExplainTool() {
  const registered = new Map();
  const ctx = {
    fs: {
      resolve: async (p) => ({ path: p }),
      readText: async () => '',
      writeText: async () => {},
      readBytes: async () => { throw new Error('mock'); },
      listDir: async () => [],
      stat: async () => ({ isDirectory: () => false }),
      processPath: (t) => (t && t.path) || String(t)
    },
    attachments: { imageLimits: {}, saveImage: async () => ({}) },
    tools: { register(def) { registered.set(def.name, def); return () => {}; } },
    webServer: { register() {}, registerUpgrade() {}, registerFallback() {}, tapIndex() { return () => {}; } },
    geoKernel: {
      explainerData: async (qid, independentAnswer, judge, audience) => ({
        status: 'success',
        questionId: qid,
        audience,
        report: buildExplainerReport(QUESTION, true, judge ? judge.scaffold : null, [], audience),
        variants: []
      })
    },
    get() { return undefined; },
    provide() {},
    on() { return () => {}; },
    effect(cb) { try { return cb(); } catch {} }
  };
  const mod = await import('../.agent-presets/geo-teacher/plugins/analysis/index.js');
  mod.default.apply(ctx, {});
  return registered.get('geo_explain');
}

test('工具边界回归：scaffold 缺 scorePoints/coverageGrid 时结果仍是无损 JSON', async () => {
  const tool = await loadExplainTool();
  const scaffolds = [{}, { answer: 'B' }, { scorePoints: [{ point: '正确项 B' }] }, { coverageGrid: [{ item: '正确项=B' }] }];
  for (const scaffold of scaffolds) {
    const judgeReport = JSON.stringify({ questionId: QUESTION.questionId, standard: scaffold });
    const result = await tool.execute({ qid: QUESTION.questionId, independentAnswer: 'B', judgeReport });
    assert.doesNotThrow(() => assertLossless(result), `scaffold=${JSON.stringify(scaffold)}`);
    assert.equal(result.verification.status, 'material_provided_pending_review');
    assert.equal(result.verification.verified, false, '材料齐备也不得宣称已核验');
    assert.deepEqual(result.report.judgeSummary.scorePoints, Array.isArray(scaffold.scorePoints) ? scaffold.scorePoints : []);
    assert.deepEqual(result.report.judgeSummary.coverageGrid, Array.isArray(scaffold.coverageGrid) ? scaffold.coverageGrid : []);
  }
});

test('工具边界回归：缺材料、非法 audience、Markdown 误传的结果都是无损 JSON', async () => {
  const tool = await loadExplainTool();

  const noJudge = await tool.execute({ qid: QUESTION.questionId });
  assert.doesNotThrow(() => assertLossless(noJudge));
  assert.equal(noJudge.verification.status, 'missing_solve_and_judge');
  assert.equal(noJudge.report.judgeSummary, null);

  const badAudience = await tool.execute({ qid: QUESTION.questionId, audience: 'nope' });
  assert.doesNotThrow(() => assertLossless(badAudience));
  assert.equal(badAudience.code, 'INVALID_AUDIENCE');

  // geo_judge 给模型看的是 Markdown 渲染；若原样回传，按契约应如实标为待核验而非崩溃。
  const markdown = await tool.execute({ qid: QUESTION.questionId, judgeReport: '# 核验材料\n## 标准答案\nB' });
  assert.doesNotThrow(() => assertLossless(markdown));
  assert.equal(markdown.verification.status, 'judge_report_invalid');
  assert.equal(markdown.verification.verified, false);
});

test('工具边界回归：三个对象与跨题材料的结果都是无损 JSON', async () => {
  const tool = await loadExplainTool();
  const judgeReport = JSON.stringify({ questionId: QUESTION.questionId, standard: { answer: 'B', scorePoints: [], coverageGrid: [] } });
  for (const audience of EXPLAIN_AUDIENCES) {
    const result = await tool.execute({ qid: QUESTION.questionId, independentAnswer: 'B', judgeReport, audience });
    assert.doesNotThrow(() => assertLossless(result), `audience=${audience}`);
    assert.equal(result.audience, audience);
    assert.equal(result.verification.status, 'material_provided_pending_review');
  }
  const crossQuestion = await tool.execute({
    qid: QUESTION.questionId,
    independentAnswer: 'B',
    judgeReport: JSON.stringify({ questionId: '其他题-Q1', standard: {} })
  });
  assert.doesNotThrow(() => assertLossless(crossQuestion));
  assert.equal(crossQuestion.verification.status, 'judge_qid_mismatch');
});

// ========== 核验材料交接：geo_judge 渲染附机器可读 JSON ==========
// geo_judge 的渲染是 Markdown，而 geo_explain 的 judgeReport 只接受 JSON；模型转写时
// 缺字段就会撞上无损 JSON 边界。renderJudge 现附一段可原样回传的 JSON 代码块。

const JUDGE_RESULT = {
  status: 'success',
  questionId: QUESTION.questionId,
  independent: 'B',
  standard: {
    standardAnswer: 'B',
    analysis: '乙地受北大西洋暖流增温影响，海水温度偏高，全年几乎无海冰。',
    scorePoints: [{ type: 'choice', option: 'B', answer: 'B', knowledgeUnit: '洋流对地理环境的影响', weight: '1.0' }],
    coverageGrid: [{ match: '正确项=B' }]
  }
};

test('geo_judge 渲染附机器可读 JSON，原样回传 geo_explain 即得「提供材料待核验」', async () => {
  const text = renderJudge({ qid: QUESTION.questionId }, JUDGE_RESULT)[0].text;
  assert.match(text, /机器可读核验材料/);

  const block = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, '渲染中缺少机器可读 JSON 代码块');
  const judgeReport = block[1];
  const parsed = JSON.parse(judgeReport);
  assert.equal(parsed.questionId, QUESTION.questionId);
  assert.equal(parsed.standard.standardAnswer, 'B');
  assert.equal(parsed.standard.scorePoints.length, 1);
  assert.equal(parsed.standard.coverageGrid.length, 1);
  assert.doesNotMatch(judgeReport, /undefined|NaN/, '机器可读 JSON 不得含失真标记');

  const tool = await loadExplainTool();
  const result = await tool.execute({ qid: QUESTION.questionId, independentAnswer: 'B', judgeReport });
  assert.doesNotThrow(() => assertLossless(result));
  assert.equal(result.verification.status, 'material_provided_pending_review');
  assert.equal(result.verification.verified, false, '材料齐备也不得宣称已核验');
  assert.equal(result.report.judgeSummary.scorePoints.length, 1);
  assert.equal(result.report.judgeSummary.coverageGrid.length, 1);

  const studentText = renderExplain({ qid: QUESTION.questionId }, result)[0].text;
  assert.match(studentText, /material_provided_pending_review/);
  assert.match(studentText, /提供材料待核验/);
});

test('toJudgeReportJson 在 scaffold 缺失或含 undefined 时仍产出合法 JSON', () => {
  const cases = [undefined, null, {}, { scorePoints: undefined }, { scorePoints: [], coverageGrid: undefined, standardAnswer: 'B' }];
  for (const standard of cases) {
    const json = toJudgeReportJson({ questionId: 'Q1', standard });
    const parsed = JSON.parse(json);
    assert.equal(parsed.questionId, 'Q1');
    assert.doesNotMatch(json, /undefined|NaN/);
    assert.ok(parsed.standard === null || typeof parsed.standard === 'object');
    if (parsed.standard && 'scorePoints' in parsed.standard) {
      assert.ok(Array.isArray(parsed.standard.scorePoints));
    }
  }
  const empty = JSON.parse(toJudgeReportJson({}));
  assert.equal(empty.standard, null);
  assert.equal(empty.questionId, '');
});

// ========== 学生对象「设问先行六步」：段内骨架与渲染落位 ==========
// 依据 docs/讲题学生版结构方案.md §六 第 6 项：六步是外层四段式内部的推进序列，
// 不是新的顶层目录。期望值以 audiencePlan 的结构为准，渲染文本只用来证明六步真的
// 落成了段内列表项（结构→行为的对应关系），而不是把提示词字符串当作唯一证据。

test('学生 audiencePlan 给出设问先行六步骨架，首末步与三个待填字段保留', () => {
  const student = buildExplainerReport(QUESTION, true, null, [], 'student');
  const plan = student.audiencePlan;

  // flow：六步动作序列，顺序即教学顺序
  assert.equal(plan.flow.length, 6);
  assert.deepEqual(plan.flow, ['设问先行', '定向读材料', '知识选择', '推理链', '作答与检查', '方法提炼']);
  for (const [i, name] of plan.flow.entries()) {
    assert.equal(typeof name, 'string', `flow[${i}] 应为字符串`);
    assert.ok(name.trim().length > 0, `flow[${i}] 不应为空`);
  }

  // stepPlacement：六步落进外层四段的位置
  assert.deepEqual(plan.stepPlacement, { examine: '①', solve: '②③④⑤', reflect: '⑥', note: '外层仍为四段式' });

  // stepTemplate：与 flow 同步的六步模板，每步都有动作与思维锚点
  assert.equal(plan.stepTemplate.length, plan.flow.length, '六步模板应与 flow 一一对应');
  for (const [i, step] of plan.stepTemplate.entries()) {
    for (const key of ['step', 'action', 'anchor']) {
      assert.equal(typeof step[key], 'string', `stepTemplate[${i}].${key} 应为字符串`);
      assert.ok(step[key].trim().length > 0, `stepTemplate[${i}].${key} 不应为空`);
    }
  }
  assert.ok(plan.stepTemplate[0].step.includes('拆设问'), '首步应是设问先行');
  assert.match(plan.stepTemplate[0].step, /①/);
  assert.ok(plan.stepTemplate[5].step.includes('方法提炼'), '末步应是方法提炼');
  assert.match(plan.stepTemplate[5].step, /⑥/);

  // 六步是段内序列：三个由讲题阶段填写的字段与 guidance 保持原样
  assert.equal(plan.entryQuestion, '');
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.methodBoundary, '');
  assert.equal(plan.guidance.length, 4);
});

test('学生渲染把六步落在段内列表项、未成为顶层标题；教师分支不变', () => {
  const report = buildExplainerReport(QUESTION, true, null, [], 'student');
  const plan = report.audiencePlan;
  const studentValue = {
    status: 'success',
    questionId: QUESTION.questionId,
    audience: 'student',
    report,
    variants: [],
    verification: buildVerification({ qid: QUESTION.questionId }, null)
  };
  const text = renderExplain({ qid: QUESTION.questionId }, studentValue)[0].text;

  // 正向：六步流程与落位按契约文本出现在段内
  assert.match(text, /段内教学流程：设问先行 → 定向读材料 → 知识选择 → 推理链 → 作答与检查 → 方法提炼/);
  assert.ok(
    text.includes(`落位：审题＝${plan.stepPlacement.examine}；破题＝${plan.stepPlacement.solve}；反思与迁移＝${plan.stepPlacement.reflect}（${plan.stepPlacement.note}）`),
    '渲染缺少六步在外层四段中的落位'
  );

  // 正向：六步与思维锚点逐条出现（期望值取自 audiencePlan，渲染不得自成一套）
  for (const step of plan.stepTemplate) {
    assert.ok(text.includes(`${step.step}：${step.action}`), `渲染缺少步骤：${step.step}`);
    assert.ok(text.includes(`思维锚点（讲给学生听）：${step.anchor}`), `渲染缺少思维锚点：${step.step}`);
  }
  assert.match(text, /① 拆设问（先行）/);
  assert.match(text, /⑥ 方法提炼/);

  // 反向：六步只作段内列表项，不得升格为顶层标题
  assert.doesNotMatch(text, /^##\s*[①②③④⑤⑥]/m);

  // 顶层四段仍在（六步嵌在段内，不替换四段式）
  for (const title of ['题目定位', '审题提示', '破题', '反思与迁移']) {
    assert.match(text, new RegExp(`^## ${title}$`, 'm'), `顶层四段缺少 ${title}`);
  }

  // 教师分支对照：无六步模板，渲染里也不出现学生的段内流程与思维锚点
  const teacher = buildExplainerReport(QUESTION, true, null, [], 'teacher');
  assert.ok(!('stepTemplate' in teacher.audiencePlan), '教师对象不应有六步模板');
  const teacherText = renderExplain({ qid: QUESTION.questionId }, {
    ...studentValue,
    audience: 'teacher',
    report: teacher
  })[0].text;
  assert.doesNotMatch(teacherText, /段内教学流程/);
  assert.doesNotMatch(teacherText, /思维锚点（讲给学生听）/);
  assert.match(teacherText, /^## 题目定位$/m);
});
