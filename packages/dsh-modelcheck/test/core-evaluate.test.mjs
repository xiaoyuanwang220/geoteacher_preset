// ModelCheck evaluate.js 单测（设计 §2.9 / 规格 §5–§7、§17）
//
// 覆盖：复用、依赖变化 stale、规则变化重跑、runtime 缺证据、旧构建/上下文丢弃、
//      元判据未过不可启用与其缓存、ids/full 筛选、currentKeys/summary、写盘与内存镜像。
// 全部用临时目录 + fixtures/project 的副本，避免污染仓库夹具；不依赖宿主包。

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contractContentHash } from '../lib/contract.js';
import { attachUserConfirmation } from '../lib/evidence.js';
import { EvaluateError, createFilesAdapter, evaluateCriteria } from '../lib/evaluate.js';
import { loadProject } from '../lib/project.js';
import { executeRule as realExecuteRule } from '../lib/rules.js';
import { selfCheckRule as realSelfCheckRule } from '../lib/selfcheck.js';
import { Store } from '../lib/store.js';
import { deepEqual, sha256 } from '../lib/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = resolve(HERE, '../fixtures/project');
const NOW = '2026-10-22T12:00:00.000Z';
const EV_BUILD = `sha256:${'b'.repeat(64)}`;
const OTHER_BUILD = `sha256:${'d'.repeat(64)}`;
const OTHER_SOURCE = `sha256:${'e'.repeat(64)}`;

/** 复制夹具项目到临时目录并载入。 */
async function fixtureProject(t) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-modelcheck-eval-'));
  t.after(async () => {
    await rm(base, { recursive: true, force: true });
  });
  const root = join(base, 'project');
  await cp(FIXTURE_PROJECT, root, { recursive: true });
  const store = new Store(root);
  const project = await loadProject(root, { store });
  return { root, store, project };
}

/** 读原始契约（loadProject 之前/直接改文件时用）。 */
async function readContractRaw(root) {
  return JSON.parse(await readFile(join(root, '.modelcheck/contract.json'), 'utf8'));
}

/** 构造运行时证据；context 默认与夹具判据一致。 */
function runtimeEvidence(project, overrides = {}) {
  return {
    requestId: 'req-1',
    projectId: project.config.projectId,
    buildHash: EV_BUILD,
    sourceHash: project.hashes.sourceHash,
    adapterVersion: 'modelcheck-adapter/test',
    context: { step: 'end', mode: 'normal', view: 'default' },
    components: {
      'nh-trade-winds': {
        unit: 'world',
        directionDeg: 45,
        endpoints: { start: { x: 1, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } },
      },
      'nh-westerlies': {
        unit: 'world',
        endpoints: { start: { x: 0.035, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } },
      },
    },
    coverage: [],
    errors: [],
    evidenceKind: 'runtime',
    capturedAt: NOW,
    ...overrides,
  };
}

test('evaluate：真实规则引擎跑夹具，闭合缝 0.035 判 fail、方向 45° 判 fail、文案 pass', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const ctxCalls = [];
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ctxFactory: async (group, context) => {
      ctxCalls.push({ ids: group.map((criterion) => criterion.id), context });
      return runtimeEvidence(project);
    },
  });

  assert.deepEqual(Object.keys(evaluation.results).sort(), ['GEO-CLOSE-01', 'GEO-DIR-01', 'GEO-TEXT-01']);
  assert.equal(evaluation.results['GEO-CLOSE-01'].status, 'fail');
  assert.equal(evaluation.results['GEO-DIR-01'].status, 'fail');
  assert.equal(evaluation.results['GEO-TEXT-01'].status, 'pass');
  assert.ok(Math.abs(evaluation.results['GEO-CLOSE-01'].measured.distance - 0.035) < 1e-9);
  assert.equal(evaluation.results['GEO-CLOSE-01'].reused, false);
  assert.equal(evaluation.results['GEO-CLOSE-01'].evidenceKind, 'runtime');
  // 同一 context 的运行时判据只请求一次取证，且批次里包含两条判据。
  assert.equal(ctxCalls.length, 1);
  assert.deepEqual(ctxCalls[0].ids.sort(), ['GEO-CLOSE-01', 'GEO-DIR-01']);
  assert.deepEqual(ctxCalls[0].context, { step: 'end', mode: 'normal', view: 'default' });
  assert.equal(evaluation.runtimeWarnings.length, 0);
  assert.equal(evaluation.contractVersion, '1.0.0');
  assert.equal(evaluation.at, NOW);

  // 证据落到 evidence.json，状态镜像回 contract.json（status/evidence 不参与内容哈希）。
  const evidenceDoc = JSON.parse(await readFile(store.paths.evidence, 'utf8'));
  assert.equal(evidenceDoc.entries['GEO-CLOSE-01'].status, 'fail');
  assert.equal(evidenceDoc.entries['GEO-TEXT-01'].status, 'pass');
  assert.deepEqual(evidenceDoc.entries['GEO-CLOSE-01'].keyParts.context, {
    step: 'end',
    mode: 'normal',
    view: 'default',
  });
  assert.equal(evidenceDoc.entries['GEO-CLOSE-01'].keyParts.buildHash, EV_BUILD);
  const contractDoc = JSON.parse(await readFile(store.paths.contract, 'utf8'));
  const closeCriterion = contractDoc.criteria.find((criterion) => criterion.id === 'GEO-CLOSE-01');
  assert.equal(closeCriterion.status, 'fail');
  assert.equal(closeCriterion.evidence.status, 'fail');
  assert.deepEqual(contractDoc.criteria.find((criterion) => criterion.id === 'GEO-TEXT-01').status, 'pass');

  // 内存镜像（host tools 紧接着读取）。
  assert.equal(project.evidence.entries['GEO-CLOSE-01'].status, 'fail');
  assert.equal(project.contract.criteria.find((criterion) => criterion.id === 'GEO-DIR-01').status, 'fail');
  assert.equal(root, project.root);
});

test('evaluate：键一致且上次 pass 时复用，evidence 与 contract 内容哈希都不被破坏', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const hashBefore = contractContentHash(project.contract);

  let ruleCalls = 0;
  const execute = async (rule, ctx) => {
    ruleCalls += 1;
    return realExecuteRule(rule, ctx);
  };
  const first = await evaluateCriteria(project, { store, now: NOW, ids: ['GEO-TEXT-01'], executeRule: execute });
  assert.equal(first.results['GEO-TEXT-01'].status, 'pass');
  assert.equal(ruleCalls, 1);
  const capturedAt = first.evidence.entries['GEO-TEXT-01'].capturedAt;

  // 重新载入项目（模拟下一次工具调用），证据键未变 → 复用且不再执行规则。
  const reloaded = await loadProject(root, { store });
  const second = await evaluateCriteria(reloaded, {
    store,
    now: '2026-10-22T12:30:00.000Z',
    ids: ['GEO-TEXT-01'],
    executeRule: execute,
  });
  assert.equal(second.results['GEO-TEXT-01'].status, 'pass');
  assert.equal(second.results['GEO-TEXT-01'].reused, true);
  assert.equal(ruleCalls, 1, '复用路径不得调用规则执行器');
  assert.equal(second.evidence.entries['GEO-TEXT-01'].capturedAt, capturedAt, '复用不得改写证据时间');
  assert.equal(second.summary.reused, 1);
  assert.equal(second.summary.evaluated, 0);

  // 契约内容哈希在状态镜像后保持不变（status/evidence 是易变字段）。
  assert.equal(contractContentHash(reloaded.contract), hashBefore);
});

test('evaluate：键一致但上次非 pass → 重跑；buildHash 已登记时证据键保持稳定', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const withBuild = { ...project, hashes: { ...project.hashes, buildHash: EV_BUILD } };
  let ctxCalls = 0;
  const ctxFactory = async () => {
    ctxCalls += 1;
    return runtimeEvidence(project);
  };
  const first = await evaluateCriteria(withBuild, { store, now: NOW, ctxFactory, ids: ['GEO-CLOSE-01'] });
  assert.equal(first.results['GEO-CLOSE-01'].status, 'fail');
  assert.equal(ctxCalls, 1);

  const reloaded = await loadProject(root, { store });
  const reuseProject = { ...reloaded, hashes: { ...reloaded.hashes, buildHash: EV_BUILD } };
  const second = await evaluateCriteria(reuseProject, {
    store,
    now: '2026-10-22T13:00:00.000Z',
    ids: ['GEO-CLOSE-01'],
    ctxFactory,
  });
  // 上次状态是 fail，键一致但 status !== pass → 必须重跑（不复用失败结果）。
  assert.equal(second.results['GEO-CLOSE-01'].reused, false);
  assert.equal(ctxCalls, 2);
  assert.equal(reuseProject.hashes.buildHash, EV_BUILD);
});

test('evaluate：依赖文件变化 → 执行前显式写 stale，重跑得到新结果', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const first = await evaluateCriteria(project, { store, now: NOW, ids: ['GEO-TEXT-01'] });
  assert.equal(first.results['GEO-TEXT-01'].status, 'pass');
  const firstKey = first.evidence.entries['GEO-TEXT-01'].key;

  // 改掉被依赖的配置文案（判据应 fail）。
  await writeFile(join(root, 'src/config.js'), '// 文案被改坏\nexport const X = 1;\n', 'utf8');

  const statusAtExecution = [];
  const execute = async (rule, ctx) => {
    const doc = JSON.parse(await readFile(store.paths.evidence, 'utf8'));
    statusAtExecution.push(doc.entries['GEO-TEXT-01'] ? doc.entries['GEO-TEXT-01'].status : null);
    return realExecuteRule(rule, ctx);
  };
  const reloaded = await loadProject(root, { store });
  const second = await evaluateCriteria(reloaded, {
    store,
    now: '2026-10-22T13:10:00.000Z',
    ids: ['GEO-TEXT-01'],
    executeRule: execute,
  });

  assert.deepEqual(statusAtExecution, ['stale'], '执行前必须把旧证据显式标记为 stale');
  assert.equal(second.results['GEO-TEXT-01'].status, 'fail');
  assert.equal(second.results['GEO-TEXT-01'].reused, false);
  const secondKey = second.evidence.entries['GEO-TEXT-01'].key;
  assert.notEqual(secondKey, firstKey, '依赖变化后证据键必须变化');
  assert.notDeepEqual(second.evidence.entries['GEO-TEXT-01'].keyParts.deps, {
    'src/config.js': first.evidence.entries['GEO-TEXT-01'].keyParts.deps['src/config.js'],
  });
});

test('evaluate：规则/阈值变化 → 证据键变化并重跑（不复用旧 pass）', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const ctxFactory = async () => runtimeEvidence(project);
  let ruleCalls = 0;
  const execute = async (rule, ctx) => {
    ruleCalls += 1;
    return realExecuteRule(rule, ctx);
  };
  const first = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-CLOSE-01'],
    ctxFactory,
    executeRule: execute,
  });
  assert.equal(ruleCalls, 1);
  assert.equal(first.results['GEO-CLOSE-01'].status, 'fail', '容差 0.03 时 0.035 的闭合缝应 fail');

  // 放宽容差到 0.05：规则哈希变化 → 不复用旧 pass/fail，必须重跑；0.035 变成 pass。
  const raw = await readContractRaw(root);
  const target = raw.criteria.find((criterion) => criterion.id === 'GEO-CLOSE-01');
  target.rule.tolerance = 0.05;
  await store.writeJson(store.paths.contract, raw);

  const reloaded = await loadProject(root, { store });
  const second = await evaluateCriteria(reloaded, {
    store,
    now: '2026-10-22T13:20:00.000Z',
    ids: ['GEO-CLOSE-01'],
    ctxFactory,
    executeRule: execute,
  });
  assert.equal(ruleCalls, 2);
  assert.equal(second.results['GEO-CLOSE-01'].reused, false);
  assert.equal(second.results['GEO-CLOSE-01'].status, 'pass');
  assert.notEqual(
    second.evidence.entries['GEO-CLOSE-01'].keyParts.ruleHash,
    first.evidence.entries['GEO-CLOSE-01'].keyParts.ruleHash,
  );
});

test('evaluate：运行时无证据 → 运行时判据 inconclusive（绝不 pass），配置判据不受影响', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ctxFactory: async () => null,
  });
  assert.equal(evaluation.results['GEO-CLOSE-01'].status, 'inconclusive');
  assert.equal(evaluation.results['GEO-DIR-01'].status, 'inconclusive');
  assert.match(evaluation.results['GEO-CLOSE-01'].detail, /未取得运行时取证/);
  assert.equal(evaluation.results['GEO-TEXT-01'].status, 'pass');
  assert.equal(evaluation.summary.byStatus.pass, 1);
  assert.equal(evaluation.summary.byStatus.inconclusive, 2);
  assert.equal(evaluation.summary.selfCheckFailed, 0);
});

test('evaluate：取证 buildHash 与当前产物不一致（旧构建）→ inconclusive', async (t) => {
  const { store, project } = await fixtureProject(t);
  const staleProject = { ...project, hashes: { ...project.hashes, buildHash: OTHER_BUILD } };
  const evaluation = await evaluateCriteria(staleProject, {
    store,
    now: NOW,
    ids: ['GEO-CLOSE-01'],
    ctxFactory: async () => runtimeEvidence(project, { buildHash: OTHER_SOURCE }),
  });
  assert.equal(evaluation.results['GEO-CLOSE-01'].status, 'inconclusive');
  assert.match(evaluation.results['GEO-CLOSE-01'].detail, /旧构建/);
});

test('evaluate：取证上下文与判据要求不符 → inconclusive', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-DIR-01'],
    ctxFactory: async () => runtimeEvidence(project, { context: { step: 'start', mode: 'normal', view: 'default' } }),
  });
  assert.equal(evaluation.results['GEO-DIR-01'].status, 'inconclusive');
  assert.match(evaluation.results['GEO-DIR-01'].detail, /上下文/);
});

test('evaluate：取证缺少 buildHash → inconclusive', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evidence = runtimeEvidence(project);
  delete evidence.buildHash;
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-CLOSE-01'],
    ctxFactory: async () => evidence,
  });
  assert.equal(evaluation.results['GEO-CLOSE-01'].status, 'inconclusive');
  assert.match(evaluation.results['GEO-CLOSE-01'].detail, /buildHash/);
});

test('evaluate：元判据未通过 → 判据不可启用（inconclusive）且不执行规则', async (t) => {
  const { store, project } = await fixtureProject(t);
  let ruleCalls = 0;
  const execute = async () => {
    ruleCalls += 1;
    return { status: 'pass', measured: 1, assertion: '不该执行', detail: '不该执行' };
  };
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-TEXT-01'],
    executeRule: execute,
    selfCheckRule: async () => ({ ok: false, cases: [], issues: ['正确样本未 pass'] }),
  });
  assert.equal(evaluation.results['GEO-TEXT-01'].status, 'inconclusive');
  assert.match(evaluation.results['GEO-TEXT-01'].detail, /元判据未通过/);
  assert.equal(ruleCalls, 0);
  assert.equal(evaluation.summary.selfCheckFailed, 1);
  assert.deepEqual(evaluation.selfCheckFailures, ['GEO-TEXT-01']);
  const entry = evaluation.evidence.entries['GEO-TEXT-01'];
  assert.equal(entry.selfCheck.ok, false);
  assert.equal(entry.status, 'inconclusive');
});

test('evaluate：元判据按 ruleHash 缓存，同规则多判据只自检一次', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const raw = await readContractRaw(root);
  const source = raw.criteria.find((criterion) => criterion.id === 'GEO-TEXT-01');
  raw.criteria.push({ ...JSON.parse(JSON.stringify(source)), id: 'GEO-TEXT-02', claim: '同一规则的重复判据' });
  await store.writeJson(store.paths.contract, raw);

  let checkCalls = 0;
  const selfCheck = async (criterion, fixtures) => {
    checkCalls += 1;
    return realSelfCheckRule(criterion, fixtures);
  };
  const reloaded = await loadProject(root, { store });
  const evaluation = await evaluateCriteria(reloaded, {
    store,
    now: NOW,
    ids: ['GEO-TEXT-01', 'GEO-TEXT-02'],
    selfCheckRule: selfCheck,
  });
  assert.equal(checkCalls, 1);
  assert.equal(evaluation.results['GEO-TEXT-01'].status, 'pass');
  assert.equal(evaluation.results['GEO-TEXT-02'].status, 'pass');
});

test('evaluate：ids 筛选与 unknown-ids 结构化错误', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evaluation = await evaluateCriteria(project, { store, now: NOW, ids: ['GEO-TEXT-01'] });
  assert.deepEqual(Object.keys(evaluation.results), ['GEO-TEXT-01']);
  assert.equal(evaluation.summary.total, 1);
  assert.equal(evaluation.summary.skipped, 2);

  await assert.rejects(
    () => evaluateCriteria(project, { store, now: NOW, ids: ['GEO-NOT-EXIST'] }),
    (error) => error instanceof EvaluateError && error.code === 'unknown-ids' && deepEqual(error.missing, ['GEO-NOT-EXIST']),
  );
});

test('evaluate：full=true 强制重跑（即使键一致且上次 pass）', async (t) => {
  const { store, project } = await fixtureProject(t);
  let ruleCalls = 0;
  const execute = async (rule, ctx) => {
    ruleCalls += 1;
    return realExecuteRule(rule, ctx);
  };
  await evaluateCriteria(project, { store, now: NOW, ids: ['GEO-TEXT-01'], executeRule: execute });
  await evaluateCriteria(project, { store, now: NOW, ids: ['GEO-TEXT-01'], executeRule: execute });
  assert.equal(ruleCalls, 1);
  const forced = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-TEXT-01'],
    full: true,
    executeRule: execute,
  });
  assert.equal(ruleCalls, 2);
  assert.equal(forced.results['GEO-TEXT-01'].reused, false);
  assert.equal(forced.results['GEO-TEXT-01'].status, 'pass');
});

test('evaluate：currentKeys 与 evidence.entries[].key 一致，summary 自洽', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ctxFactory: async () => runtimeEvidence(project),
  });
  for (const [id, result] of Object.entries(evaluation.results)) {
    assert.equal(typeof evaluation.currentKeys[id], 'string');
    assert.equal(result.key, evaluation.currentKeys[id]);
    assert.equal(evaluation.evidence.entries[id].key, evaluation.currentKeys[id]);
    assert.match(evaluation.currentKeys[id], /^sha256:[0-9a-f]{64}$/);
  }
  assert.equal(evaluation.summary.total, 3);
  const sum = Object.values(evaluation.summary.byStatus).reduce((total, count) => total + count, 0);
  assert.equal(sum, 3);
  assert.equal(evaluation.summary.currentKeys, 3);
  // completion 用 currentKeys 校验新鲜度：与证据键逐条相等。
  assert.equal(Object.keys(evaluation.currentKeys).length, 3);
});

test('evaluate：没有 store 时不落盘，但内存镜像仍可用且不改动载入的证据对象', async (t) => {
  const { project } = await fixtureProject(t);
  const originalEvidenceRef = project.evidence;
  const originalEntries = project.evidence.entries;
  const evaluation = await evaluateCriteria(project, { now: NOW, ids: ['GEO-TEXT-01'] });
  assert.deepEqual(originalEntries, {}, '载入的证据对象不得被原地改写');
  assert.notEqual(project.evidence, originalEvidenceRef, '内存镜像应替换为新的证据文档');
  assert.equal(project.evidence.entries['GEO-TEXT-01'].status, 'pass');
  assert.equal(evaluation.evidence.entries['GEO-TEXT-01'].status, 'pass');
});

test('evaluate：缺契约 → EvaluateError(no-contract)', async () => {
  await assert.rejects(
    () => evaluateCriteria({ contract: null }),
    (error) => error instanceof EvaluateError && error.code === 'no-contract',
  );
  await assert.rejects(
    () => evaluateCriteria(null),
    (error) => error instanceof EvaluateError && error.code === 'no-project',
  );
});

test('createFilesAdapter：只允许项目内路径，hash 与文件字节一致', async (t) => {
  const { root } = await fixtureProject(t);
  const files = createFilesAdapter(root);
  const text = await files.read('src/config.js');
  assert.match(text, /北半球东北信风/);
  assert.equal(await files.hash('src/config.js'), sha256(Buffer.from(text, 'utf8')));
  assert.equal(await files.exists('src/config.js'), true);
  assert.equal(await files.exists('src/not-there.js'), false);
  await assert.rejects(
    () => files.read('../outside.txt'),
    (error) => error instanceof EvaluateError && error.code === 'invalid-path',
  );
  await assert.rejects(
    () => files.hash('/etc/passwd'),
    (error) => error instanceof EvaluateError && error.code === 'invalid-path',
  );
});

test('evaluate：证据键含全部版本字段（contractVersion/ruleHash/deps/adapterVersion/context/buildHash/sourceHash）', async (t) => {
  const { store, project } = await fixtureProject(t);
  const evaluation = await evaluateCriteria(project, {
    store,
    now: NOW,
    ids: ['GEO-CLOSE-01'],
    ctxFactory: async () => runtimeEvidence(project),
  });
  const parts = evaluation.evidence.entries['GEO-CLOSE-01'].keyParts;
  for (const field of ['contractVersion', 'ruleHash', 'deps', 'adapterVersion', 'context', 'buildHash', 'sourceHash']) {
    assert.ok(Object.prototype.hasOwnProperty.call(parts, field), `证据键缺少字段 ${field}`);
  }
  assert.deepEqual(parts.deps, { 'index.html': sha256(await readFile(join(project.root, 'index.html'))) });
  assert.equal(parts.sourceHash, project.hashes.sourceHash);
  assert.equal(parts.adapterVersion, 'modelcheck-adapter/test');
});

test('evaluate：人工验收的用户确认在证据键不变时保留，键变化时失效', async (t) => {
  const { store, root, project } = await fixtureProject(t);
  const raw = await readContractRaw(root);
  raw.criteria = [
    {
      id: 'USR-0001',
      level: 'P1',
      blocking: true,
      claim: '构图配色需用户确认',
      method: 'manual',
      rule: { kind: 'manual' },
      depends: ['src/config.js'],
      acceptance: 'manual',
      requiredEvidence: 'user',
      context: {},
      status: 'unverified',
      evidence: null,
    },
  ];
  await store.writeJson(store.paths.contract, raw);

  let reloaded = await loadProject(root, { store });
  const first = await evaluateCriteria(reloaded, { store, now: NOW, ids: ['USR-0001'] });
  assert.equal(first.results['USR-0001'].status, 'inconclusive');
  const firstKey = first.evidence.entries['USR-0001'].key;
  assert.match(firstKey, /^sha256:[0-9a-f]{64}$/);

  // 模拟用户在面板点“通过”：宿主调用 evidence.js 的唯一入口写 userConfirmation。
  const withConfirmation = attachUserConfirmation(first.evidence, {
    criterionId: 'USR-0001',
    evidenceKey: firstKey,
    confirmedBy: 'user',
    confirmedAt: NOW,
  });
  await store.writeJson(store.paths.evidence, withConfirmation);

  // 同一证据版本重跑：键不变 → 确认保留（completion 依据绑定键判定是否仍是当前版本）。
  reloaded = await loadProject(root, { store });
  const second = await evaluateCriteria(reloaded, { store, now: '2026-10-22T13:40:00.000Z', ids: ['USR-0001'] });
  const kept = second.evidence.entries['USR-0001'];
  assert.equal(kept.key, firstKey);
  assert.equal(kept.userConfirmation.confirmedBy, 'user');
  assert.equal(kept.userConfirmation.evidenceKey, firstKey);

  // 依赖变化 → 证据键变化 → 旧确认失效，必须由用户对新版本重新确认。
  await writeFile(join(root, 'src/config.js'), '// 版本变化\nexport const X = 2;\n', 'utf8');
  reloaded = await loadProject(root, { store });
  const third = await evaluateCriteria(reloaded, { store, now: '2026-10-22T13:50:00.000Z', ids: ['USR-0001'] });
  const dropped = third.evidence.entries['USR-0001'];
  assert.notEqual(dropped.key, firstKey);
  assert.equal(dropped.userConfirmation, undefined);
});
