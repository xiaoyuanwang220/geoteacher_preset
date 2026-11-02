// ModelCheck —— 宿主半边入口（薄装配层）
//
// 组装：
//   · server/static.js         /modelcheck/assets      桥接脚本等静态资源
//   · server/preview.js        /modelcheck/preview     项目内文件同源预览（入口 HTML 注入 bridge）
//                              /modelcheck/artifact    取证产物（截图/数据）
//   · server/api.js            /modelcheck/api         面板 JSON 接口
//   · server/tools.js          7 个 modelcheck_* 模型工具
//   · agent/turn-stopping      记录“本回合结束时仍未认证”（只记录，不宣称能阻止）
//
// 降级原则：任何一路注册失败只 console.error，不让整个 profile 挂载失败；
// 没有 webServer 时工具仍可用（配置/哈希类判据），没有面板时运行时判据返回 inconclusive。
//
// 只用 node: 内置模块与包内相对路径，不 import 宿主包。

import { join } from 'node:path';

import { findProjectRoot, loadProject } from './lib/project.js';
import { Store } from './lib/store.js';
import * as completionLib from './lib/completion.js';
import { nowIso } from './lib/util.js';
import { scanProject } from './lib/scaffold.js';
import { computeReadiness } from './lib/readiness.js';
import { EvidenceQueue } from './server/evidence-queue.js';
import { registerStatic } from './server/static.js';
import { registerPreview } from './server/preview.js';
import { completionInput, registerApi } from './server/api.js';
import { registerTools } from './server/tools.js';

const LOG_PREFIX = 'modelcheck:';
/** 会话 → 项目根 的短缓存：根目录在会话内不会频繁变化，避免每次面板轮询都从 cwd 向上找。 */
const ROOT_CACHE_TTL_MS = 5000;

function logError(where, error) {
  console.error(`${LOG_PREFIX} ${where}:`, error);
}

/**
 * 组装宿主门面：会话/Agent → 工作目录 → 项目根 → 项目快照。
 * 只通过可选服务读取，任何服务缺失都降级而不是抛错。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
function createHost(ctx) {
  const evidence = new EvidenceQueue({ log: (message) => console.warn(`${LOG_PREFIX} ${message}`) });
  /** @type {Map<string, {root: string|null, at: number}>} */
  const rootCache = new Map();

  const getService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * 会话显式选中的项目根。多模型工作区（会话 cwd 下有很多模型目录）里，单靠 cwd
   * 向上查找找不到 .modelcheck；面板/工具初始化后把选中项目根记在这里。
   * 进程内有效；目标被删除时自动失效并回退到 cwd 查找。
   */
  const projectSelections = new Map();

  function selectedRootForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    return projectSelections.get(sessionId) || null;
  }

  function setProjectForSession(sessionId, root) {
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (root === null || root === undefined) {
      projectSelections.delete(sessionId);
      return true;
    }
    if (typeof root !== 'string' || !root.trim()) return false;
    projectSelections.set(sessionId, root);
    if (projectSelections.size > 200) {
      const oldest = projectSelections.keys().next().value;
      if (oldest !== undefined) projectSelections.delete(oldest);
    }
    return true;
  }

  /** 选中根仍可载入才继续用；否则清掉选择并回退到 cwd 查找。 */
  async function loadSelectedProject(sessionId) {
    const root = selectedRootForSession(sessionId);
    if (!root) return null;
    try {
      const project = await loadProject(root);
      if (project && project.config) return project;
    } catch (error) {
      console.warn(`${LOG_PREFIX} 选中的项目根读取失败，回退到会话工作目录:`, String((error && error.message) || error));
    }
    projectSelections.delete(sessionId);
    return null;
  }

  /** 从 Agent 取有效工作目录：优先 workingDirectory，其次会话头。 */
  async function cwdForAgent(agent) {
    if (!agent || !agent.id) return undefined;
    const workingDirectory = getService('workingDirectory');
    if (workingDirectory && typeof workingDirectory.ensure === 'function') {
      try {
        const dir = await workingDirectory.ensure(agent);
        if (typeof dir === 'string' && dir) return dir;
      } catch (error) {
        logError('workingDirectory.ensure 失败', error);
      }
    }
    const sessions = getService('sessions');
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(agent.id) : undefined;
    const cwd = session && session.header ? session.header.cwd : undefined;
    return typeof cwd === 'string' && cwd ? cwd : undefined;
  }

  /** 从 sessionId 取有效工作目录：先看在线会话头，必要时 resolveAgent 再问 workingDirectory。 */
  async function cwdForSession(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return undefined;
    const sessions = getService('sessions');
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    const cwd = session && session.header ? session.header.cwd : undefined;
    if (typeof cwd === 'string' && cwd) return cwd;
    const sessionController = getService('sessionController');
    if (sessionController && typeof sessionController.resolveAgent === 'function') {
      try {
        const result = await sessionController.resolveAgent(sessionId);
        if (result && result.agent) return await cwdForAgent(result.agent);
      } catch (error) {
        // 未找到会话 / Agent 忙 / 持久化缺失都只是“没有项目”，不打断面板。
        console.warn(`${LOG_PREFIX} resolveAgent(${sessionId}) 未取得 Agent:`, String((error && error.message) || error));
      }
    }
    return undefined;
  }

  async function rootForCwd(cwd) {
    if (typeof cwd !== 'string' || !cwd) return null;
    try {
      return await findProjectRoot(cwd);
    } catch (error) {
      logError('findProjectRoot 失败', error);
      return null;
    }
  }

  async function rootForSession(sessionId) {
    const cached = rootCache.get(sessionId);
    if (cached && Date.now() - cached.at < ROOT_CACHE_TTL_MS) return cached.root;
    const root = await rootForCwd(await cwdForSession(sessionId));
    rootCache.set(sessionId, { root, at: Date.now() });
    if (rootCache.size > 200) {
      const oldest = rootCache.keys().next().value;
      if (oldest !== undefined) rootCache.delete(oldest);
    }
    return root;
  }

  async function projectForSession(sessionId) {
    const selected = await loadSelectedProject(sessionId);
    if (selected) return selected;
    const root = await rootForSession(sessionId);
    if (!root) return null;
    return loadProject(root);
  }

  async function projectForAgent(agent) {
    if (!agent || !agent.id) return null;
    const selected = await loadSelectedProject(agent.id);
    if (selected) return selected;
    const root = await rootForCwd(await cwdForAgent(agent));
    if (!root) return null;
    return loadProject(root);
  }

  return {
    ctx,
    evidence,
    cwdForAgent,
    cwdForSession,
    rootForSession,
    projectForSession,
    projectForAgent,
    selectedRootForSession,
    setProjectForSession,
    storeFor(root) {
      return new Store(root);
    },
    clearCaches() {
      rootCache.clear();
      projectSelections.clear();
    }
  };
}

/**
 * 监听 agent/turn-stopping：项目活跃且回合结束时未认证 → 先尽力把提醒插回下一步（steer），
 * 再在 reports/ 记一条记录。
 *
 * 依据 M0 能力矩阵（docs/modelcheck/M0-能力矩阵.md §1/§3.2）：宿主循环在 turn-stopping
 * 之后重新检查 next-step 队列，因此 `sessionController.prompt({mode:'steer'})` 能让回合继续；
 * 监听器返回值本身不能否决，抛异常只会让回合以 error 结束。
 * 承诺边界：同一 agent+turn 最多干预 STEER_LIMIT 次；用户主动停止（signal.aborted）时不续跑；
 * 不宣称能阻止用户停止、关闭会话或在新回合强行续跑。本函数绝不抛异常。
 */
const STEER_LIMIT = 2;
const STEER_MEMORY_MAX = 200;
const steerCounts = new Map();

function buildGateReminder(completion, readiness) {
  const blocking = Array.isArray(completion && completion.blocking) ? completion.blocking.slice(0, 3) : [];
  const lines = blocking.map((item) => `- ${item.id}（${item.status}）：${item.remedy || '见 modelcheck_status'}`);
  const body = lines.length > 0 ? lines.join('\n') : '（阻塞项明细见 modelcheck_status）';
  const readinessBlocks = readiness && Array.isArray(readiness.checks)
    ? readiness.checks.filter((check) => check.ok === false && check.severity === 'block').slice(0, 2)
    : [];
  const readinessLines = readinessBlocks.map((check) => `- ${check.detail}：${check.remedy || '见 modelcheck_status'}`);
  return [
    '【ModelCheck 完成门禁】本回合结束时，本项目仍未获得完成认证。',
    '未通过的阻塞项：',
    body,
    readinessLines.length > 0 ? '接入就绪阻塞（先修这些，再 verify）：\n' + readinessLines.join('\n') : '',
    '请继续修复，然后调用 modelcheck_verify；全部阻塞项通过后再调用 modelcheck_complete 申请认证。',
    '如果 verify 返回 blocked（面板未开/取证入口或钩子缺失），按提示修一次；不要重复空跑 verify。',
    '不要声称已经通过认证；模型自证不算验证结果。'
  ].filter(Boolean).join('\n');
}

function registerTurnStoppingHook(ctx, host, disposers) {
  if (typeof ctx.on !== 'function') return;
  const getService = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const dispose = ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload && payload.agent;
      if (!agent || !agent.id) return;
      if (payload.signal && payload.signal.aborted) return; // 用户已停止：不续跑
      const work = (async () => {
        const project = await host.projectForAgent(agent);
        if (!project) return; // 没有 .modelcheck：不干预，也不记录
        const evaluateCompletion = completionLib.evaluateCompletion;
        if (typeof evaluateCompletion !== 'function') return;
        const completion = evaluateCompletion(completionInput(project));
        if (completion && completion.certified) return;

        const contractConfirmed = Boolean(project.contract && project.contract.status === 'confirmed');
        let readiness = null;
        if (contractConfirmed) {
          try {
            const scan = await scanProject(project.root);
            readiness = await computeReadiness({
              root: project.root,
              config: project.config,
              components: project.components,
              contract: project.contract,
              scan
            });
          } catch (error) {
            logError('完成门禁 readiness 计算失败（已降级为不附加诊断）', error);
          }
        }
        let steered = false;
        if (contractConfirmed) {
          const controller = getService('sessionController');
          const turn = typeof payload.turn === 'number' ? payload.turn : 0;
          const key = `${agent.id}:${turn}`;
          const used = steerCounts.get(key) || 0;
          if (controller && typeof controller.prompt === 'function' && used < STEER_LIMIT) {
            steerCounts.set(key, used + 1);
            if (steerCounts.size > STEER_MEMORY_MAX) {
              const oldest = steerCounts.keys().next().value;
              if (oldest !== undefined) steerCounts.delete(oldest);
            }
            try {
              const abort = new AbortController();
              await controller.prompt({
                requestId: `mc-gate-${key}-${used + 1}`,
                sessionId: agent.id,
                mode: 'steer',
                content: [{ type: 'text', text: buildGateReminder(completion, readiness) }]
              }, abort.signal);
              steered = true;
            } catch (error) {
              logError('完成门禁提醒投递失败（已降级为仅记录）', error);
            }
          }
        }

        const store = host.storeFor(project.root);
        const at = nowIso();
        const fileName = `${at.replace(/[:.]/g, '-')}-uncertified-turn.json`;
        await store.writeJson(join(store.paths.reportsDir, fileName), {
          type: 'uncertified-turn',
          at,
          sessionId: agent.id,
          turn: typeof payload.turn === 'number' ? payload.turn : null,
          projectId: (project.config && project.config.projectId) || null,
          contractVersion: (project.contract && project.contract.contractVersion) || null,
          certified: false,
          steered,
          steerLimit: STEER_LIMIT,
          reasons: (completion && completion.reasons) || [],
          blocking: ((completion && completion.blocking) || []).slice(0, 10),
          note: steered
            ? '已通过 sessionController.prompt(mode:steer) 把未认证提醒插回下一步；返回值不能否决，同一回合有次数上限。'
            : '本条仅为记录；未注入提醒（未认证/无契约/已达干预上限/宿主无 sessionController）。'
        });
      })().catch((error) => logError('未认证回合记录失败（已忽略）', error));
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, 3000);
      });
      try {
        await Promise.race([work, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
    if (typeof dispose === 'function') disposers.push(dispose);
  } catch (error) {
    logError('agent/turn-stopping 监听注册失败（已降级，不影响其余能力）', error);
  }
}

export default {
  name: 'modelcheck',
  inject: ['webServer', 'tools'],
  apply(ctx) {
    const host = createHost(ctx);
    const disposers = [];

    function safely(label, register) {
      try {
        const dispose = register();
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        logError(`${label}注册失败（已降级，其余能力继续可用）`, error);
      }
    }

    function registerAll() {
      safely('静态资源路由 /modelcheck/assets', () => registerStatic(ctx));
      safely('预览路由 /modelcheck/preview 与 /modelcheck/artifact', () => registerPreview(ctx, host));
      safely('API 路由 /modelcheck/api', () => registerApi(ctx, host));
      safely('modelcheck_* 工具', () => registerTools(ctx, host));
      registerTurnStoppingHook(ctx, host, disposers);
      if (disposers.length === 0) {
        console.error(`${LOG_PREFIX} 没有任何路由或工具注册成功：插件降级为无操作。请检查宿主版本与 webServer/tools 服务。`);
      }
    }

    function cleanup() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose();
        } catch (error) {
          logError('反注册失败（已忽略）', error);
        }
      }
      host.evidence.dispose();
      host.clearCaches();
    }

    // 有 ctx.effect 就交给插件生命周期；否则手动收集 disposer（profile 卸载时随插件回收）。
    if (typeof ctx.effect === 'function') {
      try {
        ctx.effect(() => {
          registerAll();
          return cleanup;
        }, 'modelcheck: 路由、工具与事件');
        return;
      } catch (error) {
        logError('ctx.effect 注册失败，改为手动清理', error);
      }
    }
    registerAll();
    if (typeof ctx.on === 'function') {
      try {
        ctx.on('dispose', cleanup);
      } catch (error) {
        logError('dispose 事件监听注册失败（依赖 profile 卸载回收）', error);
      }
    }
  }
};
