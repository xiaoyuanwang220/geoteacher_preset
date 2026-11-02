// ModelCheck —— 接入就绪自检（readiness）
//
// 目的：初始化/验证前，把“现在缺哪几根线、每根怎么接”一次性说清，agent 不需要读插件源码。
// 只做只读检查，不修改任何文件。
//
// 检查项（block=不做就无法完成对应能力；warn=能继续但会降级）：
//   project       项目/路线/入口是否存在
//   hook          Three.js 路线是否暴露 window.__MC_PREVIEW__（含 THREE）
//   verifyEntry   是否区分“取证版入口”与“交付版入口”
//   buildOutputs  构建产物是否登记（决定 buildHash 能否绑定）
//   pickWiring    组件 pick 是否与源码里的场景对象名/userData.mcId 对上
//   contract      契约是否已确认
//   panel         运行时取证需要打开面板（静态提醒）
//
// 只用 node: 内置模块与包内相对路径。

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 60;
const SCENE_NAME_RE = /(?:\.name\s*=\s*["']|name\s*:\s*["']|userData\.mcId\s*=\s*["']|userData\.mcId\s*:\s*["'])([^"'\r\n]{2,80})["']/g;
// 场景对象名（真正能被 three pick 命中的）与配置里的中文名称要分开：
// 把 data.js 的 name:'赤道低压' 当 pick 建议会误导，因为它不是场景对象名。
const OBJECT_NAME_RE = /(?:\.name\s*=\s*["']|userData\.mcId\s*=\s*["'])([^"'\r\n]{2,80})["']/g;
const DATA_NAME_RE = /\bname\s*:\s*["']([^"'\r\n]{2,80})["']/g;
const HOOK_RE = /__MC_PREVIEW__/;
const THREE_RE = /WebGLRenderer|\bTHREE\s*\.|from\s+["']three["']/;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
async function readTextSafe(path, maxBytes = MAX_ENTRY_BYTES) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    const buffer = await readFile(path);
    return (buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer).toString('utf8');
  } catch {
    return null;
  }
}
async function readSourceTexts(root, sources) {
  const out = [];
  for (const rel of (Array.isArray(sources) ? sources : []).slice(0, MAX_SOURCE_FILES)) {
    const text = await readTextSafe(join(root, rel), MAX_ENTRY_BYTES);
    if (text) out.push({ rel, text });
  }
  return out;
}

/** 从源码里提取“场景对象名”（.name= / userData.mcId=），可用于 pick 接线判断。 */
export function extractObjectNames(sourceTexts) {
  return extractByRegex(sourceTexts, OBJECT_NAME_RE);
}
/** 从源码里提取配置/数据里的 name: 中文名称（仅作展示，不能当 pick 建议）。 */
export function extractDataNames(sourceTexts) {
  return extractByRegex(sourceTexts, DATA_NAME_RE);
}
function extractByRegex(sourceTexts, regex) {
  const names = new Set();
  for (const { text } of sourceTexts) {
    for (const match of text.matchAll(regex)) {
      const value = String(match[1] || '').trim();
      if (!value || value.length > 80) continue;
      names.add(value);
    }
  }
  return [...names].sort();
}

/** 兼容：返回对象名 + 数据名（用于展示），wiring 判断请用 extractObjectNames。 */
export function extractSceneNames(sourceTexts) {
  const names = new Set([...extractObjectNames(sourceTexts), ...extractDataNames(sourceTexts)]);
  return [...names].sort();
}

/** 找 __MC_PREVIEW__ 缺失时的建议插入位置（scene/camera/renderer 创建行）。 */
export function suggestHookLocation(sourceTexts) {
  let scene = null;
  let camera = null;
  let renderer = null;
  for (const { rel, text } of sourceTexts) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!scene && /new\s+THREE\.Scene\s*\(/.test(line)) scene = { file: rel, line: index + 1, text: line.trim() };
      if (!camera && /new\s+THREE\.(?:Perspective|Orthographic)Camera\s*\(/.test(line)) camera = { file: rel, line: index + 1, text: line.trim() };
      if (!renderer && /new\s+THREE\.WebGLRenderer\s*\(/.test(line)) renderer = { file: rel, line: index + 1, text: line.trim() };
    }
  }
  const anchor = camera || scene || renderer;
  return { scene, camera, renderer, anchor };
}

function hookSnippet(anchor) {
  const where = anchor ? `${anchor.file}:${anchor.line}` : '创建 scene/camera/renderer 之后';
  return {
    file: anchor ? anchor.file : null,
    line: anchor ? anchor.line : null,
    snippet: 'window.__MC_PREVIEW__ = { scene, camera, renderer, THREE };',
    note: `建议在 ${where} 之后加上述钩子（校验版构建）；交付版应剥离该钩子`
  };
}

/** 组件 pick 是否在源码里“接上线”。 */
function wiringOf(component, objectNames) {
  const pick = component && typeof component.pick === 'string' ? component.pick.trim() : '';
  const id = component && typeof component.id === 'string' ? component.id : '';
  const names = new Set(objectNames);
  // 源码里常见 group.name = 'mcbelt-' + id 的前缀拼接；objectNames 只能看到模板。
  const templates = objectNames
    .filter((name) => name.length >= 3 && /[.:_/-]$/.test(name))
    .sort((a, b) => b.length - a.length);
  let wired = false;
  let wiredBy = null;
  let matchedTemplate = null;
  if (pick && names.has(pick)) {
    wired = true;
    wiredBy = 'exact';
  } else if (id && names.has(id)) {
    wired = true;
    wiredBy = 'exact';
  } else if (pick) {
    matchedTemplate = templates.find((template) => pick.startsWith(template)) || null;
    if (matchedTemplate) {
      wired = true;
      wiredBy = 'prefix';
    }
  }
  let suggestedPick = null;
  if (!wired) {
    const label = String((component && component.label) || '').replace(/[（）()\s]/g, '');
    if (label) {
      // 只从“场景对象名”里找候选；不要把数据层的 name: 中文标签当建议。
      suggestedPick = objectNames.find((name) => name && !/[.:_/-]$/.test(name) && label.includes(name)) || null;
      if (!suggestedPick) {
        const keyword = label.slice(0, 2);
        suggestedPick = objectNames.find((name) => name && !/[.:_/-]$/.test(name) && name.includes(keyword)) || null;
      }
    }
  }
  return {
    id,
    label: component && component.label ? component.label : id,
    pick: pick || null,
    wired,
    wiredBy,
    matchedTemplate,
    suggestedPick,
    ...(wiredBy === 'prefix' ? { note: '源码用前缀拼接对象名；运行时可能命中，建议用面板点选确认一次' } : {})
  };
}

/**
 * 计算接入就绪清单（只读）。
 * @param {{root:string, config:object, components:object, contract:object|null, scan?:object}} input
 */
export async function computeReadiness(input) {
  const root = input && input.root;
  const config = (input && input.config) || {};
  const scan = (input && input.scan) || null;
  const components = input && input.components && Array.isArray(input.components.components) ? input.components.components : [];
  const contract = (input && input.contract) || null;
  const checks = [];

  if (!root) {
    return {
      ok: false,
      checks: [{ id: 'project', ok: false, severity: 'block', detail: '缺少项目根目录', remedy: '先初始化 .modelcheck' }],
      nextActions: ['初始化 .modelcheck'],
      wiring: { sceneNames: [], objectNames: [], dataNames: [], unwired: [] }
    };
  }

  const preview = config.preview || {};
  const previewEntry = preview.entry || null;
  const previewEntryText = previewEntry ? await readTextSafe(join(root, previewEntry)) : null;
  const entryIsVerifyBuild = Boolean(previewEntryText && HOOK_RE.test(previewEntryText));
  const scanDeliveryEntry = (scan && (scan.deliveryEntry || scan.previewEntry)) || null;
  const deliveryEntry = preview.deliveryEntry ||
    (entryIsVerifyBuild ? (scanDeliveryEntry || previewEntry) : (previewEntry || scanDeliveryEntry)) ||
    null;
  const implicitVerifyEntry = entryIsVerifyBuild && !preview.verifyEntry ? previewEntry : null;
  const configuredVerifyEntry = preview.verifyEntry || implicitVerifyEntry;
  const detectedVerifyEntry = (scan && scan.verifyEntry) || null;
  const verifyEntry = configuredVerifyEntry || detectedVerifyEntry || null;
  const route = config.route || (scan && scan.route) || null;
  const sources = Array.isArray(config.sources) ? config.sources : (scan && Array.isArray(scan.sources) ? scan.sources : []);
  const sourceTexts = await readSourceTexts(root, sources);
  const objectNames = extractObjectNames(sourceTexts);
  const dataNames = extractDataNames(sourceTexts);
  const sceneNames = [...new Set([...objectNames, ...dataNames])].sort();

  // 1) 项目与入口
  const deliveryExists = deliveryEntry ? await exists(join(root, deliveryEntry)) : false;
  checks.push(deliveryExists
    ? { id: 'project', ok: true, severity: 'info', detail: `${route || '未知路线'} / ${deliveryEntry}` }
    : {
      id: 'project',
      ok: false,
      severity: 'block',
      detail: deliveryEntry ? `交付入口不存在：${deliveryEntry}` : '未配置预览入口',
      remedy: '在 config.json 的 preview.entry（或 deliveryEntry）指向真实存在的 HTML'
    });

  // 2) 取证入口（交付版/校验版分离）
  const verifyExists = verifyEntry ? await exists(join(root, verifyEntry)) : false;
  if (implicitVerifyEntry && verifyExists) {
    checks.push({
      id: 'verifyEntry', ok: false, severity: 'warn',
      detail: `preview.entry 指向校验版（${implicitVerifyEntry}），交付入口按扫描推断为 ${deliveryEntry}`,
      remedy: `显式设置 preview.verifyEntry="${implicitVerifyEntry}" 与 preview.deliveryEntry="${deliveryEntry}"，避免交付时误带验证钩子`
    });
  } else if (preview.verifyEntry && verifyExists) {
    checks.push({ id: 'verifyEntry', ok: true, severity: 'info', detail: `取证入口 ${verifyEntry}（交付入口 ${deliveryEntry}）` });
  } else if (preview.verifyEntry && !verifyExists) {
    checks.push({
      id: 'verifyEntry', ok: false, severity: 'block',
      detail: `preview.verifyEntry 指向的文件不存在：${preview.verifyEntry}`,
      remedy: '修正 verifyEntry，或让构建生成校验版后再指向它'
    });
  } else if (detectedVerifyEntry && verifyExists) {
    // 文件存在但 config 没指向它：面板仍然会加载交付版，必须显式写进 config。
    checks.push({
      id: 'verifyEntry', ok: false, severity: 'block',
      detail: `检测到校验版入口 ${detectedVerifyEntry}，但 config.json 的 preview.verifyEntry 未设置`,
      remedy: `把 config.json 的 preview.verifyEntry 设为 "${detectedVerifyEntry}"，交付版继续用 preview.deliveryEntry`
    });
  } else if (route === 'three') {
    const deliveryText = deliveryEntry ? await readTextSafe(join(root, deliveryEntry)) : null;
    if (deliveryText && HOOK_RE.test(deliveryText)) {
      // 单入口项目：交付入口本身含钩子，取证可用；但交付时必须剥离，否则验证代码进成品。
      checks.push({
        id: 'verifyEntry', ok: false, severity: 'warn',
        detail: '未配置 preview.verifyEntry；交付入口本身含 __MC_PREVIEW__，取证可用，但交付版会带验证钩子',
        remedy: '构建两份：交付版剥离钩子（deliveryEntry），校验版含钩子（verifyEntry），并把 preview.verifyEntry 指向校验版'
      });
    } else {
      checks.push({
        id: 'verifyEntry', ok: false, severity: 'block',
        detail: '未配置 preview.verifyEntry：面板会把交付版当预览，若交付版剥离了钩子，运行时判据会一直 inconclusive',
        remedy: '让构建输出校验版（含 __MC_PREVIEW__），并把 config.json 的 preview.verifyEntry 指向它；交付版继续用 deliveryEntry'
      });
    }
  } else {
    checks.push({ id: 'verifyEntry', ok: true, severity: 'info', detail: '非 three 路线不需要单独校验版入口' });
  }

  // 3) 钩子（three）
  const hookEntry = verifyEntry && verifyExists ? verifyEntry : deliveryEntry;
  const hookText = hookEntry ? await readTextSafe(join(root, hookEntry)) : null;
  if (route === 'three') {
    if (hookText && HOOK_RE.test(hookText)) {
      checks.push({ id: 'hook', ok: true, severity: 'info', detail: `取证入口已包含 __MC_PREVIEW__（${hookEntry}）` });
    } else {
      const suggestion = suggestHookLocation(sourceTexts);
      checks.push({
        id: 'hook', ok: false, severity: 'block',
        detail: hookEntry ? `${hookEntry} 里没有 __MC_PREVIEW__` : '没有可检查的入口文件',
        remedy: '在模型源码里暴露 window.__MC_PREVIEW__ = { scene, camera, renderer, THREE } 并重建校验版',
        suggestion: hookSnippet(suggestion.anchor)
      });
    }
  } else {
    checks.push({ id: 'hook', ok: true, severity: 'info', detail: '非 three 路线不需要 __MC_PREVIEW__' });
  }

  // 4) 构建产物（buildHash 绑定）
  const outputs = Array.isArray(config.build && config.build.outputs) ? config.build.outputs : [];
  const existingOutputs = [];
  for (const rel of outputs) if (await exists(join(root, rel))) existingOutputs.push(rel);
  if (existingOutputs.length > 0) {
    checks.push({ id: 'buildOutputs', ok: true, severity: 'info', detail: `构建产物 ${existingOutputs.join('、')}` });
  } else {
    checks.push({
      id: 'buildOutputs', ok: false, severity: 'warn',
      detail: outputs.length ? `build.outputs 里的文件不存在：${outputs.join('、')}` : 'build.outputs 为空，构建哈希只能退化为 static',
      remedy: deliveryEntry ? `把成品文件登记进 build.outputs（例如 ["${deliveryEntry}"]）` : '先确定成品文件，再登记 build.outputs'
    });
  }

  // 5) pick 接线（点选能否映射到场景对象）
  const wiring = [];
  const skippedWiring = [];
  for (const component of components) {
    if (component && component.annotatable === false) continue;
    const pick = component && typeof component.pick === 'string' ? component.pick.trim() : '';
    // 点选只聚焦模型几何：three 路线的 DOM 选择器（#labels/#panel 等）不属于可点几何，直接跳过。
    if (pick.startsWith('#') && route !== 'svg' && route !== 'dom') {
      skippedWiring.push({ id: component.id, pick, reason: 'DOM 选择器在 three 路线不可点（文字/控件不点选）' });
      continue;
    }
    wiring.push(wiringOf(component, objectNames));
  }
  const unwired = wiring.filter((item) => item.wired === false);
  const prefixWired = wiring.filter((item) => item.wiredBy === 'prefix');
  const skippedNote = skippedWiring.length ? `；已跳过 ${skippedWiring.length} 个非几何选择器（DOM/文字/控件）` : '';
  if (components.length === 0) {
    checks.push({ id: 'pickWiring', ok: false, severity: 'warn', detail: '还没有登记组件，点选无法映射', remedy: '先 modelcheck_init 生成候选，或用 modelcheck_components 登记场景对象名' });
  } else if (unwired.length === 0) {
    checks.push({
      id: 'pickWiring', ok: true, severity: prefixWired.length ? 'warn' : 'info',
      detail: `${wiring.length} 个组件 pick 都能在源码里找到对应名称` +
        (prefixWired.length ? `（其中 ${prefixWired.length} 个按前缀模板匹配，未逐名验证）` : '') + skippedNote
    });
  } else {
    checks.push({
      id: 'pickWiring', ok: false, severity: 'warn',
      detail: `${unwired.length}/${wiring.length} 个组件的 pick 在源码里找不到（点选会命中但无法映射到组件）` +
        (prefixWired.length ? `；另有 ${prefixWired.length} 个按前缀模板匹配（未逐名验证）` : '') + skippedNote,
      remedy: '把 pick 改成源码里真实存在的对象名/userData.mcId；建议值见 wiring.unwired[].suggestedPick；只用于取证、不可点的参考点请标 annotatable:false',
      wiring: unwired.slice(0, 20),
      prefixWired: prefixWired.slice(0, 20),
      skipped: skippedWiring.slice(0, 20)
    });
  }

  // 6) 契约
  if (contract && contract.status === 'confirmed') {
    checks.push({ id: 'contract', ok: true, severity: 'info', detail: `契约 v${contract.contractVersion || '?'} 已确认` });
  } else if (contract && contract.status === 'proposed') {
    checks.push({ id: 'contract', ok: false, severity: 'warn', detail: '契约草稿待用户确认', remedy: '请用户在「建模判定」面板点击「确认契约」' });
  } else {
    checks.push({
      id: 'contract', ok: false, severity: 'warn', detail: '未建立契约',
      remedy: '依据项目《科学性文档》《开发文档》用 modelcheck_contract action=scaffold 起草，再由用户确认'
    });
  }

  // 7) 面板取证（运行时判据的硬前提，静态只能提醒）
  checks.push({
    id: 'panelEvidence', ok: null, severity: 'info',
    detail: '运行时判据需要面板「建模判定」→「标注」页签打开并停留在预览上；面板关闭时 verify 会返回 blocked'
  });

  const blocking = checks.filter((item) => item.severity === 'block' && item.ok === false);
  const warns = checks.filter((item) => item.severity === 'warn' && item.ok === false);
  const nextActions = checks
    .filter((item) => item.ok === false && typeof item.remedy === 'string')
    .sort((a, b) => (a.severity === 'block' ? 0 : 1) - (b.severity === 'block' ? 0 : 1))
    .map((item) => item.remedy);

  return {
    ok: blocking.length === 0,
    route,
    deliveryEntry,
    verifyEntry,
    checks,
    nextActions: [...new Set(nextActions)],
    wiring: { sceneNames, objectNames, dataNames, unwired, prefixWired, skipped: skippedWiring },
    summary: { block: blocking.length, warn: warns.length, total: checks.length }
  };
}
