// 隔离解题会话的 preset 插件（内部预设 geo-solver-internal 唯一插件行）。
//
// 为什么需要它：agent preset 只决定「本 preset 注册哪些工具」，宿主/全局注册的工具
// （session_search、session_event_*、modelcheck_*、working_directory、load_workspace_dependencies
// 等）仍会被子 agent 继承。计划 §一.2 要求「解题会话只获取题面、提交作答」，所以这里在
// preset 作用域内做两件事：
//   1) restrict：把当前已知的继承工具全部隐藏（子会话的工具目录里不再出现）；
//   2) guard：注册在 preset 作用域（只作用于本 preset 下的 agent），任何漏网的工具调用一律拒绝。
// 同时提供解题 persona（唯一来源：skills/geo-solver.md 正文），替代静态 persona 配置。
//
// 时间差处理：本插件随 bundle 在 profile 启动早期加载，晚于此加载的宿主 bundle（session-search、
// modelcheck 等）注册的工具不在第一轮已知清单里。因此按短延时重试补 deny；guard 在第一次成功
// restrict 后注册，作为最终兜底。

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOLVER_SKILL_PATH = join(HERE, '..', '..', 'skills', 'geo-solver.md');
const RESERVED_TOOL_NAMES = new Set(['run_code']);

const FALLBACK_PERSONA = [
  '你是一个隔离的地理独立解题会话：只收到题组题面与题面图片，没有任何工具。',
  '按「设问拆解 → 定向读材料/读图 → 知识选择 → 推理链 → 作答与检查」独立完成题组内全部小问，',
  '每条结论都要有材料依据或图中信息；不得臆造题面之外的内容。',
  '最终回复只包含三段：## 答案、## 关键依据、## 推理过程。'
].join('\n');

function stripFrontmatter(text) {
  if (typeof text !== 'string') return '';
  const m = text.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return m ? text.slice(m[0].length) : text;
}

// 解题方法只维护一份（skills/geo-solver.md）；读取失败或含模板变量时用内置兜底并如实记录。
export function readSolverPersona(skillPath) {
  const target = skillPath || SOLVER_SKILL_PATH;
  try {
    const raw = readFileSync(target, 'utf8');
    const body = stripFrontmatter(raw).trim();
    if (body.length < 200) throw new Error('解题技能正文过短');
    if (/\{\{[^}]*\}\}/.test(body)) throw new Error('解题技能正文含模板变量 {{…}}，persona 渲染会失败');
    return { text: body, source: 'skill' };
  } catch (e) {
    console.error('geo-solver-isolation: 读取解题 persona 失败，使用内置兜底：', (e && e.message) || e);
    return { text: FALLBACK_PERSONA, source: 'fallback' };
  }
}

export default {
  name: 'geo-solver-isolation',
  inject: ['tools', 'systemPrompt'],
  apply(ctx) {
    const tools = ctx.tools || (ctx.get && ctx.get('tools'));
    const systemPrompt = ctx.systemPrompt || (ctx.get && ctx.get('systemPrompt'));
    // 真实运行由 inject 保证两个服务都在；mock/非预设环境直接跳过，不产生噪音日志。
    if (!tools || !systemPrompt) {
      return;
    }

    // 1) persona：与 dsh-persona 的 prefix 同一落点（同名 section、同一 order）。
    const persona = readSolverPersona();
    if (typeof systemPrompt.section === 'function' && typeof systemPrompt.getSectionOrder === 'function') {
      ctx.effect(() => systemPrompt.section({
        name: 'deployment:persona-prefix',
        order: systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: persona.text
      }));
    } else {
      console.error('geo-solver-isolation: systemPrompt 缺少 section API，隔离解题会话将没有解题 persona');
    }
    if (persona.source === 'fallback') {
      console.error('geo-solver-isolation: 解题 persona 使用内置兜底（skills/geo-solver.md 未读到）');
    }

    // 2) 工具锁死：restrict 隐藏 + guard 执行期兜底。二者都注册在 preset 作用域，
    //    只作用于挂在 geo-solver-internal 下的 agent（即隔离解题子会话）。
    let scopedRestrictionAvailable = false;
    let lockFailed = false;
    const denied = new Set();
    function denyVisibleTools(label) {
      let names = [];
      try {
        const schemas = typeof tools.schemas === 'function' ? tools.schemas() : [];
        names = (Array.isArray(schemas) ? schemas : [])
          .map((schema) => schema && schema.name)
          .filter((name) => typeof name === 'string' && name && !RESERVED_TOOL_NAMES.has(name) && !denied.has(name));
      } catch (e) {
        lockFailed = true;
        console.error('geo-solver-isolation: 读取工具清单失败：', (e && e.message) || e);
        return;
      }
      if (names.length === 0) return;
      try {
        ctx.effect(() => tools.restrict({ deny: names }));
        for (const name of names) denied.add(name);
        scopedRestrictionAvailable = true;
        console.log(`geo-solver-isolation: 已隐藏 ${names.length} 个继承工具（${label}）：${names.join('、')}`);
      } catch (e) {
        lockFailed = true;
        console.error('geo-solver-isolation: 工具限制失败（隔离解题会话可能继承全局工具）：', (e && e.message) || e);
      }
    }

    denyVisibleTools('启动时');

    // 启动时已有继承工具却限制失败 → 让 preset 直接挂载失败，geo_solve 会报
    // SOLVER_ISOLATION_UNAVAILABLE（fail-closed），绝不带着可见工具运行隔离解题。
    if (lockFailed) {
      throw new Error('无法在 preset 作用域限制继承工具，隔离解题会话不可用');
    }

    // 3) 兜底 guard：只在 restrict 成功（证明本 ctx 是 scoped preset 作用域）后注册，
    //    否则在全局层注册会阻断所有 agent 的工具调用。
    if (scopedRestrictionAvailable) {
      try {
        ctx.effect(() => tools.guard(() => '隔离解题会话不开放工具：只依据题面与图片作答，或直接提交作答。'));
      } catch (e) {
        console.error('geo-solver-isolation: 工具兜底拒绝注册失败：', (e && e.message) || e);
      }
    }

    // 4) 晚注册的宿主工具（session-search / modelcheck 等）在启动后才出现：短延时补 deny。
    //    deny 按名字生效，后续新增的名字不会自动被已有 restriction 覆盖，所以再扫一次。
    //    注意：不能在未 inject 的情况下访问 `ctx.timer`（Cordis 会抛
    //    `cannot get property "timer" without inject` 并打挂 preset），这里只用全局定时器。
    if (typeof setTimeout === 'function') {
      const t1 = setTimeout(() => denyVisibleTools('延时复查'), 4000);
      const t2 = setTimeout(() => denyVisibleTools('延时复查'), 15000);
      if (t1 && typeof t1.unref === 'function') t1.unref();
      if (t2 && typeof t2.unref === 'function') t2.unref();
      ctx.effect(() => () => { clearTimeout(t1); clearTimeout(t2); });
    }
  }
};
