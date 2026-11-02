// ModelCheck —— 结构化判据规则执行器
//
// 设计契约见 docs/modelcheck/设计-一期实现.md §2.6。要点：
//   · 规则是受限、结构化的操作，不执行任意表达式、不做 eval；
//   · 每条规则返回 { status:'pass'|'fail'|'inconclusive', measured, assertion, detail, coverage, errors }；
//   · fail-closed：缺证据、字段非法、执行异常一律 inconclusive，绝不 pass；
//   · 证据充分性：要求运行时几何的规则没有运行时证据时不得用配置值替代。
//
// 本模块只依赖 node: 内置模块与 ./util.js，不 import 宿主包。

import { sha256, stableStringify } from './util.js';

export const RULE_KINDS = ['numeric', 'closure', 'direction', 'text', 'hash', 'svgEndpoint', 'bboxOverlap', 'manual'];

const RUNTIME_KINDS = new Set(['closure', 'direction', 'svgEndpoint', 'bboxOverlap']);
const CONFIG_KINDS = new Set(['text', 'hash']);
const OPS = new Set(['<=', '<', '>=', '>', '==', '!=']);
const MAX_PATTERN_LEN = 512;
const MAX_TEXT_CHARS = 1024 * 1024;
const DEG = 180 / Math.PI;
// 浮点边界容差：0.03 与 0.030000000000001 应视为同一边界，避免闭区间误判。
const EPS = 1e-9;

export function requiredEvidenceKind(rule) {
  if (!rule || typeof rule !== 'object') return 'runtime';
  if (rule.requiredEvidence) return rule.requiredEvidence;
  if (CONFIG_KINDS.has(rule.kind)) return 'config';
  if (rule.kind === 'manual') return 'user';
  if (RUNTIME_KINDS.has(rule.kind)) return 'runtime';
  return 'config';
}

/** 规则结构校验：只报结构问题，不求值。 */
export function validateRule(rule) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    fail('rule/missing', '规则必须是对象');
    return { ok: false, errors };
  }
  if (!RULE_KINDS.includes(rule.kind)) {
    fail('rule/kind', '未知规则类型: ' + String(rule.kind));
    return { ok: false, errors };
  }
  if (rule.requiredEvidence && !['config', 'runtime', 'visual', 'user', 'hash'].includes(rule.requiredEvidence)) {
    fail('rule/required-evidence', 'requiredEvidence 非法: ' + String(rule.requiredEvidence));
  }
  switch (rule.kind) {
    case 'numeric': {
      if (!OPS.has(rule.op)) fail('rule/op', 'numeric.op 必须是 <= < >= > == != 之一');
      if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) fail('rule/value', 'numeric.value 必须是有限数值');
      if (rule.tolerance != null && (typeof rule.tolerance !== 'number' || rule.tolerance < 0)) fail('rule/tolerance', 'numeric.tolerance 必须是非负数');
      if (!rule.observed && !(rule.component && rule.property)) fail('rule/observed', 'numeric 需要 observed 或 component+property');
      if (rule.observed && !/^(component:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+|file:.+)$/.test(rule.observed)) {
        fail('rule/observed', 'numeric.observed 只支持 component:<id>:<prop> 或 file:<相对路径>');
      }
      break;
    }
    case 'closure': {
      if (!rule.from || !rule.to) fail('rule/components', 'closure 需要 from 与 to 组件 id');
      if (typeof rule.tolerance !== 'number' || !(rule.tolerance >= 0)) fail('rule/tolerance', 'closure.tolerance 必须是非负数');
      if (rule.unit && !['world', 'px'].includes(rule.unit)) fail('rule/unit', 'closure.unit 只支持 world 或 px');
      break;
    }
    case 'direction': {
      if (!rule.component) fail('rule/component', 'direction 需要 component');
      if (rule.expectedAzimuthDeg == null && !rule.expected) fail('rule/expected', 'direction 需要 expectedAzimuthDeg 或 expected 向量');
      if (rule.expectedAzimuthDeg != null && (typeof rule.expectedAzimuthDeg !== 'number' || !Number.isFinite(rule.expectedAzimuthDeg))) {
        fail('rule/expected', 'expectedAzimuthDeg 必须是有限数值');
      }
      if (typeof rule.toleranceDeg !== 'number' || rule.toleranceDeg < 0 || rule.toleranceDeg > 180) {
        fail('rule/tolerance', 'direction.toleranceDeg 必须在 0..180');
      }
      break;
    }
    case 'text': {
      if (!rule.file || typeof rule.file !== 'string') fail('rule/file', 'text.file 必填');
      if (!['equals', 'matches', 'not-matches'].includes(rule.mode)) fail('rule/mode', 'text.mode 只支持 equals/matches/not-matches');
      if (rule.mode === 'equals' && typeof rule.value !== 'string') fail('rule/value', 'text.equals 需要 value 字符串');
      if (rule.mode !== 'equals' && typeof rule.pattern !== 'string') fail('rule/pattern', 'text 正则模式需要 pattern');
      break;
    }
    case 'hash': {
      if (!rule.file || typeof rule.file !== 'string') fail('rule/file', 'hash.file 必填');
      if (typeof rule.sha256 !== 'string' || !/^(sha256:)?[0-9a-fA-F]{64}$/.test(rule.sha256)) fail('rule/hash', 'hash.sha256 必须是 64 位十六进制（可带 sha256: 前缀）');
      break;
    }
    case 'svgEndpoint': {
      if (!rule.pick && !rule.component) fail('rule/component', 'svgEndpoint 需要 component 或 pick');
      if (!['start', 'end'].includes(rule.from || 'start')) fail('rule/from', 'svgEndpoint.from 只支持 start/end');
      if (!['start', 'end'].includes(rule.to || 'end')) fail('rule/to', 'svgEndpoint.to 只支持 start/end');
      if (typeof rule.tolerance !== 'number' || rule.tolerance < 0) fail('rule/tolerance', 'svgEndpoint.tolerance 必须是非负数');
      break;
    }
    case 'bboxOverlap': {
      if (!Array.isArray(rule.components) || rule.components.length !== 2 || rule.components.some((id) => typeof id !== 'string')) {
        fail('rule/components', 'bboxOverlap.components 必须是两个组件 id');
      }
      break;
    }
    case 'manual': {
      break;
    }
    default:
      break;
  }
  return { ok: errors.length === 0, errors };
}

function result(status, measured, assertion, detail, extra) {
  return {
    status,
    measured: measured == null ? null : measured,
    assertion: assertion == null ? null : assertion,
    detail: detail || '',
    coverage: (extra && extra.coverage) || [],
    errors: (extra && extra.errors) || []
  };
}
function inconclusive(detail, extra) {
  return result('inconclusive', extra && extra.measured, extra && extra.assertion, detail, extra);
}
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function point(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = value.z == null ? 0 : Number(value.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}
function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}
function round(n, digits = 6) {
  if (!isNum(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function normAzimuth(deg) {
  const value = ((deg % 360) + 360) % 360;
  return value;
}
function angleDelta(a, b) {
  const diff = Math.abs(normAzimuth(a) - normAzimuth(b));
  return diff > 180 ? 360 - diff : diff;
}
function azimuthOfVector(vector) {
  // 罗盘方位角：北 = -y（屏幕坐标 y 向下时由 bridge 已换算），东 = +x，顺时针为正。
  if (!vector) return null;
  const x = Number(vector.x);
  const y = Number(vector.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return normAzimuth(Math.atan2(x, -y) * DEG);
}
function nearlyLE(actual, limit) {
  return actual <= limit + EPS * Math.max(1, Math.abs(limit));
}
function nearlyLT(actual, limit) {
  return actual < limit - EPS * Math.max(1, Math.abs(limit));
}
function compare(actual, op, expected, tolerance) {
  if (!isNum(actual)) return false;
  if ((op === '==' || op === '!=') && isNum(tolerance)) {
    const equal = nearlyLE(Math.abs(actual - expected), tolerance);
    return op === '==' ? equal : !equal;
  }
  switch (op) {
    case '<=': return nearlyLE(actual, expected);
    case '<': return nearlyLT(actual, expected);
    case '>=': return nearlyLE(expected, actual);
    case '>': return nearlyLT(expected, actual);
    case '==': return nearlyLE(Math.abs(actual - expected), 0);
    case '!=': return !nearlyLE(Math.abs(actual - expected), 0);
    default: return false;
  }
}
function assertionText(rule) {
  if (rule.kind === 'numeric') {
    const tolerance = isNum(rule.tolerance) ? '（容差 ±' + rule.tolerance + '）' : '';
    return rule.observed + ' ' + rule.op + ' ' + rule.value + tolerance;
  }
  if (rule.kind === 'closure') {
    return rule.from + '.end → ' + rule.to + '.start 距离 ' + (rule.inclusive === false ? '<' : '≤') + ' ' + rule.tolerance;
  }
  if (rule.kind === 'direction') {
    return rule.component + ' 实际方向与期望方位角夹角 ≤ ' + rule.toleranceDeg + '°';
  }
  if (rule.kind === 'text') return rule.file + ' ' + rule.mode + ' ' + (rule.mode === 'equals' ? JSON.stringify(rule.value) : '/' + rule.pattern + '/');
  if (rule.kind === 'hash') return rule.file + ' sha256 == ' + rule.sha256;
  if (rule.kind === 'svgEndpoint') return rule.pick || rule.component + ' 端点偏差 ≤ ' + rule.tolerance;
  if (rule.kind === 'bboxOverlap') return (rule.components || []).join(' × ') + ' 包围盒仅候选相交检测（不判穿模）';
  return '需要用户确认';
}

/** 运行时证据缺失/不适用时的统一出口：绝不退回配置值。 */
function requireRuntime(rule, ctx) {
  if (!ctx || !ctx.evidence || !ctx.evidence.components) return '未取得运行时取证（面板未打开、超时或适配器不可用），不得用配置值替代';
  const id = rule.component || rule.from || rule.pick;
  if (id && rule.kind !== 'bboxOverlap') {
    const record = ctx.evidence.components[id];
    if (!record) return '运行时证据缺少组件 ' + id + '（覆盖不足）';
  }
  return null;
}
function componentRecord(ctx, id) {
  return (ctx && ctx.evidence && ctx.evidence.components && ctx.evidence.components[id]) || null;
}
function worldPoint(value, record, ctx) {
  const p = point(value);
  if (!p) return null;
  if (record && record.unit === 'px') {
    const unitToPx = Number(ctx && ctx.unitToPx);
    if (!Number.isFinite(unitToPx) || unitToPx <= 0) return null;
    return { x: p.x * unitToPx, y: p.y * unitToPx, z: p.z * unitToPx };
  }
  return p;
}
function readObserved(rule, ctx) {
  if (rule.observed) {
    if (rule.observed.startsWith('component:')) {
      const [, id, prop] = rule.observed.split(':');
      const record = componentRecord(ctx, id);
      if (!record) return { error: '运行时证据缺少组件 ' + id };
      const value = record[prop];
      if (!isNum(value)) return { error: '组件 ' + id + ' 未导出数值属性 ' + prop };
      return { value, unit: record.unit || 'world', record };
    }
    if (rule.observed.startsWith('file:')) {
      return { file: rule.observed.slice('file:'.length) };
    }
  }
  if (rule.component && rule.property) {
    const record = componentRecord(ctx, rule.component);
    if (!record) return { error: '运行时证据缺少组件 ' + rule.component };
    if (!isNum(record[rule.property])) return { error: '组件 ' + rule.component + ' 未导出数值属性 ' + rule.property };
    return { value: record[rule.property], unit: record.unit || 'world', record };
  }
  return { error: '规则缺少可观测来源' };
}
function parseFirstNumber(text) {
  const match = String(text || '').match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
  return match ? Number(match[0]) : null;
}
function navigateJson(value, path) {
  if (!path) return value;
  let current = value;
  for (const key of String(path).split('.')) {
    if (current == null) return undefined;
    current = current[key];
  }
  return current;
}
function compilePattern(rule) {
  const pattern = rule.pattern;
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) {
    return { error: '正则长度必须在 1..' + MAX_PATTERN_LEN + ' 之间' };
  }
  const nested = /\([^()]*[+*][^()]*\)[+*]/.test(pattern) || /[+*]\)[+*]/.test(pattern) || /\{[^}]*,[^}]*\}\)[+*]/.test(pattern);
  if (nested) return { error: '拒绝可能回溯爆炸的正则（嵌套量词），请拆成更简单的模式' };
  const flags = (rule.flags || '').replace(/[^im]/g, '');
  try {
    return { regex: new RegExp(pattern, flags) };
  } catch (error) {
    return { error: '正则非法: ' + String((error && error.message) || error) };
  }
}

async function runNumeric(rule, ctx) {
  const observed = readObserved(rule, ctx);
  if (observed.error) return inconclusive(observed.error, { assertion: assertionText(rule) });
  let actual = observed.value;
  let path = observed.unit || 'world';
  if (observed.file) {
    if (!rule.parse || rule.parse === 'first-number') {
      const text = await ctx.files.read(observed.file);
      actual = parseFirstNumber(text);
      path = 'config';
    } else if (rule.parse === 'regex') {
      if (typeof rule.pattern !== 'string' || rule.pattern.length === 0 || rule.pattern.length > MAX_PATTERN_LEN) {
        return inconclusive('numeric.parse=regex 需要 1..' + MAX_PATTERN_LEN + ' 字符的 pattern', { assertion: assertionText(rule) });
      }
      const text = await ctx.files.read(observed.file);
      let regex;
      try {
        regex = new RegExp(rule.pattern, (rule.flags || '').replace(/[^im]/g, ''));
      } catch (error) {
        return inconclusive('numeric 正则非法: ' + String((error && error.message) || error), { assertion: assertionText(rule) });
      }
      const match = text.match(regex);
      actual = match ? Number(match[1] != null ? match[1] : match[0]) : null;
      path = 'config';
    } else if (rule.parse === 'json') {
      const text = await ctx.files.read(observed.file);
      let doc;
      try {
        doc = JSON.parse(text);
      } catch {
        return inconclusive('文件不是合法 JSON: ' + observed.file, { assertion: assertionText(rule) });
      }
      const value = navigateJson(doc, rule.jsonPath);
      actual = Number(value);
      path = 'config';
    } else {
      return inconclusive('未知的 numeric.parse: ' + String(rule.parse), { assertion: assertionText(rule) });
    }
  }
  if (!isNum(actual)) return inconclusive('未取到可比较的数值（文件里没有数字）', { assertion: assertionText(rule) });
  if (rule.unit === 'px' && path === 'px') {
    const unitToPx = Number(ctx.unitToPx);
    if (!Number.isFinite(unitToPx) || unitToPx <= 0) return inconclusive('证据为 px 但缺少 unitToPx 换算条件', { assertion: assertionText(rule) });
    actual = actual * unitToPx;
  }
  const pass = compare(actual, rule.op, rule.value, rule.tolerance);
  return result(pass ? 'pass' : 'fail', { value: round(actual), unit: rule.unit || path, op: rule.op, expected: rule.value }, assertionText(rule),
    '实测 ' + round(actual) + '，期望 ' + rule.op + ' ' + rule.value + (isNum(rule.tolerance) ? '（容差 ±' + rule.tolerance + '）' : ''));
}

async function runClosure(rule, ctx) {
  const missing = requireRuntime(rule, ctx);
  if (missing) return inconclusive(missing, { assertion: assertionText(rule) });
  const from = componentRecord(ctx, rule.from);
  const to = componentRecord(ctx, rule.to);
  if (!from || !to) return inconclusive('运行时证据缺少 ' + (!from ? rule.from : rule.to), { assertion: assertionText(rule) });
  let startPoint = null;
  let endPoint = null;
  if (from.endpoints && from.endpoints.end) startPoint = worldPoint(from.endpoints.end, from, ctx);
  else startPoint = worldPoint(from.worldPosition, from, ctx);
  if (to.endpoints && to.endpoints.start) endPoint = worldPoint(to.endpoints.start, to, ctx);
  else endPoint = worldPoint(to.worldPosition, to, ctx);
  if (!startPoint || !endPoint) return inconclusive('组件缺少端点或世界坐标，无法计算闭合距离', { assertion: assertionText(rule) });
  const measured = distance(startPoint, endPoint);
  const pass = rule.inclusive === false ? nearlyLT(measured, rule.tolerance) : nearlyLE(measured, rule.tolerance);
  return result(pass ? 'pass' : 'fail', {
    distance: round(measured),
    tolerance: rule.tolerance,
    unit: from.unit === 'px' || to.unit === 'px' ? 'world' : 'world',
    from: rule.from,
    to: rule.to,
    endpoints: { start: startPoint, end: endPoint }
  }, assertionText(rule), '实测端点距离 ' + round(measured) + ' 世界单位（容差 ' + rule.tolerance + (rule.inclusive === false ? '，开区间' : '，闭区间') + '）');
}

async function runDirection(rule, ctx) {
  if (!ctx || !ctx.evidence) return inconclusive('未取得运行时取证，不得读取配置值判定方向', { assertion: assertionText(rule) });
  const record = componentRecord(ctx, rule.component);
  if (!record) return inconclusive('运行时证据缺少组件 ' + rule.component, { assertion: assertionText(rule) });
  let actualAzimuth = isNum(record.directionDeg) ? normAzimuth(record.directionDeg) : null;
  if (actualAzimuth == null && record.worldDirection) actualAzimuth = azimuthOfVector(record.worldDirection);
  if (actualAzimuth == null) return inconclusive('组件未导出可用的实际方向（directionDeg/worldDirection）', { assertion: assertionText(rule) });
  let expectedAzimuth = null;
  if (isNum(rule.expectedAzimuthDeg)) expectedAzimuth = normAzimuth(rule.expectedAzimuthDeg);
  else if (rule.expected) expectedAzimuth = azimuthOfVector(rule.expected);
  if (expectedAzimuth == null) return inconclusive('规则未给出可计算的期望方向', { assertion: assertionText(rule) });
  const delta = angleDelta(actualAzimuth, expectedAzimuth);
  const pass = nearlyLE(delta, rule.toleranceDeg);
  return result(pass ? 'pass' : 'fail', {
    actualAzimuthDeg: round(actualAzimuth),
    expectedAzimuthDeg: round(expectedAzimuth),
    deltaDeg: round(delta),
    toleranceDeg: rule.toleranceDeg,
    source: 'runtime'
  }, assertionText(rule), '实测方位角 ' + round(actualAzimuth) + '°，期望 ' + round(expectedAzimuth) + '°，夹角 ' + round(delta) + '°（容差 ' + rule.toleranceDeg + '°）');
}

async function runText(rule, ctx) {
  const text = await ctx.files.read(rule.file);
  if (typeof text !== 'string') return inconclusive('读取文件失败: ' + rule.file, { assertion: assertionText(rule) });
  if (text.length > MAX_TEXT_CHARS) return inconclusive('文件超过 ' + MAX_TEXT_CHARS + ' 字符，拒绝执行文案判据', { assertion: assertionText(rule) });
  if (rule.mode === 'equals') {
    const pass = text === rule.value;
    return result(pass ? 'pass' : 'fail', { file: rule.file, mode: 'equals', matched: pass }, assertionText(rule),
      pass ? '文件内容与期望完全一致' : '文件内容与期望不一致（长度 ' + text.length + ' / ' + rule.value.length + '）');
  }
  const compiled = compilePattern(rule);
  if (compiled.error) return inconclusive(compiled.error, { assertion: assertionText(rule) });
  const matched = compiled.regex.test(text);
  const pass = rule.mode === 'matches' ? matched : !matched;
  return result(pass ? 'pass' : 'fail', { file: rule.file, mode: rule.mode, matched }, assertionText(rule),
    '文件 ' + rule.file + ' ' + (matched ? '命中' : '未命中') + ' /' + rule.pattern + '/');
}

async function runHash(rule, ctx) {
  const actual = await ctx.files.hash(rule.file);
  if (!actual) return inconclusive('无法计算文件哈希: ' + rule.file, { assertion: assertionText(rule) });
  const expected = rule.sha256.replace(/^sha256:/, '').toLowerCase();
  const actualHex = String(actual).replace(/^sha256:/, '').toLowerCase();
  const pass = actualHex === expected;
  return result(pass ? 'pass' : 'fail', { file: rule.file, expected: expected, actual: actualHex }, assertionText(rule),
    pass ? '文件哈希一致' : '文件哈希不一致');
}

async function runSvgEndpoint(rule, ctx) {
  const missing = requireRuntime(rule, ctx);
  if (missing) return inconclusive(missing, { assertion: assertionText(rule) });
  const id = rule.component || rule.pick;
  const record = componentRecord(ctx, id);
  if (!record) return inconclusive('运行时证据缺少组件 ' + id, { assertion: assertionText(rule) });
  const endpoints = record.endpoints || {};
  const startPoint = worldPoint(endpoints[rule.from || 'start'], record, ctx);
  const endPoint = worldPoint(endpoints[rule.to || 'end'], record, ctx);
  if (!startPoint || !endPoint) return inconclusive('组件缺少 SVG 路径端点数据', { assertion: assertionText(rule) });
  const measured = distance(startPoint, endPoint);
  const pass = rule.inclusive === false ? nearlyLT(measured, rule.tolerance) : nearlyLE(measured, rule.tolerance);
  return result(pass ? 'pass' : 'fail', { distance: round(measured), tolerance: rule.tolerance, unit: 'world' }, assertionText(rule),
    '实测端点偏差 ' + round(measured) + '（容差 ' + rule.tolerance + '）');
}

async function runBboxOverlap(rule, ctx) {
  if (!ctx || !ctx.evidence) return inconclusive('未取得运行时取证，包围盒重叠只能标记候选', { assertion: assertionText(rule) });
  const [aId, bId] = rule.components;
  const a = componentRecord(ctx, aId);
  const b = componentRecord(ctx, bId);
  if (!a || !b || !a.bbox || !b.bbox) return inconclusive('缺少包围盒数据，不能判定候选相交', { assertion: assertionText(rule) });
  const overlap = a.bbox.x < b.bbox.x + b.bbox.width && b.bbox.x < a.bbox.x + a.bbox.width
    && a.bbox.y < b.bbox.y + b.bbox.height && b.bbox.y < a.bbox.y + a.bbox.height;
  // 规格 §9：包围盒重叠只标记候选相交，不直接判定穿模。
  return inconclusive(overlap ? '包围盒存在重叠候选，需人工/几何复核是否穿模（不自动判穿模）' : '包围盒未重叠，不构成穿模候选',
    { measured: { candidate: overlap, a: a.bbox, b: b.bbox }, assertion: assertionText(rule) });
}

/**
 * 执行一条规则。
 * @param {object} rule 判据的结构化规则
 * @param {object} ctx  { projectRoot, route, files:{read,hash,exists}, components, evidence, unitToPx, now }
 * @returns {Promise<{status:'pass'|'fail'|'inconclusive',measured:any,assertion:string,detail:string,coverage:any[],errors:any[]}>}
 */
export async function executeRule(rule, ctx) {
  const validation = validateRule(rule);
  if (!validation.ok) {
    return inconclusive('规则结构非法: ' + validation.errors.map((e) => e.code).join(', '), { errors: validation.errors });
  }
  const environment = ctx || {};
  if (!environment.files && CONFIG_KINDS.has(rule.kind)) {
    return inconclusive('缺少文件读取适配器，无法执行配置类判据', { assertion: assertionText(rule) });
  }
  try {
    switch (rule.kind) {
      case 'numeric': return await runNumeric(rule, environment);
      case 'closure': return await runClosure(rule, environment);
      case 'direction': return await runDirection(rule, environment);
      case 'text': return await runText(rule, environment);
      case 'hash': return await runHash(rule, environment);
      case 'svgEndpoint': return await runSvgEndpoint(rule, environment);
      case 'bboxOverlap': return await runBboxOverlap(rule, environment);
      case 'manual': return inconclusive('需要人工验收：插件不能替你判断好不好看或教学取舍', { assertion: assertionText(rule) });
      default: return inconclusive('未知规则类型: ' + String(rule.kind));
    }
  } catch (error) {
    return inconclusive('规则执行异常（fail-closed）: ' + String((error && error.message) || error), { assertion: assertionText(rule) });
  }
}

/** 仅供测试/自检：用 node:fs 构造文件适配器；执行器本身不直接碰 fs。 */
export function createNodeFilesAdapter(rootDir) {
  return {
    async read(relPath) {
      const { readFile } = await import('node:fs/promises');
      const { resolve, sep } = await import('node:path');
      const target = resolve(rootDir, relPath);
      if (!target.startsWith(resolve(rootDir) + sep)) throw new Error('路径越界: ' + relPath);
      return readFile(target, 'utf8');
    },
    async hash(relPath) {
      const text = await this.read(relPath);
      return sha256(text);
    },
    async exists(relPath) {
      const { access } = await import('node:fs/promises');
      const { resolve, sep } = await import('node:path');
      const target = resolve(rootDir, relPath);
      if (!target.startsWith(resolve(rootDir) + sep)) return false;
      try {
        await access(target);
        return true;
      } catch {
        return false;
      }
    }
  };
}

/** 证据规范：把证据里的组件表规范排序（供 evidence.js 复用键计算）。 */
export function canonicalEvidenceComponents(components) {
  return stableStringify(components || {});
}
