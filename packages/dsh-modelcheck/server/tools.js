// ModelCheck —— 8 个模型可见工具（设计 §3.6）
//
// 统一输出：{ type:'object', additionalProperties:true }，render 把 JSON 文本交给模型。
// 所有工具在“没有 .modelcheck/”时返回 {status:'inactive'}，不报错、不干预会话
// （modelcheck_init 例外：它的职责就是在已有模型项目里生成 .modelcheck）。
// 所有工具都不接受、也不写“用户确认”字段：契约确认与标注验收只能由真实用户在面板点击。
//
// 只用 node: 内置模块与包内相对路径。

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { findProjectRoot, loadProject } from '../lib/project.js';
import {
  contractContentHash,
  criteriaOf,
  diffContracts,
  normalizeContract,
  validateContract
} from '../lib/contract.js';
import { normalizeRegistry, validateRegistry, componentFingerprints } from '../lib/registry.js';
import {
  applyScaffold,
  buildComponents,
  buildConfig,
  buildContractDraft,
  discoverCandidates,
  isProjectDir,
  scanProject,
  writeContractDraft
} from '../lib/scaffold.js';
import { computeReadiness } from '../lib/readiness.js';
// evaluate.js / completion.js 仍在与 core-lib 并行收尾：用命名空间导入，
// 缺少个别导出时降级为结构化错误，而不是让整个插件在 import 阶段挂掉。
import * as evaluateLib from '../lib/evaluate.js';
import * as completionLib from '../lib/completion.js';
import { budgetPhase, budgetSummary, recordRound } from '../lib/budget.js';
import {
  closeByCriteria,
  pendingRequests,
  triageRequest
} from '../lib/annotations.js';
import { nowIso } from '../lib/util.js';
import { ADAPTER_VERSION } from './evidence-queue.js';
import {
  completionInput,
  criterionRows,
  findRequest,
  pendingProposed,
  readProposed,
  roundsOf,
  summarizeRequest
} from './api.js';

const { certificationValid, evaluateCompletion, renderReportPage } = completionLib;

const INACTIVE = { status: 'inactive', reason: '未发现 .modelcheck 目录，插件不干预' };
const MAX_RENDER_CHARS = 24000;
const MAX_TEXT_LENGTH = 4000;
const ROUTES = ['three', 'svg', 'dom', 'image'];
const LEVELS = ['P0', 'P1', 'P2'];
const PHASES = ['science', 'dev', 'prototype', 'production', 'delivery'];

function renderJson(args, value) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = JSON.stringify({ status: 'error', error: { code: 'not-serializable', message: '工具结果无法序列化' } });
  }
  if (typeof text !== 'string') text = 'null';
  const capped = text.length > MAX_RENDER_CHARS
    ? text.slice(0, MAX_RENDER_CHARS) + `\n...[已截断，完整长度 ${text.length} 字符]`
    : text;
  return [{ type: 'text', text: capped }];
}

function clampInt(value, min, max, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function errorResult(code, message, remedy, extra) {
  return {
    status: 'error',
    error: {
      code,
      message,
      ...(extra && Array.isArray(extra.issues) ? { issues: extra.issues } : {})
    },
    remedy: remedy || '修正参数后重试；若持续失败，向用户报告具体错误，不要编造通过结果。'
  };
}

/**
 * 解析工具调用对应的项目。exec.agent 是唯一的目录来源（不信任模型传入的路径）。
 * @returns {Promise<{project?: object, store?: object, inactive?: true, reason?: string}>}
 */
async function resolveProject(host, exec) {
  const agent = exec && exec.agent ? exec.agent : null;
  if (!agent || !agent.id) return { inactive: true, reason: '无法确定会话身份' };
  // projectForAgent 会先看“本会话显式选中的项目根”（modelcheck_init 初始化后写入），
  // 再回退到 cwd 向上查找；多模型工作区必须走这条路径。
  const project = await host.projectForAgent(agent);
  if (!project) {
    const cwd = await host.cwdForAgent(agent);
    return { inactive: true, reason: cwd ? '未发现 .modelcheck 目录' : '无法确定会话工作目录' };
  }
  const store = host.storeFor(project.root);
  return { project, store };
}

/** 判据规则执行用的项目内文件读取器（只允许项目内相对路径，越界直接抛错）。 */
function projectFiles(rootDir) {
  const rootAbs = resolve(rootDir);
  const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
  function guard(rel) {
    if (typeof rel !== 'string' || !rel.trim()) throw new Error('文件路径为空');
    const normalized = rel.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      throw new Error('只允许项目内相对路径');
    }
    const abs = resolve(rootAbs, normalized);
    if (!abs.toLowerCase().startsWith(prefix.toLowerCase())) {
      throw new Error('路径越出项目根：' + rel);
    }
    return abs;
  }
  return {
    async read(rel) {
      return readFile(guard(rel), 'utf8');
    },
    async exists(rel) {
      try {
        await stat(guard(rel));
        return true;
      } catch {
        return false;
      }
    },
    async hash(rel) {
      const bytes = await readFile(guard(rel));
      return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
    }
  };
}

/** 需要运行时取证的组件描述（只从注册表取；未登记组件不猜测）。 */
function componentDescriptors(project, criteria) {
  const registry = project.components || { components: [] };
  const byId = new Map((registry.components || []).map((component) => [component.id, component]));
  const ids = new Set();
  for (const criterion of criteria) {
    if (typeof criterion.component === 'string' && criterion.component) ids.add(criterion.component);
    const rule = criterion.rule || {};
    for (const key of ['component', 'from', 'to']) {
      if (typeof rule[key] === 'string' && rule[key]) ids.add(rule[key]);
    }
    if (Array.isArray(rule.components)) {
      for (const id of rule.components) if (typeof id === 'string' && id) ids.add(id);
    }
  }
  const descriptors = [];
  for (const id of ids) {
    const component = byId.get(id);
    if (!component) continue;
    descriptors.push({
      id,
      label: component.label ?? id,
      route: component.route ?? null,
      pick: component.pick ?? null,
      observables: Array.isArray(component.observables) ? component.observables : [],
      related: Array.isArray(component.related) ? component.related : []
    });
  }
  return descriptors;
}

function remedyFor(criterionId, status, row) {
  if (status === 'fail') {
    return `按 measured/assertion 修正组件 ${row && row.component ? row.component : criterionId} 的几何/文案后重新 modelcheck_verify；不要放宽阈值。`;
  }
  if (status === 'inconclusive') {
    return '缺少充分证据：打开「建模判定」面板的预览页后重试；运行时超时或缺证据不是通过。';
  }
  if (status === 'stale') {
    return '依赖文件/契约/构建已变化：重新 modelcheck_verify 复验，旧证据不得复用。';
  }
  if (status === 'unverified') {
    return '该判据尚未执行：调用 modelcheck_verify（可指定 ids）。';
  }
  return null;
}

function nextContractVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!match) return '0.1.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

async function appendDraftCriterion(store, project, draft) {
  let raw = await store.readJson(store.paths.contractProposed, null);
  // 已确认契约的残留草稿不再当作草稿基底（否则会循环确认同一份内容）。
  if (raw && typeof raw === 'object' && project.contractHash) {
    try {
      if (contractContentHash(normalizeContract(raw)) === project.contractHash) raw = null;
    } catch {
      // 非法草稿保留原样，交给下面的 normalizeContract 报具体错误。
    }
  }
  const confirmed = project.contract ? criteriaOf(project.contract) : [];
  if (confirmed.some((criterion) => criterion.id === draft.id)) {
    return { reused: true, contentHash: project.contractHash ?? null, doc: null };
  }
  let doc;
  if (raw && typeof raw === 'object' && Array.isArray(raw.criteria)) {
    doc = raw;
  } else if (project.contract) {
    doc = {
      schemaVersion: 1,
      contractVersion: nextContractVersion(project.contract.contractVersion),
      status: 'proposed',
      source: Array.isArray(project.contract.source) ? project.contract.source : [],
      criteria: confirmed.map((criterion) => ({ ...criterion }))
    };
  } else {
    doc = { schemaVersion: 1, contractVersion: '0.1.0', status: 'proposed', source: [], criteria: [] };
  }
  const criteria = (Array.isArray(doc.criteria) ? doc.criteria : []).filter((criterion) => criterion.id !== draft.id);
  criteria.push(draft);
  const normalized = normalizeContract({ ...doc, status: 'proposed', criteria });
  const contentHash = contractContentHash(normalized);
  await store.writeJson(store.paths.contractProposed, { ...normalized, contentHash });
  return { reused: false, contentHash, doc: { ...normalized, contentHash } };
}

// ── 工具实现 ──────────────────────────────────────────────────────────

async function statusTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project } = resolved;
  const rows = criterionRows(project);
  const pending = pendingRequests(project.annotations);
  const completion = evaluateCompletion(completionInput(project));
  const budget = budgetSummary(project, roundsOf(project));
  const contract = project.contract;
  const certification = project.certification || null;
  const config = project.config || {};
  const certValid = certification
    ? certificationValid(certification, {
      contractVersion: contract && contract.contractVersion,
      buildHash: project.hashes && project.hashes.buildHash,
      sourceHash: project.hashes && project.hashes.sourceHash
    })
    : false;
  const blockingOpen = rows.filter((row) => row.blocking && row.status !== 'pass');
  return {
    status: 'ok',
    project: {
      projectId: config.projectId ?? null,
      title: config.title ?? null,
      route: config.route ?? null,
      root: project.root,
      previewEntry: (config.preview && config.preview.entry) || 'index.html'
    },
    contract: {
      version: contract ? contract.contractVersion : null,
      status: contract ? contract.status : 'missing',
      confirmed: Boolean(contract && contract.status === 'confirmed'),
      counts: {
        total: rows.length,
        pass: rows.filter((row) => row.status === 'pass').length,
        fail: rows.filter((row) => row.status === 'fail').length,
        inconclusive: rows.filter((row) => row.status === 'inconclusive').length,
        unverified: rows.filter((row) => row.status === 'unverified').length,
        stale: rows.filter((row) => row.status === 'stale').length
      }
    },
    blockingOpen: blockingOpen.map((row) => ({ id: row.id, status: row.status, remedy: remedyFor(row.id, row.status, row) })),
    annotations: {
      pending: pending.map(summarizeRequest)
    },
    budget,
    certification: certification
      ? { certified: certification.certified === true, valid: certValid, contractVersion: certification.contractVersion ?? null, buildHash: certification.buildHash ?? null, at: certification.certifiedAt ?? certification.at ?? null }
      : { certified: false, valid: false },
    completion: {
      certified: Boolean(completion.certified),
      reasons: Array.isArray(completion.reasons) ? completion.reasons : [],
      blocking: Array.isArray(completion.blocking) ? completion.blocking.slice(0, 10) : []
    },
    evidenceBuild: {
      buildHash: (project.hashes && project.hashes.buildHash) ?? null,
      sourceHash: (project.hashes && project.hashes.sourceHash) ?? null,
      adapterVersion: ADAPTER_VERSION
    },
    nextSteps: statusNextSteps(project, rows, completion, pending),
    note: '只读摘要。模型自证不算验证结果；完成认证只由 modelcheck_complete 依据证据签发。'
  };
}

function statusNextSteps(project, rows, completion, pending) {
  const steps = [];
  if (!project.contract) {
    steps.push('先调用 modelcheck_contract(action:"propose") 建立契约草稿，再请用户在面板确认。');
  } else if (project.contract.status !== 'confirmed') {
    steps.push('契约尚未确认：agent 不能确认，必须由用户在「建模判定」面板点击确认。');
  }
  const runtimeOpen = rows.filter((row) => row.requiredEvidence === 'runtime' && ['unverified', 'inconclusive', 'stale'].includes(row.status));
  if (runtimeOpen.length) steps.push(`有 ${runtimeOpen.length} 条运行时判据待取证：打开面板预览页后调用 modelcheck_verify。`);
  const blockingOpen = rows.filter((row) => row.blocking && row.status !== 'pass');
  if (project.contract && project.contract.status === 'confirmed' && blockingOpen.length) {
    steps.push(`阻塞判据未过 ${blockingOpen.length} 条：按 remedy 修复后重新 modelcheck_verify。`);
  }
  if (pending.length) steps.push(`有 ${pending.length} 条标注请求待处理：用 modelcheck_annotations 整理/关闭。`);
  if (completion && completion.certified) steps.push('已认证：可交付；交付版需剥离 .modelcheck 与验证入口。');
  return steps;
}

async function contractTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  const action = typeof args.action === 'string' ? args.action : 'read';

  if (action === 'read') {
    const proposed = pendingProposed(await readProposed(store), project);
    return {
      status: 'ok',
      contract: project.contract ?? null,
      contractHash: project.contractHash ?? null,
      proposed: proposed ? { contract: proposed.contract, contentHash: proposed.contentHash } : null,
      note: '只读。契约确认只能由用户在面板点击完成。'
    };
  }

  if (action === 'propose') {
    if (!args.contract || typeof args.contract !== 'object' || Array.isArray(args.contract)) {
      return errorResult('missing-contract', 'propose 需要 contract 对象参数', '传入 contract:{contractVersion, source, criteria:[...]} 后重试。');
    }
    const validation = validateContract(args.contract);
    if (!validation.ok || (Array.isArray(validation.errors) && validation.errors.length > 0)) {
      return {
        status: 'error',
        error: { code: 'invalid-contract', message: '契约校验未通过', issues: validation.errors || [] },
        remedy: '按 issues 修正契约字段（见设计 §2.4 契约形）后重试；不要为了通过校验而删除判据或放宽阈值。'
      };
    }
    let normalized;
    try {
      // agent 只能写草稿：无论传入什么，状态一律降为 proposed，确认字段一律删除。
      const draft = { ...args.contract, status: 'proposed' };
      delete draft.confirmedBy;
      delete draft.confirmedAt;
      delete draft.contentHash;
      normalized = normalizeContract(draft);
    } catch (error) {
      return errorResult('invalid-contract', `契约规范化失败：${String((error && error.message) || error)}`);
    }
    const contentHash = contractContentHash(normalized);
    await store.writeJson(store.paths.contractProposed, { ...normalized, contentHash });
    const diff = project.contract ? diffContracts(project.contract, normalized) : null;
    return {
      status: 'ok',
      written: 'contract.proposed.json',
      contractVersion: normalized.contractVersion,
      contentHash,
      diff,
      requiresUserConfirmation: true,
      note: '草稿已写入。契约尚未生效：必须由真实用户在「建模判定」面板确认；agent 不能确认，也不能通过“声明”绕过。'
    };
  }

  if (action === 'scaffold') {
    // 轻量 criteria 列表 → 契约草稿：适合"已有模型项目，但不想手写完整契约 JSON"的场景。
    if (!Array.isArray(args.criteria) || args.criteria.length === 0) {
      return errorResult('missing-criteria', 'scaffold 需要 criteria 数组',
        '传入 criteria:[{claim, rule:{kind,…}, level?, component?, depends?}]；判据内容仍只来自项目文档与用户标注。');
    }
    let scan = null;
    try {
      scan = await scanProject(project.root);
    } catch (error) {
      // 扫描失败不影响生成草稿；docs 由 agent 用 sourceDocs 显式提供。
    }
    let draft;
    try {
      draft = await buildContractDraft({
        contractVersion: typeof args.contractVersion === 'string' ? args.contractVersion : undefined,
        sourceDocs: Array.isArray(args.sourceDocs) ? args.sourceDocs : undefined,
        criteria: args.criteria
      }, scan);
    } catch (error) {
      return {
        status: 'error',
        error: {
          code: (error && error.code) || 'invalid-contract',
          message: String((error && error.message) || error),
          issues: Array.isArray(error && error.issues) ? error.issues : []
        },
        remedy: '按 error.issues 修正 criteria 后重试；不要为了通过而删除判据、放宽阈值或降低阻塞级别。'
      };
    }
    await writeContractDraft(store, draft);
    const diff = project.contract ? diffContracts(project.contract, draft) : null;
    return {
      status: 'ok',
      written: 'contract.proposed.json',
      contractVersion: draft.contractVersion,
      contentHash: draft.contentHash,
      criteriaCount: draft.criteria.length,
      diff,
      requiresUserConfirmation: true,
      note: '草稿已写入。契约尚未生效：必须由真实用户在「建模判定」面板确认；agent 不能确认。'
    };
  }

  if (action === 'confirm-info') {
    const proposed = pendingProposed(await readProposed(store), project);
    if (!proposed) {
      return { status: 'ok', hasProposal: false, note: '没有待确认的契约草稿。' };
    }
    return {
      status: 'ok',
      hasProposal: true,
      contractVersion: proposed.contract && proposed.contract.contractVersion,
      contentHash: proposed.contentHash,
      requiresUserConfirmation: true,
      note: '请用户在「建模判定」面板点击“确认契约”。agent 没有确认能力；不要要求用户口头确认代替面板操作。'
    };
  }

  return errorResult('unknown-action', `未知 action：${action}`, 'action 只能是 read / propose / scaffold / confirm-info。');
}

/**
 * modelcheck_init：在已有模型项目里生成 `.modelcheck/` 脚手架。
 * 多模型工作区（会话 cwd 下有多个模型目录）时先 scan 出候选，再按 relativeRoot 选择 apply。
 */
async function initTool(host, args, exec) {
  const sessionId = exec.agent && exec.agent.id;
  if (!sessionId) return errorResult('no-agent', '无法确定会话身份');
  const cwd = await host.cwdForAgent(exec.agent);
  if (typeof cwd !== 'string' || !cwd) {
    return errorResult('no-workdir', '无法确定会话工作目录', '在会话中打开项目目录后重试。');
  }
  const action = args.action === 'apply' ? 'apply' : 'scan';
  const base = args.path ? resolve(cwd, String(args.path)) : cwd;
  const rel = relative(cwd, base);
  if (rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) {
    return errorResult('outside-workdir', '目标路径必须位于会话工作目录内');
  }

  if (action === 'scan') {
    if (await isProjectDir(base)) {
      const scan = await scanProject(base);
      // 已初始化项目用磁盘真实状态；否则用脚手架候选评估。
      let readinessInput = { config: buildConfig(scan), components: buildComponents(scan), contract: null };
      if (scan.modelcheck && scan.modelcheck.state === 'ready') {
        try {
          const project = await loadProject(base);
          readinessInput = { config: project.config, components: project.components, contract: project.contract };
        } catch {
          // 读取失败时退回候选评估
        }
      }
      const readiness = await computeReadiness({
        root: base,
        ...readinessInput,
        scan
      });
      return {
        status: 'ok',
        mode: 'project',
        target: base,
        relativeRoot: rel.split(sep).join('/') || '.',
        projectId: scan.projectId,
        title: scan.title,
        route: scan.route,
        previewEntry: scan.previewEntry,
        deliveryEntry: scan.deliveryEntry || scan.previewEntry,
        verifyEntry: scan.verifyEntry || null,
        sources: scan.sources,
        buildOutputs: scan.buildOutputs,
        docs: scan.docs,
        components: scan.components,
        readiness,
        modelcheck: {
          state: scan.modelcheck.state,
          dirExists: scan.modelcheck.dirExists,
          empty: scan.modelcheck.empty,
          files: scan.modelcheck.files,
          missing: scan.modelcheck.missing,
          componentsCount: scan.modelcheck.componentsCount,
          contractStatus: scan.modelcheck.contractStatus,
          issues: scan.modelcheck.issues
        },
        warnings: scan.warnings,
        notes: scan.notes,
        nextAction: scan.modelcheck.state === 'ready'
          ? '项目已初始化；如需重新生成可加 force:true（会覆盖 config/components）'
          : '确认无误后调用 modelcheck_init action=apply（空目录/半成品会补齐，有效文件不覆盖）'
      };
    }
    const found = await discoverCandidates(base);
    return {
      status: 'ok',
      mode: 'workspace',
      target: base,
      candidates: found.candidates,
      scannedDirs: found.scannedDirs,
      note: found.candidates.length > 1
        ? '工作目录下有多个模型项目：调用 apply 时用 path 指定 relativeRoot（或让用户在面板选择）'
        : '调用 modelcheck_init action=apply 生成 .modelcheck/config.json 与 components.json'
    };
  }

  // apply：解析目标（工作区根 → 唯一候选 / 指定相对路径 / 报多候选）
  let targetDir = base;
  let chosen = null;
  if (!(await isProjectDir(targetDir))) {
    const found = await discoverCandidates(base);
    const list = found.candidates;
    if (args.path) {
      const wanted = String(args.path).replace(/\\/g, '/');
      chosen = list.find((item) => item.relativeRoot === wanted) || list.find((item) => item.root === base) || null;
      if (!chosen) {
        return errorResult('no-project-candidate', '指定路径下没有找到可初始化的模型项目',
          '从上次 scan 的 candidates 里选 relativeRoot；候选：' + list.map((item) => item.relativeRoot).join(', '));
      }
      targetDir = chosen.root;
    } else if (list.length === 1) {
      targetDir = list[0].root;
      chosen = list[0];
    } else if (list.length > 1) {
      return {
        status: 'needs-selection',
        target: base,
        candidates: list,
        note: '有多个候选项目：再次调用 modelcheck_init action=apply path=<relativeRoot>'
      };
    } else {
      return errorResult('no-project-candidate', '没有找到可初始化的模型项目',
        '目标目录需要 index.html / dist/index.html / src/index.html 或 package.json；也可以用 path 指定子目录。');
    }
  }

  const overrides = {};
  if (typeof args.projectId === 'string') overrides.projectId = args.projectId;
  if (typeof args.title === 'string') overrides.title = args.title;
  if (typeof args.route === 'string') overrides.route = args.route;
  if (typeof args.previewEntry === 'string') overrides.previewEntry = args.previewEntry;
  if (typeof args.unitToPx === 'number') overrides.unitToPx = args.unitToPx;

  let result;
  try {
    result = await applyScaffold(targetDir, { force: args.force === true, overrides });
  } catch (error) {
    return errorResult((error && error.code) || 'scaffold-failed', String((error && error.message) || error),
      '检查目标目录可写、且不是 Blender 路线；issues 见返回对象。', { issues: (error && error.issues) || [] });
  }
  host.setProjectForSession(sessionId, targetDir);
  let readinessInput = { config: result.config, components: result.components, contract: null };
  try {
    const project = await loadProject(targetDir);
    readinessInput = { config: project.config, components: project.components, contract: project.contract };
  } catch {
    // 刚写入的脚手架至少能用生成结果评估
  }
  const readiness = await computeReadiness({
    root: targetDir,
    ...readinessInput,
    scan: result.scan
  });
  return {
    status: 'ok',
    root: targetDir,
    relativeRoot: relative(cwd, targetDir).split(sep).join('/') || '.',
    selected: true,
    state: result.state,
    readiness,
    before: {
      state: result.before.state,
      empty: result.before.empty,
      files: result.before.files,
      missing: result.before.missing,
      issues: result.before.issues
    },
    after: {
      state: result.after.state,
      componentsCount: result.after.componentsCount,
      contractStatus: result.after.contractStatus
    },
    written: result.written,
    skipped: result.skipped,
    notes: result.notes,
    nextSteps: result.nextSteps,
    config: result.config,
    scanSummary: {
      route: result.scan.route,
      previewEntry: result.scan.previewEntry,
      deliveryEntry: result.scan.deliveryEntry || result.scan.previewEntry,
      verifyEntry: result.scan.verifyEntry || null,
      sources: result.scan.sources.length,
      buildOutputs: result.scan.buildOutputs,
      components: result.scan.components.length,
      docs: result.scan.docs,
      warnings: result.scan.warnings
    },
    note: '已把该项目绑定到当前会话；后续 modelcheck_* 工具会以它为项目根。'
  };
}

async function componentsTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  const registry = project.components || { schemaVersion: 1, components: [] };
  const action = typeof args.action === 'string' ? args.action : 'list';

  if (action === 'list') {
    const fingerprints = componentFingerprints(registry);
    return {
      status: 'ok',
      components: (registry.components || []).map((component) => ({ ...component, fingerprint: fingerprints[component.id] ?? null })),
      fingerprints,
      note: '组件指纹用于改后核对：修改共享配置/材质可能影响未声明组件。'
    };
  }

  if (action === 'upsert') {
    const incoming = Array.isArray(args.components) ? args.components : (args.components ? [args.components] : []);
    if (incoming.length === 0) {
      return errorResult('missing-components', 'upsert 需要 components 数组', '传入 [{id,label,route,pick,locator:{file},observables}] 后重试。');
    }
    const existing = new Map((registry.components || []).map((component) => [component.id, component]));
    const errors = [];
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push('组件项必须是对象');
        continue;
      }
      if (typeof raw.id !== 'string' || !raw.id.trim()) errors.push('组件缺少 id');
      if (typeof raw.label !== 'string' || !raw.label.trim()) errors.push(`组件 ${raw.id || '(未知)'} 缺少中文 label`);
      if (!ROUTES.includes(raw.route)) errors.push(`组件 ${raw.id || '(未知)'} 的 route 必须是 ${ROUTES.join('/')}`);
      if (typeof raw.pick !== 'string' || !raw.pick.trim()) errors.push(`组件 ${raw.id || '(未知)'} 缺少 pick（运行时点选钩子）`);
      if (!raw.locator || typeof raw.locator.file !== 'string' || !raw.locator.file.trim()) {
        errors.push(`组件 ${raw.id || '(未知)'} 缺少 locator.file`);
      }
      if (errors.length) continue;
      existing.set(raw.id, {
        ...existing.get(raw.id),
        ...raw,
        id: raw.id.trim(),
        label: raw.label.trim(),
        pick: raw.pick.trim(),
        observables: Array.isArray(raw.observables) ? raw.observables : [],
        related: Array.isArray(raw.related) ? raw.related : []
      });
    }
    if (errors.length) {
      return { status: 'error', error: { code: 'invalid-components', message: '组件校验未通过', issues: errors }, remedy: '按 issues 修正组件字段后重试。' };
    }
    const merged = { schemaVersion: 1, components: [...existing.values()] };
    const validation = validateRegistry(merged);
    if (!validation.ok || (Array.isArray(validation.errors) && validation.errors.length > 0)) {
      return {
        status: 'error',
        error: { code: 'invalid-registry', message: '组件表校验未通过（常见原因：id 重复或 pick 冲突）', issues: validation.errors || [] },
        remedy: '保证 id 与 pick 全局唯一；重命名/删除组件需保留迁移记录，不可静默复用 id。'
      };
    }
    let normalized;
    try {
      normalized = normalizeRegistry(merged);
    } catch (error) {
      return errorResult('invalid-registry', `组件表规范化失败：${String((error && error.message) || error)}`);
    }
    await store.writeJson(store.paths.components, normalized);
    return {
      status: 'ok',
      written: 'components.json',
      components: normalized.components,
      fingerprints: componentFingerprints(normalized)
    };
  }

  return errorResult('unknown-action', `未知 action：${action}`, 'action 只能是 list / upsert。');
}

async function verifyTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  if (!project.contract || criteriaOf(project.contract).length === 0) {
    return {
      status: 'inconclusive',
      reason: '契约不存在或为空：没有可执行判据',
      remedy: '先 modelcheck_contract(action:"propose") 建立契约，并由用户在面板确认后再验证。'
    };
  }
  const config = project.config || {};
  const timeoutMs = clampInt(args.timeoutMs, 1000, 60000,
    clampInt(config.preview && config.preview.timeoutMs, 1000, 60000, 8000));
  const sessionId = exec && exec.agent && exec.agent.id ? exec.agent.id : null;

  // —— 预检（P0）：先算接入就绪，避免面板/钩子/入口没接好时空等 20 秒 ——
  const scan = await scanProject(project.root);
  const readiness = await computeReadiness({
    root: project.root,
    config,
    components: project.components,
    contract: project.contract,
    scan
  });
  const criteria = criteriaOf(project.contract);
  const runtimeKinds = new Set(['closure', 'direction', 'svgEndpoint', 'bboxOverlap']);
  const needsRuntime = criteria.filter((criterion) => criterion && criterion.method === 'auto' &&
    (criterion.requiredEvidence === 'runtime' || (criterion.rule && runtimeKinds.has(criterion.rule.kind))));

  if (args.dryRun === true) {
    return {
      status: 'ok',
      dryRun: true,
      readiness,
      criteria: criteria.map((criterion) => ({
        id: criterion.id,
        level: criterion.level,
        blocking: criterion.blocking,
        method: criterion.method,
        requiredEvidence: criterion.requiredEvidence || (criterion.rule && criterion.rule.kind) || null,
        depends: Array.isArray(criterion.depends) ? criterion.depends : []
      })),
      runtimeCriteria: needsRuntime.map((criterion) => criterion.id),
      note: 'dryRun 只列证据要求，不执行判据、不写入证据；模型自证不算验证结果。'
    };
  }

  if (!project.contract || project.contract.status !== 'confirmed') {
    return {
      status: 'blocked',
      reason: '契约尚未确认',
      remedy: '请用户在「建模判定」面板确认契约草稿后再 verify；agent 不能代替确认。',
      readiness
    };
  }
  const blockers = readiness.checks.filter((check) => check.ok === false && check.severity === 'block' &&
    ['project', 'verifyEntry', 'hook'].includes(check.id));
  if (blockers.length > 0) {
    return {
      status: 'blocked',
      reason: blockers.map((check) => check.detail).join('；'),
      remedy: blockers.map((check) => check.remedy).filter(Boolean).join('；'),
      readiness
    };
  }
  if (needsRuntime.length > 0 && sessionId && !host.evidence.panelOnline(sessionId) && args.allowOffline !== true) {
    return {
      status: 'blocked',
      reason: '运行时判据需要面板取证，但当前会话没有面板在轮询证据',
      remedy: '打开「建模判定」面板 →「标注」页签，保持预览可见，然后重新 verify；面板关闭时这些判据只能 inconclusive。',
      readiness,
      runtimeCriteria: needsRuntime.map((criterion) => criterion.id)
    };
  }

  const stats = { requests: 0, responses: 0, timedOut: 0, staticContextAttested: 0 };
  const hashes = project.hashes || {};

  const ctxFactory = async (group, requiredContext) => {
    stats.requests += 1;
    if (!sessionId) {
      stats.timedOut += 1;
      return null;
    }
    const requested = requiredContext || (group[0] && group[0].context) || {};
    const response = await host.evidence.createRequest({
      sessionId,
      projectId: config.projectId ?? null,
      expected: { buildHash: hashes.buildHash ?? null, sourceHash: hashes.sourceHash ?? null },
      components: componentDescriptors(project, group),
      context: requested,
      props: { criteria: group.map((criterion) => ({ id: criterion.id, kind: (criterion.rule && criterion.rule.kind) || null })) },
      timeoutMs
    });
    if (response) {
      stats.responses += 1;
      // 静态单状态页（SVG/DOM/image，无状态机/动画）观测不到也控制不了 step/mode/view；
      // bridge 显式声明 static + unobservable 时，把请求的状态按“唯一静态状态”补进上下文，
      // 让 evaluate 的上下文充分性检查通过。动态页面（three）不享受该豁免，仍 fail-closed。
      const responseContext = response.context || {};
      const unobservable = Array.isArray(responseContext.unobservable) ? responseContext.unobservable : [];
      // 只有非 three 路线（静态单状态页）才允许这条豁免；three 有动画/相机状态，必须真正到达。
      const staticMergeAllowed = config.route !== 'three';
      if (staticMergeAllowed && responseContext.static === true && unobservable.length > 0) {
        const merged = { ...responseContext };
        let attested = false;
        for (const key of unobservable) {
          if (merged[key] === undefined && requested[key] !== undefined && requested[key] !== null) {
            merged[key] = requested[key];
            attested = true;
          }
        }
        if (attested) {
          stats.staticContextAttested += 1;
          return {
            ...response,
            context: merged,
            contextNote: '静态页：请求的运行状态不可观测，按唯一静态状态采信（未声称观察到状态切换）'
          };
        }
      }
      return response;
    }
    stats.timedOut += 1;
    return null;
  };
  // evaluate.js 会优先向取证通道要当前版本哈希；这里与请求里的 expected 保持一致。
  ctxFactory.getBuildHashes = async () => ({
    buildHash: hashes.buildHash ?? null,
    sourceHash: hashes.sourceHash ?? null
  });

  const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === 'string' && id) : undefined;
  if (typeof evaluateLib.evaluateCriteria !== 'function') {
    return errorResult('evaluate-unavailable', 'lib/evaluate.js 缺少 evaluateCriteria：无法执行判据',
      '把 evaluate.js 补进 lib/ 后重试；不要把未执行的判据当成通过。');
  }
  let evaluation;
  try {
    evaluation = await evaluateLib.evaluateCriteria(project, {
      ids: ids && ids.length ? ids : undefined,
      full: args.full === true,
      ctxFactory,
      store,
      files: projectFiles(project.root),
      logger: {
        info: (...parts) => console.log('modelcheck:', ...parts),
        warn: (...parts) => console.warn('modelcheck:', ...parts),
        error: (...parts) => console.error('modelcheck:', ...parts),
        debug: () => {}
      }
    });
  } catch (error) {
    return errorResult('evaluate-failed', `判据执行失败：${String((error && error.message) || error)}`,
      '检查契约与依赖文件是否齐全后重试；执行异常记为 inconclusive，不能当通过。');
  }
  const rows = criterionRows(project);
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const results = evaluation.results || {};
  const remedies = {};
  for (const [id, result] of Object.entries(results)) {
    if (result && result.status !== 'pass') remedies[id] = remedyFor(id, result.status, rowById.get(id));
  }
  const note = stats.requests > 0 && stats.responses === 0
    ? '未取得运行时取证（面板未打开/超时）：相关判据为 inconclusive，不是通过。请打开「建模判定」面板的预览页后重试。'
    : '结果来自契约判据与运行时证据；模型自证不算验证结果。';
  return {
    status: 'ok',
    evaluation,
    remedies,
    runtime: {
      requests: stats.requests,
      responses: stats.responses,
      timedOut: stats.timedOut,
      staticContextAttested: stats.staticContextAttested,
      timeoutMs,
      panelOnline: sessionId ? host.evidence.panelOnline(sessionId) : false,
      adapterVersion: ADAPTER_VERSION
    },
    note
  };
}

async function annotationsTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  const action = typeof args.action === 'string' ? args.action : 'list';
  const annotations = project.annotations || {};

  if (action === 'list') {
    const pending = pendingRequests(annotations);
    return {
      status: 'ok',
      pending: pending.map(summarizeRequest),
      requests: (Array.isArray(annotations.requests) ? annotations.requests : []).map(summarizeRequest),
      batches: Array.isArray(annotations.batches) ? annotations.batches : [],
      note: 'draft 不算待处理；已发送请求必须关闭或由用户撤回后才能通过完成门禁。'
    };
  }

  if (action === 'get') {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    if (!requestId) return errorResult('missing-request-id', 'get 需要 requestId');
    const request = findRequest(annotations, requestId);
    if (!request) return errorResult('unknown-request', `未找到标注请求：${requestId}`);
    const batch = (Array.isArray(annotations.batches) ? annotations.batches : []).find((item) => item.id === request.batchId) || null;
    return { status: 'ok', request: summarizeRequest(request), batch };
  }

  if (action === 'triage') {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    const claim = typeof args.claim === 'string' ? args.claim.trim() : '';
    if (!requestId) return errorResult('missing-request-id', 'triage 需要 requestId');
    if (!claim) return errorResult('missing-claim', 'triage 需要 claim（可判定的陈述句）', '把用户原话整理成一条可执行、可判定的 claim 后重试。');
    if (claim.length > MAX_TEXT_LENGTH) return errorResult('claim-too-long', `claim 超过 ${MAX_TEXT_LENGTH} 字`);
    const request = findRequest(annotations, requestId);
    if (!request) return errorResult('unknown-request', `未找到标注请求：${requestId}`);
    // 状态机要求先发送（sent）才能整理；提前校验，避免先写草稿再失败留下孤儿判据。
    if (!['sent', 'triaged'].includes(request.state)) {
      return errorResult('invalid-state',
        `请求 ${requestId} 当前状态为 ${request.state}，不能整理（需先由面板发送，状态为 sent/triaged）`,
        '等面板发送批次后再 triage；draft 状态不要整理。');
    }
    const level = LEVELS.includes(args.level) ? args.level : (LEVELS.includes(request.level) ? request.level : 'P1');
    // lib 的验收枚举是 auto/visual/manual；面板/文档里的 "user" 一律映射为 manual（人工验收）。
    let acceptance = null;
    if (args.acceptance === 'auto') acceptance = 'auto';
    else if (args.acceptance === 'visual') acceptance = 'visual';
    else if (args.acceptance === 'manual' || args.acceptance === 'user') acceptance = 'manual';
    const requestedIds = Array.isArray(args.criteriaIds)
      ? args.criteriaIds.filter((id) => typeof id === 'string' && id)
      : [];
    const warnings = [];
    let criteriaIds = requestedIds;
    let draftCriterion = null;
    let proposedHash = null;

    if (criteriaIds.length === 0) {
      // 标注文本无法可靠生成可执行规则：默认落一条人工验收的判据草案，
      // 自动验收需要的 rule 必须由 agent/用户在契约草稿里显式补充。
      const acceptanceKind = acceptance || 'manual';
      draftCriterion = {
        id: request.id,
        level,
        blocking: level !== 'P2',
        claim,
        method: acceptanceKind === 'auto' ? 'manual' : (acceptanceKind === 'visual' ? 'visual' : 'manual'),
        rule: null,
        component: request.componentId ?? null,
        depends: request.locator && request.locator.file ? [request.locator.file] : [],
        status: 'unverified',
        evidence: null,
        acceptance: acceptanceKind === 'auto' ? 'manual' : acceptanceKind,
        requiredEvidence: acceptanceKind === 'visual' ? 'visual' : 'user',
        source: { doc: '用户标注', section: request.id },
        context: {},
        requestId: request.id
      };
      const appended = await appendDraftCriterion(store, project, draftCriterion);
      proposedHash = appended.contentHash;
      criteriaIds = [draftCriterion.id];
      if (appended.reused) {
        draftCriterion = null;
        warnings.push('该请求 id 已存在于契约判据中，直接关联现有判据，未写新草稿。');
      } else if (acceptance === 'auto') {
        warnings.push('acceptance:auto 需要可执行 rule；本次草案是 method:manual，自动验收要等用户在契约草稿中补充 rule 后才成立。');
      }
    }

    let next;
    try {
      next = triageRequest(annotations, requestId, {
        claim,
        criteriaIds,
        acceptance: acceptance || undefined,
        allowedChanges: Array.isArray(args.allowedChanges) ? args.allowedChanges : undefined,
        level
      });
    } catch (error) {
      return errorResult('triage-failed', `整理请求失败：${String((error && error.message) || error)}`);
    }
    await store.writeJson(store.paths.annotations, next);
    return {
      status: 'ok',
      request: summarizeRequest(findRequest(next, requestId)),
      draftCriterion,
      proposedHash,
      criteriaIds,
      warnings,
      requiresUserConfirmation: true,
      note: '判据草案只写入 contract.proposed.json；用户确认前不进入完成门禁。agent 不能代替用户确认契约或验收。'
    };
  }

  if (action === 'close') {
    const requestId = typeof args.requestId === 'string' ? args.requestId : '';
    if (!requestId) return errorResult('missing-request-id', 'close 需要 requestId');
    const request = findRequest(annotations, requestId);
    if (!request) return errorResult('unknown-request', `未找到标注请求：${requestId}`);
    const ids = Array.isArray(request.criteriaIds) ? request.criteriaIds.filter(Boolean) : [];
    if (ids.length === 0) {
      return errorResult('no-criteria', '该请求未关联判据，不能自动关闭',
        '先用 triage 生成判据草案并由用户确认契约；用户也可以明确撤回（annotations/withdraw）。');
    }
    const rows = criterionRows(project);
    const statusById = Object.fromEntries(rows.map((row) => [row.id, row.status]));
    const criteriaStatus = {};
    for (const id of ids) criteriaStatus[id] = statusById[id] || 'unverified';
    let next;
    try {
      next = closeByCriteria(annotations, criteriaStatus);
    } catch (error) {
      return errorResult('close-failed', `关闭请求失败：${String((error && error.message) || error)}`);
    }
    await store.writeJson(store.paths.annotations, next);
    const updated = findRequest(next, requestId);
    const state = updated ? updated.state : null;
    let note;
    if (state === 'closed') note = '关联判据全部通过，请求已关闭。';
    else if (state === 'review') note = '关联判据全部通过，请求进入待验收（review）；再次调用 close 即可关闭（或由用户在面板人工验收）。';
    else note = '关联判据尚未全部通过：请求保持打开，修复后重新 verify 再 close。';
    return {
      status: 'ok',
      request: summarizeRequest(updated),
      criteriaStatus,
      note
    };
  }

  return errorResult('unknown-action', `未知 action：${action}`, 'action 只能是 list / get / triage / close。');
}

async function completeTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  const completionProject = completionInput(project);
  let completion;
  try {
    completion = evaluateCompletion(completionProject);
  } catch (error) {
    return errorResult('completion-failed', `完成门禁计算失败：${String((error && error.message) || error)}`);
  }
  if (typeof completionLib.applyCertification !== 'function') {
    return {
      ...errorResult('certification-unavailable',
        'lib/completion.js 缺少 applyCertification：无法签发认证（没有写 certification.json 的受支持入口）',
        '把 lib/completion.js 的 applyCertification 接口补上后重试；不要声称已认证。'),
      completion,
      report: renderReportPage(completion)
    };
  }
  let applied = completion;
  let report = renderReportPage(completion);
  // 无论是否通过都落 certification.json：
  //   · 通过 → certified:true，绑定契约版本 + 构建/源码哈希；
  //   · 未通过 → certified:false + invalidatedAt（作废旧认证），completion 已修成不会因此永久阻塞。
  try {
    applied = await completionLib.applyCertification(completionProject, { store });
    report = renderReportPage(applied);
  } catch (error) {
    return errorResult('certification-write-failed',
      `认证/报告写入失败：${String((error && error.message) || error)}`,
      '检查 .modelcheck/reports 与 artifacts 目录可写后重试；不要声称已完成认证。');
  }
  // applyCertification 只写 certification.json；一页式报告单独归档到 reports/<ISO>.json。
  let reportPath = null;
  try {
    const at = (applied && applied.at) || nowIso();
    const fileName = `${String(at).replace(/[:.]/g, '-')}-completion.json`;
    const record = {
      type: 'completion',
      at,
      certified: Boolean(applied.certified),
      contractVersion: applied.contractVersion ?? null,
      buildHash: applied.buildHash ?? null,
      sourceHash: applied.sourceHash ?? null,
      report: (applied && applied.report) || null,
      reportText: report
    };
    await store.writeJson(join(store.paths.reportsDir, fileName), record);
    reportPath = `reports/${fileName}`;
  } catch (error) {
    console.error('modelcheck: 报告归档失败（认证记录已写入）:', error);
  }
  return {
    status: applied.certified ? 'certified' : 'blocked',
    certified: Boolean(applied.certified),
    contractVersion: applied.contractVersion ?? null,
    buildHash: applied.buildHash ?? null,
    sourceHash: applied.sourceHash ?? null,
    reasons: Array.isArray(applied.reasons) ? applied.reasons : [],
    blocking: Array.isArray(applied.blocking) ? applied.blocking : [],
    report,
    reportPath,
    certificationPath: store.paths.certification,
    note: '认证绑定契约版本与当前产物哈希，之后任何修改都会使其失效。本插件未验证宿主级“阻止跳过”能力：这里只签发认证/未认证状态，不代表会话不能结束。'
  };
}

async function roundTool(host, args, exec) {
  const resolved = await resolveProject(host, exec);
  if (resolved.inactive) return { ...INACTIVE, reason: resolved.reason || INACTIVE.reason };
  const { project, store } = resolved;
  const phase = typeof args.phase === 'string' ? args.phase : '';
  if (!PHASES.includes(phase)) {
    return errorResult('invalid-phase', `phase 必须是 ${PHASES.join('/')}`, '按当前阶段传入 phase 后重试。');
  }
  const target = typeof args.target === 'string' ? args.target.trim() : '';
  if (!target) return errorResult('missing-target', '需要 target（本轮修改的目标）');
  const strategy = typeof args.strategy === 'string' ? args.strategy.trim() : '';
  const configBudget = (project.config && project.config.budget) || {};
  const maxRounds = configBudget.maxRounds && typeof configBudget.maxRounds === 'object'
    ? configBudget.maxRounds[phase]
    : configBudget.maxRounds;
  let recorded;
  try {
    recorded = recordRound(roundsOf(project), {
      phase,
      target,
      metricBefore: args.metricBefore ?? null,
      metricAfter: args.metricAfter ?? null,
      strategy: strategy || null,
      progressNote: typeof args.progressNote === 'string' ? args.progressNote : null,
      apiErrors: Array.isArray(args.apiErrors) ? args.apiErrors : [],
      maxRounds,
      maxMinutes: configBudget.maxMinutes ?? null
    });
  } catch (error) {
    return errorResult('record-failed', `轮次记录失败：${String((error && error.message) || error)}`);
  }
  const roundsDoc = {
    ...(project.rounds && !Array.isArray(project.rounds) ? project.rounds : {}),
    schemaVersion: 1,
    rounds: recorded.rounds
  };
  await store.writeJson(store.paths.rounds, roundsDoc);
  return {
    status: 'ok',
    verdict: recorded.verdict,
    budget: budgetSummary(project, recorded.rounds),
    phase: budgetPhase(project),
    note: 'verdict 来自轮次/空转/时间预算判定。返回 stop 时只停止插件自有动作；宿主任务是否停止未经验证，请如实报告。'
  };
}

// ── 注册 ──────────────────────────────────────────────────────────────

/**
 * 注册 7 个 modelcheck_* 工具。单个工具注册失败只记日志，不影响其余工具。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} host index.js 组装的宿主门面
 * @returns {() => void} 反注册 disposer
 */
export function registerTools(ctx, host) {
  const tools = ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    throw new Error('tools 服务不可用');
  }
  const disposers = [];
  function define(name, description, parameters, impl) {
    try {
      const dispose = tools.register({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: renderJson
        },
        async execute(args, exec) {
          try {
            // 不猜目录：没有会话内 Agent 就无法确定项目根（API 笔记 §a.3）。
            if (!exec || !exec.agent || !exec.agent.id) {
              return errorResult('no-agent', '这些工具必须在会话内由 Agent 调用：无法确定项目工作目录',
                '从会话中调用该工具；工具不接受任何路径参数。');
            }
            return await impl(host, args || {}, exec || {});
          } catch (error) {
            console.error(`modelcheck: 工具 ${name} 执行异常:`, error);
            return errorResult('tool-failed', `工具执行异常：${String((error && error.message) || error)}`);
          }
        }
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      console.error(`modelcheck: 工具 ${name} 注册失败（其余工具继续可用）:`, error);
    }
  }

  define(
    'modelcheck_status',
    '读取当前建模项目的 ModelCheck 摘要：契约版本与确认状态、判据按状态计数、阻塞项、待处理标注、轮次预算、完成认证状态与下一步建议。'
      + '开始建模前、每次修改后、或不确定下一步该做什么时调用。无 .modelcheck 目录时返回 {status:"inactive"}，表示插件不干预本项目。'
      + '本工具只读：不能替你确认契约、验收标注或作出通过声明；模型自证不算验证结果。',
    { type: 'object', properties: {}, additionalProperties: false },
    statusTool
  );

  define(
    'modelcheck_init',
    '在**已有模型项目**里生成 .modelcheck 脚手架（config.json + components.json），避免手工写 JSON。'
      + 'action:"scan" 扫描会话工作目录：如果 cwd 本身是模型项目就返回探测结果（预览入口、路线、源码、构建产物、组件候选）与 readiness 接入就绪清单；'
      + '否则列出子目录候选（支持一个工作区下多个模型）。action:"apply" 写入脚手架（默认不覆盖已有文件，force:true 才覆盖），'
      + '并把该项目绑定到当前会话，后续 modelcheck_* 工具以它为项目根。'
      + 'readiness.checks 里每条 ok:false 都带 remedy（文件:行或命令）：先按 block 项修，再处理 warn 项。'
      + '不会生成契约判据：判据必须来自项目科学性/开发文档，用 modelcheck_contract action=scaffold 起草、由用户在面板确认。'
      + 'Blender 路线（只有 .blend）不支持。接入细节见包内 README 与 docs/modelcheck/接入指南-给agent.md。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'apply'], description: 'scan 只读探测；apply 写入 .modelcheck（幂等，默认不覆盖）' },
        path: { type: 'string', description: '相对会话工作目录的子路径；多候选时用 scan 返回的 relativeRoot' },
        projectId: { type: 'string', description: '覆盖自动生成的项目 id（小写字母/数字/连字符）' },
        title: { type: 'string', description: '覆盖项目标题（中文）' },
        route: { type: 'string', enum: ['three', 'svg', 'dom', 'image'], description: '覆盖技术路线；默认按入口 HTML 探测' },
        previewEntry: { type: 'string', description: '覆盖预览入口（项目内相对路径，如 dist/index.html）' },
        unitToPx: { type: 'number', description: '像素→世界单位换算系数（world = px × unitToPx）；three 默认 1' },
        force: { type: 'boolean', description: 'true 时覆盖已有 config.json / components.json' }
      },
      required: ['action'],
      additionalProperties: false
    },
    initTool
  );

  define(
    'modelcheck_contract',
    '读取/提议建模验收契约（判据集合）。action:"read" 读取已确认契约与草稿；action:"propose" 把契约草案写入 contract.proposed.json，返回与现有契约的差异（added/removed/weakened）与 contentHash；action:"confirm-info" 返回待确认草稿的哈希与后续步骤。'
      + '契约必须由真实用户在「建模判定」面板点击确认后才生效：agent 不能确认，也不能在删除判据、放宽阈值、降低阻塞级别后自行生效。'
      + 'propose 校验失败时按 error.issues 修正字段重试；不要为了通过而削弱判据。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'propose', 'scaffold', 'confirm-info'], description: 'read 读取；propose 写完整契约草稿；scaffold 用轻量 criteria 列表生成草稿；confirm-info 取待确认哈希' },
        contract: { type: 'object', description: 'propose 时的契约草稿（contractVersion、source、criteria 等，见设计 §2.4）', additionalProperties: true },
        criteria: {
          type: 'array',
          description: 'scaffold 时的轻量判据列表：{claim, rule:{kind,…}, level?, component?, depends?, acceptance?}',
          items: { type: 'object', additionalProperties: true }
        },
        sourceDocs: { type: 'array', items: { type: 'string' }, description: 'scaffold 时的来源文档（相对项目根）' },
        contractVersion: { type: 'string', description: 'scaffold 时的契约版本，默认 0.1.0' }
      },
      additionalProperties: false
    },
    contractTool
  );

  define(
    'modelcheck_components',
    '维护组件注册表（判据、标注与冻结共用的身份底座）。action:"list" 列出组件及内容指纹；action:"upsert" 新增/更新组件，需 id、中文 label、route(three/svg/dom/image)、pick（Three.js 对象名/CSS 选择器/SVG id）、locator.file 与 observables。'
      + '建模开始时先登记组件；组件 id 必须唯一且不可静默复用，重命名/删除需保留迁移记录。pick 冲突或 locator.file 缺失会被拒绝，按 error.issues 修正后重试。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'upsert'], description: 'list 列出；upsert 新增或更新' },
        components: {
          type: 'array',
          description: 'upsert 时的组件数组',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string', description: '中文标签' },
              route: { type: 'string', enum: ['three', 'svg', 'dom', 'image'] },
              pick: { type: 'string', description: '点选钩子：Three.js 对象名 / CSS 选择器 / SVG id' },
              locator: { type: 'object', additionalProperties: true, description: '源码定位：{file, symbol?, line?}' },
              observables: { type: 'array', additionalProperties: true },
              related: { type: 'array', items: { type: 'string' } },
              sharedDependencies: { type: 'array', items: { type: 'string' } }
            },
            required: ['id', 'label', 'route', 'pick', 'locator'],
            additionalProperties: true
          }
        }
      },
      additionalProperties: false
    },
    componentsTool
  );

  define(
    'modelcheck_verify',
    '增量执行契约判据，返回每条判据的 status/measured/assertion/evidenceKind/remedy。修改代码后调用它复验；ids 指定判据，full:true 强制全量。'
      + '调用前会先做接入预检（契约已确认、取证入口、__MC_PREVIEW__ 钩子、面板是否在线）；不满足时返回 status:"blocked" 并给一条补救指令，不要重试空等。'
      + 'dryRun:true 只列每条判据需要的证据类型与来源，不执行、不写证据。'
      + '运行时几何判据需要打开「建模判定」面板的「标注」页签取证：面板未打开会返回 blocked（不是通过）——此时按 remedy 打开面板后重试，绝不能把 inconclusive/blocked 当作通过。'
      + '模型自己声称“已验证/已通过”不算结果；只有本工具基于运行时证据返回的 pass 才算。',
    {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: '只复验这些判据 id（省略则按增量策略执行）' },
        full: { type: 'boolean', description: 'true 时忽略证据复用，全量执行' },
        dryRun: { type: 'boolean', description: 'true 时只列证据要求与就绪清单，不执行判据、不写证据' },
        allowOffline: { type: 'boolean', description: '面板不可用时只执行配置类判据（运行时判据仍记 inconclusive）；不能用于认证，默认 false' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, description: '运行时取证超时毫秒数，默认 8000，可被 config.preview.timeoutMs 覆盖' }
      },
      additionalProperties: false
    },
    verifyTool
  );

  define(
    'modelcheck_annotations',
    '处理组件标注请求。action:"list" 列待处理请求；"get" 取详情；"triage" 为请求整理可判定 claim、级别与关联判据（生成契约草案，不改已确认契约，需用户确认）；"close" 在关联判据全部 pass 后关闭请求。'
      + '收到用户标注后先 list/get，再 triage 把用户原话整理成可判定的陈述句；不要替用户宣告验收通过——人工验收只能由用户在面板点击。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'triage', 'close'] },
        requestId: { type: 'string', description: '请求 id，如 USR-0001' },
        claim: { type: 'string', description: 'triage 时整理出的可判定陈述句' },
        criteriaIds: { type: 'array', items: { type: 'string' }, description: 'triage 时关联的判据 id（省略则生成一条草案判据）' },
        acceptance: { type: 'string', enum: ['auto', 'visual', 'manual'], description: '验收方式；auto 需要可执行 rule，否则会退化为人工验收' },
        level: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        allowedChanges: { type: 'array', items: { type: 'string' }, description: '允许变化的组件/属性范围' }
      },
      required: ['action'],
      additionalProperties: false
    },
    annotationsTool
  );

  define(
    'modelcheck_complete',
    '完成门禁：检查契约是否已确认、阻塞判据是否全部 pass、是否存在 stale/inconclusive/unverified、已发送标注是否都已关闭，然后签发完成认证并写一页式报告。'
      + '只有 agent 认为建模已完成时才调用；不达标时返回阻塞项与可执行补救指令，修复后重新 verify 再调用。'
      + '认证绑定契约版本与当前产物哈希，之后任何修改都会使其失效；本插件未验证宿主级“阻止跳过”能力，认证只表示当前产物满足契约，不代表会话不能结束。',
    { type: 'object', properties: {}, additionalProperties: false },
    completeTool
  );

  define(
    'modelcheck_round',
    '记录一次修改轮次并返回轮次预算判定（continue/remind/forbid-strategy/stop）与恢复梯子文案。每完成一次“针对同一目标的一批修改 + 一次有效复验”后调用；phase 为 science/dev/prototype/production/delivery。'
      + 'metricBefore/metricAfter 必须来自实测，不得编造；连续空转或超出时间预算时会得到禁止策略/停止建议。等待类动作不要调用（不计轮次）。'
      + '返回 stop 时只停止插件自有动作并如实报告宿主任务未确认停止。',
    {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['science', 'dev', 'prototype', 'production', 'delivery'] },
        target: { type: 'string', description: '本轮修改目标（同一目标连续无进展会被判空转）' },
        metricBefore: { description: '修改前实测指标（数字或对象）' },
        metricAfter: { description: '修改后实测指标（数字或对象）' },
        strategy: { type: 'string', description: '本轮采用的修复策略' },
        progressNote: { type: 'string', description: '进度标记；变化才算新进展' }
      },
      required: ['phase', 'target'],
      additionalProperties: false
    },
    roundTool
  );

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        console.error('modelcheck: 工具反注册失败（已忽略）:', error);
      }
    }
  };
}
