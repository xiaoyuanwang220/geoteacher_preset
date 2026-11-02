// ModelCheck —— 元判据（判据自检）
//
// 规格 §6：每条 auto 判据启用前，至少要有一个正确样本应 pass、一个已知缺陷样本应 fail，
// 并验证阈值边界；规则或阈值变化后必须重跑。不能“红过”的判据不可启用。
//
// 本模块只依赖 ./rules.js 与 node: 内置模块。

import { executeRule, validateRule } from './rules.js';

const ZERO_HASH = 'sha256:' + '0'.repeat(64);

function range(radius, base = 0) {
  // 生成以 base 为中心、半径 radius 的端点，便于按规则容差构造通过/缺陷样本。
  return {
    start: { x: base, y: 0, z: 0 },
    end: { x: base + radius, y: 0, z: 0 }
  };
}

function evidenceFor(components) {
  return {
    buildHash: 'sha256:' + '1'.repeat(64),
    sourceHash: 'sha256:' + '2'.repeat(64),
    adapterVersion: 'modelcheck-adapter/test',
    context: { step: 'end', mode: 'normal', view: 'default' },
    components,
    coverage: Object.keys(components).map((id) => ({ id, props: ['endpoints', 'worldPosition', 'directionDeg', 'bbox'] })),
    errors: []
  };
}

function filesAdapter(text) {
  return {
    read: async () => text,
    hash: async () => ZERO_HASH,
    exists: async () => true
  };
}

function baseCtx(rule, evidence) {
  return {
    projectRoot: '/fixture',
    route: 'svg',
    unitToPx: 0.001,
    files: filesAdapter('北半球东北信风 azimuthDeg: 225\n'),
    components: { components: [] },
    evidence: evidence || null,
    now: '2026-10-22T00:00:00.000Z'
  };
}

function passRadius(rule) {
  const tolerance = Number(rule.tolerance);
  return Number.isFinite(tolerance) && tolerance > 0 ? tolerance / 2 : 0;
}

/**
 * 按规则本身构造默认夹具：正确样本、缺陷样本、边界样本。
 * 返回 { pass: ctx, fail: ctx, boundary: ctx[] } 或 { unsupported: reason }。
 */
export function buildDefaultFixtures(rule) {
  if (!rule || typeof rule !== 'object') return { unsupported: '规则缺失' };
  const tolerance = Number(rule.tolerance);
  switch (rule.kind) {
    case 'numeric': {
      const expected = Number(rule.value);
      const delta = Number.isFinite(tolerance) && tolerance > 0 ? tolerance / 2 : Math.max(1, Math.abs(expected) * 0.1);
      const passValue = rule.op === '==' ? expected : expected - Math.sign(rule.op === '>=' || rule.op === '>' ? -1 : 1) * delta;
      // 观测目标可能写成 component:<id>:<prop>，否则退到夹具专用 id。
      const parts = typeof rule.observed === 'string' && rule.observed.startsWith('component:') ? rule.observed.split(':') : null;
      const componentId = parts ? parts[1] : (rule.component || 'fx-num');
      const property = parts ? parts[2] : (rule.property || 'value');
      const make = (value) => baseCtx(rule, evidenceFor({ [componentId]: { [property]: value, unit: 'world' } }));
      return {
        pass: make(passValue),
        fail: make(rule.op === '==' ? expected + 10 * Math.max(1, Math.abs(expected)) : expected + 10 * Math.max(1, Math.abs(expected)) + 1),
        boundary: [make(expected + (Number.isFinite(tolerance) ? tolerance : 0))]
      };
    }
    case 'closure': {
      const from = rule.from;
      const to = rule.to;
      const make = (distance) => baseCtx(rule, evidenceFor({
        [from]: { unit: 'world', endpoints: { start: { x: -1, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } }, worldPosition: { x: 0, y: 0, z: 0 } },
        [to]: { unit: 'world', endpoints: { start: { x: distance, y: 0, z: 0 }, end: { x: distance + 1, y: 0, z: 0 } }, worldPosition: { x: distance, y: 0, z: 0 } }
      }));
      return { pass: make(passRadius(rule)), fail: make(tolerance * 1.5 + 0.01), boundary: [make(tolerance)] };
    }
    case 'direction': {
      const expected = Number(rule.expectedAzimuthDeg);
      const make = (deg) => baseCtx(rule, evidenceFor({ [rule.component]: { unit: 'world', directionDeg: deg, endpoints: range(0) } }));
      return { pass: make(expected), fail: make((expected + 90) % 360), boundary: [make(expected + Number(rule.toleranceDeg))] };
    }
    case 'text': {
      const passText = rule.mode === 'equals' ? rule.value : '北半球东北信风 azimuthDeg: 225\n';
      const failText = rule.mode === 'equals' ? String(rule.value) + '-defect' : '无关内容';
      return {
        pass: { ...baseCtx(rule), files: filesAdapter(passText) },
        fail: { ...baseCtx(rule), files: filesAdapter(failText) },
        boundary: []
      };
    }
    case 'hash': {
      const expected = rule.sha256.replace(/^sha256:/, '');
      const passCtx = { ...baseCtx(rule), files: { read: async () => '', hash: async () => 'sha256:' + expected, exists: async () => true } };
      const failCtx = { ...baseCtx(rule), files: { read: async () => '', hash: async () => 'sha256:' + 'f'.repeat(64), exists: async () => true } };
      return { pass: passCtx, fail: failCtx, boundary: [] };
    }
    case 'svgEndpoint': {
      const id = rule.component || rule.pick;
      const make = (distance) => baseCtx(rule, evidenceFor({ [id]: { unit: 'world', endpoints: { start: { x: 0, y: 0, z: 0 }, end: { x: distance, y: 0, z: 0 } } } }));
      return { pass: make(passRadius(rule)), fail: make(tolerance * 1.5 + 0.01), boundary: [make(tolerance)] };
    }
    case 'bboxOverlap': {
      const [a, b] = rule.components;
      const make = (overlap) => baseCtx(rule, evidenceFor({
        [a]: { unit: 'world', bbox: { x: 0, y: 0, width: 10, height: 10 } },
        [b]: { unit: 'world', bbox: { x: overlap ? 5 : 20, y: 0, width: 10, height: 10 } }
      }));
      // bboxOverlap 只标记候选，任何情况都必须是 inconclusive（不判穿模）。
      return { pass: make(true), fail: make(false), boundary: [], alwaysInconclusive: true };
    }
    case 'manual':
      return { pass: baseCtx(rule), fail: baseCtx(rule), boundary: [], alwaysInconclusive: true };
    default:
      return { unsupported: '未知规则类型: ' + String(rule.kind) };
  }
}

/**
 * 判据自检。
 * @param {object} criterion 判据（含 rule）
 * @param {{pass?:object,fail?:object,boundary?:object[]}} [fixtures] 覆盖默认夹具
 * @returns {Promise<{ok:boolean,cases:Array,issues:string[]}>}
 */
export async function selfCheckRule(criterion, fixtures) {
  const issues = [];
  const cases = [];
  const rule = criterion && criterion.rule;
  const validation = validateRule(rule);
  if (!validation.ok) {
    return { ok: false, cases, issues: ['规则结构非法: ' + validation.errors.map((e) => e.code).join(', ')] };
  }
  const built = fixtures || buildDefaultFixtures(rule);
  if (built.unsupported) return { ok: false, cases, issues: [built.unsupported] };
  const alwaysInconclusive = built.alwaysInconclusive === true;

  async function runCase(name, ctx, expected) {
    if (!ctx) {
      cases.push({ name, expected, actual: 'missing', status: 'fail', detail: '缺少夹具样本' });
      return;
    }
    const outcome = await executeRule(rule, ctx);
    const actual = outcome.status;
    const ok = actual === expected;
    cases.push({ name, expected, actual, status: ok ? 'pass' : 'fail', detail: outcome.detail });
    if (!ok) issues.push(name + ': 期望 ' + expected + '，实际 ' + actual + '（' + outcome.detail + '）');
  }

  if (alwaysInconclusive) {
    await runCase('内省型判据（只允许 inconclusive）', built.pass, 'inconclusive');
    await runCase('内省型判据（缺陷样本仍 inconclusive）', built.fail, 'inconclusive');
    return { ok: issues.length === 0, cases, issues };
  }

  await runCase('正确样本应 pass', built.pass, 'pass');
  await runCase('已知缺陷样本应 fail', built.fail, 'fail');
  for (const [index, ctx] of (built.boundary || []).entries()) {
    const inclusive = rule.inclusive !== false;
    const expected = rule.kind === 'closure' || rule.kind === 'svgEndpoint' ? (inclusive ? 'pass' : 'fail') : 'pass';
    await runCase('边界样本 ' + (index + 1), ctx, expected);
  }
  return { ok: issues.length === 0, cases, issues };
}
