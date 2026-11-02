// ModelCheck 数据层 — 组件注册表（components.json）
// 纯 ESM，只用 node: 内置模块。
// registry 是"模型里有哪些可点选/取证对象"的登记簿：pick 必须唯一（否则点选与取证会认错对象），
// locator.file 必须指向项目内文件（标注消息据此给模型代码位置）。

import { isPlainObject, sha256, stableStringify } from './util.js';

export const ROUTES = Object.freeze(['three', 'svg', 'dom', 'image']);
// 可标注单元类型（v2）。文字标签与二维控件不在点选范围，因此没有 label/ui 类型。
export const KINDS = Object.freeze(['structure', 'region', 'cell', 'belt', 'arrow', 'image-region', 'other']);
const UNIT_KEY_RE = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 ._:/-]{0,79}$/;

// 注册表规范形：schemaVersion 兜底 1；组件字段补齐但不"猜值"（非法值保留原样，交给 validate 报错）。
export function normalizeRegistry(raw) {
  const { registry, errors } = buildRegistry(raw);
  if (errors.length > 0) throw registryError(errors);
  return registry;
}

// 不抛版本：一次返回全部 errors + warnings。
// context 可选（{ criteriaIds, componentIds }）：提供时才能对 related 做"引用不存在"的警告——判据可能后补，所以只警告。
export function validateRegistry(raw, context = {}) {
  const { errors, warnings } = buildRegistry(raw, context);
  return { ok: errors.length === 0, errors, warnings };
}

export function componentById(registry, id) {
  if (!registry || !Array.isArray(registry.components) || typeof id !== 'string') return null;
  return registry.components.find((component) => component && component.id === id) || null;
}

// 组件指纹：对规范化后的组件做规范哈希（排除指纹/更新时间这类自指或易变字段），用于"改后核对"显示已变/未变。
export function componentFingerprints(registry) {
  const out = {};
  const components = registry && Array.isArray(registry.components) ? registry.components : [];
  for (const raw of components) {
    const component = normalizeComponent(raw);
    if (!component.id) continue;
    const { fingerprint, updatedAt, checkedAt, ...stable } = component;
    out[component.id] = sha256(stableStringify(stable));
  }
  return out;
}

function buildRegistry(raw, context = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    errors.push(issue('registry/type', 'components.json 必须是 JSON 对象'));
    return { registry: { schemaVersion: 1, components: [] }, errors, warnings };
  }

  const registry = { ...raw };
  registry.schemaVersion = Number.isInteger(raw.schemaVersion) ? raw.schemaVersion : 1;

  if (raw.components === undefined) {
    warnings.push(issue('registry/components-missing', 'components.json 没有 components 数组，按空注册表处理'));
    registry.components = [];
  } else if (!Array.isArray(raw.components)) {
    errors.push(issue('registry/components', 'components 必须是数组'));
    registry.components = [];
  } else {
    registry.components = raw.components.map(normalizeComponent);
    if (raw.components.length === 0) warnings.push(issue('registry/empty', '组件注册表为空，标注与运行时取证将不可用'));
  }

  const seenIds = new Map();
  const seenPicks = new Map();
  const criteriaIds = Array.isArray(context.criteriaIds) ? new Set(context.criteriaIds) : null;
  const knownComponentIds = new Set(registry.components.map((component) => component.id).filter(Boolean));
  const contextComponentIds = Array.isArray(context.componentIds) ? new Set(context.componentIds) : null;

  registry.components.forEach((component, index) => {
    const where = `components[${index}]`;
    const id = component.id;
    if (!id) errors.push(issue('component/id', `${where} 缺少非空 id`, where));
    else if (/\s/.test(id) || id.length > 128) errors.push(issue('component/id', `${where}.id 不能含空白且不超过 128 字符`, `${where}.id`, id));
    else if (seenIds.has(id)) errors.push(issue('component/id-duplicate', `组件 id 重复：${id}`, `${where}.id`, id));
    if (id) seenIds.set(id, (seenIds.get(id) || 0) + 1);

    if (!component.label) errors.push(issue('component/label', `${id || where} 缺少 label`, `${where}.label`, id));

    if (component.route === null) {
      errors.push(issue('component/route', `${id || where}：route 非法或缺失（允许：${ROUTES.join('/')}）`, `${where}.route`, id));
    }

    if (!component.pick) errors.push(issue('component/pick', `${id || where}：缺少 pick（对象 name 或选择器）`, `${where}.pick`, id));
    else if (seenPicks.has(component.pick)) {
      errors.push(
        issue(
          'component/pick-duplicate',
          `${id || where}：pick 与组件 ${seenPicks.get(component.pick)} 重复（${component.pick}）`,
          `${where}.pick`,
          id,
        ),
      );
    }
    if (component.pick) seenPicks.set(component.pick, id || where);

    const rawComponent = raw.components[index];
    if (component.kind === null) {
      errors.push(issue('component/kind', `${id || where}：kind 非法（允许：${KINDS.join('/')}）`, `${where}.kind`, id));
    }
    if (rawComponent && rawComponent.annotatable !== undefined && typeof rawComponent.annotatable !== 'boolean') {
      errors.push(issue('component/annotatable', `${id || where}：annotatable 必须是布尔值`, `${where}.annotatable`, id));
    }
    validateUnits(rawComponent, component, where, id, errors, warnings);

    const locator = component.locator;
    if (!locator || !locator.file) {
      errors.push(issue('component/locator-file', `${id || where}：locator.file 必填`, `${where}.locator.file`, id));
    } else if (!isProjectRelativePath(locator.file)) {
      errors.push(issue('component/locator-file', `${id || where}：locator.file 必须是项目内相对路径（${locator.file}）`, `${where}.locator.file`, id));
    }

    if (rawComponent && rawComponent.related !== undefined) {
      if (!Array.isArray(rawComponent.related)) errors.push(issue('component/related', `${id || where}：related 必须是数组`, `${where}.related`, id));
      else for (const ref of rawComponent.related) {
        if (typeof ref !== 'string' || !ref.trim()) {
          errors.push(issue('component/related', `${id || where}：related 含非字符串或空引用`, `${where}.related`, id));
          continue;
        }
        if (!criteriaIds && !contextComponentIds) continue;
        const known = knownComponentIds.has(ref) || (contextComponentIds && contextComponentIds.has(ref)) || (criteriaIds && criteriaIds.has(ref));
        if (!known) warnings.push(issue('component/related-unknown', `${id || where}：related 引用的 ${ref} 暂不存在（判据可能后补）`, `${where}.related`, id));
      }
    }

    if (rawComponent && rawComponent.observables !== undefined) {
      if (!Array.isArray(rawComponent.observables)) {
        errors.push(issue('component/observables', `${id || where}：observables 必须是数组`, `${where}.observables`, id));
      } else for (const [obsIndex, observable] of rawComponent.observables.entries()) {
        if (!isPlainObject(observable) || typeof observable.name !== 'string' || !observable.name.trim()) {
          errors.push(issue('component/observables', `${id || where}：observables[${obsIndex}] 缺少 name`, `${where}.observables`, id));
        }
      }
    }

    if (rawComponent && rawComponent.sharedDependencies !== undefined) {
      const deps = rawComponent.sharedDependencies;
      if (!Array.isArray(deps) || deps.some((dep) => typeof dep !== 'string' || !dep.trim())) {
        errors.push(issue('component/shared-dependencies', `${id || where}：sharedDependencies 必须是文件路径数组`, `${where}.sharedDependencies`, id));
      }
    }
  });

  return { registry, errors, warnings };
}

function normalizeComponent(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const out = { ...source };
  out.id = typeof source.id === 'string' ? source.id.trim() : '';
  out.label = typeof source.label === 'string' ? source.label.trim() : '';
  out.kind = KINDS.includes(source.kind) ? source.kind : (source.kind === undefined ? 'other' : null);
  out.annotatable = source.annotatable === false ? false : true;
  out.route = ROUTES.includes(source.route) ? source.route : null;
  out.pick = typeof source.pick === 'string' ? source.pick.trim() : null;

  const locator = isPlainObject(source.locator) ? source.locator : {};
  out.locator = {
    ...locator,
    file: typeof locator.file === 'string' ? locator.file.trim() : null,
    symbol: typeof locator.symbol === 'string' ? locator.symbol.trim() : null,
    line: Number.isInteger(locator.line) ? locator.line : null,
  };

  out.related = Array.isArray(source.related) ? source.related.filter((item) => typeof item === 'string' && item.trim()) : [];
  out.observables = Array.isArray(source.observables) ? source.observables.filter((item) => isPlainObject(item)) : [];
  out.sharedDependencies = Array.isArray(source.sharedDependencies)
    ? source.sharedDependencies.filter((item) => typeof item === 'string' && item.trim())
    : [];
  out.parts = Array.isArray(source.parts) ? source.parts.map(normalizeUnit).filter((unit) => unit.key) : [];
  out.instances = Array.isArray(source.instances) ? source.instances.map(normalizeUnit).filter((unit) => unit.key) : [];
  return out;
}

// 子单元（parts/instances）规范形：只保留已知字段；不猜值。
function normalizeUnit(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const out = { key: typeof source.key === 'string' ? source.key.trim() : '' };
  if (typeof source.label === 'string' && source.label.trim()) out.label = source.label.trim();
  if (isPlainObject(source.selector)) out.selector = { ...source.selector };
  if (isPlainObject(source.instanceSelector)) out.instanceSelector = { ...source.instanceSelector };
  if (Number.isInteger(source.instanceId)) out.instanceId = source.instanceId;
  if (isPlainObject(source.locator)) {
    const locator = source.locator;
    out.locator = {
      ...locator,
      file: typeof locator.file === 'string' ? locator.file.trim() : null,
      symbol: typeof locator.symbol === 'string' ? locator.symbol.trim() : null,
      line: Number.isInteger(locator.line) ? locator.line : null
    };
  }
  if (Array.isArray(source.observables)) out.observables = source.observables.filter((item) => isPlainObject(item));
  if (typeof source.fingerprint === 'string' && source.fingerprint.trim()) out.fingerprint = source.fingerprint.trim();
  return out;
}

// parts/instances 校验：key 必须唯一（跨两者也不能重复，因为选择标识是 `组件#key`）。
function validateUnits(rawComponent, component, where, id, errors, warnings) {
  if (!rawComponent) return;
  const seen = new Map();
  for (const field of ['parts', 'instances']) {
    const raw = rawComponent[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) {
      errors.push(issue(`component/${field}`, `${id || where}：${field} 必须是数组`, `${where}.${field}`, id));
      continue;
    }
    raw.forEach((unit, index) => {
      const path = `${where}.${field}[${index}]`;
      if (!isPlainObject(unit)) {
        errors.push(issue(`component/${field}`, `${id || where}：${field}[${index}] 必须是对象`, path, id));
        return;
      }
      const key = typeof unit.key === 'string' ? unit.key.trim() : '';
      if (!key) {
        errors.push(issue(`component/${field}-key`, `${id || where}：${field}[${index}] 缺少 key`, `${path}.key`, id));
        return;
      }
      if (!UNIT_KEY_RE.test(key)) {
        errors.push(issue(`component/${field}-key`, `${id || where}：${field}[${index}].key 含非法字符或过长（${key}）`, `${path}.key`, id));
      }
      if (seen.has(key)) {
        errors.push(issue('component/unit-key-duplicate', `${id || where}：子单元 key 重复：${key}（${seen.get(key)} 与 ${path}）`, `${path}.key`, id));
      } else {
        seen.set(key, path);
      }
      if (unit.locator && unit.locator.file && !isProjectRelativePath(unit.locator.file)) {
        errors.push(issue('component/unit-locator', `${id || where}：${field}[${index}].locator.file 必须是项目内相对路径`, `${path}.locator.file`, id));
      }
      if (unit.instanceId !== undefined && !Number.isInteger(unit.instanceId)) {
        errors.push(issue('component/unit-instance-id', `${id || where}：${field}[${index}].instanceId 必须是整数`, `${path}.instanceId`, id));
      }
      if (field === 'instances' && !unit.selector && !unit.instanceSelector && unit.instanceId === undefined) {
        warnings.push(issue('component/unit-selector', `${id || where}：instances[${index}] 没有 selector/instanceId，取证时只能按顺序匹配`, `${path}.selector`, id));
      }
    });
  }
}

// locator.file 只接受项目内相对路径：拒绝绝对路径与 `..` 上跳（标注消息会把它交给模型去改文件）。
function isProjectRelativePath(value) {
  const text = String(value).replace(/\\/g, '/');
  if (!text || text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return false;
  return !text.split('/').includes('..');
}

function registryError(errors) {
  const error = new Error(`组件注册表不合法（${errors.length} 项）：${errors.slice(0, 5).map((item) => item.message).join('；')}`);
  error.name = 'RegistryError';
  error.code = 'registry/invalid';
  error.issues = errors;
  return error;
}

function issue(code, message, path, componentId) {
  const entry = { code, message };
  if (path) entry.path = path;
  if (componentId) entry.componentId = componentId;
  return entry;
}
