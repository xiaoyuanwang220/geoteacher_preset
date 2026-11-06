// 讲题三对象（audience）行为测试。
// 覆盖：参数缺省/合法/非法、参数从工具到内核到渲染不丢失、三对象骨架差异、
// 讲稿规则 3 的新骨架（四项内容要求 / knowledgeRole / comparison / transfer）、
// 综合题选项层不适用、缓存键随题面/对象/规则版本变化、同类题比较的依据与缺口、
// 核验状态必须来自服务端记录（server_run_record），以及工具边界的无损 JSON。
// 只断言结构与行为关系，不把提示词字符串当作唯一证据。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPLAIN_AUDIENCES,
  normalizeAudience,
  renderExplain
} from '../.agent-presets/geo-teacher/plugins/analysis/index.js';
import {
  buildExplainerReport,
  EXPLAIN_CONTENT_REQUIREMENTS,
  EXPLAIN_RULESET_VERSION
} from '../.agent-presets/geo-teacher/plugins/core/index.js';

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

const COMPARISON_WITH_BASIS = {
  basis: [{
    questionId: '2023-广东-地理-0012-Q1',
    file: '2023广东卷.md',
    groupLabel: '2023广东卷 第12题',
    stem: '分析甲地水温低于同纬度海区的原因。',
    questionType: '原因分析',
    sharedTask: '设问任务相同（原因分析）',
    sharedReasoning: '材料证据维度相近（气候、水源）',
    sharedMaterial: '情境类型相同（区域案例）',
    differences: '设问对象相反（水温偏低 vs 偏高），推理方向需反向'
  }],
  insufficient: false,
  gap: ''
};

const COMPARISON_INSUFFICIENT = {
  basis: [],
  insufficient: true,
  gap: '题库中与该题设问任务/推理关系相近的题目不足 2 道（已检索到 0 道）；只能依据本题与已列题目比较，不凭单题经验编造通用套路'
};

function verifiedValue(report, audience = 'student', comparison = COMPARISON_INSUFFICIENT) {
  return {
    status: 'success',
    questionId: QUESTION.questionId,
    audience,
    report,
    variants: [],
    comparison,
    verification: {
      status: 'verified',
      verified: true,
      evidence: 'server_run_record',
      runId: `${QUESTION.questionId}__fp_mock`,
      submittedAt: '2026-11-06T05:00:00.000Z',
      judgeOpenedAt: '2026-11-06T05:01:00.000Z',
      verifiedAt: '2026-11-06T05:02:00.000Z',
      conclusion: { verdict: 'partially_consistent', matched: ['暖流增温'], missed: ['海冰覆盖'], wrong: [], disputed: [], correction: '补充海冰覆盖这一判断线索' },
      message: '核验状态来自服务端运行记录：答案在作答提交后开放，核验结论已归档。该记录不证明内容正确。'
    }
  };
}

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

// ========== 骨架结构：三对象差异 ==========
test('学生与教师对象保留四段式，命题人对象改用自己的设计评价结构', () => {
  const student = buildExplainerReport(QUESTION, true, [], 'student');
  assert.equal(student.audience, 'student');
  assert.equal(student.schemaVersion, EXPLAIN_RULESET_VERSION);
  assert.equal(student.schemaVersion, 3, '讲稿规则版本应为 3');
  for (const key of ['locate', 'examine', 'solve', 'reflect']) {
    assert.ok(student.structure[key], `学生对象缺少 ${key}`);
  }
  assert.equal(student.structure.solve.title, '破题');
  assert.equal(student.structure.locate.title, '题目定位');
  assert.equal(student.structure.reflect.title, '反思与迁移');

  const teacher = buildExplainerReport(QUESTION, true, [], 'teacher');
  assert.equal(teacher.audience, 'teacher');
  for (const key of ['locate', 'examine', 'solve', 'reflect']) {
    assert.ok(teacher.structure[key], `教师对象缺少 ${key}`);
  }
  assert.equal(teacher.audiencePlan.nodeTemplate.length, 6);

  const setter = buildExplainerReport(QUESTION, true, [], 'setter');
  assert.equal(setter.audience, 'setter');
  assert.equal(setter.structure.sections.length, 7);
  assert.deepEqual(
    setter.structure.sections.map(s => s.key),
    ['examTarget', 'context', 'interference', 'cognitionPath', 'answerConditions', 'transferDesign', 'qualityReview']
  );
  assert.equal(setter.structure.locate, undefined, '命题人对象不应套用四段式');
  assert.deepEqual(setter.contentRequirements, [], '命题人对象不套用学生/教师四项内容要求');
});

test('讲稿规则 3 新骨架：四项内容要求、knowledgeRole、comparison、transfer、references 指向', () => {
  for (const audience of ['student', 'teacher']) {
    const report = buildExplainerReport(QUESTION, true, [], audience, COMPARISON_WITH_BASIS);

    // 四项内容要求：与计划 §四 表格逐项对应，顺序固定。
    assert.equal(report.contentRequirements.length, 4, `${audience} 应有四项内容要求`);
    assert.deepEqual(
      report.contentRequirements.map(item => item.item),
      ['考查知识', '解题过程', '同类问题', '迁移运用'],
      `${audience} 内容要求项与顺序应固定`
    );
    assert.deepEqual(report.contentRequirements, EXPLAIN_CONTENT_REQUIREMENTS[audience], '内核不得自成一套内容要求');
    for (const item of report.contentRequirements) assert.ok(item.focus.trim().length > 0, `${audience}「${item.item}」缺一句话侧重`);

    // locate.knowledgeRole：核心考点 / 支撑知识 / 待填 roleInSolving。
    const knowledgeRole = report.structure.locate.knowledgeRole;
    assert.ok(knowledgeRole, `${audience} 缺少 locate.knowledgeRole`);
    assert.equal(knowledgeRole.examPoint, '洋流对地理环境的影响');
    assert.equal(knowledgeRole.supporting.length, 0, '本题只有核心考点，无支撑知识');
    assert.equal(knowledgeRole.roleInSolving, '', 'roleInSolving 是待讲题阶段填写的字段');
    assert.match(knowledgeRole.note, /知识/);

    // solve.comparison：题库检索依据 + 引用规则 + 缺口口径。
    const comparison = report.structure.solve.comparison;
    assert.ok(comparison, `${audience} 缺少 solve.comparison`);
    assert.equal(comparison.basis.length, 1);
    assert.equal(comparison.basis[0].questionId, COMPARISON_WITH_BASIS.basis[0].questionId);
    assert.equal(comparison.basis[0].sharedTask, COMPARISON_WITH_BASIS.basis[0].sharedTask);
    assert.equal(comparison.basis[0].differences, COMPARISON_WITH_BASIS.basis[0].differences);
    assert.equal(comparison.insufficient, false);
    assert.equal(comparison.gap, '');
    assert.match(comparison.citationRule, /列出所依据的题目/);
    assert.match(comparison.citationRule, /缺口/);
    assert.match(comparison.focus, /学生|教师/);

    // reflect.transfer：学生看方法沿用，教师看独立尝试与观察点。
    const transfer = report.structure.reflect.transfer;
    assert.equal(typeof transfer.student, 'string');
    assert.equal(typeof transfer.teacher, 'string');
    assert.ok(transfer.student.length > 0 && transfer.teacher.length > 0);

    // 对象细则唯一来源是 references；内核不再重复 languageGuide/guidance。
    assert.equal(report.languageGuide, undefined, 'languageGuide 已移入 references，不得回到骨架');
    assert.equal(report.judgeSummary, undefined, 'judgeSummary 已随材料待核验路径删除');
    assert.equal(report.audiencePlan.guidance, undefined, 'audiencePlan.guidance 已移入 references');
    assert.match(report.audiencePlan.reference, /explainer-audiences\.md §/);
    assert.equal(report.audiencePlan.reference, audience === 'teacher'
      ? 'skills/references/explainer-audiences.md §5（教师对象组织模板、启发式追问与支架撤除要求）'
      : 'skills/references/explainer-audiences.md §4（学生对象写法、语言文体与六步推进约束）');
  }

  // 学生/教师四项内容要求的侧重必须不同，不是同一份稿换称呼。
  const studentFocus = EXPLAIN_CONTENT_REQUIREMENTS.student.map(item => item.focus).join('|');
  const teacherFocus = EXPLAIN_CONTENT_REQUIREMENTS.teacher.map(item => item.focus).join('|');
  assert.notEqual(studentFocus, teacherFocus);
});

test('对象决定正文取舍：结构侧重与计划随对象变化', () => {
  const student = buildExplainerReport(QUESTION, true, [], 'student');
  const teacher = buildExplainerReport(QUESTION, true, [], 'teacher');
  const setter = buildExplainerReport(QUESTION, true, [], 'setter');

  assert.notEqual(student.audienceDeliverable, teacher.audienceDeliverable);
  assert.notEqual(student.structure.locate.audienceFocus, teacher.structure.locate.audienceFocus);
  assert.ok(student.structure.locate.audienceFocus.includes('要解决什么问题'));
  assert.ok(student.structure.locate.audienceFocus.includes('知识在本题解题中的作用'));
  assert.ok(teacher.structure.locate.audienceFocus.includes('教学价值'));

  // 学生计划：设问先行六步仍在（段内序列）。
  assert.equal(student.audiencePlan.flow.length, 6);
  assert.equal(student.audiencePlan.stepTemplate.length, 6);
  // 教师计划：组织模板 + 支架撤除 + 独立迁移，不套学生六步。
  assert.equal(teacher.audiencePlan.nodeTemplate.length, 6);
  assert.ok(teacher.audiencePlan.scaffoldRemoval && 'signal' in teacher.audiencePlan.scaffoldRemoval);
  assert.ok(teacher.audiencePlan.independentTransfer && 'observe' in teacher.audiencePlan.independentTransfer);
  assert.equal('stepTemplate' in teacher.audiencePlan, false);
  // 命题人计划：三层干扰 + 约束 + references §6。
  assert.ok(setter.audiencePlan.constraints.some(item => item.includes('依据题面推断')));
  assert.ok(setter.audiencePlan.constraints.some(item => item.includes('正确率')));
  assert.match(setter.audiencePlan.reference, /explainer-audiences\.md §6/);
});

test('综合题把选项层标为不适用，且不虚构选项', () => {
  const setter = buildExplainerReport(COMPREHENSIVE, false, [], 'setter');
  const optionLayer = setter.audiencePlan.interferenceLayers[2];
  assert.equal(optionLayer.applicable, false);
  assert.match(optionLayer.note, /不得虚构选项/);
  assert.equal(setter.basic.type, '综合题');
  const interferenceSection = setter.structure.sections.find(section => section.key === 'interference');
  assert.ok(interferenceSection.items.some(item => /选项层/.test(item)));
  assert.ok(interferenceSection.items.some(item => /不得虚构选项/.test(item)));
});

test('非法 audience 传入骨架时按学生对象兜底，不抛错', () => {
  const r = buildExplainerReport(QUESTION, true, [], 'bogus');
  assert.equal(r.audience, 'student');
  assert.ok(r.structure.locate);
});

test('跨学科状态由讲题阶段判定，工具只给 pending，不做关键词关联', () => {
  for (const audience of EXPLAIN_AUDIENCES) {
    const r = buildExplainerReport(QUESTION, true, [], audience);
    assert.equal(r.interdisciplinary.status, 'pending');
    assert.deepEqual(r.interdisciplinary.allowedStatus, ['applicable', 'not_applicable', 'pending']);
    assert.deepEqual(r.interdisciplinary.chain, ['地理解释需要', '学科工具', '情境对应', '解释贡献', '适用限制']);
  }
});

test('缓存键区分题面指纹、讲解对象与讲稿规则版本', () => {
  const student = buildExplainerReport(QUESTION, true, [], 'student');
  const teacher = buildExplainerReport(QUESTION, true, [], 'teacher');
  assert.notEqual(student.cacheKey, teacher.cacheKey, '对象不同必须换缓存键');
  assert.ok(student.cacheKey.includes('#student#rules3'));
  assert.ok(student.cacheKey.includes(`#rules${EXPLAIN_RULESET_VERSION}`));

  const changedStem = buildExplainerReport({ ...QUESTION, stem: QUESTION.stem + '（改）' }, true, [], 'student');
  assert.notEqual(student.cacheKey, changedStem.cacheKey, '题面（题干）变化必须换缓存键');
  const changedMaterial = buildExplainerReport({ ...QUESTION, material: QUESTION.material + '（改）' }, true, [], 'student');
  assert.notEqual(student.cacheKey, changedMaterial.cacheKey, '题面（材料）变化必须换缓存键');
  // 答案不属于题面指纹，改答案不应换缓存键。
  const changedAnswer = buildExplainerReport({ ...QUESTION, answer: 'C' }, true, [], 'student');
  assert.equal(student.cacheKey, changedAnswer.cacheKey, '答案变化不改变讲稿缓存键');
});

// ========== 渲染：核验状态与同类题比较段 ==========
test('renderExplain 渲染服务端核验状态与同类问题比较段', () => {
  const report = buildExplainerReport(QUESTION, true, [], 'student', COMPARISON_WITH_BASIS);
  const value = verifiedValue(report, 'student', COMPARISON_WITH_BASIS);
  const text = renderExplain({ qid: QUESTION.questionId }, value)[0].text;

  assert.match(text, /讲解对象：学生（student）/);
  assert.match(text, /^## 核验状态$/m);
  assert.match(text, /server_run_record/);
  assert.match(text, /verified=true/);
  assert.match(text, /状态：verified/);
  assert.match(text, /判定：partially_consistent/);
  assert.match(text, /修正结论：补充海冰覆盖这一判断线索/);
  assert.match(text, /核验状态来自服务端运行记录/);

  // 四项内容要求渲染为内容要求清单。
  assert.match(text, /^## 内容要求（按此组织，不逐条机械成章）$/m);
  for (const item of report.contentRequirements) assert.match(text, new RegExp(`- ${item.item}：`));

  // knowledgeRole 落成题目定位段。
  assert.match(text, /核心考点：洋流对地理环境的影响/);
  assert.match(text, /知识作用（待填）/);

  // 同类问题比较段：依据题目、对应关系、引用规则都要出现。
  assert.match(text, /^## 同类问题比较（题库检索依据）$/m);
  assert.match(text, /2023广东卷 第12题 2023-广东-地理-0012-Q1/);
  assert.match(text, /共同点：设问任务相同/);
  assert.match(text, /推理关系：材料证据维度相近/);
  assert.match(text, /差异\/边界：设问对象相反/);
  assert.match(text, /引用要求：总结须列出所依据的题目/);
  assert.doesNotMatch(text, /缺口：/, '候选充足时不应渲染缺口');

  // 反思与迁移段的 transfer 双对象说明。
  assert.match(text, /^## 反思与迁移$/m);
  assert.match(text, /- 学生版：换一道相关题时/);
  assert.match(text, /- 教师版：怎样安排独立尝试/);
});

test('renderExplain 在同类题不足时渲染缺口，命题人对象不套四段式', () => {
  const studentReport = buildExplainerReport(QUESTION, true, [], 'student', COMPARISON_INSUFFICIENT);
  const studentText = renderExplain({ qid: QUESTION.questionId }, verifiedValue(studentReport))[0].text;
  assert.match(studentText, /题库未检索到可用同类题/);
  assert.match(studentText, /缺口：题库中与该题设问任务\/推理关系相近的题目不足 2 道/);

  const setterReport = buildExplainerReport(QUESTION, true, [], 'setter');
  const setterText = renderExplain({ qid: QUESTION.questionId }, verifiedValue(setterReport, 'setter', COMPARISON_INSUFFICIENT))[0].text;
  assert.match(setterText, /讲解对象：命题人（setter）/);
  assert.match(setterText, /三层干扰辨析/);
  assert.match(setterText, /核验状态/);
  assert.match(setterText, /server_run_record/);
  assert.doesNotMatch(setterText, /题目定位/);
  assert.doesNotMatch(setterText, /同类问题比较（题库检索依据）/);
});

test('渲染层对非成功结果回退为 JSON，不假装成功', () => {
  const early = { status: 'error', code: 'EXPLAIN_NOT_VERIFIED', solveStatus: { state: 'submitted', canExplain: false }, message: '未完成核验，不能生成讲稿。' };
  const text = renderExplain({ qid: 'Q1' }, early)[0].text;
  assert.match(text, /EXPLAIN_NOT_VERIFIED/);
  assert.doesNotMatch(text, /讲题稿骨架/);
  const invalid = renderExplain({ qid: 'Q1' }, { status: 'error', code: 'INVALID_AUDIENCE', message: '非法输入' })[0].text;
  assert.match(invalid, /INVALID_AUDIENCE/);
});

// ========== 学生对象「设问先行六步」：段内骨架与渲染落位 ==========
test('学生 audiencePlan 给出设问先行六步骨架，首末步与待填字段保留', () => {
  const student = buildExplainerReport(QUESTION, true, [], 'student');
  const plan = student.audiencePlan;

  assert.equal(plan.flow.length, 6);
  assert.deepEqual(plan.flow, ['设问先行', '定向读材料', '知识选择', '推理链', '作答与检查', '方法提炼']);
  assert.deepEqual(plan.stepPlacement, { examine: '①', solve: '②③④⑤', reflect: '⑥', note: '外层仍为四段式' });
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

  assert.equal(plan.entryQuestion, '');
  assert.deepEqual(plan.steps, []);
  assert.equal(plan.methodBoundary, '');
});

test('学生渲染把六步落在段内列表项、未成为顶层标题', () => {
  const report = buildExplainerReport(QUESTION, true, [], 'student');
  const plan = report.audiencePlan;
  const text = renderExplain({ qid: QUESTION.questionId }, verifiedValue(report))[0].text;

  assert.match(text, /段内教学流程：设问先行 → 定向读材料 → 知识选择 → 推理链 → 作答与检查 → 方法提炼/);
  assert.ok(
    text.includes(`落位：审题＝${plan.stepPlacement.examine}；破题＝${plan.stepPlacement.solve}；反思与迁移＝${plan.stepPlacement.reflect}（${plan.stepPlacement.note}）`),
    '渲染缺少六步在外层四段中的落位'
  );
  for (const step of plan.stepTemplate) {
    assert.ok(text.includes(`${step.step}：${step.action}`), `渲染缺少步骤：${step.step}`);
    assert.ok(text.includes(`思维锚点（讲给学生听）：${step.anchor}`), `渲染缺少思维锚点：${step.step}`);
  }
  assert.match(text, /① 拆设问（先行）/);
  assert.match(text, /⑥ 方法提炼/);

  // 六步只作段内列表项，不得升格为顶层标题。
  assert.doesNotMatch(text, /^##\s*[①②③④⑤⑥]/m);
  for (const title of ['题目定位', '审题提示', '破题', '反思与迁移']) {
    assert.match(text, new RegExp(`^## ${title}$`, 'm'), `顶层四段缺少 ${title}`);
  }

  // 教师分支对照：无六步模板，渲染里也不出现学生的段内流程与思维锚点。
  const teacher = buildExplainerReport(QUESTION, true, [], 'teacher');
  assert.ok(!('stepTemplate' in teacher.audiencePlan), '教师对象不应有六步模板');
  const teacherText = renderExplain({ qid: QUESTION.questionId }, verifiedValue(teacher, 'teacher'))[0].text;
  assert.doesNotMatch(teacherText, /段内教学流程/);
  assert.doesNotMatch(teacherText, /思维锚点（讲给学生听）/);
  assert.match(teacherText, /^## 题目定位$/m);
});

// ========== 工具边界回归：mock geoKernel.assembleExplanation ==========
// 背景：工具边界的返回值必须是"无损 JSON"（DSH 会做一次 JSON 往返检查）。
// 旧实现的 judgeReport/scaffold 曾产出 undefined 字段或循环引用，导致整个 geo_explain
// 调用失败。现在 geo_explain 不再接收模型自报材料，只把内核返回原样交回，
// 这里用 mock 内核直接验证执行层与边界。
function assertLossless(value, label = 'result', pathLabel = 'result', seen = new Set()) {
  if (value === undefined) throw new Error(`${label} ${pathLabel} 是 undefined`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} ${pathLabel} 不是有限数字`);
  if (typeof value === 'function') throw new Error(`${label} ${pathLabel} 是函数`);
  if (typeof value === 'symbol' || typeof value === 'bigint') throw new Error(`${label} ${pathLabel} 是 ${typeof value}`);
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${label} ${pathLabel} 存在循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLossless(item, label, `${pathLabel}[${i}]`, seen));
    seen.delete(value);
    return;
  }
  for (const key of Object.keys(value)) assertLossless(value[key], label, `${pathLabel}.${key}`, seen);
  seen.delete(value);
  const roundTrip = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTrip, value, `${label} ${pathLabel} 不能无损通过 JSON 往返`);
}

async function loadExplainTool(kernelResult) {
  const registered = new Map();
  const calls = [];
  const ctx = {
    fs: {
      resolve: async (target) => ({ path: target }),
      readText: async () => '',
      writeText: async () => {},
      readBytes: async () => { throw new Error('mock'); },
      listDir: async () => [],
      stat: async () => ({ isDirectory: () => false }),
      processPath: (target) => (target && target.path) || String(target)
    },
    attachments: { imageLimits: {}, saveImage: async () => ({}) },
    tools: { register(def) { registered.set(def.name, def); return () => {}; } },
    webServer: { register() {}, registerUpgrade() {}, registerFallback() {}, tapIndex() { return () => {}; } },
    geoKernel: {
      assembleExplanation: async (qid, audience) => {
        calls.push({ qid, audience });
        return kernelResult;
      }
    },
    get() { return undefined; },
    provide() {},
    on() { return () => {}; },
    effect(cb) { try { const dispose = cb(); return typeof dispose === 'function' ? dispose : () => {}; } catch { return () => {}; } }
  };
  const plugin = (await import('../.agent-presets/geo-teacher/plugins/analysis/index.js')).default;
  plugin.apply(ctx, {});
  return { tool: registered.get('geo_explain'), calls };
}

test('工具边界回归：已核验结果原样返回且无损，三个对象都走内核', async () => {
  for (const audience of EXPLAIN_AUDIENCES) {
    const report = buildExplainerReport(QUESTION, true, [], audience, COMPARISON_WITH_BASIS);
    const value = verifiedValue(report, audience, COMPARISON_WITH_BASIS);
    const { tool, calls } = await loadExplainTool(value);
    const result = await tool.execute({ qid: QUESTION.questionId, audience });
    assert.doesNotThrow(() => assertLossless(result, `geo_explain-${audience}`));
    assert.equal(result.status, 'success');
    assert.equal(result.audience, audience);
    assert.equal(result.audienceExplicit, true);
    assert.deepEqual(calls, [{ qid: QUESTION.questionId, audience }], '内核收到的对象必须与入参一致');
    const text = renderExplain({ qid: QUESTION.questionId }, result)[0].text;
    assert.match(text, /server_run_record/);
    if (audience === 'setter') {
      assert.match(text, /三层干扰辨析/);
      assert.doesNotMatch(text, /同类问题比较（题库检索依据）/);
    } else {
      assert.match(text, /同类问题比较（题库检索依据）/);
    }
  }

  // 缺省对象：按 student 交给内核，并标记为非显式传入。
  const report = buildExplainerReport(QUESTION, true, [], 'student', COMPARISON_WITH_BASIS);
  const { tool, calls } = await loadExplainTool(verifiedValue(report, 'student', COMPARISON_WITH_BASIS));
  const result = await tool.execute({ qid: QUESTION.questionId });
  assert.equal(result.audience, 'student');
  assert.equal(result.audienceExplicit, false);
  assert.deepEqual(calls, [{ qid: QUESTION.questionId, audience: 'student' }]);
});

test('工具边界回归：未核验、非法 audience、缺 qid 的结果都是无损 JSON', async () => {
  const refused = { status: 'error', code: 'EXPLAIN_NOT_VERIFIED', solveStatus: { state: 'submitted', runId: 'RUN-1', fingerprintMatches: true, canExplain: false }, message: '未完成核验，不能生成讲稿。' };
  const { tool, calls } = await loadExplainTool(refused);

  const notVerified = await tool.execute({ qid: QUESTION.questionId });
  assert.doesNotThrow(() => assertLossless(notVerified, 'geo_explain-unverified'));
  assert.equal(notVerified.code, 'EXPLAIN_NOT_VERIFIED');
  assert.match(renderExplain({ qid: QUESTION.questionId }, notVerified)[0].text, /EXPLAIN_NOT_VERIFIED/);

  const badAudience = await tool.execute({ qid: QUESTION.questionId, audience: 'nope' });
  assert.doesNotThrow(() => assertLossless(badAudience, 'geo_explain-invalid-audience'));
  assert.equal(badAudience.code, 'INVALID_AUDIENCE');

  const missingQid = await tool.execute({});
  assert.doesNotThrow(() => assertLossless(missingQid, 'geo_explain-missing-qid'));
  assert.equal(missingQid.code, 'MISSING_QID');

  assert.equal(calls.length, 1, '只有缺省对象的合法调用会进入内核，其余在入口被拒');
});
