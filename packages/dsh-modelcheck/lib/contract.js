// ModelCheck 数据层 — 契约载入 / 校验 / 内容哈希 / 变更通道
// 纯 ESM，只用 node: 内置模块；不读环境、不碰宿主服务。
// 契约是判定体系的"法律文本"：这里负责补默认值、把非法契约一次性收集全部问题，并给出可比较的规范哈希。

import { isPlainObject, sha256, stableStringify } from './util.js';

export const STATUSES = Object.freeze(['unverified', 'pass', 'fail', 'inconclusive', 'stale']);
export const LEVELS = Object.freeze(['P0', 'P1', 'P2']);

// 一期支持的结构化规则类型（与 rules.js 对齐；未知类型一律拒绝，避免静默跳过判据）。
export const RULE_KINDS = Object.freeze([
  'numeric',
  'closure',
  'direction',
  'text',
  'hash',
  'svgEndpoint',
  'bboxOverlap',
  'manual',
]);

export const REQUIRED_EVIDENCE = Object.freeze(['config', 'runtime', 'visual', 'user', 'hash']);
const METHODS = Object.freeze(['auto', 'visual', 'manual']);
const ACCEPTANCES = Object.freeze(['auto', 'visual', 'manual']);
const CONTRACT_STATUSES = Object.freeze(['draft', 'proposed', 'confirmed', 'superseded']);

// 证据要求按规则类型推导：配置类看文件，几何类必须运行时取证，manual 只能用户确认。
const EVIDENCE_BY_KIND = Object.freeze({
  text: 'config',
  hash: 'config',
  closure: 'runtime',
  direction: 'runtime',
  numeric: 'runtime',
  svgEndpoint: 'runtime',
  bboxOverlap: 'runtime',
  manual: 'user',
});

// 内容哈希时排除的"非内容"字段：确认动作产生的时间/人、提议元数据、以及每条判据的运行时状态。
// 契约级 status 也排除：draft → confirmed 只是确认动作，不应让同一份判据规则换一个哈希。
const CONTRACT_VOLATILE_KEYS = Object.freeze([
  'contentHash',
  'status',
  'confirmedAt',
  'confirmedBy',
  'proposedAt',
  'proposedBy',
  'proposedReason',
  'proposedFrom',
  'proposedFromHash',
]);
const CRITERION_VOLATILE_KEYS = Object.freeze(['status', 'evidence', 'contentHash', 'proposedAt', 'proposedBy']);

export class ContractError extends Error {
  // code 取第一条问题的 code（如 'criterion/id-duplicate'），issues 保留全部问题，便于宿主逐条展示。
  constructor(message, code = 'contract/invalid', issues = []) {
    if (Array.isArray(code)) {
      issues = code;
      code = 'contract/invalid';
    }
    super(message);
    this.name = 'ContractError';
    this.code = typeof code === 'string' && code ? code : 'contract/invalid';
    this.issues = Array.isArray(issues) ? issues : [];
  }
}

export function blockingDefaults(level) {
  // P0/P1 阻塞，P2 不阻塞；未知等级按阻塞处理（fail-closed，等校验去报错）。
  if (level === 'P2') return false;
  return true;
}

// 契约规范形：补默认值 + 收集全部问题（不抛错）。normalize / validate / hash / diff 共用这一份逻辑。
function buildContract(raw) {
  const issues = [];
  if (!isPlainObject(raw)) {
    issues.push(issue('contract/type', '契约必须是 JSON 对象'));
    return { contract: { schemaVersion: 1, contractVersion: '0.0.0', status: 'draft', source: [], criteria: [] }, issues };
  }

  const contract = { ...raw };

  if (raw.schemaVersion === undefined) contract.schemaVersion = 1;
  else if (raw.schemaVersion !== 1) {
    issues.push(issue('contract/schema', `不支持的 schemaVersion=${JSON.stringify(raw.schemaVersion)}，一期只支持 1`, 'schemaVersion'));
    contract.schemaVersion = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1;
  } else contract.schemaVersion = 1;

  if (raw.contractVersion === undefined) contract.contractVersion = '0.0.0';
  else if (typeof raw.contractVersion !== 'string' || !raw.contractVersion.trim()) {
    issues.push(issue('contract/version', 'contractVersion 必须是非空字符串', 'contractVersion'));
    contract.contractVersion = '0.0.0';
  } else contract.contractVersion = raw.contractVersion.trim();

  if (raw.status === undefined) contract.status = 'draft';
  else if (!CONTRACT_STATUSES.includes(raw.status)) {
    issues.push(issue('contract/status', `契约状态 ${JSON.stringify(raw.status)} 非法（允许：${CONTRACT_STATUSES.join('/')}）`, 'status'));
    contract.status = 'draft';
  } else contract.status = raw.status;

  for (const field of ['confirmedAt', 'confirmedBy']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') {
      issues.push(issue(`contract/${field}`, `${field} 必须是 ISO 字符串`, field));
      contract[field] = null;
    }
  }

  if (raw.source === undefined) contract.source = [];
  else if (!Array.isArray(raw.source)) {
    issues.push(issue('contract/source', 'source 必须是数组', 'source'));
    contract.source = [];
  } else {
    contract.source = raw.source.map((entry, index) => {
      if (!isPlainObject(entry) || typeof entry.doc !== 'string' || !entry.doc.trim()) {
        issues.push(issue('contract/source', `source[${index}] 缺少 doc`, `source[${index}]`));
        return entry;
      }
      if (entry.hash !== undefined && (typeof entry.hash !== 'string' || !entry.hash.startsWith('sha256:'))) {
        issues.push(issue('contract/source', `source[${index}].hash 必须是 'sha256:…'`, `source[${index}].hash`));
      }
      return entry;
    });
  }

  if (raw.criteria === undefined) {
    issues.push(issue('contract/criteria', '契约缺少 criteria 数组', 'criteria'));
    issues.push(issue('contract/empty', '契约至少需要一条判据', 'criteria'));
    contract.criteria = [];
  } else if (!Array.isArray(raw.criteria)) {
    issues.push(issue('contract/criteria', 'criteria 必须是数组', 'criteria'));
    contract.criteria = [];
  } else {
    const criteria = raw.criteria.map((entry, index) => normalizeCriterion(entry, index, issues)).filter(Boolean);
    contract.criteria = criteria;
    if (criteria.length === 0) issues.push(issue('contract/empty', '契约至少需要一条判据', 'criteria'));
    const seen = new Set();
    for (const criterion of criteria) {
      if (!criterion.id) continue;
      if (seen.has(criterion.id)) {
        issues.push(issue('criterion/id-duplicate', `判据 id 重复：${criterion.id}`, 'criteria', criterion.id));
      }
      seen.add(criterion.id);
    }
  }
  if (Array.isArray(raw.criteria) && raw.criteria.length === 0) {
    if (!issues.some((item) => item.code === 'contract/empty')) {
      issues.push(issue('contract/empty', '契约至少需要一条判据', 'criteria'));
    }
  }
  return { contract, issues };
}

function normalizeCriterion(raw, index, issues) {
  const where = `criteria[${index}]`;
  if (!isPlainObject(raw)) {
    issues.push(issue('criterion/type', `${where} 必须是对象`, where));
    return null;
  }

  const out = { ...raw };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) issues.push(issue('criterion/id', `${where} 缺少非空 id`, `${where}.id`));
  else if (/\s/.test(id) || id.length > 128) {
    issues.push(issue('criterion/id', `${where}.id 不能含空白且不超过 128 字符`, `${where}.id`, id));
  }
  out.id = id;

  let level;
  if (raw.level === undefined) level = 'P1';
  else if (LEVELS.includes(raw.level)) level = raw.level;
  else {
    issues.push(issue('criterion/level', `${id || where}：等级 ${JSON.stringify(raw.level)} 非法（允许：${LEVELS.join('/')}）`, `${where}.level`, id));
    level = 'P1';
  }
  out.level = level;

  let blocking;
  if (raw.blocking === undefined) blocking = blockingDefaults(level);
  else if (typeof raw.blocking === 'boolean') blocking = raw.blocking;
  else {
    issues.push(issue('criterion/blocking', `${id || where}：blocking 必须是布尔值`, `${where}.blocking`, id));
    blocking = blockingDefaults(level);
  }
  if (level === 'P0' && blocking === false) {
    issues.push(issue('criterion/blocking-p0', `${id || where}：P0 判据必须 blocking=true`, `${where}.blocking`, id));
  }
  out.blocking = blocking;

  let claim;
  if (typeof raw.claim === 'string' && raw.claim.trim()) claim = raw.claim.trim();
  else {
    issues.push(issue('criterion/claim-empty', `${id || where}：判据主张 claim 不能为空`, `${where}.claim`, id));
    claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
  }
  out.claim = claim;

  let method;
  if (raw.method === undefined) method = 'auto';
  else if (METHODS.includes(raw.method)) method = raw.method;
  else {
    issues.push(issue('criterion/method', `${id || where}：method 非法（允许：${METHODS.join('/')}）`, `${where}.method`, id));
    method = 'auto';
  }
  out.method = method;

  let acceptance;
  if (raw.acceptance === undefined) acceptance = 'auto';
  else if (ACCEPTANCES.includes(raw.acceptance)) acceptance = raw.acceptance;
  else {
    issues.push(issue('criterion/acceptance', `${id || where}：acceptance 非法（允许：${ACCEPTANCES.join('/')}）`, `${where}.acceptance`, id));
    acceptance = 'auto';
  }
  out.acceptance = acceptance;

  let status;
  if (raw.status === undefined) status = 'unverified';
  else if (STATUSES.includes(raw.status)) status = raw.status;
  else {
    issues.push(issue('criterion/status', `${id || where}：状态 ${JSON.stringify(raw.status)} 非法`, `${where}.status`, id));
    status = 'unverified';
  }
  out.status = status;

  out.evidence = raw.evidence === undefined ? null : raw.evidence;
  if (out.evidence !== null && !isPlainObject(out.evidence)) {
    issues.push(issue('criterion/evidence', `${id || where}：evidence 必须是对象或 null`, `${where}.evidence`, id));
    out.evidence = null;
  }

  if (raw.depends === undefined) out.depends = [];
  else if (!Array.isArray(raw.depends)) {
    issues.push(issue('criterion/depends', `${id || where}：depends 必须是文件路径数组`, `${where}.depends`, id));
    out.depends = [];
  } else {
    const bad = raw.depends.filter((item) => typeof item !== 'string' || !item.trim());
    if (bad.length > 0) issues.push(issue('criterion/depends', `${id || where}：depends 含非字符串或空路径`, `${where}.depends`, id));
    out.depends = raw.depends.filter((item) => typeof item === 'string' && item.trim());
  }

  if (raw.context === undefined) out.context = {};
  else if (!isPlainObject(raw.context)) {
    issues.push(issue('criterion/context', `${id || where}：context 必须是对象`, `${where}.context`, id));
    out.context = {};
  }

  if (raw.component !== undefined && raw.component !== null && (typeof raw.component !== 'string' || !raw.component.trim())) {
    issues.push(issue('criterion/component', `${id || where}：component 必须是非空字符串或 null`, `${where}.component`, id));
    out.component = null;
  } else {
    out.component = typeof raw.component === 'string' && raw.component.trim() ? raw.component.trim() : null;
  }

  if (raw.supersededBy !== undefined && raw.supersededBy !== null && (typeof raw.supersededBy !== 'string' || !raw.supersededBy.trim())) {
    issues.push(issue('criterion/superseded-by', `${id || where}：supersededBy 必须是非空字符串或 null`, `${where}.supersededBy`, id));
    out.supersededBy = null;
  } else {
    out.supersededBy = raw.supersededBy ? raw.supersededBy.trim() : null;
  }

  if (raw.withdrawn !== undefined && typeof raw.withdrawn !== 'boolean') {
    issues.push(issue('criterion/withdrawn', `${id || where}：withdrawn 必须是布尔值`, `${where}.withdrawn`, id));
    out.withdrawn = false;
  } else out.withdrawn = Boolean(raw.withdrawn);

  // rule：缺省按 method 兜底成 manual，其余缺失一律报错（不允许"没有规则的判据"蒙混过关）。
  let rule;
  let ruleWasObject = false;
  if (isPlainObject(raw.rule)) {
    ruleWasObject = true;
    try {
      rule = JSON.parse(JSON.stringify(raw.rule));
    } catch {
      issues.push(issue('criterion/rule', `${id || where}：rule 不是可序列化对象`, `${where}.rule`, id));
      rule = { kind: null };
    }
  } else if (raw.rule === undefined || raw.rule === null) {
    if (method === 'manual' || method === 'visual') rule = { kind: 'manual' };
    else {
      issues.push(issue('criterion/rule', `${id || where}：缺少 rule`, `${where}.rule`, id));
      rule = { kind: null };
    }
  } else {
    issues.push(issue('criterion/rule', `${id || where}：rule 必须是对象`, `${where}.rule`, id));
    rule = { kind: null };
  }
  out.rule = rule;

  if (ruleWasObject && !RULE_KINDS.includes(rule.kind)) {
    issues.push(
      issue(
        'criterion/rule-kind',
        `${id || where}：未知规则类型 ${JSON.stringify(rule.kind)}（允许：${RULE_KINDS.join('/')}）`,
        `${where}.rule.kind`,
        id,
      ),
    );
  }
  if (RULE_KINDS.includes(rule.kind)) checkRuleShape(rule.kind, rule, issues, where, id);

  let requiredEvidence;
  if (raw.requiredEvidence !== undefined) {
    if (REQUIRED_EVIDENCE.includes(raw.requiredEvidence)) requiredEvidence = raw.requiredEvidence;
    else {
      issues.push(
        issue(
          'criterion/required-evidence',
          `${id || where}：requiredEvidence 非法（允许：${REQUIRED_EVIDENCE.join('/')}）`,
          `${where}.requiredEvidence`,
          id,
        ),
      );
      requiredEvidence = deriveRequiredEvidence({ method, rule });
    }
  } else requiredEvidence = deriveRequiredEvidence({ method, rule });
  out.requiredEvidence = requiredEvidence;

  if (raw.source !== undefined && !isPlainObject(raw.source) && !Array.isArray(raw.source)) {
    issues.push(issue('criterion/source', `${id || where}：source 必须是对象或数组`, `${where}.source`, id));
  }

  return out;
}

// 规则参数校验：只查"能不能执行"，不查判定是否合理；任一缺失都 fail-closed（不能执行就 inconclusive）。
function checkRuleShape(kind, rule, issues, where, id) {
  const push = (code, message, field) => issues.push(issue(code, `${id || where}：${message}`, `${where}.rule.${field}`, id));

  for (const field of ['tolerance', 'toleranceDeg']) {
    const value = rule[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) push('rule/tolerance', `${field} 必须是非负有限数值`, field);
  }
  const requireTolerance = (fields) => {
    if (fields.some((field) => rule[field] !== undefined)) return;
    push('rule/tolerance', `缺少容差 ${fields.join('/')}`, fields[0]);
  };

  switch (kind) {
    case 'numeric': {
      if (typeof rule.observed !== 'string' || !rule.observed.trim()) push('rule/numeric', 'numeric 缺少 observed', 'observed');
      if (!['<', '<=', '>', '>=', '==', '!='].includes(rule.op)) push('rule/numeric', `numeric 的 op 非法：${JSON.stringify(rule.op)}`, 'op');
      if (typeof rule.value !== 'number' || !Number.isFinite(rule.value)) push('rule/numeric', 'numeric 缺少有限数值 value', 'value');
      break;
    }
    case 'closure': {
      const hasEdge =
        (typeof rule.from === 'string' && rule.from.trim() && typeof rule.to === 'string' && rule.to.trim()) ||
        (typeof rule.path === 'string' && rule.path.trim());
      if (!hasEdge) push('rule/closure', 'closure 需要 from/to 或 path', 'from');
      requireTolerance(['tolerance']);
      break;
    }
    case 'direction': {
      if (typeof rule.component !== 'string' || !rule.component.trim()) push('rule/direction', 'direction 缺少 component', 'component');
      const expected = rule.expected;
      const hasVector = isPlainObject(expected) && ['x', 'y', 'z'].every((axis) => typeof expected[axis] === 'number' && Number.isFinite(expected[axis]));
      const hasAzimuth =
        (typeof rule.expectedAzimuthDeg === 'number' && Number.isFinite(rule.expectedAzimuthDeg)) ||
        (isPlainObject(expected) && typeof expected.azimuthDeg === 'number' && Number.isFinite(expected.azimuthDeg));
      if (!hasVector && !hasAzimuth) push('rule/direction', 'direction 需要 expected 向量或方位角', 'expected');
      requireTolerance(['toleranceDeg', 'tolerance']);
      break;
    }
    case 'text': {
      if (typeof rule.file !== 'string' || !rule.file.trim()) push('rule/text', 'text 缺少 file', 'file');
      if (!['equals', 'matches', 'not-matches'].includes(rule.mode)) push('rule/text', `text 的 mode 非法：${JSON.stringify(rule.mode)}`, 'mode');
      if (rule.mode === 'equals') {
        if (typeof rule.value !== 'string') push('rule/text', 'text equals 模式需要字符串 value', 'value');
      } else if (rule.mode === 'matches' || rule.mode === 'not-matches') {
        if (typeof rule.pattern !== 'string' || !rule.pattern) push('rule/text', 'text 正则模式需要非空 pattern', 'pattern');
        else if (rule.pattern.length > 512) push('rule/text', 'text pattern 超过 512 字符上限', 'pattern');
      }
      break;
    }
    case 'hash': {
      if (typeof rule.file !== 'string' || !rule.file.trim()) push('rule/hash', 'hash 缺少 file', 'file');
      if (typeof rule.sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(rule.sha256)) {
        push('rule/hash', "hash 的 sha256 必须是 'sha256:<64 位十六进制>'", 'sha256');
      }
      break;
    }
    case 'svgEndpoint': {
      if (typeof rule.pick !== 'string' || !rule.pick.trim()) push('rule/svg-endpoint', 'svgEndpoint 缺少 pick', 'pick');
      for (const field of ['from', 'to']) {
        if (!['start', 'end'].includes(rule[field])) push('rule/svg-endpoint', `${field} 必须是 start 或 end`, field);
      }
      requireTolerance(['tolerance']);
      break;
    }
    case 'bboxOverlap': {
      const components = Array.isArray(rule.components) ? rule.components.filter((item) => typeof item === 'string' && item.trim()) : [];
      if (components.length < 2) push('rule/bbox-overlap', 'bboxOverlap 需要两个组件 id', 'components');
      if (rule.candidateOnly !== undefined && typeof rule.candidateOnly !== 'boolean') {
        push('rule/bbox-overlap', 'candidateOnly 必须是布尔值', 'candidateOnly');
      }
      break;
    }
    case 'manual':
    default:
      break;
  }
}

function deriveRequiredEvidence({ method, rule }) {
  if (method === 'manual') return 'user';
  if (method === 'visual') return 'visual';
  const kind = rule && rule.kind;
  return EVIDENCE_BY_KIND[kind] || 'runtime';
}

export function normalizeContract(raw) {
  const { contract, issues } = buildContract(raw);
  if (issues.length > 0) {
    const preview = issues.slice(0, 5).map((item) => item.message).join('；');
    throw new ContractError(`契约不合法（${issues.length} 项）：${preview}${issues.length > 5 ? ' …' : ''}`, issues[0].code, issues);
  }
  return contract;
}

// 不抛版本：一次返回全部问题，供工具/面板逐条展示并让 agent 一次性修完。
export function validateContract(raw) {
  const { issues } = buildContract(raw);
  return { ok: issues.length === 0, errors: issues };
}

// 内容哈希：规范 JSON（键排序、判据按 id 排序）的 sha256。
// 排除：contentHash、契约级 status/confirmed*、提议元数据、每条判据的 status/evidence。
// 因此换行/键序/确认动作不改变哈希；规则、容差、等级、阻塞性、验收方式、claim 任一变化都会改变哈希。
export function contractContentHash(contract) {
  const { contract: built } = buildContract(contract);
  const canonical = {};
  for (const [key, value] of Object.entries(built)) {
    if (CONTRACT_VOLATILE_KEYS.includes(key)) continue;
    canonical[key] = value;
  }
  canonical.criteria = (built.criteria || [])
    .map((criterion) => {
      const keep = {};
      for (const [key, value] of Object.entries(criterion)) {
        if (CRITERION_VOLATILE_KEYS.includes(key)) continue;
        keep[key] = value;
      }
      return keep;
    })
    .sort((a, b) => {
      const left = String(a.id ?? '');
      const right = String(b.id ?? '');
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    });
  return sha256(stableStringify(canonical));
}

// 返回契约的全部判据（含被取代/撤回的）；是否生效用 isActive 判断。
export function criteriaOf(contract) {
  if (!contract || !Array.isArray(contract.criteria)) return [];
  return contract.criteria.slice();
}

export function isActive(criterion) {
  if (!criterion || typeof criterion !== 'object') return false;
  if (criterion.supersededBy) return false;
  if (criterion.withdrawn === true) return false;
  return true;
}

// 规则 + 阈值（含单位/包含边界等全部 rule 字段）的规范哈希；证据键的组成部分。
export function ruleHash(criterion) {
  const rule = criterion && isPlainObject(criterion.rule) ? criterion.rule : null;
  return sha256(stableStringify(rule));
}

// 契约变更通道：added / removed / weakened。
// weakened 按规格 §7.2 判定：删判据、降等级、去阻塞、放宽容差、放宽验收方式、降低证据要求、改写 claim。
// 每项形如 { id, kind, reason, old?, new? }。
export function diffContracts(oldContract, newContract) {
  const oldC = buildContract(oldContract).contract;
  const newC = buildContract(newContract).contract;
  const oldMap = new Map((oldC.criteria || []).map((criterion) => [criterion.id, criterion]));
  const newMap = new Map((newC.criteria || []).map((criterion) => [criterion.id, criterion]));

  const added = [];
  const removed = [];
  const weakened = [];

  for (const [id, criterion] of newMap) {
    if (!oldMap.has(id)) added.push({ id, kind: 'added', reason: '新增判据', new: criterion });
  }

  for (const [id, oldCrit] of oldMap) {
    if (!newMap.has(id)) {
      const entry = { id, kind: 'removed', reason: '判据被删除', old: oldCrit };
      removed.push(entry);
      weakened.push(entry);
      continue;
    }
    const newCrit = newMap.get(id);
    const add = (kind, reason, oldValue, newValue) => weakened.push({ id, kind, reason, old: oldValue, new: newValue });

    const oldLevel = LEVELS.indexOf(oldCrit.level);
    const newLevel = LEVELS.indexOf(newCrit.level);
    if (oldLevel >= 0 && newLevel >= 0 && newLevel > oldLevel) {
      add('level', `判据等级由 ${oldCrit.level} 降为 ${newCrit.level}`, oldCrit.level, newCrit.level);
    }

    if (oldCrit.blocking === true && newCrit.blocking === false) {
      add('blocking', '判据由阻塞降为非阻塞', true, false);
    }

    for (const field of ['tolerance', 'toleranceDeg']) {
      const oldValue = oldCrit.rule && oldCrit.rule[field];
      const newValue = newCrit.rule && newCrit.rule[field];
      if (typeof oldValue === 'number' && typeof newValue === 'number' && newValue > oldValue) {
        add('tolerance', `${field} 由 ${oldValue} 放宽到 ${newValue}`, oldValue, newValue);
      } else if (typeof oldValue !== 'number' && typeof newValue === 'number') {
        add('tolerance', `新增容差 ${field}=${newValue}（失去原有约束）`, oldValue ?? null, newValue);
      }
    }

    if (oldCrit.acceptance !== newCrit.acceptance && oldCrit.acceptance === 'auto' && ['manual', 'visual'].includes(newCrit.acceptance)) {
      add('acceptance', `验收方式由 ${oldCrit.acceptance} 改为 ${newCrit.acceptance}`, oldCrit.acceptance, newCrit.acceptance);
    }

    const oldEvidenceRank = evidenceRank(oldCrit.requiredEvidence);
    const newEvidenceRank = evidenceRank(newCrit.requiredEvidence);
    if (newEvidenceRank < oldEvidenceRank) {
      add(
        'evidence',
        `证据要求由 ${oldCrit.requiredEvidence} 降为 ${newCrit.requiredEvidence}`,
        oldCrit.requiredEvidence,
        newCrit.requiredEvidence,
      );
    }

    if (oldCrit.claim !== newCrit.claim) {
      add('claim', '判据主张（claim）被改写，需重新确认', oldCrit.claim, newCrit.claim);
    }

    const oldKind = oldCrit.rule && oldCrit.rule.kind;
    const newKind = newCrit.rule && newCrit.rule.kind;
    if (oldKind && newKind && oldKind !== newKind) {
      add('rule-kind', `规则类型由 ${oldKind} 改为 ${newKind}`, oldKind, newKind);
    }
  }

  return { added, removed, weakened };
}

function evidenceRank(value) {
  // runtime/hash 是硬证据；visual 次之；config 只能证明配置；user 是人工确认，最弱。
  const ranks = { runtime: 4, hash: 4, visual: 3, config: 2, user: 1 };
  return ranks[value] ?? 0;
}

function issue(code, message, path, criterionId) {
  const entry = { code, message };
  if (path) entry.path = path;
  if (criterionId) entry.criterionId = criterionId;
  return entry;
}
