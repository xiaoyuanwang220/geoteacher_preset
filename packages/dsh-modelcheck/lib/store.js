// ModelCheck 数据层 — .modelcheck/ JSON 存储（唯一写盘入口）
// 纯 ESM，只用 node: 内置模块。
// 约束（设计 §2.2）：任何写操作先校验目标路径在项目根 `.modelcheck/` 内，绝不落到项目外；写 JSON 一律"同目录临时文件 → rename"。

import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { sha256, stableStringify } from './util.js';

const STORE_ERROR_CODES = ['not-found', 'parse', 'conflict', 'io'];

export class StoreError extends Error {
  // code: 'not-found' | 'parse' | 'conflict' | 'io'
  // extra 可带 path / actual / expected / cause，方便宿主日志定位；不覆盖 name/code/message。
  constructor(message, code = 'io', extra = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = STORE_ERROR_CODES.includes(code) ? code : 'io';
    if (extra && typeof extra === 'object') {
      for (const [key, value] of Object.entries(extra)) {
        if (key === 'name' || key === 'code' || key === 'message' || key === 'stack') continue;
        this[key] = value;
      }
    }
  }
}

// 读写 .modelcheck/ 下的 JSON；产物落 artifacts/。
// rootDir 是项目根（要求含或将要创建 `.modelcheck/`）。
export class Store {
  constructor(rootDir) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      throw new StoreError('Store 需要项目根目录', 'io');
    }
    this.rootDir = resolve(rootDir);
  }

  get paths() {
    const dir = join(this.rootDir, '.modelcheck');
    return {
      dir,
      config: join(dir, 'config.json'),
      components: join(dir, 'components.json'),
      contract: join(dir, 'contract.json'),
      contractProposed: join(dir, 'contract.proposed.json'),
      evidence: join(dir, 'evidence.json'),
      annotations: join(dir, 'annotations.json'),
      rounds: join(dir, 'rounds.json'),
      certification: join(dir, 'certification.json'),
      reportsDir: join(dir, 'reports'),
      artifactsDir: join(dir, 'artifacts'),
    };
  }

  // 项目根：调用方拼项目内相对路径时用，不要拿它当写盘许可。
  get root() {
    return this.rootDir;
  }

  // 相对路径按项目根解析，绝对路径原样规范化；结果一定是绝对路径。
  absolute(path) {
    return isAbsolute(String(path)) ? resolve(String(path)) : resolve(this.rootDir, String(path));
  }

  // 目标必须位于 `<root>/.modelcheck/` 内（含子目录），否则 StoreError('io')。
  // 这是路径穿越防护：`../x.json` 在 resolve 后落在 .modelcheck 外，会被拒绝。
  assertWritablePath(path) {
    const abs = this.absolute(path);
    if (!isInside(this.paths.dir, abs)) {
      throw new StoreError(`拒绝写入 .modelcheck 之外的路径：${abs}`, 'io', { path: abs });
    }
    return abs;
  }

  async ensureLayout() {
    await mkdir(this.paths.dir, { recursive: true });
    await mkdir(this.paths.reportsDir, { recursive: true });
    await mkdir(this.paths.artifactsDir, { recursive: true });
  }

  // 文件不存在返回 fallback（fallback 未提供时抛 not-found）；解析失败抛 parse。
  // 注意：fallback 原样返回，调用方改它不会写盘。
  async readJson(path, fallback) {
    const abs = this.absolute(path);
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (fallback !== undefined) return fallback;
        throw new StoreError(`文件不存在：${abs}`, 'not-found', { path: abs });
      }
      throw new StoreError(`读取失败：${abs}（${error && error.message ? error.message : error}）`, 'io', {
        path: abs,
        cause: error,
      });
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new StoreError(`JSON 解析失败：${abs}（${error.message}）`, 'parse', { path: abs, cause: error });
    }
  }

  // 原子写 JSON：同目录 .tmp-<随机> 写完再 rename；失败清理临时文件。
  async writeJson(path, value) {
    const abs = this.assertWritablePath(path);
    await this.#requireLayout();
    const parent = dirname(abs);
    await mkdir(parent, { recursive: true });
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await this.#atomicWrite(abs, body);
  }

  // 读-改-写。mutate(current, { revision, path }) 返回新值；返回 undefined 表示不写入。
  // revision = 读入时的内容哈希（无文件为 null），写前再读一次校验；期间被别的进程/模块改过 → StoreError('conflict')。
  // 局限：没有文件锁，只做写前复核，冲突判定粒度是"整个文件"；evaluate 等调用方按判据逐条写即可。
  async updateJson(path, mutate) {
    if (typeof mutate !== 'function') throw new StoreError('updateJson 需要 mutate 函数', 'io', { path: this.absolute(path) });
    const abs = this.absolute(path);
    const current = await this.readJson(abs, null);
    const revision = current === null ? null : sha256(stableStringify(current));
    const next = await mutate(current, { revision, path: abs });
    if (next === undefined) return current;
    const fresh = await this.readJson(abs, null);
    const freshRevision = fresh === null ? null : sha256(stableStringify(fresh));
    if (freshRevision !== revision) {
      throw new StoreError(`写入冲突：${abs} 在读取后被修改`, 'conflict', {
        path: abs,
        expected: revision,
        actual: freshRevision,
      });
    }
    await this.writeJson(abs, next);
    return next;
  }

  // 产物落 artifacts/，文件名 = 内容哈希（可重名复用，重复写同一内容无副作用）。
  async writeArtifact(bytes, ext = 'bin') {
    const buffer = toBuffer(bytes);
    const contentHash = sha256(buffer);
    const hex = contentHash.slice('sha256:'.length);
    const suffix = normalizeExt(ext);
    const name = `${hex}${suffix}`;
    const artifactsDir = this.paths.artifactsDir;
    if (!isInside(this.paths.dir, artifactsDir)) {
      throw new StoreError(`产物目录不在 .modelcheck 内：${artifactsDir}`, 'io', { path: artifactsDir });
    }
    await this.ensureLayout();
    const path = join(artifactsDir, name);
    if (!(await this.exists(path))) await this.#atomicWrite(path, buffer);
    return { name, path, hash: contentHash };
  }

  async exists(path) {
    try {
      await access(this.absolute(path));
      return true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
      throw new StoreError(`检查文件失败：${this.absolute(path)}（${error && error.message ? error.message : error}）`, 'io', {
        path: this.absolute(path),
        cause: error,
      });
    }
  }

  // 写盘前确认 `.modelcheck/` 已存在：store 只在 ensureLayout 里创建目录，写 JSON 不隐式建目录。
  async #requireLayout() {
    try {
      await access(this.paths.dir);
    } catch {
      throw new StoreError(`项目缺少 .modelcheck 目录，先调用 ensureLayout()：${this.paths.dir}`, 'io', {
        path: this.paths.dir,
      });
    }
  }

  async #atomicWrite(abs, body) {
    const tmp = `${abs}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, body, { flag: 'wx' });
      await rename(tmp, abs);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      if (error instanceof StoreError) throw error;
      throw new StoreError(`写入失败：${abs}（${error && error.message ? error.message : error}）`, 'io', {
        path: abs,
        cause: error,
      });
    }
  }
}

function isInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  if (target === base) return true;
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8');
  throw new StoreError('writeArtifact 只接受 Buffer/Uint8Array/字符串', 'io');
}

function normalizeExt(ext) {
  const raw = String(ext == null ? '' : ext).trim().replace(/^\.+/, '').replace(/[^a-zA-Z0-9_-]/g, '');
  return raw ? `.${raw}` : '';
}
