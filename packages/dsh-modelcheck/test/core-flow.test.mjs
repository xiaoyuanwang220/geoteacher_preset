/**
 * core-flow 单测：evidence / completion / annotations / budget 四个核心模块。
 * 运行：node --test packages/dsh-modelcheck/test/core-flow.test.mjs（工作目录 = 仓库根）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sha256, stableStringify } from '../lib/util.js';
import {
  evidenceKey,
  reuseDecision,
  buildEvidenceRecord,
  invalidateByDependency,
  summarizeEvidence,
  attachUserConfirmation
} from '../lib/evidence.js';
import {
  evaluateCompletion,
  renderReportPage,
  certificationValid,
  knownFailures,
  applyCertification
} from '../lib/completion.js';
import {
  REQUEST_STATES,
  createBatch,
  sendBatch,
  triageRequest,
  setRequestState,
  pendingRequests,
  closeByCriteria,
  renderBatchMessage
} from '../lib/annotations.js';
import {
  PHASE_DEFAULTS,
  budgetPhase,
  recordRound,
  budgetSummary,
  recoveryLadder
} from '../lib/budget.js';

const CONTRACT_VERSION = '1.0.0';
const BUILD = `sha256:${'a'.repeat(64)}`;
const SOURCE = `sha256:${'b'.repeat(64)}`;
const ADAPTER = 'modelcheck-adapter/1';

/** 构造一套完整的证据键组成字段。 */
function makeParts(id, extra = {}) {
  return {
    contractVersion: CONTRACT_VERSION,
    ruleHash: sha256(`rule:${id}`),
    deps: {},
    adapterVersion: ADAPTER,
    context: {},
    buildHash: BUILD,
    sourceHash: SOURCE,
    ...extra
  };
}

/** 构造判据。 */
function makeCriterion(id, extra = {}) {
  return { id, level: 'P0', blocking: true, claim: `判据 ${id}`, method: 'auto', ...extra };
}

/** 用证据记录组装 entries 映射与 currentKeys。 */
function makeEntries(criteria, statuses = {}) {
  const entries = {};
  const currentKeys = {};
  for (const criterion of criteria) {
    const parts = makeParts(criterion.id);
    const status = statuses[criterion.id] ?? 'pass';
    entries[criterion.id] = buildEvidenceRecord(criterion, {
      status,
      measured: { checked: true },
      evidenceKind: 'runtime'
    }, parts);
    currentKeys[criterion.id] = evidenceKey(parts);
  }
  return { entries, currentKeys };
}

/** 构造 project（含契约、证据、版本哈希）。 */
function makeProject({ criteria, statuses, contract = {}, annotations, certification = null } = {}) {
  const list = criteria ?? [makeCriterion('GEO-TEST-01')];
  const { entries, currentKeys } = makeEntries(list, statuses);
  return {
    contract: {
      schemaVersion: 1,
      contractVersion: CONTRACT_VERSION,
      status: 'confirmed',
      criteria: list,
      ...contract
    },
    components: [],
    evidence: { schemaVersion: 1, adapterVersion: ADAPTER, entries },
    annotations: annotations ?? { schemaVersion: 1, batches: [], requests: [] },
    certification,
    config: {},
    buildHash: BUILD,
    sourceHash: SOURCE,
    currentKeys
  };
}

// ---------------------------------------------------------------- evidence.js

test('evidenceKey：字段顺序无关、带 sha256 前缀、必需字段缺失返回 null', () => {
  const parts = makeParts('C-1');
  const reordered = {
    sourceHash: parts.sourceHash,
    buildHash: parts.buildHash,
    context: parts.context,
    adapterVersion: parts.adapterVersion,
    deps: parts.deps,
    ruleHash: parts.ruleHash,
    contractVersion: parts.contractVersion
  };
  assert.equal(evidenceKey(parts), evidenceKey(reordered));
  assert.match(evidenceKey(parts), /^sha256:[0-9a-f]{64}$/);
  assert.equal(evidenceKey({ ...parts, buildHash: undefined }), null);
  assert.equal(evidenceKey({ ...parts, deps: [] }), null);
  assert.equal(evidenceKey({ ...parts, contractVersion: '' }), null);
  assert.equal(evidenceKey(null), null);
  assert.notEqual(evidenceKey(parts), evidenceKey({ ...parts, ruleHash: sha256('other') }));
});

test('reuseDecision：rerun / reuse / stale 三分支', () => {
  const parts = makeParts('C-2');
  const key = evidenceKey(parts);
  assert.equal(reuseDecision(null, key), 'rerun');
  assert.equal(reuseDecision(undefined, key), 'rerun');
  assert.equal(reuseDecision({ key, status: 'pass' }, key), 'reuse');
  assert.equal(reuseDecision({ key, status: 'fail' }, key), 'rerun');
  assert.equal(reuseDecision({ key: sha256('old'), status: 'pass' }, key), 'stale');
  assert.equal(reuseDecision({ status: 'pass' }, key), 'stale');
  assert.equal(reuseDecision({ key, status: 'pass' }, null), 'rerun');
});

test('buildEvidenceRecord：字段齐全、键与 keyParts 一致、不修改入参', () => {
  const criterion = makeCriterion('C-3', { requiredEvidence: 'runtime', context: { step: 'end' } });
  const parts = makeParts('C-3', { context: { step: 'end' } });
  const result = { status: 'fail', measured: { distance: 0.05 }, detail: '超出容差', errors: ['boom'] };
  const criterionSnapshot = stableStringify(criterion);
  const resultSnapshot = stableStringify(result);

  const record = buildEvidenceRecord(criterion, result, parts);
  assert.equal(record.status, 'fail');
  assert.equal(record.criterionId, 'C-3');
  assert.deepEqual(record.measured, { distance: 0.05 });
  assert.equal(record.evidenceKind, 'runtime');
  assert.equal(record.key, evidenceKey(parts));
  assert.equal(record.buildHash, BUILD);
  assert.equal(record.sourceHash, SOURCE);
  assert.deepEqual(record.context, { step: 'end' });
  assert.equal(record.detail, '超出容差');
  assert.deepEqual(record.errors, ['boom']);
  assert.deepEqual(record.artifacts, []);
  assert.deepEqual(record.coverage, []);
  assert.match(record.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(record.assertion, criterion.claim);
  assert.equal(stableStringify(criterion), criterionSnapshot);
  assert.equal(stableStringify(result), resultSnapshot);
});

test('invalidateByDependency：命中依赖的证据置 stale，且不修改入参', () => {
  const entryA = buildEvidenceRecord(makeCriterion('A'), { status: 'pass' }, makeParts('A', {
    deps: { 'index.html': sha256('<html>') }
  }));
  const entryB = buildEvidenceRecord(makeCriterion('B'), { status: 'pass' }, makeParts('B', {
    deps: { 'src/config.js': sha256('cfg') }
  }));
  const evidence = { schemaVersion: 1, entries: { A: entryA, B: entryB } };
  const snapshot = stableStringify(evidence);

  const result = invalidateByDependency(evidence, ['index.html']);
  assert.deepEqual(result.staleIds, ['A']);
  assert.deepEqual(result.matched, ['index.html']);
  assert.equal(result.evidence.entries.A.status, 'stale');
  assert.match(result.evidence.entries.A.staleReason, /index\.html/);
  assert.equal(result.evidence.entries.B.status, 'pass');
  assert.equal(stableStringify(evidence), snapshot);
  assert.equal(entryA.status, 'pass');

  const none = invalidateByDependency(evidence, ['docs/other.md']);
  assert.deepEqual(none.staleIds, []);
  assert.equal(none.evidence.entries.A.status, 'pass');
});

test('summarizeEvidence：状态计数与过期/失败清单', () => {
  const entries = {
    A: { status: 'pass' },
    B: { status: 'fail' },
    C: { status: 'stale' },
    D: { status: 'unverified' },
    E: { status: 'unknown' }
  };
  const summary = summarizeEvidence({ entries });
  assert.equal(summary.total, 5);
  assert.equal(summary.byStatus.pass, 1);
  assert.equal(summary.byStatus.fail, 1);
  assert.deepEqual(summary.staleIds, ['C']);
  assert.deepEqual(summary.failingIds, ['B']);
  assert.deepEqual(summary.unknownIds, ['E']);
  assert.deepEqual(summary.unverifiedIds, ['D']);
});

test('attachUserConfirmation：写入确认、不可变、unknown 抛错、accepted=false 记 fail', () => {
  const key = evidenceKey(makeParts('M-1'));
  const evidence = {
    schemaVersion: 1,
    entries: { 'M-1': buildEvidenceRecord(makeCriterion('M-1'), { status: 'pass' }, makeParts('M-1')) }
  };
  const snapshot = stableStringify(evidence);

  const confirmed = attachUserConfirmation(evidence, { criterionId: 'M-1', evidenceKey: key, confirmedAt: '2026-10-22T00:00:00.000Z' });
  assert.equal(confirmed.entries['M-1'].status, 'pass');
  assert.deepEqual(confirmed.entries['M-1'].userConfirmation, {
    confirmedBy: 'user',
    confirmedAt: '2026-10-22T00:00:00.000Z',
    evidenceKey: key,
    accepted: true,
    reason: null
  });
  assert.equal(stableStringify(evidence), snapshot);

  const rejected = attachUserConfirmation(evidence, {
    criterionId: 'M-1',
    evidenceKey: key,
    accepted: false,
    reason: '方向仍反'
  });
  assert.equal(rejected.entries['M-1'].status, 'fail');
  assert.equal(rejected.entries['M-1'].detail, '方向仍反');

  assert.throws(() => attachUserConfirmation(evidence, { criterionId: 'NOPE', evidenceKey: key }), /未知判据/);
});

// -------------------------------------------------------------- completion.js

test('evaluateCompletion：契约+证据+版本齐全时认证通过', () => {
  const project = makeProject({ criteria: [makeCriterion('GEO-A'), makeCriterion('GEO-B', { level: 'P1' })] });
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true);
  assert.deepEqual(completion.blocking, []);
  assert.equal(completion.contractVersion, CONTRACT_VERSION);
  assert.equal(completion.buildHash, BUILD);
  assert.equal(completion.sourceHash, SOURCE);
  assert.equal(completion.report.rows.length, 2);
  assert.equal(completion.report.summary.pass, 2);
  assert.equal(completion.report.knownFailures.length, 0);
  assert.match(completion.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('evaluateCompletion：阻塞判据 fail 与缺证据都会拦截', () => {
  const failing = evaluateCompletion(makeProject({
    criteria: [makeCriterion('GEO-FAIL')],
    statuses: { 'GEO-FAIL': 'fail' }
  }));
  assert.equal(failing.certified, false);
  assert.equal(failing.blocking.length, 1);
  assert.equal(failing.blocking[0].id, 'GEO-FAIL');
  assert.equal(failing.blocking[0].status, 'fail');
  assert.ok(failing.blocking[0].remedy.length > 0);

  const missingProject = makeProject({ criteria: [makeCriterion('GEO-MISS')] });
  delete missingProject.evidence.entries['GEO-MISS'];
  delete missingProject.currentKeys['GEO-MISS'];
  const missing = evaluateCompletion(missingProject);
  assert.equal(missing.certified, false);
  assert.equal(missing.blocking[0].status, 'unverified');
});

test('evaluateCompletion：证据键与当前版本不一致记为 stale 并拦截', () => {
  const project = makeProject({ criteria: [makeCriterion('GEO-STALE')] });
  project.buildHash = `sha256:${'c'.repeat(64)}`; // 构建已变化，旧证据过期
  delete project.currentKeys; // 走键重算路径
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, false);
  assert.equal(completion.blocking[0].id, 'GEO-STALE');
  assert.equal(completion.blocking[0].status, 'stale');
});

test('evaluateCompletion：非阻塞 fail 允许但进入 knownFailures', () => {
  const criteria = [makeCriterion('GEO-OK'), makeCriterion('GEO-SOFT', { blocking: false, level: 'P2' })];
  const project = makeProject({ criteria, statuses: { 'GEO-SOFT': 'fail' } });
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true);
  assert.equal(completion.report.knownFailures.length, 1);
  assert.equal(completion.report.knownFailures[0].id, 'GEO-SOFT');
  assert.equal(completion.report.knownFailures[0].blocking, false);
  assert.deepEqual(knownFailures(project).map((item) => item.id), ['GEO-SOFT']);
});

test('evaluateCompletion：契约未确认 / 判据为空时不可认证', () => {
  const unconfirmed = makeProject({ criteria: [makeCriterion('GEO-U')], contract: { status: 'draft' } });
  const result = evaluateCompletion(unconfirmed);
  assert.equal(result.certified, false);
  assert.ok(result.reasons.some((reason) => reason.includes('契约状态')));

  const emptyProject = makeProject({ criteria: [makeCriterion('GEO-E')] });
  emptyProject.contract.criteria = [];
  const empty = evaluateCompletion(emptyProject);
  assert.equal(empty.certified, false);
  assert.ok(empty.reasons.some((reason) => reason.includes('没有判据')));
});

test('evaluateCompletion：manual 验收必须有绑定当前证据键的用户确认', () => {
  const criterion = makeCriterion('GEO-MANUAL', { acceptance: 'manual', method: 'manual' });
  const project = makeProject({ criteria: [criterion] });
  const key = project.currentKeys['GEO-MANUAL'];

  const missing = evaluateCompletion(project);
  assert.equal(missing.certified, false);
  assert.equal(missing.blocking[0].status, 'unconfirmed');
  assert.match(missing.blocking[0].remedy, /人工|确认/);

  const confirmedEntries = attachUserConfirmation(project.evidence, {
    criterionId: 'GEO-MANUAL',
    evidenceKey: key,
    confirmedAt: '2026-10-22T00:00:00.000Z'
  });
  const confirmed = evaluateCompletion({ ...project, evidence: confirmedEntries });
  assert.equal(confirmed.certified, true);

  const wrongKey = attachUserConfirmation(project.evidence, {
    criterionId: 'GEO-MANUAL',
    evidenceKey: sha256('stale-key'),
    confirmedAt: '2026-10-22T00:00:00.000Z'
  });
  const staleConfirmation = evaluateCompletion({ ...project, evidence: wrongKey });
  assert.equal(staleConfirmation.certified, false);
  assert.equal(staleConfirmation.blocking[0].status, 'unconfirmed');
});

test('evaluateCompletion：未关闭的标注请求会拦截，关闭后放行', () => {
  const criterion = makeCriterion('GEO-ANN');
  const project = makeProject({ criteria: [criterion] });

  const created = createBatch({}, {
    projectId: 'demo',
    modelVersion: { buildHash: BUILD },
    items: [{ componentId: 'nh-trade-winds', label: '信风箭头', locator: { file: 'src/config.js', symbol: 'TRADE' }, userText: '方向反了' }]
  });
  const sent = sendBatch(created.annotations, 'B-0001');
  assert.equal(pendingRequests(sent.annotations).length, 1);

  const blocked = evaluateCompletion({ ...project, annotations: sent.annotations });
  assert.equal(blocked.certified, false);
  assert.ok(blocked.reasons.some((reason) => reason.includes('标注请求')));

  const closedAnnotations = {
    ...sent.annotations,
    requests: sent.annotations.requests.map((request) => ({ ...request, state: 'closed' }))
  };
  const open = evaluateCompletion({ ...project, annotations: closedAnnotations });
  assert.equal(open.certified, true);
});

test('certificationValid：版本一致且未作废才有效', () => {
  const cert = { certified: true, contractVersion: CONTRACT_VERSION, buildHash: BUILD };
  assert.equal(certificationValid(cert, { contractVersion: CONTRACT_VERSION, buildHash: BUILD }), true);
  assert.equal(certificationValid(cert, { contractVersion: '2.0.0', buildHash: BUILD }), false);
  assert.equal(certificationValid(cert, { contractVersion: CONTRACT_VERSION, buildHash: SOURCE }), false);
  assert.equal(certificationValid({ ...cert, invalidatedAt: '2026-10-22T00:00:00.000Z' }, {
    contractVersion: CONTRACT_VERSION,
    buildHash: BUILD
  }), false);
  assert.equal(certificationValid({ ...cert, certified: false }, {
    contractVersion: CONTRACT_VERSION,
    buildHash: BUILD
  }), false);
  assert.equal(certificationValid(null, { contractVersion: CONTRACT_VERSION, buildHash: BUILD }), false);
});

test('renderReportPage：输出中文一页式报告', () => {
  const project = makeProject({
    criteria: [makeCriterion('GEO-ROW'), makeCriterion('GEO-SOFT', { blocking: false, level: 'P2' })],
    statuses: { 'GEO-SOFT': 'fail' }
  });
  const text = renderReportPage(evaluateCompletion(project));
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('ModelCheck 完成判定报告'));
  assert.ok(text.includes('结论：通过完成门禁'));
  assert.ok(text.includes('GEO-ROW'));
  assert.ok(text.includes('已知缺陷'));
  assert.ok(text.includes('GEO-SOFT'));
  assert.ok(text.includes(CONTRACT_VERSION));
});

// ------------------------------------------------------------- annotations.js

test('createBatch：编号连续、状态 draft、返回新对象且不改入参', () => {
  const original = {};
  const first = createBatch(original, {
    projectId: 'demo',
    modelVersion: { buildHash: BUILD },
    items: [
      { componentId: 'a', label: '组件 A', userText: '改这里' },
      { componentId: 'b', label: '组件 B', userText: '再改这里' }
    ]
  });
  assert.equal(first.batch.id, 'B-0001');
  assert.equal(first.batch.status, 'draft');
  assert.deepEqual(first.annotations.requests.map((request) => request.id), ['USR-0001', 'USR-0002']);
  assert.deepEqual(original, {});
  assert.equal(first.annotations.nextRequestSeq, 3);
  assert.equal(first.annotations.nextBatchSeq, 2);
  assert.equal(first.annotations.requests[0].state, 'draft');
  assert.equal(first.annotations.requests[0].history.length, 1);

  const second = createBatch(first.annotations, { items: [{ componentId: 'c', label: '组件 C' }] });
  assert.equal(second.batch.id, 'B-0002');
  assert.equal(second.annotations.requests[2].id, 'USR-0003');
  assert.throws(() => createBatch(first.annotations, { items: [] }), /至少一条标注/);
});

test('sendBatch：生成 §8.3 文本、置 sent、幂等且不改入参', () => {
  const created = createBatch({}, {
    projectId: 'demo',
    modelVersion: { buildHash: BUILD },
    items: [
      {
        componentId: 'nh-trade-winds',
        label: '北半球东北信风箭头',
        locator: { file: 'src/config.js', symbol: 'TRADE_WINDS_NH', line: 42 },
        userText: '方向反了…',
        criteriaIds: ['GEO-DIR-01'],
        screenshot: 'artifacts/abc.png'
      },
      { componentId: 'nh-westerlies', label: '盛行西风带', userText: '位置偏高' }
    ]
  });
  const snapshot = stableStringify(created.annotations);

  const sent = sendBatch(created.annotations, 'B-0001');
  assert.equal(sent.idempotent, false);
  assert.ok(sent.message.startsWith('【组件标注 · 第 1 批】'));
  assert.ok(sent.message.includes('1. USR-0001（北半球东北信风箭头）'));
  assert.ok(sent.message.includes('   代码: src/config.js:TRADE_WINDS_NH'));
  assert.ok(sent.message.includes('   关联判据: GEO-DIR-01'));
  assert.ok(sent.message.includes('   用户要求: "方向反了…"'));
  assert.ok(sent.message.includes('   截图: artifacts/abc.png'));
  assert.ok(sent.message.includes('2. USR-0002（盛行西风带）'));
  assert.ok(sent.message.includes(`构建：${BUILD}`));
  assert.equal(sent.annotations.batches[0].status, 'sent');
  assert.equal(sent.annotations.requests[0].state, 'sent');
  assert.equal(stableStringify(created.annotations), snapshot);

  const again = sendBatch(sent.annotations, 'B-0001');
  assert.equal(again.idempotent, true);
  assert.equal(again.message, sent.message);
  assert.equal(again.annotations.requests[0].state, 'sent');
  assert.throws(() => sendBatch(sent.annotations, 'B-9999'), /未知批次/);
});

test('renderBatchMessage：registry 回填定位、批次序号取自编号', () => {
  const created = createBatch({}, {
    items: [{ componentId: 'nh-westerlies', label: '盛行西风带', userText: '位置偏高' }]
  });
  const batch = { ...created.batch, id: 'B-0002' };
  const message = renderBatchMessage(batch, {
    components: [{ id: 'nh-westerlies', file: 'src/winds.js', symbol: 'WESTERLIES' }]
  });
  assert.ok(message.startsWith('【组件标注 · 第 2 批】'));
  assert.ok(message.includes('   代码: src/winds.js:WESTERLIES'));
  assert.ok(message.includes('   关联判据: —'));
  assert.equal(renderBatchMessage(null), '');
});

test('triageRequest / setRequestState：状态机与非法迁移', () => {
  assert.deepEqual(REQUEST_STATES, ['draft', 'sent', 'triaged', 'editing', 'review', 'closed', 'withdrawn']);

  const created = createBatch({}, {
    items: [{ componentId: 'a', label: '组件 A', userText: '方向反了', criteriaIds: ['GEO-DIR-01'] }]
  });
  assert.throws(() => triageRequest(created.annotations, 'USR-0001', { claim: 'x' }), /需先发送/);

  const sent = sendBatch(created.annotations, 'B-0001').annotations;
  assert.throws(() => setRequestState(sent, 'USR-0001', 'closed'), /非法状态迁移/);
  assert.throws(() => setRequestState(sent, 'USR-0001', 'bogus'), /非法请求状态/);

  const triaged = triageRequest(sent, 'USR-0001', {
    claim: '箭头方向应为西南向',
    criteriaIds: ['USR-0001'],
    acceptance: 'manual',
    allowedChanges: ['src/config.js'],
    level: 'P0'
  });
  const request = triaged.requests[0];
  assert.equal(request.state, 'triaged');
  assert.equal(request.claim, '箭头方向应为西南向');
  assert.deepEqual(request.criteriaIds, ['USR-0001']);
  assert.deepEqual(request.allowedChanges, ['src/config.js']);
  assert.equal(request.level, 'P0');
  assert.equal(request.history.length, 3);

  const withdrawn = setRequestState(sent, 'USR-0001', 'withdrawn', '用户撤回');
  assert.equal(withdrawn.requests[0].state, 'withdrawn');
  assert.equal(withdrawn.requests[0].reason, '用户撤回');
  assert.throws(() => triageRequest(withdrawn, 'USR-0001', { claim: 'x' }), /不能分诊/);

  const editing = setRequestState(triaged, 'USR-0001', 'editing');
  const review = setRequestState(editing, 'USR-0001', 'review');
  const closed = setRequestState(review, 'USR-0001', 'closed', '已修复');
  assert.equal(closed.requests[0].state, 'closed');
  assert.equal(closed.requests[0].history.at(-1).reason, '已修复');
  assert.deepEqual(setRequestState(closed, 'USR-0001', 'closed'), closed);
  assert.equal(setRequestState(closed, 'USR-0001', 'closed').requests[0].history.length, closed.requests[0].history.length);
});

test('pendingRequests / closeByCriteria：判据全通过逐级推进到 closed', () => {
  const created = createBatch({}, {
    items: [
      { componentId: 'a', label: '组件 A', userText: '方向反了', criteriaIds: ['GEO-DIR-01'] },
      { componentId: 'b', label: '组件 B', userText: '文字不对', criteriaIds: ['GEO-TEXT-01'] }
    ]
  });
  assert.equal(pendingRequests(created.annotations).length, 0);

  const sent = sendBatch(created.annotations, 'B-0001').annotations;
  assert.equal(pendingRequests(sent).length, 2);

  const partial = closeByCriteria(sent, { 'GEO-DIR-01': 'pass', 'GEO-TEXT-01': 'fail' });
  assert.equal(partial.requests[0].state, 'review');
  assert.equal(partial.requests[1].state, 'sent');
  assert.equal(pendingRequests(partial).length, 2);

  const allPass = closeByCriteria(partial, { 'GEO-DIR-01': { status: 'pass' }, 'GEO-TEXT-01': 'pass' });
  assert.equal(allPass.requests[1].state, 'review');
  const closed = closeByCriteria(allPass, { 'GEO-DIR-01': 'pass', 'GEO-TEXT-01': 'pass' });
  assert.equal(closed.requests[0].state, 'closed');
  assert.equal(closed.requests[1].state, 'closed');
  assert.equal(pendingRequests(closed).length, 0);
  assert.equal(closed.requests[0].reason, '关联判据全部通过');
});

// ------------------------------------------------------------------ budget.js

test('budgetPhase / PHASE_DEFAULTS：显式阶段优先，缺省按项目形态推断', () => {
  assert.equal(PHASE_DEFAULTS.science.maxRounds, 3);
  assert.equal(PHASE_DEFAULTS.prototype.maxRounds, 5);
  assert.equal(PHASE_DEFAULTS.production.maxRounds, 8);
  assert.equal(budgetPhase({ config: { budget: { phase: 'prototype' } } }), 'prototype');
  assert.equal(budgetPhase({ config: { phase: 'production' } }), 'production');
  assert.equal(budgetPhase({}), 'science');
  assert.equal(budgetPhase({ contract: { criteria: [] } }), 'dev');
  assert.equal(budgetPhase({ contract: {}, certification: { certified: true } }), 'delivery');
});

test('recordRound：追加轮次、返回继续裁决与剩余轮次', () => {
  const first = recordRound([], { phase: 'dev', target: '闭合误差', strategy: 'S1', newPass: 1 });
  assert.equal(first.rounds.length, 1);
  assert.equal(first.rounds[0].round, 1);
  assert.equal(first.verdict.action, 'continue');
  assert.equal(first.verdict.allowed, true);
  assert.equal(first.verdict.round, 1);
  assert.equal(first.verdict.remaining, 2);
  assert.equal(first.verdict.maxRounds, 3);

  const input = [{ round: 1, at: '2026-01-01T00:00:00.000Z', wait: false, newPass: 1 }];
  const snapshot = stableStringify(input);
  const second = recordRound(input, { phase: 'dev', now: '2026-01-01T00:10:00.000Z', newPass: 1 });
  assert.equal(second.rounds.length, 2);
  assert.equal(second.verdict.remaining, 1);
  assert.equal(stableStringify(input), snapshot);
});

test('recordRound：连续空转 3 轮重复策略 → forbid-strategy，5 轮 → stop', () => {
  let rounds = [];
  let verdict = null;
  for (let i = 0; i < 3; i += 1) {
    const outcome = recordRound(rounds, {
      phase: 'dev',
      maxRounds: 10,
      strategy: 'same-strategy',
      target: '闭合误差',
      metricBefore: 0.05,
      metricAfter: 0.05
    });
    rounds = outcome.rounds;
    verdict = outcome.verdict;
  }
  assert.equal(verdict.stagnantCount, 3);
  assert.equal(verdict.action, 'forbid-strategy');
  assert.equal(verdict.allowed, true);
  assert.match(verdict.message, /禁止继续该策略/);

  for (let i = 0; i < 2; i += 1) {
    const outcome = recordRound(rounds, { phase: 'dev', maxRounds: 10, strategy: 'same-strategy' });
    rounds = outcome.rounds;
    verdict = outcome.verdict;
  }
  assert.equal(verdict.stagnantCount, 5);
  assert.equal(verdict.action, 'stop');
  assert.equal(verdict.allowed, false);
});

test('recordRound：progressNote 变化不算策略重复，wait 轮不参与空转但计入耗时', () => {
  let rounds = [];
  let verdict = null;
  for (let i = 0; i < 3; i += 1) {
    const outcome = recordRound(rounds, {
      phase: 'dev',
      maxRounds: 10,
      strategy: 'same-strategy',
      progressNote: `第 ${i} 轮换了排查角度`,
      now: `2026-01-01T0${i}:00:00.000Z`
    });
    rounds = outcome.rounds;
    verdict = outcome.verdict;
  }
  assert.equal(verdict.stagnantCount, 3);
  assert.equal(verdict.repeatedStrategy, false);
  assert.equal(verdict.action, 'remind');

  let waitRounds = [];
  const normal = recordRound(waitRounds, { phase: 'dev', maxRounds: 10, now: '2026-01-01T00:00:00.000Z' });
  const withWait = recordRound(normal.rounds, {
    phase: 'dev',
    maxRounds: 10,
    wait: true,
    now: '2026-01-01T01:00:00.000Z'
  });
  assert.equal(withWait.verdict.stagnantCount, 1);
  assert.equal(withWait.verdict.elapsedMinutes, 60);
});

test('recordRound：超过轮次预算或时间预算 → stop', () => {
  let rounds = [];
  for (let i = 0; i < 2; i += 1) {
    rounds = recordRound(rounds, { phase: 'dev', maxRounds: 2, newPass: 1 }).rounds;
  }
  const overRounds = recordRound(rounds, { phase: 'dev', maxRounds: 2, newPass: 1 });
  assert.equal(overRounds.verdict.action, 'stop');
  assert.equal(overRounds.verdict.allowed, false);
  assert.match(overRounds.verdict.message, /轮次预算/);

  const start = recordRound([], { phase: 'dev', strategy: 'a', now: '2026-01-01T00:00:00.000Z' });
  const overTime = recordRound(start.rounds, {
    phase: 'dev',
    strategy: 'b',
    now: '2026-01-01T03:00:00.000Z',
    maxMinutes: 60
  });
  assert.equal(overTime.verdict.action, 'stop');
  assert.ok(overTime.verdict.message.includes('只停止插件自有任务，宿主任务未确认停止'));
  assert.equal(overTime.verdict.elapsedMinutes, 180);
});

test('budgetSummary：汇总阶段、上限、剩余与累计进展', () => {
  const project = { config: { budget: { phase: 'prototype', maxRounds: 5, maxMinutes: 180 } } };
  const recorded = [
    { round: 1, at: '2026-01-01T00:00:00.000Z', strategy: 'a', newPass: 1, unknownReduced: 2,  metricImproved: true,  apiErrors: 1, wait: false },
    { round: 2, at: '2026-01-01T00:30:00.000Z', strategy: 'b', newPass: 0, unknownReduced: 1,  metricImproved: false, apiErrors: 2, wait: false }
  ];
  const summary = budgetSummary(project, recorded);
  assert.equal(summary.phase, 'prototype');
  assert.equal(summary.maxRounds, 5);
  assert.equal(summary.maxMinutes, 180);
  assert.equal(summary.round, 2);
  assert.equal(summary.remaining, 3);
  assert.equal(summary.elapsedMinutes, 30);
  assert.deepEqual(summary.totals, { newPass: 1, unknownReduced: 3, metricImproved: 1, apiErrors: 3 });
  assert.equal(summary.verdict.action, 'continue');
  assert.equal(summary.waitRounds, 0);
});

test('recoveryLadder：返回三步中文恢复阶梯', () => {
  const text = recoveryLadder({ round: 4, action: 'forbid-strategy' });
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('恢复阶梯'));
  assert.ok(text.includes('1.'));
  assert.ok(text.includes('2.'));
  assert.ok(text.includes('3.'));
  assert.ok(text.includes('禁止重复策略'));
});

// -------------------------------------------------- 宿主集成形状（loadProject）

test('evaluateCompletion：读取 loadProject 的 hashes 形状', () => {
  const project = makeProject({ criteria: [makeCriterion('GEO-HASH')] });
  delete project.buildHash;
  delete project.sourceHash;
  project.hashes = { buildHash: BUILD, sourceHash: SOURCE };
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true);
  assert.equal(completion.buildHash, BUILD);
  assert.equal(completion.sourceHash, SOURCE);

  // hashes 变化 → 旧证据过期（去掉 currentKeys，走键重算路径）
  const changed = {
    ...project,
    currentKeys: null,
    hashes: { buildHash: sha256('new-build'), sourceHash: SOURCE }
  };
  const stale = evaluateCompletion(changed);
  assert.equal(stale.certified, false);
  assert.equal(stale.blocking[0].status, 'stale');
});

test('applyCertification：通过时写认证，未通过时写 certified:false 并作废', async () => {
  const writes = [];
  const store = {
    paths: { certification: 'C:/demo/.modelcheck/certification.json' },
    writeJson: async (path, value) => {
      writes.push({ path, value });
    }
  };

  const passProject = makeProject({ criteria: [makeCriterion('GEO-CERT')] });
  passProject.hashes = { buildHash: BUILD, sourceHash: SOURCE };
  delete passProject.buildHash;
  delete passProject.sourceHash;
  const applied = await applyCertification(passProject, { store });
  assert.equal(applied.certified, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, store.paths.certification);
  assert.equal(writes[0].value.certified, true);
  assert.equal(writes[0].value.buildHash, BUILD);
  assert.equal(writes[0].value.sourceHash, SOURCE);
  assert.equal(writes[0].value.contractVersion, CONTRACT_VERSION);
  assert.equal(writes[0].value.invalidatedAt, null);
  assert.equal(certificationValid(writes[0].value, {
    contractVersion: CONTRACT_VERSION,
    buildHash: BUILD,
    sourceHash: SOURCE
  }), true);

  const failProject = makeProject({
    criteria: [makeCriterion('GEO-CERT')],
    statuses: { 'GEO-CERT': 'fail' }
  });
  failProject.hashes = { buildHash: BUILD, sourceHash: SOURCE };
  const blocked = await applyCertification(failProject, { store });
  assert.equal(blocked.certified, false);
  assert.equal(blocked.certification.certified, false);
  assert.ok(blocked.certification.invalidatedAt);
  assert.equal(certificationValid(blocked.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: BUILD
  }), false);

  // 无 store 时不落盘，只返回认证对象
  const preview = await applyCertification(failProject);
  assert.equal(preview.certification.certified, false);
});

test('recordRound / budgetSummary：兼容 rounds.json 包装文档与 apiErrors 数组', () => {
  const doc = { schemaVersion: 1, rounds: [] };
  const snapshot = stableStringify(doc);
  const recorded = recordRound(doc, {
    phase: 'dev',
    strategy: 'S1',
    newPass: 1,
    apiErrors: ['e1', 'e2'],
    now: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(Array.isArray(recorded.rounds), false);
  assert.equal(recorded.rounds.schemaVersion, 1);
  assert.equal(recorded.rounds.rounds.length, 1);
  assert.equal(recorded.rounds.rounds[0].apiErrors, 2);
  assert.equal(recorded.rounds.rounds[0].round, 1);
  assert.equal(stableStringify(doc), snapshot);

  const summary = budgetSummary(
    { contract: {}, config: { budget: { maxRounds: { dev: 3 }, maxMinutes: { dev: 120 } } } },
    recorded.rounds
  );
  assert.equal(summary.phase, 'dev');
  assert.equal(summary.maxRounds, 3);
  assert.equal(summary.maxMinutes, 120);
  assert.equal(summary.round, 1);
  assert.equal(summary.remaining, 2);
  assert.equal(summary.totals.apiErrors, 2);
});

// ------------------------------ 联调回归（core-lib / lead 实测：验收阻塞缺陷）

test('静态项目：项目无构建产物时用证据里的 static 占位版本完成认证', async () => {
  const criterion = makeCriterion('GEO-STATIC');
  const parts = makeParts('GEO-STATIC', { buildHash: 'static', sourceHash: 'static' });
  const project = {
    contract: { contractVersion: CONTRACT_VERSION, status: 'confirmed', criteria: [criterion] },
    components: [],
    evidence: {
      schemaVersion: 1,
      entries: {
        'GEO-STATIC': buildEvidenceRecord(criterion, { status: 'pass', measured: { ok: true } }, parts)
      }
    },
    annotations: { batches: [], requests: [] },
    certification: null,
    config: { build: { entry: 'index.html', outputs: [] } },
    hashes: { buildHash: null, sourceHash: null }
  };

  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true, completion.reasons.join('；'));
  assert.equal(completion.buildHash, 'static');
  assert.ok(!completion.reasons.some((reason) => reason.includes('缺少构建哈希')));

  const applied = await applyCertification(project);
  assert.equal(applied.certification.certified, true);
  assert.equal(applied.certification.buildHash, 'static');
  assert.equal(applied.certification.sourceHash, 'static');
  assert.equal(certificationValid(applied.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: 'static',
    sourceHash: 'static'
  }), true);
  assert.equal(certificationValid(applied.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: sha256('other-build')
  }), false);
  // 宿主传 hashes.buildHash=null（未登记产物）时，不能把刚签发的认证判死
  assert.equal(certificationValid(applied.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: null,
    sourceHash: null
  }), true);
});

test('运行时证据：项目无登记产物时认证绑定证据里的真实 buildHash', async () => {
  const runtimeBuild = `sha256:${'c'.repeat(64)}`;
  const runtimeSource = `sha256:${'d'.repeat(64)}`;
  const criterion = makeCriterion('GEO-RUNTIME');
  const parts = makeParts('GEO-RUNTIME', { buildHash: runtimeBuild, sourceHash: runtimeSource });
  const project = {
    contract: { contractVersion: CONTRACT_VERSION, status: 'confirmed', criteria: [criterion] },
    evidence: {
      schemaVersion: 1,
      entries: { 'GEO-RUNTIME': buildEvidenceRecord(criterion, { status: 'pass' }, parts) }
    },
    annotations: { batches: [], requests: [] },
    certification: null,
    config: {},
    hashes: { buildHash: null, sourceHash: null }
  };
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true, completion.reasons.join('；'));
  assert.equal(completion.buildHash, runtimeBuild);

  const applied = await applyCertification(project);
  assert.equal(applied.certification.buildHash, runtimeBuild);
  assert.equal(certificationValid(applied.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: runtimeBuild
  }), true);
  assert.equal(certificationValid(applied.certification, {
    contractVersion: CONTRACT_VERSION,
    buildHash: sha256('other-build')
  }), false);
});

test('缺哈希门禁：连 static 占位都没有时仍拒绝认证', () => {
  const criterion = makeCriterion('GEO-NOHASH');
  const partialParts = {
    contractVersion: CONTRACT_VERSION,
    ruleHash: sha256('rule:GEO-NOHASH'),
    deps: {},
    adapterVersion: ADAPTER,
    context: {}
  };
  const entry = buildEvidenceRecord(criterion, { status: 'pass' }, partialParts);
  assert.equal(entry.key, null);
  const project = {
    contract: { contractVersion: CONTRACT_VERSION, status: 'confirmed', criteria: [criterion] },
    evidence: { schemaVersion: 1, entries: { 'GEO-NOHASH': entry } },
    annotations: { batches: [], requests: [] },
    certification: null,
    config: {},
    hashes: { buildHash: null, sourceHash: null }
  };
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, false);
  assert.ok(completion.reasons.some((reason) => reason.includes('缺少构建哈希')));
  assert.ok(completion.reasons.some((reason) => reason.includes('缺少源码哈希')));
});

test('失败认证不毒化门禁：修复后重跑 certified=true；失败认证在盘不影响 phase', async () => {
  const criterion = makeCriterion('GEO-POISON');
  const writes = [];
  const store = {
    paths: { certification: 'C:/demo/.modelcheck/certification.json' },
    writeJson: async (path, value) => {
      writes.push({ path, value });
    }
  };
  const failing = makeProject({ criteria: [criterion], statuses: { 'GEO-POISON': 'fail' } });
  const blocked = await applyCertification(failing, { store });
  assert.equal(blocked.certified, false);
  assert.ok(writes[0].value.invalidatedAt);

  // 失败认证记录留在盘上，不代表已认证：阶段不能因此变成 delivery
  const projectWithFailedCert = { ...failing, certification: writes[0].value, contract: failing.contract };
  assert.equal(budgetPhase(projectWithFailedCert), 'dev');

  // 修好判据后重新判定：不受失败认证记录影响
  const fixed = makeProject({ criteria: [criterion] });
  fixed.certification = writes[0].value;
  const completion = evaluateCompletion(fixed);
  assert.equal(completion.certified, true, completion.reasons.join('；'));
  assert.ok(!completion.reasons.some((reason) => reason.includes('作废')));

  // 通过后真实认证记录存在 → delivery
  const applied = await applyCertification(fixed, { store });
  assert.equal(applied.certification.certified, true);
  assert.equal(budgetPhase({ ...fixed, certification: applied.certification }), 'delivery');

  // 曾经认证通过、后来被作废的记录仍然要提示
  const trulyInvalid = makeProject({ criteria: [criterion] });
  trulyInvalid.certification = {
    certified: true,
    contractVersion: CONTRACT_VERSION,
    buildHash: BUILD,
    sourceHash: SOURCE,
    invalidatedAt: '2026-10-22T00:00:00.000Z'
  };
  const invalidated = evaluateCompletion(trulyInvalid);
  assert.equal(invalidated.certified, false);
  assert.ok(invalidated.reasons.some((reason) => reason.includes('作废')));
});

test('manual 验收：规则结果 inconclusive 但用户确认后视为满足（不再被 storedStatus 卡住）', () => {
  const criterion = makeCriterion('GEO-MANUAL-2', { acceptance: 'manual', method: 'manual' });
  const parts = makeParts('GEO-MANUAL-2');
  const key = evidenceKey(parts);
  const baseEvidence = {
    schemaVersion: 1,
    entries: {
      'GEO-MANUAL-2': buildEvidenceRecord(
        criterion,
        { status: 'inconclusive', detail: 'manual 判据不能由插件自证' },
        parts
      )
    }
  };
  const confirmedEvidence = attachUserConfirmation(baseEvidence, {
    criterionId: 'GEO-MANUAL-2',
    evidenceKey: key,
    confirmedAt: '2026-10-22T00:00:00.000Z'
  });
  const project = {
    contract: { contractVersion: CONTRACT_VERSION, status: 'confirmed', criteria: [criterion] },
    evidence: confirmedEvidence,
    annotations: { batches: [], requests: [] },
    certification: null,
    config: {},
    hashes: { buildHash: BUILD, sourceHash: SOURCE }
  };
  const completion = evaluateCompletion(project);
  assert.equal(completion.certified, true, completion.reasons.join('；'));
  assert.equal(completion.report.rows[0].status, 'confirmed');
  assert.equal(completion.report.rows[0].remedy, '');
  assert.equal(completion.report.summary.pass, 1);
  assert.deepEqual(completion.blocking, []);

  // 没有用户确认时仍然阻塞，且状态为 unconfirmed
  const noConfirm = evaluateCompletion({ ...project, evidence: baseEvidence });
  assert.equal(noConfirm.certified, false);
  assert.equal(noConfirm.blocking[0].status, 'unconfirmed');
});

test('budgetPhase：失败的 certification 记录不会把阶段抬到 delivery', () => {
  assert.equal(budgetPhase({ contract: {}, certification: { certified: false, invalidatedAt: 'x' } }), 'dev');
  assert.equal(budgetPhase({ contract: {}, certification: { certified: true } }), 'delivery');
  assert.equal(budgetPhase({ certification: { certified: true } }), 'science');
});

