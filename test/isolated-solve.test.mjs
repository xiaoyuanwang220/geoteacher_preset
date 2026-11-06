// 讲题优化（隔离解题 / 题答分离 / 服务端门禁）行为测试。
// 覆盖契约 §1-§4：题面图片与解析图分离、题面指纹、run 状态机门禁、
// 同类题检索、隔离编排（内部预设 + spawn 子会话 + caller 交付）、两阶段核验、
// geo_explain 只读 service 记录、以及所有工具/内核返回值的无损 JSON 边界。
//
// 断言口径：结构（返回字段/状态/调用参数）优先；渲染文本只用来证明结构真的落地，
// 不把提示词原文当作唯一证据。需要真实题库的用例在文件缺失时退化为内联 fixture。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import corePlugin, {
  parseQuestionFileFull,
  questionFingerprint,
  createSolveRegistry,
  SOLVE_STATES,
  rankSimilarQuestions,
  buildExplainerReport
} from '../.agent-presets/geo-teacher/plugins/core/index.js';
import analysisPlugin, {
  INTERNAL_SOLVER_PRESET_ID,
  buildSolvePrompt,
  renderSolve,
  renderJudge,
  renderExplain
} from '../.agent-presets/geo-teacher/plugins/analysis/index.js';
import solverIsolationPlugin, {
  readSolverPersona
} from '../.agent-presets/geo-teacher/plugins/solver-isolation/index.js';

// ========== 通用工具 ==========

// 与 DSH 工具边界等价的无损 JSON 断言：undefined/函数/NaN/循环引用/往返丢键都会失败。
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

function headingLines(text) {
  return String(text || '').split('\n').filter((line) => /^#{1,3} /.test(line));
}

// ========== 1. 题答分离：真实题库优先，缺失时用同构内联 fixture ==========
// 题库根由环境变量给出（不在仓库里写个人绝对路径）：设置 GEO_QUESTION_BANK_ROOT 后
// 优先读安徽 2025 综合题 G18（题面图 3 张、解析图 1 张），未设置或文件缺失则用下方 fixture。
const REAL_G18 = process.env.GEO_QUESTION_BANK_ROOT
  ? path.join(process.env.GEO_QUESTION_BANK_ROOT, '安徽', '2025', '2025年安徽高考地理真题__综合题G18_Q1-3.md')
  : '';
const HAS_REAL_G18 = REAL_G18 !== '' && fs.existsSync(REAL_G18);

// 内联 fixture 与真实文件同构：`## 相关图片` 共用图 + 小问答案标记前的题面图 +
// 答案标记后的解析图；教学备注无图。文件名保持与真实题库一致，断言可共用。
const INLINE_G18 = `---
year: "2025"
region: "安徽"
question_numbers: "18(1-3)"
---

# 2025年安徽高考地理真题 · 综合题第18题（小问1–3）

## 来源
- 来源文档：精品解析：2025年安徽高考地理真题（解析版）
- 题号：第18题（非选择题，共3小问）

## 题组材料
18. 阅读图文材料，完成下列要求。

5月某日，天气晴朗，某研学小组在江苏如东"光氢储一体化"海上光伏示范项目基地开展研学活动。图1示意如东地理位置，图2为光伏项目景观照片。

## 相关图片
![如东地理位置图](../../../90_附件/题目图片/安徽/2025/2025-安徽-地理-2025年安徽高考地理真题-综合G18__shared__01.png)

![光伏项目景观照片](../../../90_附件/题目图片/安徽/2025/2025-安徽-地理-2025年安徽高考地理真题-综合G18__shared__02.png)

### 第18题（1）
question_id: \`2025-安徽-地理-2025年安徽高考地理真题-Q18-1\`

**题干**：（1）研学小组利用传感器测量当天到达地表太阳辐射量日变化。请在下图中用平滑曲线画出预期实验结果示意图。

![太阳辐射量日变化作图题示意图](../../../90_附件/题目图片/安徽/2025/2025-安徽-地理-2025年安徽高考地理真题-Q18-1__01.png)

**答案**：（作图题，预期曲线的关键特征：在地方时12时达到最大值；日出前、日落后太阳辐射量为0）

![太阳辐射量日变化参考图](../../../90_附件/题目图片/安徽/2025/2025-安徽-地理-2025年安徽高考地理真题-Q18-1__02.png)

**解析**：由图可知，如东大约位于121°E，地方时比北京时间早4分钟，太阳辐射量在地方时12点达最大值。

### 第18题（2）
question_id: \`2025-安徽-地理-2025年安徽高考地理真题-Q18-2\`

**题干**：（2）分析该项目实施光氢储一体化的必要性。

**答案**：受太阳辐射变化的影响，光伏发电不稳定；制氢可以消纳光电；储能电站可以储存氢能和光电。

**解析**：太阳辐射受季节变化、天气变化等影响，不稳定，而光伏发电依赖太阳辐射。

### 第18题（3）
question_id: \`2025-安徽-地理-2025年安徽高考地理真题-Q18-3\`

**题干**：（3）研学小组想从碳减排角度了解该光伏项目带来的生态价值，请为他们拟一份访谈提纲（至少列出3条）。

**答案**：一、光伏项目的发电功能对碳减排的影响；二、光伏项目对所在区域碳储量（生态系统）的影响。

**解析**：从碳减排角度了解生态价值，结合专家的专业素养列出访谈提纲。

## 教学备注
<!-- TEACHER-NOTES-START -->
- 易错点：
- 课堂提示：
<!-- TEACHER-NOTES-END -->
`;

const g18Source = HAS_REAL_G18 ? fs.readFileSync(REAL_G18, 'utf8') : INLINE_G18;
const g18FixtureName = HAS_REAL_G18 ? '真实题库 G18（GEO_QUESTION_BANK_ROOT）' : '内联 fixture';

test('题答分离：题面图片不含解析图，题干文字不留图片路径', () => {
  const parsed = parseQuestionFileFull(g18Source);
  assert.equal(parsed.questions.length, 3, `${g18FixtureName} 应解析出 3 个小问`);
  assert.deepEqual(
    parsed.questions.map((q) => q.questionId.slice(-5)),
    ['Q18-1', 'Q18-2', 'Q18-3']
  );

  const questionRels = parsed.questionImages.map((img) => img.rel.split('/').pop());
  const analysisRels = parsed.analysisImages.map((img) => img.rel.split('/').pop());
  assert.ok(questionRels.some((rel) => rel.endsWith('G18__shared__01.png')), '共用题面图 1 应进入题面图片');
  assert.ok(questionRels.some((rel) => rel.endsWith('G18__shared__02.png')), '共用题面图 2 应进入题面图片');
  assert.ok(questionRels.includes('2025-安徽-地理-2025年安徽高考地理真题-Q18-1__01.png'), '答案标记前的正文图是题面图');
  assert.ok(analysisRels.includes('2025-安徽-地理-2025年安徽高考地理真题-Q18-1__02.png'), '答案标记后的图必须归入解析图');
  assert.equal(questionRels.some((rel) => analysisRels.includes(rel)), false, '题面图片与解析图不得交叉');

  // 解题输入只拿题面：文字里不能残留图片 markdown 与图片路径（路径常含题号/出处）。
  assert.doesNotMatch(parsed.material, /!\[|\]\(.*\.(?:png|jpe?g|webp|gif)/i);
  for (const q of parsed.questions) {
    assert.doesNotMatch(q.stem, /!\[|\]\(.*\.(?:png|jpe?g|webp|gif)/i, `${q.questionId} 题干残留图片语法`);
  }
  // 答案仍由解析层保留（judge 阶段才开放），但不在题面字段里。
  for (const q of parsed.questions) assert.ok(q.answer, `${q.questionId} 应解析出答案供核验阶段使用`);
  assert.deepEqual(parsed.boundaryIssues, [], '真实版式不应产生边界问题');
});

test('边界检测：缺 **答案** 标记、题面混入答案痕迹都指题并阻断', () => {
  const missing = parseQuestionFileFull([
    '## 题组材料',
    '材料：某地。',
    '',
    '### 第9题',
    'question_id: `T-BOUND-9`',
    '',
    '**题干**：这题缺少答案标记。'
  ].join('\n'));
  assert.equal(missing.boundaryIssues.length, 1);
  assert.equal(missing.boundaryIssues[0].kind, 'missing_answer_marker');
  assert.equal(missing.boundaryIssues[0].questionId, 'T-BOUND-9');

  const traced = parseQuestionFileFull([
    '## 题组材料',
    '材料：某地。',
    '',
    '### 第8题',
    'question_id: `T-BOUND-8`',
    '',
    '**题干**：题面区混入答案痕迹。',
    '',
    '答案：B',
    '',
    '**答案**：B',
    '**解析**：解析正文。'
  ].join('\n'));
  assert.equal(traced.boundaryIssues.length, 1);
  assert.equal(traced.boundaryIssues[0].kind, 'answer_text_in_question_area');
  assert.equal(traced.boundaryIssues[0].questionId, 'T-BOUND-8');
  assert.match(traced.boundaryIssues[0].snippet, /答案：B/);

  // 回归：题干里出现"精品解析："这类文件名字样，不是答案痕迹（行首锚定，不全文匹配）。
  const benign = parseQuestionFileFull([
    '## 题组材料',
    '材料：某地。',
    '',
    '### 第7题',
    'question_id: `T-BOUND-7`',
    '',
    '**题干**：据精品解析：2025年真题改编，判断该地气候类型。',
    '',
    '**答案**：B',
    '**解析**：解析正文。'
  ].join('\n'));
  assert.deepEqual(benign.boundaryIssues, [], '行内"精品解析："不应被判为答案痕迹');
});

// ========== 2. 题面指纹：只随题面变化，答案不参与 ==========
test('题面指纹：答案/解析变化不改变指纹，题面任一要素变化都改变指纹', () => {
  const parts = {
    questionId: 'T-GROUP-1',
    material: '材料正文',
    stems: ['第1小问题干', '第2小问题干'],
    options: [['A 甲', 'B 乙']],
    images: [{ rel: 'a.png' }, { rel: 'b.png' }]
  };
  const base = questionFingerprint(parts);
  assert.equal(base, questionFingerprint({ ...parts }), '同一题面必须得到同一指纹');
  assert.equal(base, questionFingerprint({ ...parts, answer: '标准答案', analysis: '解析正文', knowledgePoints: [{ knowledge_unit: '考点' }] }), '答案/解析/知识点不得参与指纹');

  assert.notEqual(base, questionFingerprint({ ...parts, material: parts.material + '（改）' }), '材料变化必须换指纹');
  assert.notEqual(base, questionFingerprint({ ...parts, stems: ['第1小问题干（改）', '第2小问题干'] }), '题干变化必须换指纹');
  assert.notEqual(base, questionFingerprint({ ...parts, options: [['A 甲', 'B 丙']] }), '选项变化必须换指纹');
  assert.notEqual(base, questionFingerprint({ ...parts, images: [{ rel: 'a.png' }] }), '题面图片变化必须换指纹');
  assert.notEqual(base, questionFingerprint({ ...parts, questionId: 'T-GROUP-2' }), '题组键变化必须换指纹');
});

// ========== 3. run 状态机：题面就绪 → 作答已提交 → 核验完成 ==========
test('run 状态机：未提交不给答案、未开答案不能归档、verdict 受枚举约束', () => {
  let clock = 1_700_000_000_000;
  const registry = createSolveRegistry({ now: () => (clock += 1000) });
  const fingerprint = questionFingerprint({ questionId: 'T-SM-1', material: '材料', stems: ['题干'], options: [], images: [] });
  const ensured = registry.ensureRun({ questionId: 'T-SM-1', questionFingerprint: fingerprint });
  assert.equal(ensured.run.state, SOLVE_STATES.READY);
  assert.equal(ensured.reused, false);
  assert.equal(ensured.run.runId, `T-SM-1__${fingerprint}`, 'runId 应绑定题组键与题面指纹');

  assert.equal(registry.openReference(ensured.run.runId).code, 'SOLVE_NOT_SUBMITTED', '未提交不能开放答案');
  assert.equal(registry.recordVerification(ensured.run.runId, 'T-SM-1', { verdict: 'consistent' }).code, 'JUDGE_NOT_OPENED', '未开放答案不能归档结论');
  assert.equal(registry.submit(ensured.run.runId, { answerText: '   ' }).code, 'EMPTY_ANSWER', '空作答不得算提交');

  const submitted = registry.submit(ensured.run.runId, {
    answerText: '## 答案\nB\n\n## 关键依据\n暖流增温',
    keyEvidence: '暖流增温',
    childSessionId: 'child-1'
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.run.state, SOLVE_STATES.SUBMITTED);
  assert.equal(submitted.run.answer.childSessionId, 'child-1');
  assert.ok(submitted.run.answer.answerHash, '作答应记录哈希供绑定');

  const opened = registry.openReference(ensured.run.runId);
  assert.equal(opened.ok, true);
  assert.ok(opened.run.judgeOpenedAt, '开放答案应记录时间');
  assert.equal(registry.recordVerification(ensured.run.runId, 'T-SM-1', { verdict: 'maybe' }).code, 'CONCLUSION_INVALID', 'verdict 只接受三值枚举');

  const verified = registry.recordVerification(ensured.run.runId, 'T-SM-1', {
    verdict: 'partially_consistent',
    matched: ['B'],
    missed: ['理由'],
    wrong: [],
    disputed: [],
    correction: '补理由'
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.run.state, SOLVE_STATES.VERIFIED);
  assert.deepEqual(verified.run.conclusions['T-SM-1'].matched, ['B']);
  assert.equal(verified.run.conclusions['T-SM-1'].correction, '补理由');

  // 已核验的 run 不得被再次提交覆盖（原始作答保持不变，修正另存）。
  assert.equal(registry.submit(ensured.run.runId, { answerText: '覆盖作答' }).code, 'ANSWER_IMMUTABLE');
  assert.equal(registry.latestForQuestion('T-SM-1').answer.answerText.includes('覆盖作答'), false);
  // 同一份作答重复提交是幂等的（复用路径可能重放），不报错也不改内容。
  const replay = registry.submit(ensured.run.runId, { answerText: '## 答案\nB\n\n## 关键依据\n暖流增温' });
  assert.equal(replay.ok, true);
  assert.equal(replay.run.answer.answerText.includes('覆盖作答'), false);
});

test('run 持久化兼容：旧单条结论迁移为按小问结论，题组扩容时要求重新核验', () => {
  const registry = createSolveRegistry({});
  const fingerprint = questionFingerprint({ questionId: 'OLD-1', material: '材料', stems: ['题干'], options: [], images: [] });
  registry.restore([{
    runId: `OLD-1__${fingerprint}`,
    questionId: 'OLD-1',
    questionFingerprint: fingerprint,
    state: SOLVE_STATES.VERIFIED,
    createdAt: 1,
    submittedAt: 2,
    judgeOpenedAt: 3,
    verifiedAt: 4,
    answer: { answerText: '## 答案\nB', answerHash: 'h', childSessionId: 'child-old' },
    conclusion: { verdict: 'consistent', matched: ['B'], missed: [], wrong: [], disputed: [], correction: '', verifiedAt: 4 }
  }]);
  const migrated = registry.statusFor('OLD-1', fingerprint);
  assert.equal(migrated.state, SOLVE_STATES.SUBMITTED, '旧单条结论无法判定归属，fail-closed 回到已提交');
  assert.equal(migrated.verifiedCount, 0);
  assert.deepEqual(migrated.questionIds, ['OLD-1']);
  assert.deepEqual(migrated.conclusions, {});
  assert.equal(migrated.canExplain, false, '旧结论已丢弃，必须重新核验');
  assert.ok(registry.latestForQuestion('OLD-1').answer.answerText, '独立作答保留，不丢原始作答');

  // 题组扩容（同指纹、新增小问）：仍为 submitted，按小问重新核验后才 verified。
  const expanded = registry.ensureRun({ questionId: 'OLD-1', questionIds: ['OLD-1', 'OLD-2'], questionFingerprint: fingerprint });
  assert.equal(expanded.run.state, SOLVE_STATES.SUBMITTED);
  assert.deepEqual(expanded.run.conclusions, {});
  assert.deepEqual(expanded.run.questionIds, ['OLD-1', 'OLD-2']);
  registry.openReference(expanded.run.runId);
  registry.recordVerification(expanded.run.runId, 'OLD-1', { verdict: 'consistent' });
  const afterSecond = registry.recordVerification(expanded.run.runId, 'OLD-2', { verdict: 'partially_consistent' });
  assert.equal(afterSecond.run.state, SOLVE_STATES.VERIFIED);
  assert.equal(afterSecond.run.conclusions['OLD-1'].verdict, 'consistent');
  assert.equal(afterSecond.run.conclusions['OLD-2'].verdict, 'partially_consistent');
});

test('run 状态机：同指纹复用、题面变化重开 run 并标记失效', () => {
  let clock = 1_700_000_000_000;
  const registry = createSolveRegistry({ now: () => (clock += 1000) });
  const fp1 = questionFingerprint({ questionId: 'T-SM-2', material: '材料', stems: ['题干'], options: [], images: [] });
  const first = registry.ensureRun({ questionId: 'T-SM-2', questionFingerprint: fp1 });
  registry.submit(first.run.runId, { answerText: '作答一' });

  const reuse = registry.ensureRun({ questionId: 'T-SM-2', questionFingerprint: fp1 });
  assert.equal(reuse.reused, true, '同指纹的已提交 run 应复用，不重新解题');
  assert.equal(reuse.run.runId, first.run.runId);

  const fp2 = questionFingerprint({ questionId: 'T-SM-2', material: '材料（改）', stems: ['题干'], options: [], images: [] });
  const changed = registry.ensureRun({ questionId: 'T-SM-2', questionFingerprint: fp2 });
  assert.notEqual(changed.run.runId, first.run.runId, '题面变化必须换 run');
  assert.equal(changed.invalidated, true, '旧 run 应标记失效');
  assert.equal(changed.run.state, SOLVE_STATES.READY);

  assert.equal(registry.statusFor('T-SM-2', fp2).fingerprintMatches, true);
  const stale = registry.statusFor('T-SM-2', fp1);
  assert.equal(stale.fingerprintMatches, false, '旧指纹不得匹配当前题面');
  assert.equal(stale.canJudge, false);
  assert.equal(stale.canExplain, false);

  // 上限淘汰：按创建时间保留最新 maxRuns 条。
  const capped = createSolveRegistry({ maxRuns: 2 });
  for (const id of ['T-CAP-1', 'T-CAP-2', 'T-CAP-3']) {
    capped.ensureRun({ questionId: id, questionFingerprint: `fp_${id}` });
  }
  assert.equal(capped.list().length, 2, 'run 记录应受 maxRuns 上限约束');
});

// ========== 4. 同类题检索：不以同文件题组充数，不足时给缺口 ==========
function bankItem(questionId, file, stem, material, extra = {}) {
  return {
    questionId,
    file,
    stem,
    material,
    options: extra.options || [],
    knowledgePoints: extra.knowledgePoints || [],
    meta: { year: '2025', region: '安徽', question_numbers: '1' },
    ...extra
  };
}

test('同类题检索：同文件题组不算同类，按设问任务/材料特征命中', () => {
  const current = bankItem('SIM-CUR', 'A.md', '分析该地气温高于同纬度的原因。', '该地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。');
  const sibling = bankItem('SIM-SIB', 'A.md', '分析该地气温高于同纬度的原因。', '该地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。');
  const near = bankItem('SIM-NEAR', 'B.md', '分析乙地气温高于同纬度的原因。', '乙地位于沿海，受沿岸暖流影响，气温较高，降水较多，地形以平原为主。');
  const near2 = bankItem('SIM-NEAR2', 'D.md', '分析丙地气温高于同纬度的原因。', '丙地位于沿海，受暖流影响，气温较高，降水偏多，地形以平原为主。');
  const far = bankItem('SIM-FAR', 'C.md', '该地服务业发展的主导区位条件是（　）', '当地商业金融发达，市场需求大，销售渠道完善。', {
    options: ['A 甲', 'B 乙', 'C 丙', 'D 丁']
  });

  const result = rankSimilarQuestions([current, sibling, near, near2, far], current, 5);
  const ids = result.basis.map((item) => item.questionId);
  assert.equal(ids.includes('SIM-SIB'), false, '同文件题组共用材料，不能作为同类题依据');
  assert.equal(ids.includes('SIM-NEAR'), true, '同设问任务、相似材料的题目应命中');
  assert.equal(ids.includes('SIM-NEAR2'), true);
  assert.equal(ids.includes('SIM-FAR'), false, '设问任务与材料均不同的题目不应命中');
  assert.equal(result.insufficient, false);
  for (const item of result.basis) {
    assert.equal(typeof item.sharedTask, 'string');
    assert.equal(typeof item.sharedReasoning, 'string');
    assert.equal(typeof item.sharedMaterial, 'string');
    assert.equal(typeof item.differences, 'string');
    assert.equal(typeof item.groupLabel, 'string');
    assert.equal(typeof item.sameCorePoint, 'boolean');
  }
});

test('同类题检索：达标候选不足 2 道时标 insufficient 并说明缺口', () => {
  const current = bankItem('SIM-R1', 'R1.md', '分析该地气温高于同纬度的原因。', '该地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。');
  const sibling = bankItem('SIM-R2', 'R1.md', '说明该地降水较多的原因。', '该地位于沿海，受暖流影响，气温较高，降水较多。');
  const near = bankItem('SIM-R3', 'R2.md', '分析乙地气温高于同纬度的原因。', '乙地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。');
  const result = rankSimilarQuestions([current, sibling, near], current, 5);
  assert.equal(result.basis.length, 1);
  assert.equal(result.insufficient, true);
  assert.match(result.gap, /不足 2 道/);
  assert.match(result.gap, /编造通用套路/);
});

// ========== 5. 隔离编排：mock ctx 驱动真实工具定义 ==========
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const CHILD_TEXT = [
  '## 答案',
  '乙地受暖流增温影响，气温偏高。',
  '',
  '## 关键依据',
  '沿岸暖流增温增湿。',
  '',
  '## 推理过程',
  '设问拆解 → 证据 → 知识 → 推理 → 结论。'
].join('\n');

const DEFAULT_PREPARED = Object.freeze({
  status: 'success',
  runId: 'RUN-1',
  questionId: 'T-B-2',
  groupKey: 'T-B-1',
  questionFingerprint: 'fp_group',
  state: 'question_ready',
  reused: false,
  material: '材料：乙地位于沿海，受暖流影响。',
  questions: [
    { questionId: 'T-B-1', stem: '第1小问题干？', options: [] },
    { questionId: 'T-B-2', stem: '第2小问题干？', options: ['A 甲项', 'B 乙项'] }
  ],
  questionImages: [{ imageId: 'fig_1', caption: '图1 位置示意', rel: 'a.png', sourcePath: 'C:/bank/img/a.png', order: 1 }],
  analysisImageCount: 1,
  boundaryIssues: [],
  answer: null
});

const OPENED_RESULT = Object.freeze({
  status: 'success',
  questionId: 'T-B-2',
  runId: 'RUN-1',
  state: 'submitted',
  independent: { answerText: '## 答案\n乙地受暖流增温影响。', keyEvidence: '暖流', submittedAt: '2026-11-06T05:00:00.000Z', answerHash: 'hash1' },
  isChoice: false,
  reference: [{
    questionId: 'T-B-1',
    isChoice: false,
    standardAnswer: '暖流增温增湿',
    analysis: '沿岸暖流增温增湿。',
    scorePoints: [{ point: '暖流增温', dimension: ['气候'] }],
    coverageGrid: [{ match: '暖流增温', hit: '', note: '' }],
    distractorTargets: []
  }],
  judgeOpenedAt: '2026-11-06T05:01:00.000Z',
  nextStep: '对照完成后再次调用 geo_judge 并传入 conclusion'
});

const VERIFIED_RESULT = Object.freeze({
  status: 'success',
  questionId: 'T-B-2',
  runId: 'RUN-1',
  state: 'verified',
  verifiedAt: '2026-11-06T05:02:00.000Z',
  conclusion: { verdict: 'partially_consistent', matched: ['暖流'], missed: ['地形'], wrong: [], disputed: [], correction: '补地形抬升' }
});

function createHarness(options = {}) {
  const calls = {
    activations: [],
    registeredPresets: [],
    savedImages: [],
    recordAnswer: [],
    openReference: [],
    recordVerification: [],
    assembleExplanation: [],
    dispose: 0,
    restrictions: [],
    guards: [],
    personaSections: [],
    presetResolve: 0
  };
  const services = {};
  const activationResult = 'activationResult' in options
    ? options.activationResult
    : { stopReason: 'completed', output: [{ type: 'text', text: CHILD_TEXT }] };

  if (options.subagents !== null) {
    services.subagents = {
      getProvider: (id) => (id === 'spawn' ? { id: 'spawn' } : undefined),
      startActivation: async (request) => {
        calls.activations.push(request);
        if (options.activationThrows) throw new Error('spawn 启动失败');
        return {
          childId: 'child-42',
          result: options.activationRejects ? Promise.reject(new Error('子会话崩溃')) : Promise.resolve(activationResult),
          dispose: async () => { calls.dispose += 1; }
        };
      }
    };
  }
  if (options.agentPresets !== null) {
    services.agentPresets = {
      register: async (definition) => {
        calls.registeredPresets.push(definition);
        return () => {};
      },
      resolve: async (id) => {
        calls.presetResolve += 1;
        if (options.presetResolveThrows) throw new Error(`Unknown agent preset: ${id}`);
        return { id, broken: options.presetBroken || null };
      }
    };
  }

  const prepared = options.prepared || DEFAULT_PREPARED;
  const kernel = {
    prepareSolve: async (qid) => {
      calls.preparedFor = qid;
      return typeof prepared === 'function' ? prepared(qid) : prepared;
    },
    recordIndependentAnswer: async (runId, payload) => {
      calls.recordAnswer.push({ runId, payload });
      return options.recordedAnswer || {
        status: 'success',
        runId,
        questionId: 'T-B-1',
        state: 'submitted',
        submittedAt: '2026-11-06T05:00:00.000Z',
        answerHash: 'abc123',
        answerLength: payload && payload.answerText ? payload.answerText.length : 0
      };
    },
    openReferenceAnswer: async (qid) => {
      calls.openReference.push(qid);
      return options.openResult || OPENED_RESULT;
    },
    recordVerification: async (qid, conclusion) => {
      calls.recordVerification.push({ qid, conclusion });
      return options.verifyResult || VERIFIED_RESULT;
    },
    assembleExplanation: async (qid, audience) => {
      calls.assembleExplanation.push({ qid, audience });
      return options.explainResult || { status: 'error', code: 'EXPLAIN_NOT_VERIFIED', solveStatus: { state: 'none' } };
    },
    analyzeQuestion: async () => ({ status: 'error', code: 'NOT_USED' }),
    exportAnalysis: async () => ({ status: 'error', code: 'NOT_USED' })
  };

  const tools = new Map();
  const ctx = {
    fs: {
      resolve: async (target) => ({ path: String(target) }),
      readText: async () => '',
      writeText: async () => {},
      readBytes: async (target) => {
        const file = (target && target.path) || String(target);
        if (options.bytesFail && /broken/.test(file)) {
          throw Object.assign(new Error('题面图片读取被拒'), { code: 'EACCES' });
        }
        return PNG_BYTES;
      },
      listDir: async () => [],
      stat: async () => ({ isDirectory: () => false }),
      processPath: (target) => (target && target.path) || String(target)
    },
    attachments: {
      imageLimits: { maxImagesPerMessage: 8, maxImageBytes: 20 * 1024 * 1024, maxMessageImageBytes: 20 * 1024 * 1024 },
      saveImage: async ({ data, mediaType, name }) => {
        calls.savedImages.push({ mediaType, name, size: data.length });
        return { attachmentId: `sha256:mock-${calls.savedImages.length}`, mediaType, name };
      }
    },
    tools: {
      register(definition) {
        if (definition && definition.name) tools.set(definition.name, definition);
        return () => {};
      },
      schemas() {
        return options.globalTools || [
          { name: 'session_search' },
          { name: 'modelcheck_status' },
          { name: 'run_code' }
        ];
      },
      restrict(filter) {
        calls.restrictions.push(filter);
        return () => {};
      },
      guard(guard) {
        calls.guards.push(guard);
        return () => {};
      }
    },
    systemPrompt: {
      getSectionOrder: () => 7,
      section(definition) {
        calls.personaSections.push(definition);
        return () => {};
      }
    },
    webServer: { register() {}, registerUpgrade() {}, registerFallback() {}, tapIndex() { return () => {}; } },
    geoKernel: kernel,
    get(name) { return services[name]; },
    provide() {},
    on() { return () => {}; },
    effect(callback) {
      try {
        const dispose = callback();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (error) {
        return () => {};
      }
    }
  };
  analysisPlugin.apply(ctx, {});
  return { tools, calls, kernel, ctx, services, activationResult };
}

test('geo_solve：在内部预设的隔离子会话中解题，作答回写服务端且 prompt 只有题面', async () => {
  const prepared = {
    ...DEFAULT_PREPARED,
    // 这些字段不属于题面契约；放在这里专门验证 prompt 构造不取用（答案隔离）。
    answer: 'SAN-ANSWER',
    analysis: 'SAN-ANALYSIS',
    knowledgePoints: [{ knowledge_unit: 'SAN-KU' }]
  };
  const harness = createHarness({ prepared });
  const tool = harness.tools.get('geo_solve');
  assert.ok(tool, 'geo_solve 应注册');
  const exec = { agent: { id: 'agent-main' }, signal: 'SIGNAL' };
  const result = await tool.execute({ qid: 'T-B-2' }, exec);

  assert.equal(harness.calls.preparedFor, 'T-B-2');
  assert.equal(result.status, 'success');
  assert.equal(result.runId, 'RUN-1');
  assert.equal(result.state, 'submitted');
  assert.equal(result.reused, false);
  assert.match(result.independentAnswer, /## 答案/);
  assert.equal(result.keyEvidence, '沿岸暖流增温增湿。', '从子会话文本的"## 关键依据"段提取依据');

  // 内部预设由 bundle（cordis.patch.yml）声明，analysis 不再运行时注册；这里只校验它可用并传给子会话。
  assert.equal(harness.calls.registeredPresets.length, 0, '内部预设由 cordis.patch.yml 声明，不在运行时注册');
  assert.equal(harness.calls.presetResolve, 1, '应解析一次内部解题预设');
  assert.equal(INTERNAL_SOLVER_PRESET_ID, 'geo-solver-internal');

  // 子会话请求：spawn provider + caller 交付 + 内部预设 + 调用方 Agent。
  assert.equal(harness.calls.activations.length, 1);
  const activation = harness.calls.activations[0];
  assert.equal(activation.provider, 'spawn');
  assert.equal(activation.delivery, 'caller');
  assert.equal(activation.request.agentPreset, INTERNAL_SOLVER_PRESET_ID);
  assert.equal(activation.request.parent, exec.agent);
  assert.equal(activation.signal, exec.signal);
  assert.equal(activation.label, '独立解题');

  // prompt 只含题面：材料/题干/选项/图注，不含答案、解析、知识点、qid、runId、指纹、路径。
  const promptBlocks = activation.request.prompt;
  const textBlock = promptBlocks.find((block) => block.type === 'text');
  assert.ok(textBlock, '子会话 prompt 应含文本题面');
  const promptText = textBlock.text;
  assert.match(promptText, /材料：乙地位于沿海，受暖流影响。/);
  assert.match(promptText, /第2小问题干？/);
  assert.match(promptText, /- A 甲项/);
  assert.match(promptText, /图1 位置示意/);
  assert.match(promptText, /## 答案\n## 关键依据\n## 推理过程/, 'prompt 应要求固定三段输出');
  for (const forbidden of ['T-B-1', 'T-B-2', 'RUN-1', 'fp_group', 'SAN-ANSWER', 'SAN-ANALYSIS', 'SAN-KU', 'C:/bank', 'a.png']) {
    assert.equal(promptText.includes(forbidden), false, `prompt 不得包含 ${forbidden}`);
  }
  // 题面图片按原生图片块交付，顺序与题面一致。
  const imageBlocks = promptBlocks.filter((block) => block.type === 'image');
  assert.equal(imageBlocks.length, 1);
  assert.equal(imageBlocks[0].attachment.mediaType, 'image/png');
  assert.equal(harness.calls.savedImages.length, 1);

  // 作答由插件写回服务端：参数来自子会话文本，不来自模型工具入参。
  assert.equal(harness.calls.recordAnswer.length, 1);
  const recorded = harness.calls.recordAnswer[0];
  assert.equal(recorded.runId, 'RUN-1');
  assert.equal(recorded.payload.answerText, CHILD_TEXT);
  assert.equal(recorded.payload.keyEvidence, '沿岸暖流增温增湿。');
  assert.equal(recorded.payload.childSessionId, 'child-42');
  assert.equal(harness.calls.dispose, 1, '子会话结束后必须 dispose');

  assert.doesNotThrow(() => assertLossless(result, 'geo_solve'));
  assert.match(renderSolve({ qid: 'T-B-2' }, result)[0].text, /独立作答.*（隔离解题会话）/);
});

test('内部解题预设插件：persona 来自解题技能，且隐藏+拒绝一切继承工具', () => {
  const calls = { sections: [], restrictions: [], guards: [] };
  const ctx = {
    tools: {
      schemas: () => [{ name: 'session_search' }, { name: 'modelcheck_status' }, { name: 'working_directory' }, { name: 'run_code' }],
      restrict: (filter) => {
        calls.restrictions.push(filter);
        return () => {};
      },
      guard: (guard) => {
        calls.guards.push(guard);
        return () => {};
      }
    },
    systemPrompt: {
      getSectionOrder: () => 7,
      section(definition) {
        calls.sections.push(definition);
        return () => {};
      }
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    }
  };
  solverIsolationPlugin.apply(ctx, {});

  // persona：与 dsh-persona prefix 同落点，正文来自 skills/geo-solver.md（单一来源）。
  assert.equal(calls.sections.length, 1);
  assert.equal(calls.sections[0].name, 'deployment:persona-prefix');
  assert.equal(calls.sections[0].order, 7);
  const persona = readSolverPersona();
  assert.equal(persona.source, 'skill', 'persona 正文应来自 skills/geo-solver.md，而不是内置兜底');
  assert.equal(calls.sections[0].text, persona.text);
  assert.match(calls.sections[0].text, /## 关键依据/);
  assert.doesNotMatch(calls.sections[0].text, /\{\{/);

  // 工具锁：deny 覆盖所有继承来的全局工具（除 PTC 保留名 run_code），并注册兜底 guard。
  assert.ok(calls.restrictions.length >= 1, '应注册工具限制');
  const denied = new Set(calls.restrictions.flatMap((filter) => filter.deny || []));
  assert.ok(denied.has('session_search'), '必须隐藏会话检索');
  assert.ok(denied.has('modelcheck_status'));
  assert.ok(denied.has('working_directory'));
  assert.equal(denied.has('run_code'), false, 'PTC 保留名不得出现在限制里');
  assert.equal(calls.guards.length, 1, '应注册兜底 guard');
  const deniedReason = calls.guards[0]({ name: 'session_search' });
  assert.match(deniedReason, /不开放工具/);

  // 缺少服务（mock/非预设环境）时安静跳过，不抛错。
  assert.doesNotThrow(() => solverIsolationPlugin.apply({ effect() {}, get() { return undefined; } }, {}));

  // 有继承工具却限制失败 → 让 preset 挂载失败（fail-closed），不带可见工具运行。
  const failingCtx = {
    tools: {
      schemas: () => [{ name: 'session_search' }],
      restrict: () => { throw new Error('not scoped'); },
      guard: () => () => {}
    },
    systemPrompt: { getSectionOrder: () => 7, section: () => () => {} },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    }
  };
  assert.throws(() => solverIsolationPlugin.apply(failingCtx, {}), /无法在 preset 作用域限制继承工具/);
});

test('隔离插件只访问已 inject 的服务（Cordis 未 inject 的属性访问会打挂 preset）', () => {
  const calls = { sections: [], restrictions: [], guards: [] };
  const base = {
    tools: {
      schemas: () => [{ name: 'session_search' }],
      restrict: (filter) => { calls.restrictions.push(filter); return () => {}; },
      guard: (guard) => { calls.guards.push(guard); return () => {}; }
    },
    systemPrompt: {
      getSectionOrder: () => 7,
      section(definition) { calls.sections.push(definition); return () => {}; }
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    get() { return undefined; }
  };
  const allowed = new Set(['tools', 'systemPrompt', 'effect', 'get']);
  const strictCtx = new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (!allowed.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(target, prop, receiver);
    }
  });
  assert.doesNotThrow(() => solverIsolationPlugin.apply(strictCtx, {}), '不得访问未 inject 的属性（如 ctx.timer）');
  assert.equal(calls.sections.length, 1);
  assert.ok(calls.restrictions.length >= 1);
  assert.equal(calls.guards.length, 1);
});

test('geo_solve：已有同指纹作答时直接复用，不再启动子会话', async () => {
  const prepared = {
    ...DEFAULT_PREPARED,
    state: 'submitted',
    reused: true,
    answer: { answerText: '已有作答', keyEvidence: '已有依据', submittedAt: '2026-11-06T05:00:00.000Z', answerHash: 'oldhash' }
  };
  const harness = createHarness({ prepared });
  const result = await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, { agent: { id: 'agent-main' } });
  assert.equal(result.status, 'success');
  assert.equal(result.reused, true);
  assert.equal(result.independentAnswer, '已有作答');
  assert.equal(result.imageStatus, 'reused');
  assert.equal(harness.calls.activations.length, 0, '复用路径不得再启动子会话');
  assert.equal(harness.calls.presetResolve, 0, '复用路径无需解析预设');
  assert.equal(harness.calls.recordAnswer.length, 0, '复用路径不得覆盖已保存作答');
});

test('geo_solve：题面图片不完整时返回 IMAGE_DELIVERY_INCOMPLETE，不猜、不启动解题', async () => {
  const prepared = {
    ...DEFAULT_PREPARED,
    questionImages: [
      { imageId: 'fig_1', caption: '图1 正常图', rel: 'a.png', sourcePath: 'C:/bank/img/a.png', order: 1 },
      { imageId: 'fig_2', caption: '图2 坏图', rel: 'broken.png', sourcePath: 'C:/bank/img/broken.png', order: 2 }
    ]
  };
  const harness = createHarness({ prepared, bytesFail: true });
  const result = await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, { agent: { id: 'agent-main' } });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'IMAGE_DELIVERY_INCOMPLETE');
  assert.equal(result.imageDelivery.status, 'partial');
  assert.equal(result.imageDelivery.delivered, 1);
  assert.equal(result.imageDelivery.failed.length, 1);
  assert.equal(result.imageDelivery.failed[0].imageId, 'fig_2', '失败项应指认具体题面图片');
  assert.equal(result.imageDelivery.failed[0].code, 'EACCES');
  assert.doesNotMatch(result.imageDelivery.failed[0].message, /C:[\\/]/, '错误信息不得回显本地路径');
  assert.equal(harness.calls.activations.length, 0, '图片不全不得启动解题');
  assert.equal(harness.calls.recordAnswer.length, 0);
  assert.doesNotThrow(() => assertLossless(result, 'geo_solve-image'));
});

test('geo_solve：缺少隔离能力时返回 SOLVER_ISOLATION_UNAVAILABLE，不回落主会话', async () => {
  const cases = [
    { label: '缺 subagents 服务', options: { subagents: null } },
    { label: '缺 agentPresets 服务', options: { agentPresets: null } },
    { label: '内部预设未声明', options: { presetResolveThrows: true } },
    { label: '内部预设挂载失败', options: { presetBroken: 'solver-isolation 挂载失败' } }
  ];
  for (const testCase of cases) {
    const harness = createHarness(testCase.options);
    const result = await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, { agent: { id: 'agent-main' } });
    assert.equal(result.status, 'error', testCase.label);
    assert.equal(result.code, 'SOLVER_ISOLATION_UNAVAILABLE', testCase.label);
    assert.match(result.message, /不回落主会话解题/, testCase.label);
    assert.equal(harness.calls.activations.length, 0, testCase.label);
    assert.doesNotThrow(() => assertLossless(result, testCase.label));
  }

  // 缺调用方 Agent（exec.agent）同样 fail-closed。
  const harness = createHarness();
  const result = await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, {});
  assert.equal(result.code, 'SOLVER_ISOLATION_UNAVAILABLE');
  assert.equal(harness.calls.activations.length, 0);
});

test('geo_solve：子会话未完成 / 空作答 / 启动失败都返回 SOLVER_RUN_FAILED，不保存作答', async () => {
  const scenarios = [
    { label: 'stopReason=error', options: { activationResult: { stopReason: 'error', diagnostic: '模型超时', output: [] } } },
    { label: '空文本', options: { activationResult: { stopReason: 'completed', output: [{ type: 'text', text: '   ' }] } } },
    { label: '启动抛错', options: { activationThrows: true } },
    { label: '运行抛错', options: { activationRejects: true } }
  ];
  for (const scenario of scenarios) {
    const harness = createHarness(scenario.options);
    const result = await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, { agent: { id: 'agent-main' } });
    assert.equal(result.status, 'error', scenario.label);
    assert.equal(result.code, 'SOLVER_RUN_FAILED', scenario.label);
    assert.equal(harness.calls.recordAnswer.length, 0, `${scenario.label}：不保存不完整作答`);
    assert.doesNotThrow(() => assertLossless(result, scenario.label));
  }
  // 启动成功但运行失败时仍要 dispose。
  const harness = createHarness({ activationRejects: true });
  await harness.tools.get('geo_solve').execute({ qid: 'T-B-2' }, { agent: { id: 'agent-main' } });
  assert.equal(harness.calls.dispose, 1);
});

test('geo_judge 两阶段：先开放答案，对照后归档核验结论', async () => {
  const harness = createHarness();
  const tool = harness.tools.get('geo_judge');
  assert.ok(tool, 'geo_judge 应注册');

  // 阶段一：不传 conclusion → 打开答案，返回核验材料。
  const opened = await tool.execute({ qid: 'T-B-2' });
  assert.equal(opened.status, 'success');
  assert.equal(opened.state, 'submitted');
  assert.equal(harness.calls.openReference.length, 1);
  assert.equal(harness.calls.recordVerification.length, 0, '第一阶段不得归档结论');
  assert.equal(opened.independent.answerText.includes('暖流'), true);
  assert.equal(opened.reference.length, 1);
  assert.ok(opened.judgeOpenedAt);
  const openedText = renderJudge({ qid: 'T-B-2' }, opened)[0].text;
  assert.match(openedText, /答案已开放/);
  assert.match(openedText, /再次调用 geo_judge/);
  assert.match(openedText, /结论/);
  assert.doesNotThrow(() => assertLossless(opened, 'geo_judge-open'));

  // 阶段二：传 conclusion → 归档，返回 verified。
  const conclusion = { verdict: 'partially_consistent', matched: ['暖流'], missed: ['地形'], wrong: [], disputed: [], correction: '补地形抬升' };
  const verified = await tool.execute({ qid: 'T-B-2', conclusion });
  assert.equal(verified.status, 'success');
  assert.equal(verified.state, 'verified');
  assert.equal(harness.calls.recordVerification.length, 1);
  assert.deepEqual(harness.calls.recordVerification[0], { qid: 'T-B-2', conclusion });
  assert.equal(harness.calls.openReference.length, 1, '归档阶段不得重复打开答案');
  const verifiedText = renderJudge({ qid: 'T-B-2' }, verified)[0].text;
  assert.match(verifiedText, /核验结论已归档/);
  assert.match(verifiedText, /补地形抬升/);
  assert.doesNotThrow(() => assertLossless(verified, 'geo_judge-verify'));

  // 非法 conclusion 形态是输入错误，不落库。
  for (const bad of [['consistent'], 'consistent', 42]) {
    const result = await tool.execute({ qid: 'T-B-2', conclusion: bad });
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'CONCLUSION_INVALID');
  }
  assert.equal(harness.calls.recordVerification.length, 1, '非法 conclusion 不得写入服务端');
});

test('geo_explain：未核验返回 EXPLAIN_NOT_VERIFIED；核验后讲稿带 server_run_record 与同类题比较', async () => {
  const notVerified = createHarness();
  const refused = await notVerified.tools.get('geo_explain').execute({ qid: 'T-B-2' });
  assert.equal(refused.status, 'error');
  assert.equal(refused.code, 'EXPLAIN_NOT_VERIFIED');
  assert.equal(refused.solveStatus.state, 'none');
  assert.deepEqual(notVerified.calls.assembleExplanation, [{ qid: 'T-B-2', audience: 'student' }], '缺省对象按 student 交给内核');
  const refusedText = renderExplain({ qid: 'T-B-2' }, refused)[0].text;
  assert.match(refusedText, /EXPLAIN_NOT_VERIFIED/);
  assert.doesNotThrow(() => assertLossless(refused, 'geo_explain-refused'));

  // 非法 audience 是输入错误，不触发内核。
  const badAudience = createHarness();
  const invalid = await badAudience.tools.get('geo_explain').execute({ qid: 'T-B-2', audience: 'nope' });
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.code, 'INVALID_AUDIENCE');
  assert.equal(badAudience.calls.assembleExplanation.length, 0);

  // 已核验：讲稿骨架 + 服务端证据 + 同类题比较。
  const question = {
    questionId: 'T-B-2',
    file: 'B.md',
    material: '乙地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。',
    stem: '分析乙地气温高于同纬度的原因。',
    options: [],
    answer: '暖流增温',
    analysis: '沿岸暖流增温增湿。',
    knowledgePoints: [{ role: 'core_exam_point', knowledge_unit: '洋流对地理环境的影响', weight: '1.0' }],
    meta: { year: 2025, region: '安徽', question_numbers: '1' }
  };
  const comparison = {
    basis: [{
      questionId: 'T-B-1',
      file: 'B.md',
      groupLabel: '2025安徽卷 第1题',
      stem: '分析甲地气温高于同纬度的原因。',
      questionType: '原因分析',
      sharedTask: '设问任务相同（原因分析）',
      sharedReasoning: '材料证据维度相近（气候）',
      sharedMaterial: '情境类型相同（区域案例）',
      differences: ''
    }],
    insufficient: false,
    gap: ''
  };
  const report = buildExplainerReport(question, false, [], 'student', comparison);
  const verifiedResult = {
    status: 'success',
    questionId: 'T-B-2',
    audience: 'student',
    report,
    variants: [],
    comparison,
    verification: {
      status: 'verified',
      verified: true,
      evidence: 'server_run_record',
      runId: 'RUN-1',
      submittedAt: '2026-11-06T05:00:00.000Z',
      judgeOpenedAt: '2026-11-06T05:01:00.000Z',
      verifiedAt: '2026-11-06T05:02:00.000Z',
      conclusion: { verdict: 'partially_consistent', matched: ['暖流'], missed: ['地形'], wrong: [], disputed: [], correction: '补地形抬升' },
      message: '核验状态来自服务端运行记录：答案在作答提交后开放，核验结论已归档。'
    }
  };
  const verifiedHarness = createHarness({ explainResult: verifiedResult });
  const explained = await verifiedHarness.tools.get('geo_explain').execute({ qid: 'T-B-2' });
  assert.equal(explained.status, 'success');
  assert.equal(explained.audience, 'student');
  assert.equal(explained.audienceExplicit, false, '缺省对象应标记为非显式传入');
  assert.doesNotThrow(() => assertLossless(explained, 'geo_explain-verified'));

  const text = renderExplain({ qid: 'T-B-2' }, explained)[0].text;
  assert.match(text, /核验状态/);
  assert.match(text, /server_run_record/);
  assert.match(text, /核验状态来自服务端运行记录/);
  assert.match(text, /同类问题比较（题库检索依据）/);
  assert.match(text, /T-B-1/);
  assert.match(text, /共同点：设问任务相同/);
  assert.match(text, /引用要求：/);
  assert.match(text, /^## 题目定位$/m);
  assert.match(text, /^## 同类问题比较（题库检索依据）$/m);
  assert.equal(report.contentRequirements.length, 4);
});

// ========== 6. 内核端到端：服务端 run + 持久化 + 题面变化失效 ==========
const CORE_MAIN_MD = `---
year: "2025"
region: "安徽"
question_numbers: "1"
---

# 测试题组

## 题组材料
某地位于沿海，受暖流影响，气温较高，降水较多，地形以平原为主。图1示意位置。

![位置示意图](../../img/CORE__shared__01.png)

## 相关图片
![地貌景观](../../img/CORE__shared__02.png)

### 第1题
question_id: \`T-CORE-1-Q1\`

**题干**：分析该地气温高于同纬度的原因。

**答案**：受暖流增温影响，气温较高。

**解析**：沿岸暖流增温增湿，因此气温偏高。

![解析示意图](../../img/T-CORE-1-Q1__02.png)

### 第2题
question_id: \`T-CORE-1-Q2\`

**题干**：说明该地降水较多的原因。

**答案**：暖流增湿，地形抬升。

**解析**：暖流提供水汽，地形抬升形成降水。

## 教学备注
- 课堂提示：本题强调洋流对气候的影响。
`;

const CORE_BOUNDARY_MD = `## 题组材料
边界不明的题。

### 第9题
question_id: \`T-CORE-2-Q9\`

**题干**：这题缺少答案标记。
`;

const CORE_TRACE_MD = `## 题组材料
题面区混入答案痕迹的题。

### 第8题
question_id: \`T-CORE-3-Q8\`

**题干**：这题的题面区混入了答案痕迹。

答案：B

**答案**：B
**解析**：解析正文。
`;

function createKernelHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-isolated-solve-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bankDir = path.join(root, 'bank');
  const outDir = path.join(root, 'outputs');
  fs.mkdirSync(bankDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(bankDir, '2025安徽测试卷.md'), CORE_MAIN_MD);
  fs.writeFileSync(path.join(bankDir, '2025安徽边界卷.md'), CORE_BOUNDARY_MD);
  fs.writeFileSync(path.join(bankDir, '2025安徽痕迹卷.md'), CORE_TRACE_MD);

  const service = {
    resolve: async (target) => target,
    listDir: async (dir) => fs.readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : 'file',
      target: path.join(dir, entry.name)
    })),
    readText: async (file) => fs.readFileSync(file, 'utf8'),
    readBytes: async (file) => fs.readFileSync(file),
    stat: async (file) => fs.statSync(file),
    processPath: (target) => target,
    writeText: async (file, text) => {
      assert.ok(path.resolve(file).startsWith(path.resolve(root)), '写盘必须落在临时目录内');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };

  function mount(overrides = {}) {
    let api = null;
    corePlugin.apply(
      { fs: service, webServer: { register() {} }, provide: (name, value) => { api = value; } },
      { questionBankPath: bankDir, outputPath: outDir, workspaceRoot: root, ...overrides }
    );
    return api;
  }

  return {
    root,
    bankDir,
    outDir,
    mount,
    writeMain(mdText) { fs.writeFileSync(path.join(bankDir, '2025安徽测试卷.md'), mdText); },
    readRuns() {
      const file = path.join(outDir, 'solve-runs.json');
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    }
  };
}

test('内核：题组共用一个 run（groupKey 为题组首题），题面图片与解析图分离', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();

  const prep = await api.prepareSolve('T-CORE-1-Q2');
  assert.equal(prep.status, 'success');
  assert.equal(prep.questionId, 'T-CORE-1-Q2', '返回请求的小问 id');
  assert.equal(prep.groupKey, 'T-CORE-1-Q1', 'run 键为题组首题');
  assert.equal(prep.state, SOLVE_STATES.READY);
  assert.equal(prep.reused, false);
  assert.equal(prep.questions.length, 2, '题组内相互提示的小问整体交给解题会话');
  assert.equal(prep.answer, null, '未提交时不得返回答案');
  // 契约 §3：成功路径必须显式返回空 boundaryIssues 数组（有边界问题时走 QUESTION_BOUNDARY_UNCERTAIN 错误分支）。
  assert.deepEqual(prep.boundaryIssues, [], 'prepareSolve 成功返回应显式给出空边界问题数组');

  const questionRels = prep.questionImages.map((img) => img.rel.split('/').pop());
  assert.equal(questionRels.some((rel) => rel.endsWith('CORE__shared__01.png')), true);
  assert.equal(questionRels.some((rel) => rel.endsWith('CORE__shared__02.png')), true);
  assert.equal(questionRels.includes('T-CORE-1-Q1__02.png'), false, '解析图不得进入解题输入');
  assert.equal(prep.analysisImageCount, 1, '解析图数量单独计数');
  assert.ok(prep.questionImages.every((img) => /^[A-Za-z]:[\\/]/.test(img.sourcePath)), '题面图片应解析为磁盘绝对路径');

  // 同一题组的另一个小问拿到同一个 run，不会重复解题。
  const prepSibling = await api.prepareSolve('T-CORE-1-Q1');
  assert.equal(prepSibling.runId, prep.runId, '同一题组共用一个 run');
  assert.equal(prepSibling.groupKey, prep.groupKey);

  const status = await api.solveStatus('T-CORE-1-Q1');
  assert.equal(status.state, SOLVE_STATES.READY);
  assert.equal(status.runId, prep.runId);
  assert.equal(status.fingerprintMatches, true);
  assert.equal(status.canJudge, false);
  assert.equal(status.canExplain, false);
  assert.doesNotThrow(() => assertLossless(prep, 'prepareSolve'));
});

test('内核：未提交不给答案、未开答案不能归档、归档后讲稿可用', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();
  const prep = await api.prepareSolve('T-CORE-1-Q2');

  const earlyOpen = await api.openReferenceAnswer('T-CORE-1-Q2');
  assert.equal(earlyOpen.status, 'error');
  assert.equal(earlyOpen.code, 'SOLVE_NOT_SUBMITTED');
  assert.doesNotThrow(() => assertLossless(earlyOpen, 'open-before-submit'));

  const earlyVerify = await api.recordVerification('T-CORE-1-Q2', { verdict: 'consistent' });
  assert.equal(earlyVerify.status, 'error');
  assert.equal(earlyVerify.code, 'SOLVE_NOT_SUBMITTED');

  const recorded = await api.recordIndependentAnswer(prep.runId, {
    answerText: '## 答案\n暖流增温\n\n## 关键依据\n沿岸暖流\n\n## 推理过程\n证据→知识→结论',
    keyEvidence: '沿岸暖流',
    childSessionId: 'child-core'
  });
  assert.equal(recorded.status, 'success');
  assert.equal(recorded.state, SOLVE_STATES.SUBMITTED);
  assert.equal(recorded.questionId, 'T-CORE-1-Q1', '服务端 run 按题组键记录');
  assert.ok(recorded.answerHash);

  const verifyBeforeOpen = await api.recordVerification('T-CORE-1-Q2', { verdict: 'consistent' });
  assert.equal(verifyBeforeOpen.code, 'JUDGE_NOT_OPENED', '取得答案只是核验开始，未开放不能归档');

  const explainedTooEarly = await api.assembleExplanation('T-CORE-1-Q2', 'student');
  assert.equal(explainedTooEarly.status, 'error');
  assert.equal(explainedTooEarly.code, 'EXPLAIN_NOT_VERIFIED');

  const opened = await api.openReferenceAnswer('T-CORE-1-Q2');
  assert.equal(opened.status, 'success');
  assert.equal(opened.state, SOLVE_STATES.SUBMITTED);
  assert.deepEqual(opened.independent.answerText.startsWith('## 答案'), true);
  assert.equal(opened.reference.length, 2, '题组内小问统一开放答案');
  assert.ok(opened.reference.every((ref) => ref.standardAnswer && ref.analysis), '参考答案与解析应一并开放');
  assert.ok(opened.judgeOpenedAt);
  assert.doesNotThrow(() => assertLossless(opened, 'openReferenceAnswer'));

  const badVerdict = await api.recordVerification('T-CORE-1-Q2', { verdict: 'consistent-ish' });
  assert.equal(badVerdict.code, 'CONCLUSION_INVALID');

  const firstVerified = await api.recordVerification('T-CORE-1-Q2', {
    verdict: 'partially_consistent',
    matched: ['暖流增温'],
    missed: ['地形抬升'],
    wrong: [],
    disputed: [],
    correction: '补充地形抬升这一采分点'
  });
  assert.equal(firstVerified.status, 'success');
  assert.equal(firstVerified.state, SOLVE_STATES.SUBMITTED, '题组内还有小问未归档时不算核验完成');
  assert.deepEqual(firstVerified.pendingQuestionIds, ['T-CORE-1-Q1']);
  assert.equal((await api.solveStatus('T-CORE-1-Q2')).canExplain, false, '题组未全部归档时不能出讲稿');
  assert.equal((await api.assembleExplanation('T-CORE-1-Q2', 'student')).code, 'EXPLAIN_NOT_VERIFIED');

  const secondVerified = await api.recordVerification('T-CORE-1-Q1', {
    verdict: 'consistent',
    matched: ['暖流增温'],
    missed: [],
    wrong: [],
    disputed: [],
    correction: ''
  });
  assert.equal(secondVerified.state, SOLVE_STATES.VERIFIED);
  assert.deepEqual(secondVerified.pendingQuestionIds, []);
  assert.ok(secondVerified.verifiedAt);

  const status = await api.solveStatus('T-CORE-1-Q2');
  assert.equal(status.state, SOLVE_STATES.VERIFIED);
  assert.equal(status.canExplain, true);
  assert.equal(status.fingerprintMatches, true);
  assert.equal(status.verifiedCount, 2);
  assert.equal(status.questionCount, 2);

  const explained = await api.assembleExplanation('T-CORE-1-Q2', 'student');
  assert.equal(explained.status, 'success');
  assert.equal(explained.verification.evidence, 'server_run_record', '核验证据来自服务端运行记录');
  assert.equal(explained.verification.verified, true);
  assert.equal(explained.verification.runId, prep.runId);
  assert.equal(explained.verification.conclusion.verdict, 'partially_consistent', '讲稿读取的是本小问的核验结论');
  assert.equal(explained.verification.conclusions['T-CORE-1-Q1'].verdict, 'consistent', '题组内各小问结论分别保存');
  assert.equal(explained.report.schemaVersion, 3);
  assert.equal(explained.report.cacheKey.includes('#rules3'), true);
  assert.equal(explained.report.contentRequirements.length, 4);
  assert.ok(explained.report.structure.locate.knowledgeRole);
  assert.ok(explained.report.structure.solve.comparison);
  assert.ok(explained.report.structure.reflect.transfer);
  // 题库里只有同题组，同类题不足时必须如实给缺口，不能用同题组充数。
  assert.equal(explained.comparison.insufficient, true);
  assert.match(explained.comparison.gap, /不足 2 道/);
  assert.deepEqual(explained.comparison.basis, []);
  assert.doesNotThrow(() => assertLossless(explained, 'assembleExplanation'));
});

test('内核：run 持久化到 solve-runs.json，重启（重新挂载）后仍可核验讲题', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();
  const prep = await api.prepareSolve('T-CORE-1-Q1');
  await api.recordIndependentAnswer(prep.runId, { answerText: '## 答案\n暖流增温', keyEvidence: '暖流', childSessionId: 'child-persist' });
  await api.openReferenceAnswer('T-CORE-1-Q1');
  await api.recordVerification('T-CORE-1-Q1', { verdict: 'consistent', matched: ['暖流增温'], missed: [], wrong: [], disputed: [], correction: '' });
  await api.recordVerification('T-CORE-1-Q2', { verdict: 'consistent', matched: ['暖流增温'], missed: [], wrong: [], disputed: [], correction: '' });

  const saved = harness.readRuns();
  assert.ok(saved, '核验完成后应写 solve-runs.json');
  assert.equal(saved.version, 1);
  assert.equal(Array.isArray(saved.runs), true);
  const run = saved.runs.find((item) => item.runId === prep.runId);
  assert.ok(run, '持久化记录应包含本题 run');
  assert.equal(run.state, SOLVE_STATES.VERIFIED);
  assert.equal(run.questionFingerprint, prep.questionFingerprint);
  assert.equal(run.answer.childSessionId, 'child-persist', '独立作答与子会话 id 一并持久化');
  assert.deepEqual(Object.keys(run.conclusions).sort(), ['T-CORE-1-Q1', 'T-CORE-1-Q2'], '核验结论按小问分别持久化');
  assert.equal(run.conclusions['T-CORE-1-Q1'].verdict, 'consistent');

  // 重新挂载：新实例从磁盘恢复 run，重启后仍能讲题。
  const restarted = harness.mount();
  const status = await restarted.solveStatus('T-CORE-1-Q1');
  assert.equal(status.state, SOLVE_STATES.VERIFIED);
  assert.equal(status.fingerprintMatches, true);
  const explained = await restarted.assembleExplanation('T-CORE-1-Q1', 'teacher');
  assert.equal(explained.status, 'success');
  assert.equal(explained.audience, 'teacher');
  assert.equal(explained.verification.evidence, 'server_run_record');
  assert.doesNotThrow(() => assertLossless(explained, 'assembleExplanation-restored'));
});

test('内核：题面变化使旧作答与核验失效，必须重新解题', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();
  const prep = await api.prepareSolve('T-CORE-1-Q1');
  await api.recordIndependentAnswer(prep.runId, { answerText: '## 答案\n暖流增温', keyEvidence: '暖流' });
  await api.openReferenceAnswer('T-CORE-1-Q1');
  await api.recordVerification('T-CORE-1-Q1', { verdict: 'consistent' });
  await api.recordVerification('T-CORE-1-Q2', { verdict: 'consistent' });
  assert.equal((await api.solveStatus('T-CORE-1-Q1')).state, SOLVE_STATES.VERIFIED);

  // 改题面（题干变化）→ 指纹变化 → 旧 run 失效。
  harness.writeMain(CORE_MAIN_MD.replace('分析该地气温高于同纬度的原因。', '分析该地气温高于同纬度的主要原因。'));
  api.invalidateBankCache();

  const status = await api.solveStatus('T-CORE-1-Q1');
  assert.equal(status.fingerprintMatches, false, '题面变化后指纹必须失配');
  assert.equal(status.canExplain, false);

  const explained = await api.assembleExplanation('T-CORE-1-Q1', 'student');
  assert.equal(explained.status, 'error');
  assert.equal(explained.code, 'QUESTION_VERSION_CHANGED');
  assert.doesNotThrow(() => assertLossless(explained, 'assembleExplanation-stale'));

  const reopened = await api.openReferenceAnswer('T-CORE-1-Q1');
  assert.equal(reopened.code, 'QUESTION_VERSION_CHANGED', '题面变化后旧答案不得再次开放');
});

test('内核：题答边界不明时指出具体题目并阻断解题（不猜测切分）', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();

  const missing = await api.prepareSolve('T-CORE-2-Q9');
  assert.equal(missing.status, 'error');
  assert.equal(missing.code, 'QUESTION_BOUNDARY_UNCERTAIN');
  assert.equal(missing.questionId, 'T-CORE-2-Q9');
  assert.ok(missing.file && missing.file.includes('边界卷'));
  assert.equal(missing.boundaryIssues[0].kind, 'missing_answer_marker');
  assert.doesNotThrow(() => assertLossless(missing, 'prepareSolve-boundary'));

  const traced = await api.prepareSolve('T-CORE-3-Q8');
  assert.equal(traced.code, 'QUESTION_BOUNDARY_UNCERTAIN');
  assert.equal(traced.boundaryIssues[0].kind, 'answer_text_in_question_area');
  assert.match(traced.boundaryIssues[0].snippet, /答案：B/);

  // 边界问题的题不得产生 run，也不得被当作可解题。
  const status = await api.solveStatus('T-CORE-2-Q9');
  assert.equal(status.status, 'success');
  assert.equal(status.state, 'none');
  assert.equal(status.runId, null);
});

test('内核：similarQuestions 走题库检索，不用同题组充数', async (t) => {
  const harness = createKernelHarness(t);
  const api = harness.mount();
  const result = await api.similarQuestions('T-CORE-1-Q1', 5);
  assert.equal(result.status, 'success');
  assert.equal(result.insufficient, true);
  assert.deepEqual(result.basis, []);
  assert.match(result.gap, /不足 2 道/);
  assert.doesNotThrow(() => assertLossless(result, 'similarQuestions'));
});
