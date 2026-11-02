// ModelCheck —— 规则引擎与元判据测试
//
// 覆盖 design §2.6/§2.7 与规格 §6/§9/§19：闭合边界、方向使用运行时值、
// 文案/哈希、端点、包围盒只候选、人工判据、缺证据与非法规则 fail-closed、自检三样本。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeRule, validateRule, createNodeFilesAdapter, RULE_KINDS } from '../lib/rules.js';
import { selfCheckRule, buildDefaultFixtures } from '../lib/selfcheck.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = join(HERE, '..', 'fixtures', 'project');

function evidence(components) {
  return {
    buildHash: 'sha256:' + '1'.repeat(64),
    sourceHash: 'sha256:' + '2'.repeat(64),
    adapterVersion: 'modelcheck-adapter/test',
    context: { step: 'end', mode: 'normal', view: 'default' },
    components,
    coverage: [],
    errors: []
  };
}
function ctx(rule, components, extra = {}) {
  return {
    projectRoot: FIXTURE_PROJECT,
    route: 'svg',
    unitToPx: 0.001,
    files: createNodeFilesAdapter(FIXTURE_PROJECT),
    components: { components: [] },
    evidence: components ? evidence(components) : null,
    now: '2026-10-22T00:00:00.000Z',
    ...extra
  };
}
function endpointEvidence(distance) {
  return {
    'nh-trade-winds': { unit: 'world', endpoints: { start: { x: 320, y: 120, z: 0 }, end: { x: 220, y: 220, z: 0 } } },
    'nh-westerlies': {
      unit: 'world',
      endpoints: { start: { x: 220, y: 220 + distance, z: 0 }, end: { x: 520, y: 220 + distance, z: 0 } }
    }
  };
}

test('规则类型清单与结构校验', () => {
  assert.deepEqual(RULE_KINDS, ['numeric', 'closure', 'direction', 'text', 'hash', 'svgEndpoint', 'bboxOverlap', 'manual']);
  assert.equal(validateRule({ kind: 'nope' }).ok, false);
  assert.equal(validateRule({ kind: 'closure', from: 'a', to: 'b', tolerance: 0.03 }).ok, true);
  assert.equal(validateRule({ kind: 'closure', from: 'a', to: 'b', tolerance: -1 }).ok, false);
  assert.equal(validateRule({ kind: 'direction', component: 'a', toleranceDeg: 5 }).ok, false);
  assert.equal(validateRule({ kind: 'text', file: 'a', mode: 'bogus' }).ok, false);
  assert.equal(validateRule({ kind: 'numeric', observed: 'component:a:b', op: '<=', value: 1 }).ok, true);
});

test('closure：容差内 pass，超出 fail，边界按闭/开区间', async () => {
  const rule = { kind: 'closure', from: 'nh-trade-winds', to: 'nh-westerlies', tolerance: 0.03, inclusive: true };
  const pass = await executeRule(rule, ctx(rule, endpointEvidence(0.02)));
  assert.equal(pass.status, 'pass');
  assert.equal(pass.measured.unit, 'world');
  assert.ok(Math.abs(pass.measured.distance - 0.02) < 1e-9);

  const fail = await executeRule(rule, ctx(rule, endpointEvidence(0.035)));
  assert.equal(fail.status, 'fail');
  assert.ok(Math.abs(fail.measured.distance - 0.035) < 1e-9);

  const boundaryInclusive = await executeRule(rule, ctx(rule, endpointEvidence(0.03)));
  assert.equal(boundaryInclusive.status, 'pass');

  const openRule = { ...rule, inclusive: false };
  const boundaryOpen = await executeRule(openRule, ctx(openRule, endpointEvidence(0.03)));
  assert.equal(boundaryOpen.status, 'fail');
});

test('closure：缺运行时证据 → inconclusive，不回退配置值', async () => {
  const rule = { kind: 'closure', from: 'nh-trade-winds', to: 'nh-westerlies', tolerance: 0.03 };
  const outcome = await executeRule(rule, ctx(rule, null));
  assert.equal(outcome.status, 'inconclusive');
  assert.match(outcome.detail, /运行时取证/);
});

test('direction：用运行时实际方向，配置正确但渲染旋转 → fail', async () => {
  const rule = { kind: 'direction', component: 'nh-trade-winds', expectedAzimuthDeg: 225, toleranceDeg: 10 };
  const good = await executeRule(rule, ctx(rule, { 'nh-trade-winds': { unit: 'world', directionDeg: 228 } }));
  assert.equal(good.status, 'pass');
  assert.ok(Math.abs(good.measured.deltaDeg - 3) < 1e-9);

  const rotated = await executeRule(rule, ctx(rule, { 'nh-trade-winds': { unit: 'world', directionDeg: 45 } }));
  assert.equal(rotated.status, 'fail');

  const missing = await executeRule(rule, ctx(rule, { 'nh-trade-winds': { unit: 'world' } }));
  assert.equal(missing.status, 'inconclusive');
});

test('direction：worldDirection 向量与期望向量', async () => {
  const rule = { kind: 'direction', component: 'a', expected: { x: -1, y: 1 }, toleranceDeg: 5 };
  // 屏幕坐标 y 向下：(-1,+1) 指向西南 → 罗盘 225°
  const outcome = await executeRule(rule, ctx(rule, { a: { unit: 'world', worldDirection: { x: -1, y: 1, z: 0 } } }));
  assert.equal(outcome.status, 'pass');
  assert.ok(Math.abs(outcome.measured.actualAzimuthDeg - 225) < 1e-6);
});

test('numeric：运算符、容差、文件读数', async () => {
  const rule = { kind: 'numeric', observed: 'component:a:value', op: '<=', value: 2 };
  assert.equal((await executeRule(rule, ctx(rule, { a: { value: 1 } }))).status, 'pass');
  assert.equal((await executeRule(rule, ctx(rule, { a: { value: 3 } }))).status, 'fail');
  const eq = { kind: 'numeric', observed: 'component:a:value', op: '==', value: 1.001, tolerance: 0.002 };
  assert.equal((await executeRule(eq, ctx(eq, { a: { value: 1.002 } }))).status, 'pass');
  const fileRule = { kind: 'numeric', observed: 'file:src/config.js', op: '<=', value: 100, parse: 'regex', pattern: 'azimuthDeg:\\s*(\\d+)' };
  // src/config.js 的 azimuthDeg 为 225，225 <= 100 不成立 → fail
  assert.equal((await executeRule(fileRule, ctx(fileRule, null))).status, 'fail');
});

test('text：equals / matches / not-matches / 拒绝回溯爆炸正则', async () => {
  const matches = { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '北半球东北信风' };
  assert.equal((await executeRule(matches, ctx(matches, null))).status, 'pass');
  const notMatches = { kind: 'text', file: 'src/config.js', mode: 'not-matches', pattern: '南半球信风' };
  assert.equal((await executeRule(notMatches, ctx(notMatches, null))).status, 'pass');
  const equals = { kind: 'text', file: 'src/config.js', mode: 'equals', value: 'x' };
  assert.equal((await executeRule(equals, ctx(equals, null))).status, 'fail');
  const evil = { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '(a+)+$' };
  const outcome = await executeRule(evil, ctx(evil, null));
  assert.equal(outcome.status, 'inconclusive');
  assert.match(outcome.detail, /回溯/);
});

test('hash：文件哈希一致/不一致', async () => {
  const adapter = createNodeFilesAdapter(FIXTURE_PROJECT);
  const actual = await adapter.hash('src/config.js');
  const pass = { kind: 'hash', file: 'src/config.js', sha256: actual };
  assert.equal((await executeRule(pass, ctx(pass, null))).status, 'pass');
  const fail = { kind: 'hash', file: 'src/config.js', sha256: 'sha256:' + 'f'.repeat(64) };
  assert.equal((await executeRule(fail, ctx(fail, null))).status, 'fail');
});

test('svgEndpoint：端点偏差容差判定', async () => {
  const rule = { kind: 'svgEndpoint', component: 'a', from: 'start', to: 'end', tolerance: 0.03 };
  const pass = await executeRule(rule, ctx(rule, { a: { unit: 'world', endpoints: { start: { x: 0, y: 0 }, end: { x: 0.01, y: 0 } } } }));
  assert.equal(pass.status, 'pass');
  const fail = await executeRule(rule, ctx(rule, { a: { unit: 'world', endpoints: { start: { x: 0, y: 0 }, end: { x: 0.05, y: 0 } } } }));
  assert.equal(fail.status, 'fail');
});

test('bboxOverlap：只标记候选，永不判 pass/fail 穿模', async () => {
  const rule = { kind: 'bboxOverlap', components: ['a', 'b'] };
  const overlap = await executeRule(rule, ctx(rule, {
    a: { unit: 'world', bbox: { x: 0, y: 0, width: 10, height: 10 } },
    b: { unit: 'world', bbox: { x: 5, y: 0, width: 10, height: 10 } }
  }));
  assert.equal(overlap.status, 'inconclusive');
  assert.equal(overlap.measured.candidate, true);
  const separated = await executeRule(rule, ctx(rule, {
    a: { unit: 'world', bbox: { x: 0, y: 0, width: 10, height: 10 } },
    b: { unit: 'world', bbox: { x: 20, y: 0, width: 10, height: 10 } }
  }));
  assert.equal(separated.status, 'inconclusive');
  assert.equal(separated.measured.candidate, false);
});

test('manual：永远 inconclusive；非法规则 fail-closed', async () => {
  const manual = await executeRule({ kind: 'manual' }, {});
  assert.equal(manual.status, 'inconclusive');
  const bad = await executeRule({ kind: 'closure', from: 'a' }, {});
  assert.equal(bad.status, 'inconclusive');
  const unknown = await executeRule({ kind: 'eval', code: '1+1' }, {});
  assert.equal(unknown.status, 'inconclusive');
});

test('自检：各自动判据都有正确样本与缺陷样本', async () => {
  const rules = [
    { kind: 'closure', from: 'a', to: 'b', tolerance: 0.03, inclusive: true },
    { kind: 'direction', component: 'a', expectedAzimuthDeg: 225, toleranceDeg: 10 },
    { kind: 'numeric', observed: 'component:a:value', op: '<=', value: 2 },
    { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '北半球东北信风' },
    { kind: 'hash', file: 'src/config.js', sha256: 'sha256:' + '0'.repeat(64) },
    { kind: 'svgEndpoint', component: 'a', from: 'start', to: 'end', tolerance: 0.03 },
    { kind: 'bboxOverlap', components: ['a', 'b'] },
    { kind: 'manual' }
  ];
  for (const rule of rules) {
    const report = await selfCheckRule({ id: 'T-' + rule.kind, rule });
    assert.equal(report.ok, true, rule.kind + ' 自检失败: ' + report.issues.join('; '));
    assert.ok(report.cases.length >= 2, rule.kind + ' 自检样本不足');
  }
  const broken = await selfCheckRule({ id: 'T', rule: { kind: 'closure', from: 'a', to: 'b', tolerance: -1 } });
  assert.equal(broken.ok, false);
});

test('自检：默认夹具覆盖边界且阈值可红', async () => {
  const rule = { kind: 'closure', from: 'a', to: 'b', tolerance: 0.03, inclusive: true };
  const fixtures = buildDefaultFixtures(rule);
  assert.ok(fixtures.pass && fixtures.fail && fixtures.boundary.length === 1);
  const boundaryInclusive = await selfCheckRule({ id: 'B', rule });
  assert.equal(boundaryInclusive.ok, true);
  const openRule = { ...rule, inclusive: false };
  const boundaryOpen = await selfCheckRule({ id: 'B2', rule: openRule });
  assert.equal(boundaryOpen.ok, true);
});

test('夹具项目：闭合 0.035 fail、方向 225 pass、文案 pass', async () => {
  const files = createNodeFilesAdapter(FIXTURE_PROJECT);
  const closure = { kind: 'closure', from: 'nh-trade-winds', to: 'nh-westerlies', tolerance: 0.03, inclusive: true };
  const closureOutcome = await executeRule(closure, ctx(closure, {
    'nh-trade-winds': { unit: 'px', endpoints: { start: { x: 320, y: 120 }, end: { x: 220, y: 220 } } },
    'nh-westerlies': { unit: 'px', endpoints: { start: { x: 220, y: 255 }, end: { x: 520, y: 255 } } }
  }, { files }));
  assert.equal(closureOutcome.status, 'fail');
  assert.ok(Math.abs(closureOutcome.measured.distance - 0.035) < 1e-9);

  const direction = { kind: 'direction', component: 'nh-trade-winds', expectedAzimuthDeg: 225, toleranceDeg: 10 };
  const directionOutcome = await executeRule(direction, ctx(direction, {
    'nh-trade-winds': { unit: 'world', worldDirection: { x: -100, y: 100 } }
  }, { files }));
  assert.equal(directionOutcome.status, 'pass');
  assert.ok(Math.abs(directionOutcome.measured.actualAzimuthDeg - 225) < 1e-6);

  const text = { kind: 'text', file: 'src/config.js', mode: 'matches', pattern: '北半球东北信风' };
  assert.equal((await executeRule(text, ctx(text, null, { files }))).status, 'pass');
});
