// GeoTeacher Agent — 命题包校验 / 投影 / 渲染核心（纯函数，无 DSH 生命周期副作用）
//
// 归属：`docs/geography-question-generation-execution-plan.md` §7.2 的 `plugins/question/package.js`。
//
// 边界（重要，不要把职责扩大）：
//   - 本文件**不读写文件、不接触任何 DSH 服务**。IO 由两个调用方负责：
//     CLI `skills/geo-question-generator/scripts/check-package.mjs`（node:fs）与
//     插件 `plugins/question/index.js`（宿主 fs 服务）。需要在磁盘上核实的项
//     通过 `opts.fileExists(relPath)` 注入，默认视为「未提供」，不猜。
//   - 只做**确定性检查（结构）**。语义项（答案是否唯一、材料是否充分、采分点是否真落在材料上、
//     答案边界是否可判定、四翼与难度依据是否成立）一律记 `pending`，**本文件不给出语义通过结论**。
//     依据：执行方案 §1「确定性的字段、引用、版本、文件及一致性检查交给代码」、
//     §7.1「只有结构检查完成时，语义项仍保持 pending，不能返回"全部门禁通过"」。
//   - 字段契约的唯一来源是 `plugins/question/package.schema.json`（schemaVersion 2）。
//     本文件内置一个 JSON Schema 2020-12 **子集**校验器，直接按 schema 求值，
//     **不另抄一份字段表**——否则 schema 与校验器必然会漂移。
//     子集覆盖本 schema 实际用到的关键字：$ref/$defs、type、enum、const、pattern、
//     format(date/date-time)、minimum/exclusiveMinimum、minItems/maxItems、required、
//     properties、additionalProperties:false、items、oneOf、allOf、if/then。
//
// 跨字段不变式（schema 表达不了，必须写在这里）：
//   分值三级求和、ID 引用可解析、投影禁用字段、确认与评审的版本绑定、readiness 与门禁一致、
//   v1 题包不得按 v2 放行。
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 2;

// taskId 限定格式（与 schema 的 `^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$` 一致）。
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

// 学生投影必须排除的字段（执行方案 §5、delivery-format.md §5）。
// 综合题的四项（answerKey/rubric/answerBoundary/misconceptionPatterns）是答案侧内容，
// 漏一个就等于把答案给了学生——这是本投影最要紧的一条。
export const STUDENT_EXCLUDED_KEYS = [
  'answer', 'analysis', 'distractorMap',
  'answerKey', 'rubric', 'answerBoundary', 'misconceptionPatterns',
  'coreExamPoint', 'supportingKnowledge', 'materialClues', 'cognitiveLevel', 'fourWings',
  'design', 'simulations', 'sources', 'confirmations', 'reviews', 'risks',
  'concepts', 'selectedConcept', 'knowledge', 'taxonomySources', 'learningHypotheses',
];

// 高精度「答案泄漏」词形：只收那些出现即几乎必属泄漏的写法，避免误伤题干里合法的
// 「正确的顺序是」这类表述。用于材料、题干、选项。命中记为 warn（结构化预筛），不是语义结论。
const STUDENT_LEAK_PATTERNS = [
  /答案\s*[为是：:]/, /正确答案/, /故选/, /应选/, /本题答案/,
  /采分点/, /得分点/, /评分标准/, /答案边界/, /干扰项/, /错因/,
  /[（(【\[]\s*答案/,
];

// 附件名与图片说明专用：这里的词**不需要**跟着数值或标点就足够可疑
// （delivery-format.md §5 明写：图注或附件名出现"正确""错误""答案""关键"即属夹带答案提示）。
const ATTACHMENT_LEAK_PATTERNS = [
  /答案/, /正确选项/, /错误选项/, /关键/, /answer/i,
];

// 伪统计词形：R8 禁止在没有真实试测数据时输出正确率/难度系数/区分度/选项分布。
// 只认「带数值的赋值/百分比」写法——维度名（如"干扰项区分度：3 个干扰项…"）与禁令句式
// （如"不输出正确率、难度系数、区分度"）都不会命中。
const FAKE_STAT_PATTERNS = [
  /正确率[^。；\n]{0,8}\d+(?:\.\d+)?\s*%/,
  /选项分布[^。；\n]{0,8}\d+(?:\.\d+)?\s*%/,
  /(?:难度系数|区分度)[^。；\n]{0,8}[=＝为:：]\s*0?\.\d+/,
];

const LEVEL_RANK = { fail: 0, warn: 1, info: 2 };

// ── 通用工具 ────────────────────────────────────────────────────────────

/** 稳定序列化：键名递归排序，用于计算内容指纹。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** sha256 内容指纹，形如 `sha256:<64 hex>`（与 schema 的 contentHash 同形）。 */
export function fingerprint(value) {
  return 'sha256:' + createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

/**
 * 找出不可「无损 JSON」序列化的值。
 *
 * 背景（2026-10-12 桌面实测暴露的真实缺陷）：DSH 的工具边界会校验返回值是否 lossless JSON。
 * 对象里存在**值为 `undefined` 的键**时，`JSON.stringify` 会把这个键丢掉，往返不再等值，
 * 于是整个工具调用被判 `INVALID_TOOL_OUTPUT: value is not lossless JSON` 而失败——
 * 报错发生在序列化环节，与参数是否正确无关，排查时极易误判成「工具没实现」。
 * 同一个坑此前在 `geo_explain` 的 `judgeSummary` 上出现过（见决策记录 2026-09-30 行）。
 *
 * @returns {string[]} 违规描述；空数组表示可安全返回。
 */
export function findNonLossless(value, path = 'result', out = [], stack = new Set()) {
  if (value === undefined) { out.push(path + ' = undefined'); return out; }
  if (typeof value === 'number' && !Number.isFinite(value)) { out.push(path + ' = ' + String(value)); return out; }
  if (typeof value === 'function') { out.push(path + ' = function'); return out; }
  if (typeof value === 'symbol' || typeof value === 'bigint') { out.push(path + ' = ' + typeof value); return out; }
  if (value === null || typeof value !== 'object') return out;
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object Object]' && !Array.isArray(value)) { out.push(path + ' = ' + tag); return out; }
  // 只跟踪**祖先链**：同一对象出现在两个并列位置（如某个 finding 同时挂在
  // report.findings 与 report.gates[].findings）不是循环引用，JSON 会正常重复展开。
  if (stack.has(value)) { out.push(path + ' = 循环引用（对象出现在自己的祖先链上）'); return out; }
  stack.add(value);
  if (Array.isArray(value)) {
    value.forEach((x, i) => {
      if (x === undefined) out.push(path + '[' + i + '] = undefined（数组中的 undefined 会变成 null）');
      else findNonLossless(x, path + '[' + i + ']', out, stack);
    });
    stack.delete(value);
    return out;
  }
  for (const k of Object.keys(value)) findNonLossless(value[k], path + '.' + k, out, stack);
  stack.delete(value);
  return out;
}

/**
 * 规整为可无损 JSON 序列化的值，供工具返回前调用：
 *   - 值为 `undefined` 的**对象键直接删除**（留一个 JSON 无法表达的 undefined 正是上面的坑）；
 *   - 数组里的 `undefined` 与 `NaN`/`Infinity` → `null`；
 *   - `Date`/`Map`/`Set`/函数/循环引用这类本不该出现在工具输出里的值**不静默改写，直接抛错**：
 *     宁可让调用显式失败并暴露位置，也不要在边界上被判 not lossless。
 */
export function toLosslessJson(value, path = 'result', stack = new Set()) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('不可无损序列化的值（' + typeof value + '）出现在 ' + path);
  }
  if (typeof value !== 'object') return value;
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object Object]' && !Array.isArray(value)) {
    throw new Error('不可无损序列化的对象（' + tag + '）出现在 ' + path);
  }
  // 同 findNonLossless：只判祖先链，并列共享的同一对象要照常展开（JSON 也会重复展开）。
  if (stack.has(value)) throw new Error('循环引用出现在 ' + path);
  stack.add(value);
  if (Array.isArray(value)) {
    const arr = value.map((x, i) => toLosslessJson(x, path + '[' + i + ']', stack));
    stack.delete(value);
    return arr;
  }
  const out = {};
  for (const k of Object.keys(value)) {
    if (value[k] === undefined) continue;
    out[k] = toLosslessJson(value[k], path + '.' + k, stack);
  }
  stack.delete(value);
  return out;
}

export function isValidTaskId(taskId) {
  return typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId);
}

/**
 * 由输出根与 taskId 解析任务目录（纯计算，不触碰磁盘）。
 * 任何越界（绝对路径、`..`、空段）都返回 error，而不是返回一个"看起来对"的路径。
 */
export function resolveTaskDir(outputRoot, taskId) {
  if (!isValidTaskId(taskId)) {
    return { ok: false, error: 'taskId 格式非法（要求 ' + TASK_ID_PATTERN.source + '）：' + String(taskId) };
  }
  if (typeof outputRoot !== 'string' || !outputRoot.trim()) {
    return { ok: false, error: '输出根未配置' };
  }
  const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const root = norm(outputRoot);
  if (taskId.includes('/') || taskId.includes('\\') || taskId.includes('..')) {
    return { ok: false, error: 'taskId 不得包含路径分隔符：' + taskId };
  }
  const dir = root + '/' + taskId;
  const realRoot = root.split('/').reduce((acc, seg) => {
    if (seg === '' || seg === '.') return acc;
    if (seg === '..') { if (acc.length) acc.pop(); return acc; }
    acc.push(seg); return acc;
  }, []);
  const realDir = dir.split('/').reduce((acc, seg) => {
    if (seg === '' || seg === '.') return acc;
    if (seg === '..') { if (acc.length) acc.pop(); return acc; }
    acc.push(seg); return acc;
  }, []);
  if (realDir.length !== realRoot.length + 1 || realDir.slice(0, realRoot.length).join('/') !== realRoot.join('/')) {
    return { ok: false, error: '解析后的任务目录越出输出根：' + dir };
  }
  return { ok: true, dir, root };
}

// ── JSON Schema 2020-12 子集校验器 ──────────────────────────────────────

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function typeMatches(value, t) {
  switch (t) {
    case 'object': return isPlainObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let cur = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return null;
    cur = cur[seg];
  }
  return cur;
}

/**
 * 把一份 schema 展开为「对当前值同时生效的若干具体 schema」。
 * 处理 $ref、allOf、if/then（含 if 命中判定后并入 then）。
 * oneOf 不在此展开——它是关键字，由 applyKeywords 处理。
 */
function expandSchemas(value, schema, ctx, depth = 0) {
  const out = [];
  if (!isPlainObject(schema) || depth > 40) return out;
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, ctx.root);
    if (!target) { ctx.push('', 'fail', 'schema', '无法解析的 $ref：' + schema.$ref); return out; }
    return expandSchemas(value, target, ctx, depth + 1);
  }
  out.push(schema);
  if (Array.isArray(schema.allOf)) {
    for (const s of schema.allOf) out.push(...expandSchemas(value, s, ctx, depth + 1));
  }
  if (schema.if !== undefined) {
    const probe = new ErrCtx(ctx.root, ctx.opts);
    // 注意：必须用 walk（递归子 schema），只用 applyKeywords 会漏掉 if 里的 properties，
    // 导致条件分支永远判定为"不命中"。
    walk(value, [schema.if], '', probe, depth + 1);
    if (probe.errors.length === 0) {
      if (schema.then) out.push(...expandSchemas(value, schema.then, ctx, depth + 1));
    } else if (schema.else) {
      out.push(...expandSchemas(value, schema.else, ctx, depth + 1));
    }
  }
  return out;
}

function applyKeywords(value, schema, path, ctx, depth) {
  if (!isPlainObject(schema) || depth > 40) return;

  // type
  if (schema.type !== undefined) {
    const list = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!list.some((t) => typeMatches(value, t))) {
      ctx.push(path, 'fail', 'schema', '类型不符：期望 ' + list.join('|') + '，实际 ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value));
      return; // 类型不符时不再跑其余关键字，避免噪声
    }
  }
  // const / enum
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    ctx.push(path, 'fail', 'schema', '必须等于 ' + JSON.stringify(schema.const) + '，实际 ' + JSON.stringify(value));
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    ctx.push(path, 'fail', 'schema', '取值不在枚举内：' + JSON.stringify(value) + '（允许 ' + schema.enum.map((e) => JSON.stringify(e)).join('/') + '）');
  }
  // 字符串族
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string') {
      let re = null;
      try { re = new RegExp(schema.pattern); } catch { /* 模式非法时由 schema 侧负责 */ }
      if (re && !re.test(value)) ctx.push(path, 'fail', 'schema', '不匹配 pattern ' + schema.pattern + '：' + JSON.stringify(value));
    }
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      ctx.push(path, 'fail', 'schema', '日期格式应为 YYYY-MM-DD：' + JSON.stringify(value));
    }
    if (schema.format === 'date-time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
      ctx.push(path, 'fail', 'schema', '时间格式应为带时区的 ISO 8601：' + JSON.stringify(value));
    }
  }
  // 数值族
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) ctx.push(path, 'fail', 'schema', '应 ≥ ' + schema.minimum + '，实际 ' + value);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) ctx.push(path, 'fail', 'schema', '应 > ' + schema.exclusiveMinimum + '，实际 ' + value);
  }
  // 数组族
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) ctx.push(path, 'fail', 'schema', '至少 ' + schema.minItems + ' 项，实际 ' + value.length);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) ctx.push(path, 'fail', 'schema', '至多 ' + schema.maxItems + ' 项，实际 ' + value.length);
    if (schema.items !== undefined && !Array.isArray(schema.items)) {
      value.forEach((el, i) => walk(el, [schema.items], path + '/' + i, ctx, depth + 1));
    }
  }
  // 对象族
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in value)) ctx.push(path, 'fail', 'schema', '缺少必填字段：' + key);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) ctx.push(path, 'fail', 'schema', '不允许的字段：' + key + '（additionalProperties:false）');
      }
    }
  }
  // oneOf
  if (Array.isArray(schema.oneOf)) {
    const matched = [];
    const branchErrs = [];
    for (const branch of schema.oneOf) {
      const probe = new ErrCtx(ctx.root, ctx.opts);
      walk(value, [branch], path, probe, depth + 1);
      if (probe.errors.length === 0) matched.push(branch);
      else branchErrs.push(probe.errors[0]);
    }
    if (matched.length === 0) {
      const detail = branchErrs.map((e, i) => '分支' + (i + 1) + '：' + (e ? e.message : '不匹配')).join('；');
      ctx.push(path, 'fail', 'schema', 'oneOf 无分支匹配（' + detail + '）');
    } else if (matched.length > 1) {
      ctx.push(path, 'fail', 'schema', 'oneOf 匹配了多个分支（' + matched.length + ' 个），判别字段可能缺失或取值错误');
    } else {
      walk(value, matched, path, ctx, depth + 1);
    }
  }
}

/** 对一份值应用「同时生效的多个 schema」。 */
function walk(value, schemas, path, ctx, depth) {
  const flat = [];
  for (const s of schemas) flat.push(...expandSchemas(value, s, ctx, depth));
  if (!flat.length) return;
  // 合并 properties：同一 key 的所有子 schema 一起生效
  const perKey = new Map();
  for (const s of flat) {
    if (!isPlainObject(s.properties)) continue;
    for (const [k, sub] of Object.entries(s.properties)) {
      if (!perKey.has(k)) perKey.set(k, []);
      perKey.get(k).push(sub);
    }
  }
  for (const s of flat) applyKeywords(value, s, path, ctx, depth);
  if (isPlainObject(value)) {
    for (const [k, subs] of perKey) {
      if (k in value) walk(value[k], subs, path + '/' + k, ctx, depth + 1);
    }
  }
}

class ErrCtx {
  constructor(root, opts) { this.root = root; this.opts = opts || {}; this.errors = []; }
  push(path, level, gate, message) {
    this.errors.push({ level, gate, pointer: path || '/', message, checkType: 'structural' });
  }
}

/**
 * 按 schema 校验一份命题包数据。返回 findings 数组（不做语义判断）。
 * @param {object} pkg 命题包数据
 * @param {object} schema 已解析的 package.schema.json
 */
export function validateAgainstSchema(pkg, schema) {
  if (!isPlainObject(schema)) {
    return [{ level: 'fail', gate: 'schema', pointer: '/', checkType: 'structural', message: '未提供可用的 package.schema.json，无法按契约校验' }];
  }
  const ctx = new ErrCtx(schema, {});
  walk(pkg, [schema], '', ctx, 0);
  return ctx.errors;
}

// ── 跨字段不变式（schema 表达不了的部分） ────────────────────────────────

function ids(list, key) { return new Set((Array.isArray(list) ? list : []).map((x) => x && x[key]).filter((v) => typeof v === 'string')); }

/**
 * @param {object} pkg
 * @param {object} opts { fileExists?: (relPath:string)=>boolean|null }
 * @returns {Array} findings
 */
export function checkInvariants(pkg, opts = {}) {
  const out = [];
  const add = (level, gate, pointer, message, checkType) =>
    out.push({ level, gate, pointer: pointer || '/', message, checkType: checkType || 'structural' });

  if (!isPlainObject(pkg)) { add('fail', 'G0', '/', '命题包不是 JSON 对象'); return out; }

  // v1 题包：明确报「待迁移」，不按 v2 放行（执行方案 §7.2）
  if (pkg.schemaVersion !== SCHEMA_VERSION) {
    const v = pkg.schemaVersion;
    add('fail', 'G0', '/schemaVersion',
      v === 1
        ? '这是 schemaVersion 1 的题包，不能按 v2 校验：须先迁移（补顶层 questionType、补题组项 itemType、candidateDistractorStrategy→candidateErrorStrategy）。迁移说明见 docs/examples/README.md'
        : '未知 schemaVersion：' + JSON.stringify(v) + '（本校验器只认 ' + SCHEMA_VERSION + '）');
  }

  const questionType = pkg.questionType;
  const items = (pkg.questionSet && pkg.questionSet.items) || [];
  const lhIds = ids(pkg.learningHypotheses, 'id');
  const sourceIds = ids(pkg.sources, 'sourceId');
  const conceptIds = ids(pkg.concepts, 'id');
  const visualIds = ids(pkg.visuals, 'id');

  // ── G1 知识边界 ────────────────────────────────────────────────────
  const nrn = (pkg.knowledge && pkg.knowledge.needsReviewNodeIds) || [];
  if (nrn.length) {
    const disclosed = (pkg.risks || []).some((r) => r && (r.blocking === true || String(r.description || '').includes(nrn[0])));
    if (!disclosed) {
      add('fail', 'G1', '/knowledge/needsReviewNodeIds',
        '用到 needs_review 节点但没有提示：须在 risks 中明示（PRD §4.3：可以提出构思，但不得无提示地交付为最终作品）');
    }
    if (!(pkg.risks || []).some((r) => r && r.blocking === true)) {
      add('warn', 'G1', '/risks', '待复核节点存在，但没有任何 blocking 风险项；usable 前须由教师确认沿用');
    }
  }
  if (pkg.knowledge && pkg.knowledge.taxonomyGap === true && !((pkg.knowledge.unresolved || []).length)) {
    add('fail', 'G1', '/knowledge/unresolved', 'taxonomyGap=true 但 unresolved 为空：未收录考点必须留痕');
  }
  for (const [i, ts] of (pkg.taxonomySources || []).entries()) {
    if (ts && ts.version == null) add('warn', 'G1', '/taxonomySources/' + i + '/version', '未记录 taxonomy 版本；不得表述为"正式定稿"');
    if (ts && !ts.contentHash) add('info', 'G1', '/taxonomySources/' + i + '/contentHash', 'contentHash 未回填（校验器尚未实现回填，属收尾待办；不影响结构结论）');
  }

  // ── G2 证据 ────────────────────────────────────────────────────────
  const referenced = [];
  for (const [i, c] of (pkg.concepts || []).entries()) {
    for (const sid of (c.context && c.context.sourceIds) || []) referenced.push(['/concepts/' + i + '/context/sourceIds', sid]);
    for (const [j, cr] of (c.curriculumRefs || []).entries()) if (cr.sourceId) referenced.push(['/concepts/' + i + '/curriculumRefs/' + j + '/sourceId', cr.sourceId]);
  }
  for (const [i, cb] of ((pkg.design && pkg.design.curriculumBasis) || []).entries()) if (cb.sourceId) referenced.push(['/design/curriculumBasis/' + i + '/sourceId', cb.sourceId]);
  for (const [i, tb] of ((pkg.design && pkg.design.textbookBasis) || []).entries()) if (tb.sourceId) referenced.push(['/design/textbookBasis/' + i + '/sourceId', tb.sourceId]);
  for (const [i, v] of (pkg.visuals || []).entries()) for (const sid of v.candidateSourceIds || []) referenced.push(['/visuals/' + i + '/candidateSourceIds', sid]);
  for (const [ptr, sid] of referenced) {
    if (!sourceIds.has(sid)) add('fail', 'G2', ptr, '引用了不存在的来源 id：' + sid);
  }
  const byId = new Map((pkg.sources || []).filter(Boolean).map((s) => [s.sourceId, s]));
  for (const [i, cb] of ((pkg.design && pkg.design.curriculumBasis) || []).entries()) {
    const s = cb.sourceId ? byId.get(cb.sourceId) : null;
    if (s && s.authorityLevel === 'lead_only') {
      add('fail', 'G2', '/design/curriculumBasis/' + i + '/sourceId', '课标依据不得建立在 lead_only（仅线索）来源上：' + s.sourceId);
    }
  }
  // visuals[].files 只在 generated/verified 时才可非空；且指向的附件必须存在（fileExists 未提供时不猜）
  const fileExists = typeof opts.fileExists === 'function' ? opts.fileExists : null;
  for (const [i, v] of (pkg.visuals || []).entries()) {
    const files = v.files || [];
    if (files.length && !['generated', 'verified'].includes(v.status)) {
      add('fail', 'G5', '/visuals/' + i + '/files', 'status=' + v.status + ' 时 files 必须为空（批准前不得创建正式制图产物）');
    }
    if (files.length && fileExists) {
      for (const f of files) {
        if (!fileExists(f)) add('fail', 'G2', '/visuals/' + i + '/files', '引用的附件不存在：' + f);
      }
    } else if (files.length && !fileExists) {
      add('info', 'G2', '/visuals/' + i + '/files', '未提供文件系统访问，附件存在性未核（pending）');
    }
  }

  // ── G3 构思确认 ────────────────────────────────────────────────────
  const sc = pkg.selectedConcept || null;
  if (sc) {
    for (const [i, cid] of (sc.conceptIds || []).entries()) {
      if (!conceptIds.has(cid)) add('fail', 'G3', '/selectedConcept/conceptIds/' + i, '选定的构思不存在：' + cid);
    }
    if (sc.composed !== true) {
      if ((sc.conceptIds || []).length !== 1) {
        add('fail', 'G3', '/selectedConcept/conceptIds', '非组合构思必须且只能指向 1 个构思，实际 ' + (sc.conceptIds || []).length + ' 个（组合请置 composed=true 并写明 basis）');
      } else {
        const target = (pkg.concepts || []).find((c) => c && c.id === sc.conceptIds[0]);
        if (target && target.revision !== sc.revision) {
          add('fail', 'G3', '/selectedConcept/revision', 'selectedConcept.revision=' + sc.revision + ' 与被确认构思 ' + target.id + '.revision=' + target.revision + ' 不一致');
        }
      }
    } else if (!String(sc.basis || '').trim()) {
      add('fail', 'G3', '/selectedConcept/basis', '组合构思必须写明组合依据（改动了哪些方向）');
    }
  }
  for (const [i, cf] of (pkg.confirmations || []).entries()) {
    if (!cf) continue;
    if (cf.type === 'concept_selection') {
      const target = (pkg.concepts || []).find((c) => c && c.id === cf.objectId);
      if (!target) add('fail', 'G3', '/confirmations/' + i + '/objectId', '构思确认指向不存在的构思：' + cf.objectId);
      else if (target.revision !== cf.objectRevision) add('fail', 'G3', '/confirmations/' + i + '/objectRevision', '确认记录绑定 revision ' + cf.objectRevision + '，但 ' + cf.objectId + ' 当前是 ' + target.revision + '：旧确认已失效');
      if (sc && !(sc.conceptIds || []).includes(cf.objectId)) {
        add('warn', 'G3', '/confirmations/' + i + '/objectId', '确认的构思 ' + cf.objectId + ' 与 selectedConcept 不一致');
      }
    }
    if (cf.type === 'visual_approval') {
      const target = (pkg.visuals || []).find((v) => v && v.id === cf.objectId);
      if (!target) add('fail', 'G3', '/confirmations/' + i + '/objectId', '图表批准指向不存在的图表：' + cf.objectId);
      else if (target.revision !== cf.objectRevision) add('fail', 'G3', '/confirmations/' + i + '/objectRevision', '图表批准绑定 revision ' + cf.objectRevision + '，但 ' + cf.objectId + ' 当前是 ' + target.revision + '：旧批准已失效');
    }
  }
  // readiness 与阶段自洽
  const readiness = pkg.readiness;
  if (readiness === 'concepts_pending' && sc) {
    add('warn', 'G3', '/readiness', 'readiness=concepts_pending 但 selectedConcept 已非空，状态可能未跟上');
  }
  if (['draft_complete', 'usable'].includes(readiness) && !sc) {
    add('fail', 'G3', '/readiness', 'readiness=' + readiness + ' 但未记录教师选定的构思（selectedConcept 为空）');
  }
  if (['draft_ready', 'visuals_approved', 'finalized'].includes(pkg.stage) && !(pkg.confirmations || []).some((c) => c && c.type === 'concept_selection')) {
    add('fail', 'G3', '/confirmations', 'stage=' + pkg.stage + ' 但没有任何 concept_selection 确认记录：不得先成题再补确认');
  }

  // ── G4 题组质量（按题型） ──────────────────────────────────────────
  // 题组级检查只在**题组应当存在时**执行。构思阶段（`stage < draft_ready`）本来就没有
  // `questionSet`，此时 `items` 为空是正常状态——2026-10-21 M2 实测中，校验器把这一合法
  // 状态判成 `fail`（「选择题组应有 1—3 道小题，实际 0 道」），模型连改三轮也修不掉，
  // 最后只能放弃该 taskId 换包重来。阶段感知是这里必须的。
  const questionSetPresent = pkg.questionSet != null;
  const allPointIds = new Set();
  if (questionType === 'single_choice' && questionSetPresent) {
    if (items.length < 1 || items.length > 3) add('fail', 'G4', '/questionSet/items', '选择题组应有 1—3 道小题，实际 ' + items.length + ' 道');
    for (const [i, it] of items.entries()) {
      const p = '/questionSet/items/' + i;
      if (!it) continue;
      const opts_ = it.options || {};
      const vals = ['A', 'B', 'C', 'D'].map((k) => String(opts_[k] || '').trim());
      if (new Set(vals).size !== 4) add('fail', 'G4', p + '/options', '四个选项存在重复或空值：选项必须互不相同（答案唯一的前提）');
      if (it.distractorMap && it.answer in it.distractorMap) add('fail', 'G4', p + '/distractorMap', '正确项 ' + it.answer + ' 出现在 distractorMap 中');
      if (!it.distractorMap || Object.keys(it.distractorMap).length === 0) add('warn', 'G4', p + '/distractorMap', '未写干扰项映射：每个干扰项都应对应一种可解释的认知错误');
      for (const [k, d] of Object.entries(it.distractorMap || {})) {
        if (!d) continue;
        if (d.misconceptionId && !lhIds.has(d.misconceptionId)) add('fail', 'G4', p + '/distractorMap/' + k, 'misconceptionId 无法解析：' + d.misconceptionId);
        if (!String(d.errorType || '').trim()) add('fail', 'G4', p + '/distractorMap/' + k + '/errorType', '缺 errorType');
      }
    }
  } else if (questionType === 'comprehensive' && questionSetPresent) {
    if (items.length !== 1) add('fail', 'G4', '/questionSet/items', '综合题题组应恰好 1 项，实际 ' + items.length + ' 项');
    for (const [i, it] of items.entries()) {
      const p = '/questionSet/items/' + i;
      if (!it) continue;
      const subs = it.subQuestions || [];
      if (subs.length < 2 || subs.length > 4) add('fail', 'G4', p + '/subQuestions', '综合题应有 2—4 个小问，实际 ' + subs.length + ' 个');
      const sumSubs = subs.reduce((a, s) => a + (Number(s && s.points) || 0), 0);
      if (sumSubs !== it.totalPoints) {
        add('fail', 'G4', p + '/totalPoints', '分值三级求和（一）：各小问 points 之和=' + sumSubs + '，totalPoints=' + it.totalPoints);
      }
      const seenSub = new Set();
      for (const [j, s] of subs.entries()) {
        const sp = p + '/subQuestions/' + j;
        if (!s) continue;
        if (seenSub.has(s.subQuestionId)) add('fail', 'G4', sp + '/subQuestionId', '小问 id 重复：' + s.subQuestionId);
        seenSub.add(s.subQuestionId);
        const pts = s.answerKey || [];
        const sumPts = pts.reduce((a, k) => a + (Number(k && k.points) || 0), 0);
        if (sumPts !== s.points) {
          add('fail', 'G4', sp + '/points', '分值三级求和（二）：' + s.subQuestionId + ' 的采分点 points 之和=' + sumPts + '，该问 points=' + s.points);
        }
        if (pts.length === 0) add('fail', 'G4', sp + '/answerKey', '没有采分点：综合题至少要有 1 个采分点');
        for (const [k, pt] of pts.entries()) {
          if (!pt) continue;
          if (allPointIds.has(pt.pointId)) add('fail', 'G4', sp + '/answerKey/' + k + '/pointId', '采分点 id 在整包内重复：' + pt.pointId);
          allPointIds.add(pt.pointId);
          if (!String(pt.evidenceChain || '').trim()) add('fail', 'G4', sp + '/answerKey/' + k + '/evidenceChain', '采分点缺证据链：只写结论不写证据的采分点不合格');
          if (!String(pt.statement || '').trim()) add('fail', 'G4', sp + '/answerKey/' + k + '/statement', '采分点缺要素描述');
        }
        for (const [k, m] of (s.misconceptionPatterns || []).entries()) {
          if (m && m.misconceptionId && !lhIds.has(m.misconceptionId)) add('fail', 'G4', sp + '/misconceptionPatterns/' + k, 'misconceptionId 无法解析：' + m.misconceptionId);
          if (m && !String(m.howItLosesPoints || '').trim()) add('fail', 'G4', sp + '/misconceptionPatterns/' + k + '/howItLosesPoints', '典型错答须说明落在哪个采分点或哪条边界上失分');
        }
      }
    }
  }

  // ── 模拟作答一致性（G4/G6） ────────────────────────────────────────
  const sims = pkg.simulations || [];
  const profiles = sims.map((s) => s && s.profile);
  if (profiles.length && new Set(profiles).size !== profiles.length) add('fail', 'G6', '/simulations', '模拟档位重复：每档只应各 1 名');
  if (sims.length && sims.length !== 3) add('warn', 'G6', '/simulations', '默认应模拟 3 名（A/B/C 各 1），实际 ' + sims.length + ' 名');
  const hitSignatures = [];
  for (const [i, sim] of sims.entries()) {
    if (!sim) continue;
    const sp = '/simulations/' + i;
    const covered = new Set();
    for (const [j, r] of (sim.responses || []).entries()) {
      const rp = sp + '/responses/' + j;
      if (!r) continue;
      if (questionType === 'single_choice') {
        const it = items.find((x) => x && x.itemId === r.itemId);
        if (!it) { add('fail', 'G4', rp + '/itemId', '模拟引用了不存在的小题：' + r.itemId); continue; }
        covered.add(it.itemId);
        if (r.selected !== it.answer) {
          const d = (it.distractorMap || {})[r.selected];
          if (d && d.misconceptionId && r.misconceptionId !== d.misconceptionId) {
            add('fail', 'G4', rp + '/misconceptionId', '选错时 misconceptionId 必须与所选干扰项一致（期望 ' + d.misconceptionId + '，实际 ' + r.misconceptionId + '）');
          } else if (!d) {
            add('fail', 'G4', rp + '/selected', '所选 ' + r.selected + ' 不在 distractorMap 中：错误路径必须对应一个可解释的干扰项');
          }
        } else if (r.misconceptionId) {
          add('warn', 'G4', rp + '/misconceptionId', '答对却记了 misconceptionId');
        }
      } else if (questionType === 'comprehensive') {
        const it = items[0];
        const sub = ((it && it.subQuestions) || []).find((s) => s && s.subQuestionId === r.subQuestionId);
        if (!sub) { add('fail', 'G4', rp + '/subQuestionId', '模拟引用了不存在的小问：' + r.subQuestionId); continue; }
        covered.add(sub.subQuestionId);
        const pts = new Set((sub.answerKey || []).map((k) => k && k.pointId));
        const hit = r.hitPointIds || [];
        const miss = r.missedPointIds || [];
        for (const idp of [...hit, ...miss]) if (!pts.has(idp)) add('fail', 'G4', rp, '引用不属于该问的采分点：' + idp);
        const inter = hit.filter((x) => miss.includes(x));
        if (inter.length) add('fail', 'G4', rp, '同一采分点既命中又遗漏：' + inter.join('、'));
        const union = new Set([...hit, ...miss]);
        if (union.size !== pts.size) add('fail', 'G4', rp, '命中∪遗漏=' + union.size + '，该问采分点=' + pts.size + '：存在未说明的采分点');
      }
    }
    const expect = questionType === 'comprehensive'
      ? new Set(items.flatMap((it) => ((it && it.subQuestions) || []).map((s) => s && s.subQuestionId)))
      : new Set(items.map((it) => it && it.itemId));
    for (const idp of expect) if (idp && !covered.has(idp)) add('fail', 'G6', sp + '/responses', '模拟未覆盖 ' + idp + '：三档都要给出对每一题的作答');
    if (questionType === 'comprehensive') hitSignatures.push((sim.responses || []).flatMap((r) => (r && r.hitPointIds) || []).slice().sort().join(','));
  }
  if (questionType === 'comprehensive' && hitSignatures.length > 1 && new Set(hitSignatures).size === 1) {
    add('fail', 'G4', '/simulations', '三档模拟的命中采分点完全相同：说明该题组无法区分水平，应重设采分点，而不是只改模拟文字');
  }

  // ── G5 图表 ────────────────────────────────────────────────────────
  const itemIds = new Set(items.map((it) => it && it.itemId).filter(Boolean));
  const subQuestionIds = new Set(items.flatMap((it) => ((it && it.subQuestions) || []).map((s) => s && s.subQuestionId)).filter(Boolean));
  const usableLinked = new Set([...itemIds, ...subQuestionIds]);
  for (const [i, v] of (pkg.visuals || []).entries()) {
    if (!v) continue;
    // linkedItems 指向具体小题／小问；构思阶段题组尚未存在，此时无从核对应属正常，
    // 与题组级检查同理按阶段跳过（否则会把合法状态判成「关联对象不存在」）。
    if (questionSetPresent) {
      for (const [j, l] of (v.linkedItems || []).entries()) {
        if (!usableLinked.has(l)) add('fail', 'G5', '/visuals/' + i + '/linkedItems/' + j, '关联对象不存在：' + l + '（选择题写小题 id，综合题写小问 id）');
      }
    }
    if (v.type === 'map' && !(v.candidateSourceIds || []).some((sid) => (byId.get(sid) || {}).type === 'map')) {
      // 地图必须落在官方底图上并记录审图号（来源 type=map）。提案阶段允许尚未定位，故只提示；
      // 一旦标为 generated/verified（声明已产出），没有官方来源就是硬失败。
      const produced = ['generated', 'verified'].includes(v.status);
      add(produced ? 'fail' : 'warn', 'G5', '/visuals/' + i + '/candidateSourceIds',
        produced
          ? '地图已标为 ' + v.status + '，但没有 type=map 的官方来源：无法记录审图号与适用范围'
          : '地图提案尚无 type=map 的官方来源：制作前须先定位官方底图与审图号（禁止 AI 生成行政区划轮廓）');
    }
  }
  const declaredVisuals = (pkg.questionSet && pkg.questionSet.material && pkg.questionSet.material.visualRefs) || [];
  for (const [i, vid] of declaredVisuals.entries()) {
    const v = (pkg.visuals || []).find((x) => x && x.id === vid);
    if (!v) { add('fail', 'G5', '/questionSet/material/visualRefs/' + i, '题面引用了不存在的图表：' + vid); continue; }
    if (!['generated', 'verified'].includes(v.status)) {
      add('warn', 'G5', '/questionSet/material/visualRefs/' + i, '题面引用了尚未制作完成的图表 ' + vid + '（status=' + v.status + '）：必须读图才能作答时，readiness 至多 draft_complete');
    }
  }

  // ── G6 交付说明 ────────────────────────────────────────────────────
  const wings = [];
  const pushWings = (ptr, fw) => { if (fw) wings.push([ptr, fw]); };
  pushWings('/design/fourWings', pkg.design && pkg.design.fourWings);
  for (const [i, it] of items.entries()) pushWings('/questionSet/items/' + i + '/fourWings', it && it.fourWings);
  for (const [ptr, fw] of wings) {
    if (Array.isArray(fw.primary) && fw.primary.length && !(Array.isArray(fw.evidence) && fw.evidence.some((e) => String(e || '').trim()))) {
      add('fail', 'G6', ptr + '/evidence', '四翼标了主次却没有题面证据：禁止口号式贴标签');
    }
  }
  const ed = (pkg.design && pkg.design.expectedDifficulty) || null;
  if (ed) {
    if (questionType === 'comprehensive') {
      if (ed.distractorDiscrimination) add('fail', 'G6', '/design/expectedDifficulty/distractorDiscrimination', '综合题不得把难度第四维写成干扰项分析（应用 scoringDiscrimination）');
      if (questionType === 'comprehensive' && !String(ed.scoringDiscrimination || '').trim()) add('warn', 'G6', '/design/expectedDifficulty/scoringDiscrimination', '综合题缺难度第四维（采分点区分度与答案边界可判定性）');
    } else if (ed.scoringDiscrimination) {
      add('warn', 'G6', '/design/expectedDifficulty/scoringDiscrimination', '选择题的难度第四维应为 distractorDiscrimination');
    }
  }
  // R8：无真实试测数据时不得出现伪统计
  const statScan = [
    ['/design/expectedDifficulty', JSON.stringify(ed || {})],
    ['/request', JSON.stringify(pkg.request || {})],
  ];
  for (const [i, it] of items.entries()) {
    statScan.push(['/questionSet/items/' + i, JSON.stringify(it || {})]);
  }
  for (const [ptr, text] of statScan) {
    for (const re of FAKE_STAT_PATTERNS) {
      const m = re.exec(text);
      if (m) { add('fail', 'G6', ptr, '命中伪统计写法：' + m[0] + '（无真实试测数据时禁止输出正确率/难度系数/区分度/选项分布）'); break; }
    }
  }

  // ── facts：逐设问的材料线索是否真出现在材料里（warn 级，措辞可等价改写） ──
  // 只核「逐设问」层的线索：选择题 items[].materialClues、综合题 subQuestions[].materialClues。
  // 综合题 items[] 层的 materialClues 是题组级摘要（不是逐字引用），不在此列。
  const materialText = String((pkg.questionSet && pkg.questionSet.material && pkg.questionSet.material.text) || '');
  if (materialText) {
    const clues = [];
    for (const [i, it] of items.entries()) {
      if (questionType === 'single_choice') {
        for (const [j, c] of (it.materialClues || []).entries()) clues.push(['/questionSet/items/' + i + '/materialClues/' + j, c]);
      }
      for (const [j, s] of (it.subQuestions || []).entries()) {
        for (const [k, c] of (s.materialClues || []).entries()) clues.push(['/questionSet/items/' + i + '/subQuestions/' + j + '/materialClues/' + k, c]);
      }
    }
    const norm = (s) => String(s).replace(/\s+/g, '');
    for (const [ptr, c] of clues) {
      if (c && !norm(materialText).includes(norm(c))) {
        add('warn', 'G6', ptr, '这条材料线索在材料原文中找不到：' + JSON.stringify(c) + '（若为等价改写可忽略；否则说明线索不是从材料来的）');
      }
    }
  }

  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

// ── 投影 ────────────────────────────────────────────────────────────────

function assertNoExcludedKeys(value, path, out) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoExcludedKeys(v, path + '/' + i, out)); return; }
  for (const [k, v] of Object.entries(value)) {
    if (STUDENT_EXCLUDED_KEYS.includes(k)) out.push(path + '/' + k);
    assertNoExcludedKeys(v, path + '/' + k, out);
  }
}

function scanLeaks(text, path, out, patterns = STUDENT_LEAK_PATTERNS) {
  for (const re of patterns) {
    const m = re.exec(String(text || ''));
    if (m) out.push({ pointer: path, match: m[0] });
  }
}

/**
 * 学生投影：只含共用材料 + 题干与作答结构 + 必要图片引用。
 * 依据执行方案 §4.2、delivery-format.md §5。综合题的四项答案侧字段必须逐项排除。
 */
export function buildStudentProjection(pkg) {
  const qs = pkg.questionSet || {};
  const mat = qs.material || {};
  const items = [];
  for (const it of qs.items || []) {
    if (!it) continue;
    if (it.itemType === 'comprehensive') {
      items.push({
        itemId: it.itemId,
        itemType: 'comprehensive',
        stem: it.stem,
        totalPoints: it.totalPoints,
        subQuestions: (it.subQuestions || []).map((s) => ({
          subQuestionId: s.subQuestionId, stem: s.stem, points: s.points,
        })),
      });
    } else {
      items.push({
        itemId: it.itemId,
        itemType: 'single_choice',
        stem: it.stem,
        options: { A: it.options && it.options.A, B: it.options && it.options.B, C: it.options && it.options.C, D: it.options && it.options.D },
      });
    }
  }
  const projection = {
    kind: 'student_projection',
    schemaVersion: pkg.schemaVersion,
    taskId: pkg.taskId,
    sourceRevision: pkg.revision,
    questionType: pkg.questionType,
    questionSetId: qs.questionSetId,
    material: { text: mat.text, visualRefs: mat.visualRefs || [] },
    items,
  };
  projection.contentHash = fingerprint(projection);
  return projection;
}

/** 教师投影：教师可见的全部内容（答案或采分点、解析、映射、设计说明、来源、评审、风险）。 */
export function buildTeacherProjection(pkg) {
  const projection = {
    kind: 'teacher_projection',
    schemaVersion: pkg.schemaVersion,
    taskId: pkg.taskId,
    sourceRevision: pkg.revision,
    questionType: pkg.questionType,
    readiness: pkg.readiness,
    stage: pkg.stage,
    questionSet: pkg.questionSet,
    design: pkg.design,
    simulations: pkg.simulations,
    learningHypotheses: pkg.learningHypotheses,
    knowledge: pkg.knowledge,
    taxonomySources: pkg.taxonomySources,
    concepts: pkg.concepts,
    selectedConcept: pkg.selectedConcept,
    sources: pkg.sources,
    visuals: pkg.visuals,
    confirmations: pkg.confirmations,
    reviews: pkg.reviews,
    risks: pkg.risks,
    request: pkg.request,
  };
  projection.contentHash = fingerprint(projection);
  return projection;
}

/**
 * 投影自检：学生投影是否夹带答案侧内容（含"文件名与图注"这类文字泄漏）。
 * 结构筛查不能替代语义核验，这里只做**结构化预筛**。
 */
export function checkStudentProjection(pkg) {
  const out = [];
  const proj = buildStudentProjection(pkg);
  const leaked = [];
  assertNoExcludedKeys(proj, '', leaked);
  for (const ptr of leaked) out.push({ level: 'fail', gate: 'G4', pointer: '/student' + ptr, checkType: 'structural', message: '学生投影含答案侧字段：' + ptr.split('/').pop() });
  // 学生可读的正文：材料、题干、选项、小问题干 —— 用高精度词形，避免误伤「正确的顺序是」。
  const proseTexts = [
    ['/material', proj.material.text],
    ...proj.items.flatMap((it, i) => {
      const base = '/items/' + i;
      const rows = [[base + '/stem', it.stem]];
      if (it.options) for (const [k, v] of Object.entries(it.options)) rows.push([base + '/options/' + k, v]);
      if (it.subQuestions) for (const [j, s] of it.subQuestions.entries()) rows.push([base + '/subQuestions/' + j + '/stem', s.stem]);
      return rows;
    }),
  ];
  // 图注与附件名：这里出现「答案/正确/错误/关键」本身就足以报警（delivery-format.md §5 明写）。
  const attachmentTexts = (pkg.visuals || []).flatMap((v, i) => [
    ['/visuals/' + i + '/title', v && v.title],
    ['/visuals/' + i + '/content', v && v.content],
    ...((v && v.files) || []).map((f, k) => ['/visuals/' + i + '/files/' + k, f]),
  ]);
  const hits = [];
  for (const [ptr, t] of proseTexts) if (t) scanLeaks(t, ptr, hits, STUDENT_LEAK_PATTERNS);
  for (const [ptr, t] of attachmentTexts) if (t) scanLeaks(t, ptr, hits, ATTACHMENT_LEAK_PATTERNS);
  if (hits.length) {
    out.push({
      level: 'warn', gate: 'G4', pointer: '/student', checkType: 'structural',
      message: '学生可读文本命中答案泄漏词形：' + hits.map((h) => h.pointer + '→' + h.match).join('；') + '（这是结构化预筛，仍须人工确认）',
    });
  }
  return out;
}

// ── Markdown 渲染（六大章节） ───────────────────────────────────────────

function bullets(list) { return (list || []).map((x) => '- ' + x).join('\n'); }

export function renderMarkdown(pkg) {
  const L = [];
  const qs = pkg.questionSet || {};
  const mat = qs.material || {};
  const items = qs.items || [];
  const design = pkg.design || {};
  const isComp = pkg.questionType === 'comprehensive';
  const p = [];
  p.push('# ' + (pkg.request && pkg.request.topic ? pkg.request.topic + '（' + (isComp ? '材料型综合题' : '材料型选择题组') + '）' : '命题稿'));
  p.push('');
  p.push('> 任务 ID：`' + pkg.taskId + '`　修订号：revision ' + pkg.revision + '　完成度：**' + pkg.readiness + '**（stage=' + pkg.stage + '，mode=' + pkg.mode + '）');
  p.push('> 本稿由 `' + pkg.taskId + '/package.json`（revision ' + pkg.revision + '）渲染。教师若直接修改本稿，须先回收到 `package.json` 并重新校验，否则本稿不再视为与数据一致。');
  p.push('');
  p.push('---');
  p.push('');

  // 一、学生用试题
  p.push('## 一、学生用试题');
  p.push('');
  p.push('### 材料');
  p.push('');
  p.push(String(mat.text || '（缺材料）'));
  p.push('');
  p.push('### 拟用图表说明 / 正式图表');
  p.push('');
  const visuals = pkg.visuals || [];
  if (!visuals.length) p.push('（本题组无图表提案）');
  else {
    p.push('| 编号 | 名称 | 类型 | 作用与必要性 | 状态 |');
    p.push('| :-- | :-- | :-- | :-- | :-- |');
    for (const v of visuals) p.push('| ' + v.id + '（r' + v.revision + '） | ' + v.title + ' | ' + v.type + ' | ' + v.necessity + ' | ' + v.status + ' |');
  }
  p.push('');
  p.push('### 题干与作答结构');
  p.push('');
  for (const it of items) {
    if (!it) continue;
    if (it.itemType === 'comprehensive') {
      if (String(it.stem || '').trim()) { p.push(String(it.stem)); p.push(''); }
      p.push('（本题共 ' + it.totalPoints + ' 分）');
      p.push('');
      for (const [j, s] of (it.subQuestions || []).entries()) {
        p.push('（' + (j + 1) + '）' + s.stem + '（' + s.points + ' 分）');
        p.push('');
      }
    } else {
      p.push('**' + String(it.itemId || '').replace(/^Q/, '') + '.** ' + it.stem);
      p.push('');
      for (const k of ['A', 'B', 'C', 'D']) p.push(k + '. ' + ((it.options || {})[k] || ''));
      p.push('');
    }
  }
  p.push('---');
  p.push('');

  // 二、答案与解析
  p.push('## 二、答案与解析');
  p.push('');
  if (isComp) {
    p.push('### 答案与评分依据');
    p.push('');
    for (const it of items) {
      for (const s of it.subQuestions || []) {
        p.push('**' + s.subQuestionId + '（' + s.points + ' 分）**');
        p.push('');
        p.push('| 采分点 | 要素 | 证据链 | 分值 |');
        p.push('| :-- | :-- | :-- | :-- |');
        for (const k of s.answerKey || []) p.push('| ' + k.pointId + ' | ' + k.statement + ' | ' + k.evidenceChain + ' | ' + k.points + ' |');
        p.push('');
        if ((s.answerKey || []).some((k) => (k.acceptableVariants || []).length)) {
          p.push('可接受的等价表述：');
          for (const k of s.answerKey || []) for (const av of k.acceptableVariants || []) p.push('- ' + k.pointId + '：' + av);
          p.push('');
        }
      }
    }
    p.push('### 评分标准与答案边界');
    p.push('');
    for (const it of items) {
      for (const s of it.subQuestions || []) {
        p.push('**' + s.subQuestionId + '**');
        p.push('');
        p.push('| 等级 | 分值区间 | 答案特征 |');
        p.push('| :-- | :-- | :-- |');
        for (const r of s.rubric || []) p.push('| ' + r.level + ' | ' + (r.scoreRange || '—') + ' | ' + r.description + ' |');
        p.push('');
        const ab = s.answerBoundary || {};
        p.push('判为正确：');
        for (const x of ab.acceptable || []) p.push('- ' + x);
        p.push('');
        p.push('判为错答或不给分：');
        for (const x of ab.unacceptable || []) p.push('- ' + x);
        if (ab.notes) { p.push(''); p.push('> 待教师裁定的灰区：' + ab.notes); }
        p.push('');
        if ((s.misconceptionPatterns || []).length) {
          p.push('典型错答模式：');
          for (const m of s.misconceptionPatterns) p.push('- ' + (m.misconceptionId ? '[' + m.misconceptionId + '] ' : '') + m.pattern + ' → ' + m.howItLosesPoints);
          p.push('');
        }
      }
    }
  } else {
    p.push('### 答案与评分依据');
    p.push('');
    p.push('| 题号 | 答案 |');
    p.push('| :-- | :-- |');
    for (const it of items) p.push('| ' + it.itemId + ' | ' + it.answer + ' |');
    p.push('');
    p.push('### 逐题解析');
    p.push('');
    for (const it of items) { p.push('**' + it.itemId + '**：' + it.analysis); p.push(''); }
    p.push('### 干扰项分析');
    p.push('');
    for (const it of items) {
      const rows = Object.entries(it.distractorMap || {});
      if (!rows.length) continue;
      p.push('**' + it.itemId + '**');
      p.push('');
      p.push('| 选项 | 错因类型 | 对应认知障碍 |');
      p.push('| :-- | :-- | :-- |');
      for (const [k, d] of rows) p.push('| ' + k + ' | ' + d.errorType + ' | ' + (d.misconceptionId || '—') + ' |');
      p.push('');
    }
  }
  p.push('---');
  p.push('');

  // 三、命题设计说明
  p.push('## 三、命题设计说明');
  p.push('');
  p.push('### 学情与认知障碍');
  p.push('');
  p.push('教师原话：' + String((pkg.request && pkg.request.learningStateRaw) || '（未记录）'));
  p.push('');
  for (const h of pkg.learningHypotheses || []) {
    p.push('- **' + h.id + '**（' + h.status + '）：' + h.statement + '；可观察错误：' + (h.observableErrors || []).join('；'));
  }
  p.push('');
  p.push('### 课标、知识图谱与教材依据');
  p.push('');
  for (const cb of design.curriculumBasis || []) {
    p.push('- 课标（' + (cb.verification || 'pending') + '）：' + cb.statement + '　→ 题面承载：' + cb.evidenceInItem);
  }
  p.push('');
  for (const tb of design.textbookBasis || []) p.push('- 教材共同知识：' + tb.prerequisite + '　依据：' + tb.basis);
  p.push('');
  p.push('考点树版本：' + (pkg.taxonomySources || []).map((t) => t.file + '@' + (t.version || '未记录') + '/' + (t.status || '未记录')).join('；'));
  if ((pkg.knowledge && pkg.knowledge.needsReviewNodeIds || []).length) {
    p.push('');
    p.push('> ⚠️ **待复核节点**：' + pkg.knowledge.needsReviewNodeIds.join('、') + ' 在源中标记 `needs_review`，本题组不得无提示地作为最终作品交付。');
  }
  p.push('');
  p.push('### 题组递进与设问设计');
  p.push('');
  const selected = (pkg.concepts || []).find((c) => c && pkg.selectedConcept && (pkg.selectedConcept.conceptIds || []).includes(c.id)) || {};
  p.push('- 测量目标：' + (selected.measurementTarget || '（未记录）'));
  p.push('- 认知递进：');
  for (const g of selected.itemProgression || []) p.push('  - ' + (isComp ? '第 ' + g.item + ' 小问' : '第 ' + g.item + ' 题') + '：' + g.cognitiveLevel);
  p.push('');
  p.push('### 核心素养与四翼分析');
  p.push('');
  const fw = design.fourWings || {};
  p.push('- 设计层四翼主次：主要 ' + (fw.primary || []).join('、') + '；次要 ' + ((fw.secondary || []).join('、') || '无'));
  if ((fw.evidence || []).length) for (const e of fw.evidence) p.push('  - ' + e);
  p.push('');
  p.push('### 难度分析');
  p.push('');
  const ed = design.expectedDifficulty || {};
  p.push('预计难度：**' + (ed.level || '（未记录）') + '**');
  p.push('');
  for (const r of ed.rationale || []) p.push('- ' + r);
  if (ed.scoringDiscrimination) p.push('- 采分点区分度：' + ed.scoringDiscrimination);
  if (ed.distractorDiscrimination) p.push('- 干扰项区分度：' + ed.distractorDiscrimination);
  p.push('');
  p.push('### 创新点与边界');
  p.push('');
  p.push(bullets(design.innovationBoundary || []));
  p.push('');
  p.push('---');
  p.push('');

  // 四、典型学生模拟作答
  p.push('## 四、典型学生模拟作答');
  p.push('');
  p.push('> `disclaimer`：以下全部为**预测性认知路径**，不是试测数据，不能用来证明答案唯一。');
  p.push('');
  for (const sim of pkg.simulations || []) {
    p.push('### 水平' + sim.profile);
    p.push('');
    p.push(sim.cognitiveDescription || '');
    p.push('');
    for (const r of sim.responses || []) {
      const label = isComp ? r.subQuestionId : r.itemId;
      if (isComp) {
        p.push('- **' + label + '**：' + (r.writtenAnswer || '（未记录书面答案）'));
        p.push('  - 命中采分点：' + ((r.hitPointIds || []).join('、') || '无') + '；未命中：' + ((r.missedPointIds || []).join('、') || '无'));
      } else {
        p.push('- **' + label + '**：选 ' + r.selected);
      }
      p.push('  - 思路：' + r.reasoning);
      if (r.correctUnderstanding) p.push('  - 正确理解的部分：' + r.correctUnderstanding);
      if (r.errorStep) p.push('  - 出错环节：' + r.errorStep);
      if (r.misconceptionId) p.push('  - 对应认知障碍：' + r.misconceptionId);
    }
    p.push('');
    if (sim.teacherInterpretation) p.push('教师解读：' + sim.teacherInterpretation);
    if (sim.intervention) p.push('干预建议：' + sim.intervention);
    p.push('');
  }
  p.push('---');
  p.push('');

  // 五、来源与证据
  p.push('## 五、来源与证据');
  p.push('');
  p.push('### 课标与知识图谱版本');
  p.push('');
  for (const t of pkg.taxonomySources || []) p.push('- ' + t.file + '：version=' + (t.version || '未记录') + '，status=' + (t.status || '未记录') + '，读取于 ' + t.readAt + '，指纹 ' + (t.contentHash || '未回填'));
  p.push('');
  p.push('### 热点与政策来源');
  p.push('');
  p.push('### 论文与数据来源');
  p.push('');
  p.push('| 编号 | 类型 | 标题 | 机构 | 日期 | 读取范围 | 可信度 | 限制 |');
  p.push('| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |');
  for (const s of pkg.sources || []) {
    p.push('| ' + s.sourceId + ' | ' + s.type + ' | ' + s.title + ' | ' + (s.publisherOrInstitution || '—') + ' | ' + (s.publishedAt || '—') + ' | ' + s.accessScope + ' | ' + s.authorityLevel + ' | ' + (s.limitations || '—') + ' |');
  }
  p.push('');
  for (const s of pkg.sources || []) {
    p.push('- **' + s.sourceId + '** 支持的事实：' + (s.usedClaims || []).join('；'));
  }
  p.push('');
  p.push('### 图表与地图合规信息');
  p.push('');
  if (!visuals.length) p.push('（无）');
  for (const v of visuals) {
    p.push('- ' + v.id + '：' + v.title + '；地图合规：' + ((v.risks && v.risks.mapCompliance) || '—') + '；状态 ' + v.status + '；附件 ' + ((v.files || []).join('、') || '无'));
  }
  p.push('');
  p.push('---');
  p.push('');

  // 六、风险与待确认事项
  p.push('## 六、风险与待确认事项');
  p.push('');
  p.push('| 编号 | 事项 | 级别 | 是否阻断 | 处理 |');
  p.push('| :-- | :-- | :-- | :-- | :-- |');
  for (const r of pkg.risks || []) {
    p.push('| ' + r.id + ' | ' + r.description + ' | ' + r.level + ' | ' + (r.blocking ? '**是**' : '否') + ' | ' + (r.mitigation || '—') + ' |');
  }
  p.push('');
  const pending = (pkg.reviews || []).flatMap((r) => r.pendingItems || []);
  if (pending.length) {
    p.push('评审待办：');
    for (const x of pending) p.push('- ' + x);
    p.push('');
  }
  p.push('### 未完成、因此不得声明的');
  p.push('');
  p.push('- 本稿由任务数据渲染；结构校验结果见 `validation.json`，**结构通过不等于质量通过**。');
  p.push('- 语义项（答案唯一性、材料充分性、科学性、暗超纲、答案边界可判定、四翼与难度依据）须人工或独立核验，校验器不给结论。');
  return p.join('\n') + '\n';
}

// ── 校验报告（validation.json） ─────────────────────────────────────────

const GATE_NAMES = {
  G0: '输入', G1: '知识边界', G2: '证据', G3: '构思确认',
  G4: '题组质量', G5: '图表', G6: '交付说明',
};

function findingsOfGate(findings, id) { return findings.filter((f) => f.gate === id); }

/**
 * 汇总校验报告。语义项一律 pending —— 校验器不能代替内容评审。
 * effectiveReadiness 是**结构能够支撑到的最高完成度**，不是质量结论。
 */
export function buildValidationReport(pkg, findings, meta = {}) {
  const fail = findings.filter((f) => f.level === 'fail');
  const warn = findings.filter((f) => f.level === 'warn');
  const info = findings.filter((f) => f.level === 'info');
  const structureOk = fail.length === 0;

  const gates = Object.keys(GATE_NAMES).map((id) => {
    const own = findingsOfGate(findings, id);
    const hasFail = own.some((f) => f.level === 'fail');
    const applicable = id !== 'G5' || ((pkg.visuals || []).length > 0);
    return {
      id,
      name: GATE_NAMES[id],
      structural: !applicable ? 'not_applicable' : hasFail ? 'fail' : 'pass',
      semantic: !applicable && id === 'G5' ? 'not_applicable' : 'pending',
      checkType: 'structural',
      targetRevision: pkg.revision,
      findings: own,
    };
  });

  // 结构能支撑到的最高完成度
  const blockers = [];
  if (!structureOk) blockers.push('存在结构失败项，完成度不得高于「待补充」');
  const blockingRisks = (pkg.risks || []).filter((r) => r && r.blocking === true);
  if (blockingRisks.length) blockers.push('存在 blocking 风险项：' + blockingRisks.map((r) => r.id).join('、'));
  if (((pkg.knowledge && pkg.knowledge.needsReviewNodeIds) || []).length) blockers.push('使用了 needs_review 节点，须教师确认沿用');
  const unfinishedVisuals = (pkg.visuals || []).filter((v) => v && !['generated', 'verified'].includes(v.status)
    && ((pkg.questionSet && pkg.questionSet.material && pkg.questionSet.material.visualRefs) || []).includes(v.id));
  if (unfinishedVisuals.length) blockers.push('题面引用了未完成的图表：' + unfinishedVisuals.map((v) => v.id).join('、'));
  const semReviews = (pkg.reviews || []).filter((r) => r && r.checkType === 'semantic' && r.targetRevision === pkg.revision);
  if (!semReviews.length) blockers.push('本 revision 没有语义评审记录（校验器只能核对记录，不能证明评审真实发生）');
  // 语义项在本报告里**恒为 pending**，因此结构本身永远不足以支撑「可使用」。
  // 少了这一条，校验器会在语义全 pending 的同时输出 effectiveReadiness=usable
  // （2026-10-21 M2 实测命中），并提示"声明保守（under）"，等于反向激励模型把完成度升格。
  blockers.push('语义核验（答案唯一性、材料充分性、答案边界可判定、四翼与难度依据）须由人工或独立评审完成并签署：校验器只核对结构，不判定语义');

  // effectiveReadiness 的判定规则（只依据结构，不冒充质量结论）：
  //   结构失败                    → pending（字段都对不上，谈不到完成度）
  //   结构通过、但还没有题组       → concepts_pending（还停在构思阶段，结构撑不到初稿）
  //   结构通过、题组已存在         → draft_complete（**上限**；usable 不由校验器给出，见上）
  // 不做这层阶段判断的话，一个只有构思的包会被报成「结构可支撑 draft_complete」，
  // 反过来提示模型"你的声明太保守"——与 usable 那条是同一类反向激励。
  const hasQuestionSet = pkg.questionSet != null;
  let effective = 'pending';
  if (structureOk) effective = hasQuestionSet ? 'draft_complete' : 'concepts_pending';

  // 完成度声明的口径检查：声明高于结构可支撑 = 过度声明（危险）；低于 = 保守（允许但记明）。
  const RANK = { pending: 0, concepts_pending: 1, draft_complete: 2, usable: 3 };
  const declaredRank = RANK[pkg.readiness] === undefined ? -1 : RANK[pkg.readiness];
  const effectiveRank = RANK[effective];
  const readinessClaim = declaredRank === effectiveRank ? 'equal' : declaredRank > effectiveRank ? 'over' : 'under';

  return {
    kind: 'validation_report',
    validator: meta.validator || 'plugins/question/package.js',
    validatorSchemaVersion: SCHEMA_VERSION,
    validatedAt: meta.validatedAt || null,
    taskId: pkg.taskId ?? null,
    packageRevision: pkg.revision ?? null,
    questionType: pkg.questionType ?? null,
    declaredReadiness: pkg.readiness ?? null,
    effectiveReadiness: effective,
    readinessClaim,
    readinessClaimOk: readinessClaim !== 'over',
    structureOk,
    semanticComplete: false,
    gates,
    findings,
    summary: { fail: fail.length, warn: warn.length, info: info.length },
    usableBlockers: blockers,
    taxonomyHashes: meta.taxonomyHashes || [],
    note: '本报告只给结构结论。语义项一律 pending：结构通过不等于质量通过，不得据此宣称「全部门禁通过」。effectiveReadiness 是**结构能支撑的上限**（最高 draft_complete），usable 只能由人工/独立语义评审后由教师声明。',
  };
}

/** 一次性校验：schema + 跨字段不变式 + 投影自检。 */
export function validatePackage(pkg, opts = {}) {
  const findings = [];
  findings.push(...validateAgainstSchema(pkg, opts.schema));
  findings.push(...checkInvariants(pkg, opts));
  findings.push(...checkStudentProjection(pkg));
  return findings.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}
