// 命题包校验/渲染的行为测试（node --test test/question-package.test.mjs）
//
// 覆盖：
//   1) 两份样例作为**正例**必须零 fail；
//   2) 构造**反例**，逐条证明校验器真的能检出（正例+反例成对才算验收，见执行方案 §9 M3）；
//   3) 投影与渲染的边界（学生投影不含答案侧字段、Markdown 六章节）；
//   4) CLI 的只读默认、--render 写盘、退出码与路径约束。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  validatePackage,
  validateAgainstSchema,
  checkInvariants,
  buildValidationReport,
  buildStudentProjection,
  buildTeacherProjection,
  renderMarkdown,
  resolveTaskDir,
  isValidTaskId,
  fingerprint,
  findNonLossless,
  toLosslessJson,
} from '../.agent-presets/geo-teacher/plugins/question/package.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const SCHEMA = JSON.parse(readFileSync(join(REPO, '.agent-presets', 'geo-teacher', 'plugins', 'question', 'package.schema.json'), 'utf8'));
const CHOICE_FILE = join(REPO, 'docs', 'examples', 'question-package.sample.json');
const COMP_FILE = join(REPO, 'docs', 'examples', 'question-package-comprehensive.sample.json');
const CLI = join(REPO, '.agent-presets', 'geo-teacher', 'skills', 'geo-question-generator', 'scripts', 'check-package.mjs');

const clone = (x) => JSON.parse(JSON.stringify(x));
const loadChoice = () => JSON.parse(readFileSync(CHOICE_FILE, 'utf8'));
const loadComp = () => JSON.parse(readFileSync(COMP_FILE, 'utf8'));
const run = (pkg) => validatePackage(pkg, { schema: SCHEMA });
const report = (pkg) => buildValidationReport(pkg, run(pkg), {});
const fails = (f) => f.filter((x) => x.level === 'fail');

/** 断言存在一条满足条件的 finding。 */
function expectFinding(findings, { level = 'fail', gate, pointer, message }) {
  const hit = findings.find((f) =>
    (level === null || f.level === level) &&
    (gate === undefined || f.gate === gate) &&
    (pointer === undefined || f.pointer.includes(pointer)) &&
    (message === undefined || f.message.includes(message)));
  assert.ok(hit, '未命中预期 finding：' + JSON.stringify({ level, gate, pointer, message }) +
    '\n实际 findings：\n' + findings.map((f) => `  [${f.level}] ${f.gate} ${f.pointer} ${f.message}`).join('\n'));
  return hit;
}

// ── 正例 ────────────────────────────────────────────────────────────────
describe('正例：两份样例必须零 fail', () => {
  test('选择题组样例', () => {
    const f = run(loadChoice());
    assert.equal(fails(f).length, 0, '选择题样例出现 fail：\n' + fails(f).map((x) => x.pointer + ' ' + x.message).join('\n'));
  });
  test('综合题样例', () => {
    const f = run(loadComp());
    assert.equal(fails(f).length, 0, '综合题样例出现 fail：\n' + fails(f).map((x) => x.pointer + ' ' + x.message).join('\n'));
  });
  test('两份样例的完成度都只到 draft_complete（有阻断项 + 无语义评审）', () => {
    for (const pkg of [loadChoice(), loadComp()]) {
      const r = report(pkg);
      assert.equal(r.structureOk, true);
      assert.equal(r.effectiveReadiness, 'draft_complete', pkg.taskId);
      assert.equal(r.readinessClaimOk, true);
      assert.equal(r.semanticComplete, false, '校验器不得宣称语义完成');
    }
  });
  test('门禁：结构 pass / 语义恒 pending，且不得宣称语义完成', () => {
    const r = report(loadComp());
    for (const g of r.gates) {
      assert.equal(g.structural, 'pass', g.id);
      assert.equal(g.semantic, 'pending', g.id + ' 的语义项必须保持 pending');
    }
    assert.equal(r.semanticComplete, false);
    assert.ok(r.note.includes('语义项一律 pending'), '报告须写明语义项一律 pending');
  });
  test('反例：本 revision 没有语义评审记录时，列为阻止「可使用」的一项', () => {
    // 样例的 RV2 是 semantic 且绑 revision 2；把 revision 递到 3 后旧评审即失效
    const pkg = loadComp(); pkg.revision = 3;
    const r = report(pkg);
    assert.ok(r.usableBlockers.some((b) => b.includes('没有语义评审记录')),
      '应把"本 revision 没有语义评审记录"列为阻断项，实际：' + JSON.stringify(r.usableBlockers));
    assert.equal(r.effectiveReadiness, 'draft_complete');
  });
  test('完成度口径：结构与声明相符时为 equal', () => {
    const r = report(loadChoice());
    assert.equal(r.readinessClaim, 'equal');
    assert.equal(r.readinessClaimOk, true);
  });
  test('完成度口径：结构失败仍声明 draft_complete 属过度声明', () => {
    const pkg = loadChoice(); pkg.schemaVersion = 1;
    const r = report(pkg);
    assert.equal(r.effectiveReadiness, 'pending');
    assert.equal(r.readinessClaim, 'over');
    assert.equal(r.readinessClaimOk, false);
  });
});

// ── 反例：schema 层 ─────────────────────────────────────────────────────
describe('反例：契约（schema）层', () => {
  test('schemaVersion=1 的旧题包报「待迁移」，不按 v2 放行', () => {
    const pkg = loadChoice(); pkg.schemaVersion = 1;
    const f = run(pkg);
    expectFinding(f, { pointer: '/schemaVersion', message: '不能按 v2 校验' });
    assert.equal(report(pkg).structureOk, false);
  });
  test('题组项缺 itemType', () => {
    const pkg = loadChoice(); delete pkg.questionSet.items[0].itemType;
    const f = run(pkg);
    expectFinding(f, { message: 'itemType' });
  });
  test('选择题答案越出 A/B/C/D', () => {
    const pkg = loadChoice(); pkg.questionSet.items[0].answer = 'E';
    expectFinding(run(pkg), { pointer: '/answer' });
  });
  test('综合题 rubric 少于一档', () => {
    const pkg = loadComp(); pkg.questionSet.items[0].subQuestions[0].rubric = [pkg.questionSet.items[0].subQuestions[0].rubric[0]];
    expectFinding(run(pkg), { pointer: '/rubric', message: '至少 2 项' });
  });
  test('综合题 answerBoundary.unacceptable 为空', () => {
    const pkg = loadComp(); pkg.questionSet.items[0].subQuestions[0].answerBoundary.unacceptable = [];
    expectFinding(run(pkg), { pointer: '/unacceptable', message: '至少 1 项' });
  });
  test('readiness=usable 但仍有 blocking 风险', () => {
    const pkg = loadComp(); pkg.readiness = 'usable';
    expectFinding(run(pkg), { gate: 'schema', pointer: '/risks' });
  });
  test('综合题题组出现第二项', () => {
    const pkg = loadComp(); pkg.questionSet.items.push(clone(pkg.questionSet.items[0]));
    expectFinding(run(pkg), { pointer: '/questionSet/items', message: '恰好 1 项' });
  });
});

// ── 反例：跨字段不变式（schema 表达不了） ────────────────────────────────
describe('反例：跨字段不变式', () => {
  test('分值三级求和（一）：小问之和 ≠ totalPoints', () => {
    const pkg = loadComp(); pkg.questionSet.items[0].totalPoints = 21;
    expectFinding(run(pkg), { gate: 'G4', pointer: '/totalPoints', message: '三级求和（一）' });
  });
  test('分值三级求和（二）：采分点之和 ≠ 该问 points', () => {
    const pkg = loadComp(); pkg.questionSet.items[0].subQuestions[0].answerKey[2].points = 3;
    expectFinding(run(pkg), { gate: 'G4', pointer: '/points', message: '三级求和（二）' });
  });
  test('采分点缺证据链', () => {
    const pkg = loadComp(); pkg.questionSet.items[0].subQuestions[1].answerKey[0].evidenceChain = '   ';
    expectFinding(run(pkg), { gate: 'G4', pointer: '/evidenceChain' });
  });
  test('引用了不存在的来源 id', () => {
    const pkg = loadComp(); pkg.sources = pkg.sources.filter((s) => s.sourceId !== 'S2');
    expectFinding(run(pkg), { gate: 'G2', message: '引用了不存在的来源 id：S2' });
  });
  test('学生投影禁用字段（源数据里也不该出现于投影）', () => {
    const proj = buildStudentProjection(loadComp());
    const text = JSON.stringify(proj);
    for (const k of ['answerKey', 'rubric', 'answerBoundary', 'misconceptionPatterns', 'analysis', 'distractorMap']) {
      assert.ok(!text.includes('"' + k + '"'), '学生投影泄漏字段 ' + k);
    }
    assert.ok(text.includes('subQuestionId') && text.includes('points'), '综合题学生投影应含小问 id 与分值');
  });
  test('学生投影命中答案泄漏词形（题干里出现「答案为」）', () => {
    const pkg = loadChoice(); pkg.questionSet.items[0].stem = '该地近地面气压较低，答案为 A。';
    expectFinding(run(pkg), { level: 'warn', message: '答案泄漏词形' });
  });
  test('附件名夹带答案提示', () => {
    const pkg = loadChoice();
    pkg.visuals[0].status = 'generated';
    pkg.visuals[0].files = ['visuals/答案对比图.png'];
    expectFinding(run(pkg), { level: 'warn', message: '答案泄漏词形' });
  });
  test('模拟：命中∪遗漏 ≠ 该问采分点全集', () => {
    const pkg = loadComp();
    const r = pkg.simulations[0].responses[1]; // Q1-2：原本命中 KP-4～KP-7
    r.hitPointIds = ['KP-4', 'KP-5', 'KP-6'];
    r.missedPointIds = [];
    expectFinding(run(pkg), { gate: 'G4', message: '命中∪遗漏' });
  });
  test('模拟：同一采分点既命中又遗漏', () => {
    const pkg = loadComp(); pkg.simulations[0].responses[0].missedPointIds = ['KP-1'];
    expectFinding(run(pkg), { gate: 'G4', message: '既命中又遗漏' });
  });
  test('模拟：三档命中完全相同（采分点无法区分水平）', () => {
    const pkg = loadComp();
    pkg.simulations[1].responses = clone(pkg.simulations[0].responses);
    pkg.simulations[2].responses = clone(pkg.simulations[0].responses);
    expectFinding(run(pkg), { gate: 'G4', message: '完全相同' });
  });
  test('模拟：漏掉某一小问的作答', () => {
    const pkg = loadComp(); pkg.simulations[0].responses.pop();
    expectFinding(run(pkg), { gate: 'G6', message: '模拟未覆盖' });
  });
  test('选择题：正确项出现在 distractorMap', () => {
    const pkg = loadChoice(); pkg.questionSet.items[0].distractorMap.A = { misconceptionId: null, errorType: '概念混淆' };
    expectFinding(run(pkg), { gate: 'G4', message: '正确项 A 出现在 distractorMap' });
  });
  test('选择题：选项重复（答案唯一的前提被破坏）', () => {
    const pkg = loadChoice(); pkg.questionSet.items[0].options.B = pkg.questionSet.items[0].options.A;
    expectFinding(run(pkg), { gate: 'G4', message: '选项存在重复' });
  });
  test('确认记录绑定了旧 revision', () => {
    const pkg = loadChoice(); pkg.confirmations[0].objectRevision = 99;
    expectFinding(run(pkg), { gate: 'G3', message: '旧确认已失效' });
  });
  test('综合题把难度第四维写成干扰项分析', () => {
    const pkg = loadComp(); pkg.design.expectedDifficulty.distractorDiscrimination = '每个干扰项对应一种认知错误';
    expectFinding(run(pkg), { gate: 'G6', message: '不得把难度第四维写成干扰项分析' });
  });
  test('伪统计写法被拒（正确率 85%）', () => {
    const pkg = loadComp(); pkg.design.expectedDifficulty.rationale.push('预计正确率 85%');
    expectFinding(run(pkg), { gate: 'G6', message: '伪统计写法' });
  });
  test('维度名「干扰项区分度」不算伪统计（避免误伤）', () => {
    const f = run(loadChoice());
    assert.ok(!f.some((x) => x.message.includes('伪统计')), '正常的难度维度描述不应被判为伪统计');
  });
  test('needs_review 节点未提示', () => {
    const pkg = loadComp();
    pkg.risks.forEach((r) => { r.blocking = false; delete r.description; });
    expectFinding(run(pkg), { gate: 'G1', message: '但没有提示' });
  });
  test('taxonomyGap=true 但 unresolved 为空', () => {
    const pkg = loadComp(); pkg.knowledge.taxonomyGap = true;
    expectFinding(run(pkg), { gate: 'G1', pointer: '/unresolved' });
  });
  test('题面引用不存在的图表', () => {
    const pkg = loadChoice(); pkg.questionSet.material.visualRefs = ['V9'];
    expectFinding(run(pkg), { gate: 'G5', message: '不存在的图表' });
  });
  test('visuals[].files 在未生成状态下非空', () => {
    const pkg = loadComp(); pkg.visuals[0].files = ['visuals/x.png'];
    expectFinding(run(pkg), { gate: 'G5', message: 'files 必须为空' });
  });
  test('地图标为 generated 却没有 type=map 的官方来源', () => {
    const pkg = loadComp(); pkg.visuals[0].status = 'generated';
    expectFinding(run(pkg), { gate: 'G5', message: '地图已标为 generated' });
  });
});

// ── 投影与渲染 ──────────────────────────────────────────────────────────
describe('投影与渲染', () => {
  test('教师投影包含答案侧内容，学生投影不含', () => {
    const pkg = loadComp();
    assert.ok(JSON.stringify(buildTeacherProjection(pkg)).includes('answerKey'));
    assert.ok(!JSON.stringify(buildStudentProjection(pkg)).includes('answerKey'));
  });
  test('投影带 sourceRevision 与内容指纹', () => {
    const pkg = loadChoice();
    for (const proj of [buildStudentProjection(pkg), buildTeacherProjection(pkg)]) {
      assert.equal(proj.sourceRevision, pkg.revision);
      assert.match(proj.contentHash, /^sha256:[0-9a-f]{64}$/);
    }
  });
  test('指纹随内容变化（改一个字就变）', () => {
    const a = loadChoice(); const b = clone(a);
    b.questionSet.items[0].stem += '（改）';
    assert.notEqual(fingerprint(a), fingerprint(b));
  });
  test('Markdown 含六大章节与题型标记（选择题组）', () => {
    const md = renderMarkdown(loadChoice());
    for (const h of ['## 一、学生用试题', '## 二、答案与解析', '## 三、命题设计说明', '## 四、典型学生模拟作答', '## 五、来源与证据', '## 六、风险与待确认事项']) {
      assert.ok(md.includes(h), '缺章节：' + h);
    }
    assert.ok(md.includes('材料型选择题组'));
    assert.ok(md.includes('### 干扰项分析'));
  });
  test('Markdown 含六大章节与题型标记（综合题）', () => {
    const md = renderMarkdown(loadComp());
    assert.ok(md.includes('材料型综合题'));
    assert.ok(md.includes('### 评分标准与答案边界'));
    assert.ok(md.includes('判为正确：') && md.includes('判为错答或不给分：'));
    assert.ok(md.includes('预测性认知路径'));
    assert.ok(md.includes('待复核节点'), '应明示 needs_review 节点');
  });
});

// ── taskId 与路径约束 ───────────────────────────────────────────────────
describe('taskId 与路径约束', () => {
  test('合法 taskId', () => {
    assert.equal(isValidTaskId('2026-1004-ecofragile-01'), true);
  });
  test('非法 taskId（过短/含分隔符/穿越）', () => {
    for (const bad of ['short', '../escape', 'a/b', 'has space', '']) assert.equal(isValidTaskId(bad), false, bad);
  });
  test('resolveTaskDir 拒绝越界', () => {
    assert.equal(resolveTaskDir('E:/out/出题', '..').ok, false);
    assert.equal(resolveTaskDir('E:/out/出题', 'x/../../y').ok, false);
    assert.equal(resolveTaskDir('E:/out/出题', '2026-1004-ecofragile-01').ok, true);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────
describe('CLI（check-package.mjs）', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'geo-question-cli-'));
  const taskId = '2026-0927-heat-circulation';
  const taskDir = join(tmpRoot, taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'package.json'), JSON.stringify(loadChoice(), null, 2), 'utf8');

  const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  test('默认只读校验：退出码 0，且不写任何文件', () => {
    const res = cli(['--task', taskId, '--out', tmpRoot, '--quiet']);
    if (res.error) { console.error('跳过（无法 spawn 子进程）：' + res.error.message); return; }
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'PASS ' + taskId + ' r8 fail=0 warn=1');
    assert.ok(!existsSync(join(taskDir, 'draft.md')), '默认不得写盘');
    assert.ok(!existsSync(join(taskDir, 'validation.json')), '默认不得写盘');
  });

  test('--render 写出四个产物', () => {
    const res = cli(['--task', taskId, '--out', tmpRoot, '--render', '--quiet']);
    if (res.error) { console.error('跳过（无法 spawn 子进程）：' + res.error.message); return; }
    assert.equal(res.status, 0, res.stderr);
    for (const name of ['draft.md', 'student.json', 'teacher.json', 'validation.json']) {
      assert.ok(existsSync(join(taskDir, name)), '未写出 ' + name);
    }
    const v = JSON.parse(readFileSync(join(taskDir, 'validation.json'), 'utf8'));
    assert.equal(v.taskId, taskId);
    assert.equal(v.structureOk, true);
    const s = JSON.parse(readFileSync(join(taskDir, 'student.json'), 'utf8'));
    assert.equal(s.kind, 'student_projection');
    assert.ok(!JSON.stringify(s).includes('distractorMap'));
  });

  test('结构失败退出码 1', () => {
    const bad = clone(loadChoice()); bad.schemaVersion = 1;
    writeFileSync(join(taskDir, 'package.json'), JSON.stringify(bad), 'utf8');
    const res = cli(['--task', taskId, '--out', tmpRoot, '--quiet']);
    if (res.error) { console.error('跳过（无法 spawn 子进程）：' + res.error.message); return; }
    assert.equal(res.status, 1);
    assert.ok(res.stdout.includes('FAIL'));
    writeFileSync(join(taskDir, 'package.json'), JSON.stringify(loadChoice(), null, 2), 'utf8');
  });

  test('非法 taskId 退出码 2；未知参数退出码 2', () => {
    const a = cli(['--task', '../escape', '--out', tmpRoot]);
    if (a.error) { console.error('跳过（无法 spawn 子进程）：' + a.error.message); return; }
    assert.equal(a.status, 2);
    assert.equal(cli(['--nope']).status, 2);
  });

  test('清理临时目录', () => {
    if (!process.env.GEO_TEST_KEEP) rmSync(tmpRoot, { recursive: true, force: true });
    assert.ok(true);
  });
});

// ── DSH 工具边界：返回值必须是无损 JSON ─────────────────────────────────
// 2026-10-12 桌面实测缺陷：v1 形题包没有 questionType 字段，report 里带出 undefined，
// JSON.stringify 丢掉该键 → 往返不等值 → 工具调用被判 INVALID_TOOL_OUTPUT。
// 这一组就是那道之前缺失的闸门。
describe('DSH 工具边界：返回值必须是无损 JSON', () => {
  test('检测器能抓到 undefined 键、NaN 与循环引用', () => {
    assert.deepEqual(findNonLossless({ a: undefined }), ['result.a = undefined']);
    assert.match(findNonLossless({ a: NaN })[0], /NaN/);
    assert.deepEqual(findNonLossless({ a: null, b: [1, 'x'], c: {} }), []);
    const cyc = {}; cyc.self = cyc;
    assert.match(findNonLossless(cyc)[0], /循环引用/);
  });

  test('并列共享的同一对象不算循环引用（真实场景：finding 同时挂在 findings 与 gates[].findings）', () => {
    const shared = { x: 1 };
    assert.deepEqual(findNonLossless({ a: shared, b: shared }), []);
    assert.deepEqual(toLosslessJson({ a: shared, b: shared }), { a: { x: 1 }, b: { x: 1 } });
    const list = [shared, shared, shared];
    assert.deepEqual(findNonLossless(list), []);
  });

  test('规整器删除 undefined 键、把 NaN 变成 null', () => {
    assert.deepEqual(toLosslessJson({ a: undefined, b: NaN, c: { d: undefined, e: 1 } }), { b: null, c: { e: 1 } });
    assert.deepEqual(toLosslessJson({ arr: [1, undefined, 2] }), { arr: [1, null, 2] });
  });

  test('缺 questionType/readiness 的包，报告里不留 undefined', () => {
    const pkg = loadChoice();
    pkg.schemaVersion = 1;
    delete pkg.questionType;
    delete pkg.readiness;
    const r = buildValidationReport(pkg, run(pkg), {});
    assert.deepEqual(findNonLossless(r), []);
    assert.equal(r.questionType, null);
    assert.equal(r.declaredReadiness, null);
  });

  test('端到端：geo_question_validate 在 v1 形题包上的返回值无损', async () => {
    const plugin = (await import('../.agent-presets/geo-teacher/plugins/question/index.js')).default;
    const tmp = mkdtempSync(join(tmpdir(), 'geo-question-tool-'));
    const tid = '2026-0927-water-cycle-01';
    mkdirSync(join(tmp, tid), { recursive: true });
    const v1shaped = clone(loadChoice());
    v1shaped.schemaVersion = 1;
    delete v1shaped.questionType;
    for (const it of v1shaped.questionSet.items) delete it.itemType;
    writeFileSync(join(tmp, tid, 'package.json'), JSON.stringify(v1shaped), 'utf8');

    let def = null;
    const ctx = {
      fs: {
        resolve: async (p) => ({ path: p }),
        readText: async (t) => readFileSync(t.path, 'utf8'),
        writeText: async () => {},
      },
      tools: { register(d) { def = d; return () => {}; } },
    };
    plugin.apply(ctx, { questionOutputRoot: tmp });
    assert.ok(def, '工具未在 apply 时注册');

    const res = await def.execute({ taskId: tid });
    assert.equal(res.status, 'success');
    assert.equal(res.report.structureOk, false, 'v1 形题包必须结构不通过');
    assert.ok(res.report.summary.fail > 0, '不能空转：应真的报出失败项');
    const bad = findNonLossless(res);
    assert.deepEqual(bad, [], '工具返回值含不可无损序列化的值：' + bad.join('；'));
    rmSync(tmp, { recursive: true, force: true });
  });

  test('端到端：--render 路径写盘后返回值同样无损', async () => {
    const plugin = (await import('../.agent-presets/geo-teacher/plugins/question/index.js')).default;
    const tmp = mkdtempSync(join(tmpdir(), 'geo-question-tool-render-'));
    const tid = '2026-0927-heat-circulation';
    mkdirSync(join(tmp, tid), { recursive: true });
    writeFileSync(join(tmp, tid, 'package.json'), JSON.stringify(loadChoice(), null, 2), 'utf8');
    const written = [];
    let def = null;
    const ctx = {
      fs: {
        resolve: async (p) => ({ path: p }),
        readText: async (t) => readFileSync(t.path, 'utf8'),
        writeText: async (t, content) => { written.push([t.path, content]); },
      },
      tools: { register(d) { def = d; return () => {}; } },
    };
    plugin.apply(ctx, { questionOutputRoot: tmp });
    const res = await def.execute({ taskId: tid, render: true });
    assert.equal(res.status, 'success');
    assert.deepEqual(res.wrote, ['draft.md', 'student.json', 'teacher.json', 'validation.json']);
    assert.equal(written.length, 4);
    assert.deepEqual(findNonLossless(res), []);
    // 写出的 student.json 必须可解析且不含答案侧字段
    const stu = JSON.parse(written.find(([p]) => p.endsWith('student.json'))[1]);
    assert.equal(stu.kind, 'student_projection');
    assert.ok(!JSON.stringify(stu).includes('distractorMap'));
    rmSync(tmp, { recursive: true, force: true });
  });
});

// ── 阶段感知与完成度上限 ────────────────────────────────────────────────
// 2026-10-21 M2 实测暴露的两处设计缺陷：
//  1) 构思阶段（无 questionSet）本来就没有题组，校验器却报
//     「选择题组应有 1—3 道小题，实际 0 道」→ 模型连改三轮修不掉，只能换 taskId 重来；
//  2) 语义项全 pending 时仍输出 effectiveReadiness=usable，并提示「声明保守（under）」，
//     等于反向激励模型把完成度升格。
describe('阶段感知与完成度上限', () => {
  /** 构造一个「构思已提出、尚未成题」的题包。 */
  function conceptsStagePackage() {
    const pkg = clone(loadChoice());
    pkg.schemaVersion = 2;
    pkg.revision = 1;
    pkg.stage = 'concepts_proposed';
    pkg.readiness = 'concepts_pending';
    pkg.selectedConcept = null;
    delete pkg.questionSet;
    delete pkg.design;
    delete pkg.simulations;
    pkg.confirmations = [];
    pkg.reviews = [];
    return pkg;
  }

  test('构思阶段的包不因「题组为空」被判 fail', () => {
    const pkg = conceptsStagePackage();
    const f = run(pkg);
    const itemFails = f.filter((x) => x.level === 'fail' && String(x.pointer).includes('/questionSet'));
    assert.deepEqual(itemFails, [], '构思阶段没有题组是正常状态，不得判 fail：' + itemFails.map((x) => x.message).join('；'));
  });

  test('构思阶段结构可通过，且完成度上限是 concepts_pending（不是 draft_complete）', () => {
    const pkg = conceptsStagePackage();
    const r = report(pkg);
    assert.equal(r.structureOk, true, '构思包应结构通过，实际失败项：' +
      run(pkg).filter((x) => x.level === 'fail').map((x) => x.pointer + ' ' + x.message).join('；'));
    assert.equal(r.effectiveReadiness, 'concepts_pending',
      '没有题组的包，结构撑不到 draft_complete');
    assert.equal(r.readinessClaim, 'equal', '构思阶段声明 concepts_pending 应与结构一致');
  });

  test('完成度上限是 draft_complete：校验器永不给出 usable', () => {
    // 拿一份「什么都齐、且本 revision 有语义评审记录」的包：结构全通时也不得 usable
    for (const pkg of [loadChoice(), loadComp()]) {
      const r = report(pkg);
      assert.notEqual(r.effectiveReadiness, 'usable',
        '校验器不得单独放行到 usable（语义项恒 pending）：' + pkg.taskId);
      assert.equal(r.effectiveReadiness, 'draft_complete', pkg.taskId);
      assert.ok(r.usableBlockers.some((b) => b.includes('须由人工或独立评审完成并签署')),
        '应把「语义须人工签署」列为阻止 usable 的项：' + JSON.stringify(r.usableBlockers));
    }
  });

  test('声明 usable 而语义未签署时，判定为过度声明（over）', () => {
    const pkg = loadChoice();
    pkg.readiness = 'usable';
    // 清掉 blocking 风险，排除其它阻断项干扰，只看语义这一条
    for (const r0 of pkg.risks) r0.blocking = false;
    pkg.questionSet.material.visualRefs = [];
    const r = report(pkg);
    assert.equal(r.effectiveReadiness, 'draft_complete');
    assert.equal(r.readinessClaim, 'over', '语义未签署却声明 usable，必须判为过度声明');
    assert.equal(r.readinessClaimOk, false);
  });
});
