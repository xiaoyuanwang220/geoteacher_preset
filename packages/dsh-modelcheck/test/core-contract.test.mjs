// ModelCheck 数据层单测（util / store / project / contract / registry）
// 运行：node --test packages/dsh-modelcheck/test/core-contract.test.mjs（工作目录仓库根）
// 夹具项目 packages/dsh-modelcheck/fixtures/project 只读；写盘测试一律在 os.tmpdir() 的临时目录里做。

import assert from 'node:assert/strict';
import { readdir, readFile, rm, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ContractError,
  LEVELS,
  STATUSES,
  blockingDefaults,
  contractContentHash,
  criteriaOf,
  diffContracts,
  isActive,
  normalizeContract,
  ruleHash,
  validateContract,
} from '../lib/contract.js';
import { findProjectRoot, loadProject, projectSummary, resolveSessionProject } from '../lib/project.js';
import { componentById, componentFingerprints, normalizeRegistry, validateRegistry } from '../lib/registry.js';
import { Store, StoreError } from '../lib/store.js';
import { clampInt, deepEqual, isPlainObject, nowIso, sha256, stableStringify } from '../lib/util.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(HERE, '..', 'fixtures', 'project');
const FIXTURE_DIR = join(FIXTURE_ROOT, '.modelcheck');

const fixtureContract = JSON.parse(await readFile(join(FIXTURE_DIR, 'contract.json'), 'utf8'));
const fixtureComponents = JSON.parse(await readFile(join(FIXTURE_DIR, 'components.json'), 'utf8'));

const tempDirs = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// 深度反转对象键顺序，用来证明规范哈希与键序无关。
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).reverse()) out[key] = reverseKeys(value[key]);
    return out;
  }
  return value;
}

async function makeTempRoot(prefix = 'mc-core-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

// 建一个最小项目：.modelcheck/ + config.json（可选 components/contract）。
async function makeTempProject({ config = true, components = null, contract = null, modelcheck = true } = {}) {
  const root = await makeTempRoot();
  if (!modelcheck) return root;
  const dir = join(root, '.modelcheck');
  await mkdir(dir, { recursive: true });
  if (config) {
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify(
        config === true
          ? { schemaVersion: 1, projectId: 'temp-project', title: '临时项目', route: 'svg', preview: { entry: 'index.html' }, build: { outputs: [] }, sources: [] }
          : config,
        null,
        2,
      ),
    );
  }
  if (components) await writeFile(join(dir, 'components.json'), JSON.stringify(components, null, 2));
  if (contract) await writeFile(join(dir, 'contract.json'), JSON.stringify(contract, null, 2));
  return root;
}

// 造一份可比对的契约（覆盖 diff 的各种降级通道）。
function crit(id, overrides = {}) {
  return {
    id,
    level: 'P1',
    claim: `判据 ${id} 的主张`,
    method: 'auto',
    rule: { kind: 'manual' },
    acceptance: 'auto',
    requiredEvidence: 'user',
    ...overrides,
  };
}

function contractOf(criteria) {
  return { schemaVersion: 1, contractVersion: '1.0.0', status: 'confirmed', source: [], criteria };
}

// ========== util ==========

test('util：规范 JSON、哈希、深比较与整数夹取', () => {
  assert.match(sha256('abc'), /^sha256:[0-9a-f]{64}$/);
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.throws(() => stableStringify(undefined), TypeError);
  assert.throws(() => stableStringify(() => 1), TypeError);
  assert.throws(() => stableStringify(Number.NaN), TypeError);
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.throws(() => stableStringify(cyclic), TypeError);

  assert.equal(deepEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.equal(deepEqual([1, 2], [1, 2, 3]), false);
  assert.equal(deepEqual(Number.NaN, Number.NaN), true);

  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(Object.create(null)), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);

  assert.equal(clampInt('3', 0, 10, 5), 5);
  assert.equal(clampInt(99, 0, 10, 5), 10);
  assert.equal(clampInt(-3, 0, 10, 5), 0);
  assert.equal(clampInt(3.9, 0, 10, 5), 3);
  assert.equal(clampInt(Number.NaN, 0, 10, 7), 7);
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

// ========== contract ==========

test('contract：夹具契约通过校验并被补齐默认值', () => {
  const result = validateContract(fixtureContract);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.errors, []);

  const contract = normalizeContract(fixtureContract);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.contractVersion, '1.0.0');
  assert.equal(contract.status, 'confirmed');
  assert.equal(contract.criteria.length, 3);
  assert.deepEqual(LEVELS, ['P0', 'P1', 'P2']);
  assert.deepEqual(STATUSES, ['unverified', 'pass', 'fail', 'inconclusive', 'stale']);

  for (const criterion of contract.criteria) {
    assert.equal(criterion.status, 'unverified');
    assert.equal(criterion.evidence, null);
    assert.deepEqual(criterion.depends, Array.isArray(criterion.depends) ? criterion.depends : []);
    assert.ok(criterion.rule && typeof criterion.rule.kind === 'string');
  }
  assert.equal(criteriaOf(contract).length, 3);
  assert.equal(contract.criteria.every(isActive), true);

  const byId = Object.fromEntries(contract.criteria.map((criterion) => [criterion.id, criterion]));
  assert.equal(byId['GEO-CLOSE-01'].requiredEvidence, 'runtime');
  assert.equal(byId['GEO-CLOSE-01'].rule.tolerance, 0.03);
  assert.equal(byId['GEO-DIR-01'].requiredEvidence, 'runtime');
  assert.equal(byId['GEO-TEXT-01'].level, 'P1');
  assert.equal(byId['GEO-TEXT-01'].requiredEvidence, 'config');

  assert.match(ruleHash(byId['GEO-CLOSE-01']), /^sha256:[0-9a-f]{64}$/);
  assert.equal(ruleHash(byId['GEO-CLOSE-01']), ruleHash(clone(byId['GEO-CLOSE-01'])));
  assert.notEqual(ruleHash(byId['GEO-CLOSE-01']), ruleHash({ rule: { ...byId['GEO-CLOSE-01'].rule, tolerance: 0.031 } }));

  assert.equal(blockingDefaults('P0'), true);
  assert.equal(blockingDefaults('P1'), true);
  assert.equal(blockingDefaults('P2'), false);
});

test('contract：缺省值（等级/阻塞/方法/验收/证据要求）', () => {
  const minimal = {
    criteria: [
      { id: 'A', claim: '默认等级与阻塞', rule: { kind: 'closure', from: 'x', to: 'y', tolerance: 0.01 } },
      { id: 'B', claim: 'P2 默认不阻塞', level: 'P2', rule: { kind: 'text', file: 'a.js', mode: 'equals', value: '甲' } },
      { id: 'C', claim: '人工确认', method: 'manual' },
    ],
  };
  const contract = normalizeContract(minimal);
  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.status, 'draft');
  const byId = Object.fromEntries(contract.criteria.map((criterion) => [criterion.id, criterion]));

  assert.equal(byId.A.level, 'P1');
  assert.equal(byId.A.blocking, true);
  assert.equal(byId.A.method, 'auto');
  assert.equal(byId.A.acceptance, 'auto');
  assert.deepEqual(byId.A.depends, []);
  assert.deepEqual(byId.A.context, {});
  assert.equal(byId.A.status, 'unverified');
  assert.equal(byId.A.evidence, null);
  assert.equal(byId.A.requiredEvidence, 'runtime');
  assert.equal(byId.A.component, null);

  assert.equal(byId.B.blocking, false);
  assert.equal(byId.B.requiredEvidence, 'config');

  assert.equal(byId.C.method, 'manual');
  assert.deepEqual(byId.C.rule, { kind: 'manual' });
  assert.equal(byId.C.requiredEvidence, 'user');
  assert.equal(byId.C.blocking, true);

  assert.equal(normalizeContract(contract).criteria.length, 3, '规范化应幂等');
});

test('contract：一次收集全部错误（重复 id / P0 非阻塞 / 未知规则 / 坏容差 / 空主张 / 空契约）', () => {
  const bad = {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    status: 'confirmed',
    criteria: [
      { id: 'DUP', level: 'P0', blocking: false, claim: '', method: 'auto', rule: { kind: 'closure', from: 'a', to: 'b', tolerance: -1 } },
      { id: 'DUP', level: 'P4', blocking: 'yes', claim: '有主张', method: 'auto', rule: { kind: 'nope' } },
      { id: 'BAD-TOL', level: 'P1', claim: '坏容差', method: 'auto', rule: { kind: 'direction', component: 'a', expectedAzimuthDeg: 90, toleranceDeg: '10' } },
      { id: 'NO-TOL', level: 'P1', claim: '缺容差', method: 'auto', rule: { kind: 'closure', from: 'a', to: 'b' } },
    ],
  };
  const result = validateContract(bad);
  assert.equal(result.ok, false);
  const codes = new Set(result.errors.map((error) => error.code));
  for (const code of [
    'criterion/id-duplicate',
    'criterion/blocking-p0',
    'criterion/claim-empty',
    'criterion/rule-kind',
    'criterion/level',
    'criterion/blocking',
    'rule/tolerance',
  ]) {
    assert.equal(codes.has(code), true, `缺少错误码 ${code}；实际：${[...codes].join(',')}`);
  }
  assert.ok(result.errors.length >= 7, `应累计全部问题，实际 ${result.errors.length}`);

  assert.throws(
    () => normalizeContract(bad),
    (error) => error instanceof ContractError && error.issues.length === result.errors.length && typeof error.code === 'string',
  );

  const empty = validateContract({ schemaVersion: 1, contractVersion: '1.0.0', status: 'confirmed', criteria: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.errors.some((error) => error.code === 'contract/empty'), true);

  const missing = validateContract({ contractVersion: '1.0.0', status: 'confirmed' });
  assert.equal(missing.errors.some((error) => error.code === 'contract/empty'), true);

  const p0NonBlocking = {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    status: 'confirmed',
    criteria: [{ id: 'P0-1', level: 'P0', blocking: false, claim: 'P0 必须阻塞', rule: { kind: 'manual' }, method: 'manual' }],
  };
  const p0Result = validateContract(p0NonBlocking);
  assert.equal(p0Result.errors.some((error) => error.code === 'criterion/blocking-p0'), true);
  assert.throws(() => normalizeContract(p0NonBlocking), ContractError);
});

test('contract：内容哈希稳定（格式/键序/确认状态/判据顺序）且随规则内容变化', () => {
  const base = contractContentHash(fixtureContract);
  assert.match(base, /^sha256:[0-9a-f]{64}$/);

  assert.equal(contractContentHash(JSON.parse(JSON.stringify(fixtureContract))), base);
  assert.equal(contractContentHash(reverseKeys(fixtureContract)), base, '键序不应影响内容哈希');

  const confirmedOnly = clone(fixtureContract);
  confirmedOnly.status = 'confirmed';
  confirmedOnly.confirmedAt = '2030-01-01T00:00:00.000Z';
  confirmedOnly.confirmedBy = '另一个用户';
  confirmedOnly.contentHash = 'sha256:死值';
  for (const criterion of confirmedOnly.criteria) {
    criterion.status = 'pass';
    criterion.evidence = { measured: { distance: 0.01 }, key: 'sha256:deadbeef' };
  }
  assert.equal(contractContentHash(confirmedOnly), base, '状态/证据/确认元数据不应影响内容哈希');

  const reordered = clone(fixtureContract);
  reordered.criteria.reverse();
  assert.equal(contractContentHash(reordered), base, '判据顺序不应影响内容哈希');

  assert.equal(contractContentHash(normalizeContract(fixtureContract)), base, '规范化前后哈希一致');

  const tolerance = clone(fixtureContract);
  tolerance.criteria[0].rule.tolerance = 0.05;
  assert.notEqual(contractContentHash(tolerance), base, '容差变化必须改变哈希');

  const claim = clone(fixtureContract);
  claim.criteria[2].claim = '改写后的主张';
  assert.notEqual(contractContentHash(claim), base, 'claim 变化必须改变哈希');

  const level = clone(fixtureContract);
  level.criteria[2].level = 'P2';
  assert.notEqual(contractContentHash(level), base, '等级变化必须改变哈希');

  const blocking = clone(fixtureContract);
  blocking.criteria[2].blocking = false;
  assert.notEqual(contractContentHash(blocking), base, '阻塞性变化必须改变哈希');

  const acceptance = clone(fixtureContract);
  acceptance.criteria[2].acceptance = 'manual';
  assert.notEqual(contractContentHash(acceptance), base, '验收方式变化必须改变哈希');

  const evidenceRequirement = clone(fixtureContract);
  evidenceRequirement.criteria[0].requiredEvidence = 'config';
  assert.notEqual(contractContentHash(evidenceRequirement), base, '证据要求变化必须改变哈希');

  const rule = clone(fixtureContract);
  rule.criteria[1].rule.expectedAzimuthDeg = 45;
  assert.notEqual(contractContentHash(rule), base, '规则参数变化必须改变哈希');
});

test('contract：变更通道识别删除/放宽/降级', () => {
  const baseCriteria = [
    crit('A', { level: 'P0', blocking: true, claim: 'A 主张', rule: { kind: 'closure', from: 'gh-a', to: 'gh-b', tolerance: 0.03 }, requiredEvidence: 'runtime' }),
    crit('B', {
      level: 'P1',
      blocking: true,
      claim: 'B 主张',
      rule: { kind: 'direction', component: 'gh-a', expectedAzimuthDeg: 225, toleranceDeg: 10 },
      requiredEvidence: 'runtime',
    }),
    crit('C', { level: 'P1', blocking: true, claim: 'C 主张', rule: { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '东北信风' }, requiredEvidence: 'config' }),
    crit('D', { level: 'P2', blocking: false, method: 'manual', rule: { kind: 'manual' }, requiredEvidence: 'user' }),
    crit('F', { level: 'P1', blocking: true }),
  ];
  const base = contractOf(baseCriteria);
  const changed = contractOf([
    crit('A', { level: 'P0', blocking: true, claim: 'A 主张（放宽后）', rule: { kind: 'closure', from: 'gh-a', to: 'gh-b', tolerance: 0.05 }, requiredEvidence: 'runtime' }),
    crit('B', {
      level: 'P2',
      blocking: true,
      claim: 'B 主张',
      rule: { kind: 'direction', component: 'gh-a', expectedAzimuthDeg: 225, toleranceDeg: 10 },
      requiredEvidence: 'runtime',
      acceptance: 'manual',
    }),
    crit('C', { level: 'P1', blocking: true, claim: 'C 主张', rule: { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '东北信风' }, requiredEvidence: 'user' }),
    crit('F', { level: 'P1', blocking: false }),
    crit('E', { level: 'P1', blocking: true, method: 'manual', rule: { kind: 'manual' } }),
  ]);

  const diff = diffContracts(base, changed);
  assert.deepEqual(diff.added.map((entry) => entry.id), ['E']);
  assert.deepEqual(diff.removed.map((entry) => entry.id), ['D']);
  assert.equal(diff.weakened.some((entry) => entry.id === 'D' && entry.kind === 'removed'), true, 'removed 必须同时出现在 weakened');

  const kinds = new Set(diff.weakened.map((entry) => entry.kind));
  for (const kind of ['removed', 'tolerance', 'level', 'acceptance', 'evidence', 'claim', 'blocking']) {
    assert.equal(kinds.has(kind), true, `weakened 缺少 ${kind}；实际：${[...kinds].join(',')}`);
  }

  const toleranceEntry = diff.weakened.find((entry) => entry.id === 'A' && entry.kind === 'tolerance');
  assert.equal(toleranceEntry.old, 0.03);
  assert.equal(toleranceEntry.new, 0.05);
  assert.equal(diff.weakened.find((entry) => entry.id === 'B' && entry.kind === 'level').old, 'P1');
  assert.equal(diff.weakened.find((entry) => entry.id === 'B' && entry.kind === 'level').new, 'P2');
  assert.equal(diff.weakened.find((entry) => entry.id === 'F' && entry.kind === 'blocking').new, false);
  assert.equal(diff.weakened.find((entry) => entry.id === 'C' && entry.kind === 'evidence').old, 'config');
  assert.equal(diff.weakened.find((entry) => entry.id === 'A' && entry.kind === 'claim').new, 'A 主张（放宽后）');

  const identical = diffContracts(base, clone(base));
  assert.deepEqual(identical.added, []);
  assert.deepEqual(identical.removed, []);
  assert.deepEqual(identical.weakened, []);

  const tightened = contractOf([
    crit('A', { level: 'P0', blocking: true, claim: 'A 主张', rule: { kind: 'closure', from: 'gh-a', to: 'gh-b', tolerance: 0.01 }, requiredEvidence: 'runtime' }),
    crit('B', {
      level: 'P1',
      blocking: true,
      claim: 'B 主张',
      rule: { kind: 'direction', component: 'gh-a', expectedAzimuthDeg: 225, toleranceDeg: 10 },
      requiredEvidence: 'runtime',
    }),
    crit('C', { level: 'P1', blocking: true, claim: 'C 主张', rule: { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '东北信风' }, requiredEvidence: 'config' }),
    crit('D', { level: 'P2', blocking: false, method: 'manual', rule: { kind: 'manual' }, requiredEvidence: 'user' }),
    crit('F', { level: 'P1', blocking: true }),
  ]);
  const tightenedDiff = diffContracts(changed, tightened);
  assert.equal(tightenedDiff.weakened.some((entry) => entry.kind === 'tolerance'), false, '收紧容差不算 weakened');
  assert.equal(tightenedDiff.weakened.some((entry) => entry.kind === 'level'), false, '提升等级不算 weakened');
});

test('contract：isActive 排除被取代与已撤回判据', () => {
  assert.equal(isActive({ id: 'A', status: 'pass' }), true);
  assert.equal(isActive({ id: 'A', supersededBy: 'B' }), false);
  assert.equal(isActive({ id: 'A', withdrawn: true }), false);
  assert.equal(isActive({ id: 'A', supersededBy: null, withdrawn: false }), true);
  assert.equal(isActive(null), false);
  assert.deepEqual(criteriaOf(null), []);
});

// ========== registry ==========

test('registry：夹具注册表合法，缺省与指纹可用', () => {
  const check = validateRegistry(fixtureComponents);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.deepEqual(check.warnings, []);

  const registry = normalizeRegistry(fixtureComponents);
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.components.length, 2);
  assert.equal(componentById(registry, 'nh-trade-winds').pick, '[data-mc-id="nh-trade-winds"]');
  assert.equal(componentById(registry, '不存在'), null);

  const fingerprints = componentFingerprints(registry);
  assert.deepEqual(Object.keys(fingerprints).sort(), ['nh-trade-winds', 'nh-westerlies']);
  assert.match(fingerprints['nh-trade-winds'], /^sha256:[0-9a-f]{64}$/);
  assert.equal(componentFingerprints(reverseKeys(fixtureComponents))['nh-trade-winds'], fingerprints['nh-trade-winds'], '键序不应影响组件指纹');

  const changed = clone(fixtureComponents);
  changed.components[0].pick = '[data-mc-id="renamed"]';
  assert.notEqual(componentFingerprints(changed)['nh-trade-winds'], fingerprints['nh-trade-winds'], 'pick 变化必须改变指纹');
});

test('registry：重复 pick / 重复 id / 缺 locator.file / 非法 route 被拒绝，related 只警告', () => {
  const duplicatePick = {
    schemaVersion: 1,
    components: [
      { id: 'a', label: '甲', route: 'svg', pick: '[data-mc-id="same"]', locator: { file: 'index.html' } },
      { id: 'b', label: '乙', route: 'svg', pick: '[data-mc-id="same"]', locator: { file: 'index.html' } },
    ],
  };
  const duplicateCheck = validateRegistry(duplicatePick);
  assert.equal(duplicateCheck.ok, false);
  assert.equal(duplicateCheck.errors.some((error) => error.code === 'component/pick-duplicate'), true);
  assert.throws(() => normalizeRegistry(duplicatePick), (error) => error.code === 'registry/invalid' && Array.isArray(error.issues));

  const duplicateId = {
    schemaVersion: 1,
    components: [
      { id: 'same', label: '甲', route: 'svg', pick: 'p1', locator: { file: 'index.html' } },
      { id: 'same', label: '乙', route: 'svg', pick: 'p2', locator: { file: 'index.html' } },
    ],
  };
  assert.equal(validateRegistry(duplicateId).errors.some((error) => error.code === 'component/id-duplicate'), true);

  const bad = {
    schemaVersion: 1,
    components: [
      { id: 'x', label: '甲', route: 'blender', pick: 'p1', locator: {} },
      { label: '', route: 'svg', pick: '', locator: { file: '/etc/passwd' } },
    ],
  };
  const badCheck = validateRegistry(bad);
  const codes = new Set(badCheck.errors.map((error) => error.code));
  assert.equal(codes.has('component/locator-file'), true);
  assert.equal(codes.has('component/route'), true);
  assert.equal(codes.has('component/label'), true);
  assert.equal(codes.has('component/pick'), true);
  assert.equal(codes.has('component/id'), true);

  const related = {
    schemaVersion: 1,
    components: [
      { id: 'a', label: '甲', route: 'svg', pick: 'p1', locator: { file: 'index.html' }, related: ['GEO-FUTURE-99'] },
    ],
  };
  assert.equal(validateRegistry(related).ok, true, 'related 指向不存在的判据不应报错');
  const relatedCheck = validateRegistry(related, { criteriaIds: ['GEO-EXIST-01'] });
  assert.equal(relatedCheck.ok, true);
  assert.equal(relatedCheck.warnings.some((warning) => warning.code === 'component/related-unknown'), true);

  const emptyCheck = validateRegistry({ schemaVersion: 1, components: [] });
  assert.equal(emptyCheck.ok, true);
  assert.equal(emptyCheck.warnings.some((warning) => warning.code === 'registry/empty'), true);
});

// ========== store ==========

test('store：布局、原子写、路径防护与解析错误', async () => {
  const root = await makeTempRoot();
  const store = new Store(root);
  assert.equal(store.paths.dir, join(root, '.modelcheck'));
  for (const key of ['config', 'components', 'contract', 'contractProposed', 'evidence', 'annotations', 'rounds', 'certification', 'reportsDir', 'artifactsDir']) {
    assert.equal(typeof store.paths[key], 'string', `paths.${key} 缺失`);
  }

  await assert.rejects(() => store.writeJson(store.paths.config, { a: 1 }), (error) => error instanceof StoreError && error.code === 'io');
  await store.ensureLayout();
  for (const dir of [store.paths.dir, store.paths.reportsDir, store.paths.artifactsDir]) {
    assert.equal(await store.exists(dir), true, `${dir} 未创建`);
  }

  await store.writeJson(store.paths.config, { projectId: 'p', nested: { b: [1, 2] } });
  assert.deepEqual(await store.readJson(store.paths.config), { projectId: 'p', nested: { b: [1, 2] } });
  const rawText = await readFile(store.paths.config, 'utf8');
  assert.match(rawText, /^\{\n {2}"projectId"/);
  assert.match(rawText, /\n$/);
  const leftovers = (await readdir(store.paths.dir)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '原子写不应残留临时文件');

  assert.equal(await store.exists(store.paths.config), true);
  assert.equal(await store.exists(join(root, '.modelcheck', 'nope.json')), false);
  assert.deepEqual(await store.readJson(join(root, '.modelcheck', 'nope.json'), { fallback: true }), { fallback: true });
  await assert.rejects(
    () => store.readJson(join(root, '.modelcheck', 'nope.json')),
    (error) => error instanceof StoreError && error.code === 'not-found',
  );

  await writeFile(join(root, '.modelcheck', 'broken.json'), '{ 不是 JSON');
  await assert.rejects(
    () => store.readJson(join(root, '.modelcheck', 'broken.json')),
    (error) => error instanceof StoreError && error.code === 'parse',
  );

  await assert.rejects(() => store.writeJson(join(root, 'outside.json'), { a: 1 }), (error) => error.code === 'io');
  await assert.rejects(() => store.writeJson(join(root, '.modelcheck', '..', 'escape.json'), { a: 1 }), (error) => error.code === 'io');
  await assert.rejects(() => store.writeJson(join(root, '..', 'escape.json'), { a: 1 }), (error) => error.code === 'io');
});

test('store：updateJson 读改写与冲突检测', async () => {
  const root = await makeTempRoot();
  const store = new Store(root);
  await store.ensureLayout();
  const path = join(root, '.modelcheck', 'counter.json');

  const first = await store.updateJson(path, (current, meta) => {
    assert.equal(current, null);
    assert.equal(meta.revision, null);
    return { count: 1 };
  });
  assert.deepEqual(first, { count: 1 });
  assert.deepEqual(await store.readJson(path), { count: 1 });

  const second = await store.updateJson(path, (current, meta) => {
    assert.match(meta.revision, /^sha256:[0-9a-f]{64}$/);
    return { count: current.count + 1 };
  });
  assert.deepEqual(second, { count: 2 });
  assert.deepEqual(await store.readJson(path), { count: 2 });

  const unchanged = await store.updateJson(path, () => undefined);
  assert.deepEqual(unchanged, { count: 2 });
  assert.deepEqual(await store.readJson(path), { count: 2 }, 'mutate 返回 undefined 表示不写入');

  await assert.rejects(
    () =>
      store.updateJson(path, async (current) => {
        // 模拟并发写入：读取后、写回前文件被别的调用改掉
        await store.writeJson(path, { count: 99, tampered: true });
        return { count: current.count + 1 };
      }),
    (error) => error instanceof StoreError && error.code === 'conflict',
  );
  assert.deepEqual(await store.readJson(path), { count: 99, tampered: true }, '冲突时不覆盖对方写入');
});

test('store：writeArtifact 以内容哈希命名并落在 artifacts/', async () => {
  const root = await makeTempRoot();
  const store = new Store(root);
  await store.ensureLayout();

  const artifact = await store.writeArtifact('hello modelcheck', 'txt');
  assert.match(artifact.name, /^[0-9a-f]{64}\.txt$/);
  assert.match(artifact.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(artifact.path, join(store.paths.artifactsDir, artifact.name));
  assert.equal(artifact.name.startsWith(artifact.hash.slice('sha256:'.length)), true, '文件名 = 内容哈希');
  assert.equal(await readFile(artifact.path, 'utf8'), 'hello modelcheck');

  const again = await store.writeArtifact('hello modelcheck', 'txt');
  assert.equal(again.name, artifact.name, '相同内容应复用同名产物');
  const different = await store.writeArtifact(Buffer.from([0, 1, 2]), 'png');
  assert.notEqual(different.name, artifact.name);
  assert.match(different.name, /^[0-9a-f]{64}\.png$/);
});

// ========== project ==========

test('project：夹具项目载入、哈希与摘要', async () => {
  const project = await loadProject(FIXTURE_ROOT);
  assert.equal(project.root, resolve(FIXTURE_ROOT));
  assert.equal(project.config.projectId, 'fixture-circulation');
  assert.equal(project.config.route, 'svg');
  assert.equal(project.config.preview.unitToPx, 0.001);
  assert.match(project.configHash, /^sha256:[0-9a-f]{64}$/);

  assert.equal(project.components.components.length, 2);
  assert.equal(project.contract.criteria.length, 3);
  assert.equal(project.contractHash, contractContentHash(project.contract));
  assert.match(project.contractHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(project.contract.status, 'confirmed');

  assert.deepEqual(project.evidence.entries, {});
  assert.equal(project.evidence.adapterVersion, null);
  assert.deepEqual(project.annotations.requests, []);
  assert.deepEqual(project.rounds.rounds, []);
  assert.equal(project.certification, null);
  assert.equal(project.contractProposed, null);

  assert.match(project.hashes.sourceHash, /^sha256:[0-9a-f]{64}$/, '夹具登记了源文件，sourceHash 应有值');
  assert.equal(project.hashes.buildHash, null, '夹具没有构建产物');

  const summary = projectSummary(project);
  assert.equal(summary.projectId, 'fixture-circulation');
  assert.equal(summary.title, '夹具：三圈环流（闭合与方向）');
  assert.equal(summary.route, 'svg');
  assert.equal(summary.root, resolve(FIXTURE_ROOT));
  assert.equal(summary.previewEntry, 'index.html');
  assert.equal(summary.unitToPx, 0.001);
  assert.equal(summary.contract.confirmed, true);
  assert.equal(summary.contract.criteria.total, 3);
  assert.equal(summary.contract.criteria.active, 3);
  assert.equal(summary.contract.criteria.byLevel.P0, 2);
  assert.equal(summary.contract.criteria.byLevel.P1, 1);
  assert.equal(summary.contract.criteria.byStatus.unverified, 3);
  assert.equal(summary.contract.contentHash, project.contractHash);
  assert.equal(summary.components.total, 2);
  assert.equal(summary.evidence.sourceHash, project.hashes.sourceHash);
  assert.equal(summary.annotations.pending, 0);

  const viaStore = await loadProject(FIXTURE_ROOT, { store: new Store(FIXTURE_ROOT) });
  assert.equal(viaStore.contractHash, project.contractHash);
});

test('project：缺失可选文件按缺省处理，坏契约抛 ContractError', async () => {
  const minimalRoot = await makeTempProject();
  const minimal = await loadProject(minimalRoot);
  assert.equal(minimal.contract, null);
  assert.equal(minimal.contractHash, null);
  assert.deepEqual(minimal.evidence.entries, {});
  assert.deepEqual(minimal.annotations.batches, []);
  assert.deepEqual(minimal.rounds.rounds, []);
  assert.equal(minimal.certification, null);
  assert.equal(minimal.hashes.buildHash, null);
  assert.equal(minimal.hashes.sourceHash, null);
  assert.ok(Array.isArray(minimal.issues));

  const invalidRoot = await makeTempProject({ contract: contractOf([crit('P0-X', { level: 'P0', blocking: false })]) });
  await assert.rejects(
    () => loadProject(invalidRoot),
    (error) => error instanceof ContractError && error.issues.some((item) => item.code === 'criterion/blocking-p0'),
  );

  const brokenRoot = await makeTempProject();
  await writeFile(join(brokenRoot, '.modelcheck', 'contract.json'), '{ 这不是契约');
  await assert.rejects(
    () => loadProject(brokenRoot),
    (error) => error instanceof ContractError && error.code === 'contract/parse',
  );

  const proposedRoot = await makeTempProject({ contract: contractOf([crit('A', { rule: { kind: 'closure', from: 'x', to: 'y', tolerance: 0.01 } })]) });
  await writeFile(join(proposedRoot, '.modelcheck', 'contract.proposed.json'), JSON.stringify(contractOf([crit('A2')]))); 
  const proposed = await loadProject(proposedRoot);
  assert.notEqual(proposed.contractProposed, null);
  assert.match(projectSummary(proposed).contractProposed.contentHash, /^sha256:[0-9a-f]{64}$/);

  const corruptRoot = await makeTempProject();
  await writeFile(join(corruptRoot, '.modelcheck', 'evidence.json'), '不是 JSON');
  const corrupt = await loadProject(corruptRoot);
  assert.deepEqual(corrupt.evidence.entries, {}, '坏 evidence.json 不应拖垮项目载入');
  assert.equal(corrupt.issues.some((item) => item.includes('evidence.json')), true);
});

test('project：hashes 由 config.sources / build.outputs 计算', async () => {
  const root = await makeTempRoot();
  await mkdir(join(root, '.modelcheck'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'src', 'config.js'), 'export const A = 1;\n');
  await writeFile(join(root, 'dist', 'bundle.js'), 'console.log(1);\n');
  const config = {
    schemaVersion: 1,
    projectId: 'hash-project',
    route: 'three',
    preview: { entry: 'index.html' },
    build: { entry: 'index.html', outputs: ['dist/bundle.js', 'dist/missing.js'] },
    sources: ['src/config.js', 'src/missing.js'],
  };
  await writeFile(join(root, '.modelcheck', 'config.json'), JSON.stringify(config));

  const project = await loadProject(root);
  assert.match(project.hashes.sourceHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(project.hashes.buildHash, /^sha256:[0-9a-f]{64}$/, '至少一个产物存在时 buildHash 应有值');

  await writeFile(join(root, 'src', 'config.js'), 'export const A = 2;\n');
  const changed = await loadProject(root);
  assert.notEqual(changed.hashes.sourceHash, project.hashes.sourceHash, '源文件变化必须改变 sourceHash');

  await rm(join(root, 'dist', 'bundle.js'));
  const noBuild = await loadProject(root);
  assert.equal(noBuild.hashes.buildHash, null, '产物全缺时 buildHash 为 null');
});

test('project：findProjectRoot 从嵌套目录向上查找，支持注入 fs', async () => {
  const root = await makeTempProject();
  const nested = join(root, 'a', 'b', 'c');
  await mkdir(nested, { recursive: true });

  assert.equal(await findProjectRoot(nested), resolve(root));
  assert.equal(await findProjectRoot(root), resolve(root));

  const noProjectRoot = await makeTempRoot('mc-none-');
  const noProjectNested = join(noProjectRoot, 'x');
  await mkdir(noProjectNested, { recursive: true });
  assert.equal(await findProjectRoot(noProjectNested), null);

  const target = join(root, '.modelcheck', 'config.json');
  const fakeFs = {
    access: async (path) => {
      if (path === target) return undefined;
      const error = new Error(`ENOENT: ${path}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
  assert.equal(await findProjectRoot(nested, { fs: fakeFs }), resolve(root), '应使用注入的 fs 服务');

  const fakeExistsFs = { exists: async (path) => path === target };
  assert.equal(await findProjectRoot(nested, { fs: fakeExistsFs }), resolve(root), '应兼容 exists(path) 形状的 fs 服务');

  assert.equal(await findProjectRoot('', {}), null);
});

test('project：resolveSessionProject 用注入的 getSessionCwd 解析', async () => {
  const root = await makeTempProject();
  const nested = join(root, 'work', 'nested');
  await mkdir(nested, { recursive: true });

  const project = await resolveSessionProject('session-1', { getSessionCwd: async () => nested });
  assert.equal(project.root, resolve(root));
  assert.equal(project.config.projectId, 'temp-project');

  assert.equal(await resolveSessionProject('session-2', { getSessionCwd: async () => undefined }), null);
  assert.equal(await resolveSessionProject('session-3', { getSessionCwd: async () => { throw new Error('会话不存在'); } }), null);
  assert.equal(await resolveSessionProject('session-4', { getSessionCwd: async () => join(await makeTempRoot('mc-outside-'), 'x') }), null);
  await assert.rejects(() => resolveSessionProject('session-5', {}), TypeError);
});

test('project：projectSummary 对空项目也给出稳定形状', () => {
  const summary = projectSummary(null);
  assert.equal(summary.projectId, null);
  assert.equal(summary.root, null);
  assert.equal(summary.contract, null);
  assert.deepEqual(summary.components, { total: 0, issues: 0 });
  assert.deepEqual(summary.annotations, { batches: 0, requests: 0, pending: 0 });
  assert.equal(summary.evidence.entries, 0);
});
