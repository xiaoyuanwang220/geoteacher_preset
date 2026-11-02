// ModelCheck 数据层 — 通用工具
// 纯 ESM，只用 node: 内置模块；本文件不做任何 I/O。
// 稳定 JSON 与内容哈希是整个判定体系的底座：规则是否变了、证据能否复用、契约是否被改写，都靠这里的规范形。
// 约定：哈希统一带 'sha256:' 前缀；所有哈希输入必须先经 stableStringify（键排序、无空白）。

import { createHash } from 'node:crypto';

// 规范化 JSON：对象键按字典序、无多余空白、数组保持顺序。
// 对象里值为 undefined 的键直接丢弃（与落盘 JSON.stringify 的行为一致，避免可选字段让整次哈希崩掉）；
// 根值与数组元素为 undefined/函数时抛错——那说明调用方传了不可序列化的数据，不能悄悄产出错误哈希。
export function stableStringify(value) {
  return serialize(value, new Set(), '$');
}

function serialize(value, seen, where) {
  if (value === undefined) {
    throw new TypeError(`stableStringify: ${where} 是 undefined，无法规范化`);
  }
  if (typeof value === 'function') {
    throw new TypeError(`stableStringify: ${where} 是函数，无法规范化`);
  }
  if (typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`stableStringify: ${where} 是 ${typeof value}，无法规范化`);
  }
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`stableStringify: ${where} 是 ${String(value)}，不是有限数值`);
    }
    return JSON.stringify(value);
  }
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`stableStringify: ${where} 存在循环引用`);
    seen.add(value);
    const out = value.map((item, index) => serialize(item, seen, `${where}[${index}]`));
    seen.delete(value);
    return `[${out.join(',')}]`;
  }
  if (kind === 'object') {
    if (seen.has(value)) throw new TypeError(`stableStringify: ${where} 存在循环引用`);
    seen.add(value);
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    const out = keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key], seen, `${where}.${key}`)}`);
    seen.delete(value);
    return `{${out.join(',')}}`;
  }
  throw new TypeError(`stableStringify: ${where} 的类型 ${kind} 无法规范化`);
}

// 文本/字节哈希。字符串按 UTF-8；Buffer/Uint8Array 按原始字节（产物落盘用）。
export function sha256(text) {
  const hash = createHash('sha256');
  if (typeof text === 'string') hash.update(text, 'utf8');
  else if (Buffer.isBuffer(text)) hash.update(text);
  else if (text instanceof Uint8Array) hash.update(Buffer.from(text));
  else throw new TypeError('sha256: 只接受字符串或字节数组');
  return `sha256:${hash.digest('hex')}`;
}

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// 结构深比较：对象不看键顺序，数组看顺序；NaN 视为相等（避免状态比较里反复误判）。
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
    const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

export function nowIso() {
  return new Date().toISOString();
}

// 取整后夹到 [min,max]；非数值/非有限值用 fallback（fallback 也非数值时按 0）。
// 用于预算轮次、超时毫秒、视口尺寸这类"配置里可能写错"的整数参数。
export function clampInt(value, min, max, fallback) {
  const fallbackInt = Number.isFinite(fallback) ? Math.trunc(fallback) : 0;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallbackInt;
  let out = Math.trunc(value);
  if (Number.isFinite(min)) out = Math.max(out, Math.trunc(min));
  if (Number.isFinite(max)) out = Math.min(out, Math.trunc(max));
  return out;
}
