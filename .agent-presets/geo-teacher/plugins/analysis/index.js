// GeoTeacher Agent — 真题分析功能插件（geo-analysis）
// 路由：/geo/analysis/run?qid=、/geo/analysis/export?qid=
// 模型工具：geo_analyze、geo_solve、geo_judge、geo_explain、geo_export_analysis
// 消费 geoKernel 服务。
// 讲题契约（docs/讲题优化计划.md、docs/讲题功能设计.md）：
//   解题由隔离会话完成：bundle 声明内部 agent preset（geo-solver-internal，唯一插件
//   plugins/solver-isolation：提供解题 persona 并隐藏/拒绝全部继承工具），analysis 用
//   subagents(provider=spawn) 创建全新上下文的子 agent 独立作答，作答回传后由服务端保存；
//   参考答案在作答提交后才开放，核验结论再次调用归档；讲稿只读服务端核验记录。
// 注意：不 import 宿主包（C: 用户根无 node_modules，裸 import 会失败），工具定义直接构造对象。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function parseQuery(url) {
  const q = url.indexOf('?');
  const out = {};
  if (q >= 0) {
    for (const pair of url.slice(q + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) out[decodeURIComponent(pair)] = '';
      else out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

function renderJson(args, value) {
  const text = JSON.stringify(value, null, 2);
  const capped = text.length > 16000 ? text.slice(0, 16000) + '\n...[截断，总长 ' + text.length + ']' : text;
  return [{ type: 'text', text: capped }];
}

function formatTime(value) {
  if (!value) return '—';
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) return String(value);
  try {
    return new Date(n).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  } catch (e) {
    return String(value);
  }
}

// ========== 讲题对象（audience） ==========
// 插件之间不能相对 import（baseUrl 是 profile 目录），故枚举与 core/index.js 的
// EXPLAIN_AUDIENCES 各自声明，改动时必须同步。
export const EXPLAIN_AUDIENCES = ['student', 'teacher', 'setter'];
export const AUDIENCE_LABELS = { student: '学生', teacher: '教师', setter: '命题人' };

// 非法枚举返回明确输入错误；省略/空串按 student（旧调用兼容）。
export function normalizeAudience(value) {
  if (value === undefined || value === null) return { ok: true, audience: 'student', explicit: false };
  const raw = String(value).trim();
  if (raw === '') return { ok: true, audience: 'student', explicit: false };
  if (EXPLAIN_AUDIENCES.includes(raw)) return { ok: true, audience: raw, explicit: true };
  return {
    ok: false,
    audience: null,
    explicit: true,
    message: `非法输入：audience="${raw}"。合法值为 student | teacher | setter（可省略，缺省按 student 学生对象）。`
  };
}

const IMAGE_MEDIA_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

export function sniffImageMediaType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function safeImageName(ref, mediaType) {
  const raw = String((ref && (ref.caption || ref.imageId)) || 'question-image')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96) || 'question-image';
  const ext = IMAGE_MEDIA_TYPES[mediaType] || '';
  return raw.toLowerCase().endsWith(ext) ? raw : raw + ext;
}

function safeImageError(error) {
  const code = String((error && error.code) || 'IMAGE_DELIVERY_FAILED');
  const message = String((error && error.message) || error || '图片载入失败')
    .replace(/[A-Za-z]:[\\/][^\s，。；：)）]+/g, '<path>')
    .slice(0, 300);
  return { code, message };
}

export async function deliverNativeImages(ctx, refsResult, signal) {
  const refs = refsResult && Array.isArray(refsResult.images) ? refsResult.images : [];
  if (!refsResult || refsResult.status !== 'success') {
    return {
      status: 'degraded',
      hasImages: false,
      expected: 0,
      delivered: 0,
      images: [],
      failed: [{ imageId: '', caption: '', code: 'IMAGE_REFS_FAILED', message: (refsResult && refsResult.message) || '题面图片引用解析失败' }]
    };
  }
  if (!refsResult.hasImages || refs.length === 0) {
    return { status: 'none', hasImages: false, expected: 0, delivered: 0, images: [], failed: [] };
  }

  const fsService = ctx.fs;
  const attachments = ctx.attachments;
  const limits = (attachments && attachments.imageLimits) || {};
  const maxImages = Number.isInteger(limits.maxImagesPerMessage) && limits.maxImagesPerMessage > 0
    ? limits.maxImagesPerMessage : refs.length;
  const maxImageBytes = Number.isInteger(limits.maxImageBytes) && limits.maxImageBytes > 0
    ? limits.maxImageBytes : 20 * 1024 * 1024;
  const maxMessageBytes = Number.isInteger(limits.maxMessageImageBytes) && limits.maxMessageImageBytes > 0
    ? limits.maxMessageImageBytes : Number.MAX_SAFE_INTEGER;
  const images = [];
  const failed = [];
  let accumulatedBytes = 0;

  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    if (index >= maxImages) {
      failed.push({ imageId: ref.imageId, caption: ref.caption || '', code: 'IMAGE_COUNT_LIMIT', message: `图片数量超过当前附件上限 ${maxImages}` });
      continue;
    }
    const remainingBytes = maxMessageBytes - accumulatedBytes;
    if (remainingBytes <= 0) {
      failed.push({ imageId: ref.imageId, caption: ref.caption || '', code: 'IMAGE_MESSAGE_BYTES_LIMIT', message: '图片累计大小超过当前附件上限' });
      continue;
    }
    try {
      if (!ref.sourcePath) throw Object.assign(new Error('题面图片缺少磁盘路径'), { code: 'IMAGE_PATH_MISSING' });
      const target = await fsService.resolve(ref.sourcePath);
      const bytes = await fsService.readBytes(target, signal || null, Math.min(maxImageBytes, remainingBytes));
      if (!bytes || bytes.length === 0) throw Object.assign(new Error('图片文件为空'), { code: 'EMPTY_IMAGE' });
      const mediaType = sniffImageMediaType(bytes);
      if (!mediaType) throw Object.assign(new Error('不支持或无法识别的图片格式'), { code: 'UNSUPPORTED_IMAGE_FORMAT' });
      const attachment = await attachments.saveImage({ data: bytes, mediaType, name: safeImageName(ref, mediaType) });
      accumulatedBytes += bytes.length;
      images.push({ imageId: ref.imageId, caption: ref.caption || '', attachment });
    } catch (error) {
      const safe = safeImageError(error);
      failed.push({ imageId: ref.imageId, caption: ref.caption || '', code: safe.code, message: safe.message });
    }
  }

  return {
    status: failed.length === 0 ? 'complete' : images.length > 0 ? 'partial' : 'degraded',
    hasImages: true,
    expected: refs.length,
    delivered: images.length,
    images,
    failed
  };
}

// ========== 隔离解题：内部 agent preset（bundle 声明，插件提供 persona 与工具锁） ==========
// 该 preset 在 cordis.patch.yml 中声明（id 固定），唯一插件行是 plugins/solver-isolation：
//   提供解题 persona（读取 skills/geo-solver.md 正文）+ 隐藏并拒绝一切继承工具。
// 这里只负责校验它可用；不可用即 fail-closed，不回落主会话解题。
export const INTERNAL_SOLVER_PRESET_ID = 'geo-solver-internal';

async function ensureInternalPreset(ctx) {
  const presets = ctx.get && ctx.get('agentPresets');
  if (!presets) return { ok: false, error: '缺少 agentPresets 服务' };
  let info = null;
  try {
    info = await presets.resolve(INTERNAL_SOLVER_PRESET_ID);
  } catch (e) {
    return { ok: false, error: '内部解题预设未声明或不可用：' + ((e && e.message) || String(e)) };
  }
  if (!info) return { ok: false, error: '内部解题预设未声明' };
  if (info.broken) return { ok: false, error: '内部解题预设挂载失败：' + info.broken };
  return { ok: true, presetId: INTERNAL_SOLVER_PRESET_ID };
}

// ========== 隔离解题会话的题面消息（只含材料/题干/选项/小问/图片） ==========
export function buildSolvePrompt(prepared) {
  const p = prepared || {};
  const lines = [];
  lines.push('【题面】');
  const material = String(p.material || '').trim();
  lines.push(material || '（本组无文字材料，题干与选项见下）');
  lines.push('');
  lines.push('【小问】');
  const questions = Array.isArray(p.questions) ? p.questions : [];
  questions.forEach((q, idx) => {
    lines.push(`第${idx + 1}题`);
    lines.push(String((q && q.stem) || '').trim());
    for (const opt of (q && q.options) || []) lines.push('- ' + opt);
    lines.push('');
  });
  const images = Array.isArray(p.questionImages) ? p.questionImages : [];
  if (images.length) {
    lines.push(`【题面图片】共 ${images.length} 张，按顺序附在本消息末尾。图注：`);
    images.forEach((img, i) => lines.push(`${i + 1}. ${(img && img.caption) || '无图注'}`));
    lines.push('');
  }
  lines.push('【要求】');
  lines.push('- 只依据以上题面与图片独立作答；不得调用任何工具，不得假设能看到题面之外的材料。');
  lines.push('- 图片模糊或信息不足时，在作答中明确标为“证据不足”，不得猜测。');
  lines.push('- 你的最终回复就是提交的作答，必须严格包含以下三段标题，不写寒暄：');
  lines.push('## 答案');
  lines.push('## 关键依据');
  lines.push('## 推理过程');
  return lines.join('\n');
}

export function extractSection(text, title) {
  const src = String(text || '');
  const re = new RegExp('(?:^|\\n)##\\s*' + title + '\\s*(?:\\n|$)([\\s\\S]*?)(?=\\n##\\s|$)');
  const m = src.match(re);
  return m ? m[1].trim() : '';
}

function textOfBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('\n')
    .trim();
}

function isolationProblem(ctx, exec) {
  if (!exec || !exec.agent) return '缺少调用方 Agent（exec.agent），无法创建隔离解题会话';
  const subagents = ctx.get && ctx.get('subagents');
  if (!subagents) return '宿主缺少 subagents 服务，无法创建隔离解题会话';
  if (typeof subagents.getProvider !== 'function' || !subagents.getProvider('spawn')) return '宿主缺少 spawn 解题提供方（subagent-spawn-in-process）';
  const presets = ctx.get && ctx.get('agentPresets');
  if (!presets) return '宿主缺少 agentPresets 服务，无法解析隔离解题预设';
  return '';
}

// 在全新上下文执行独立解题：题面 + 图片 → 子会话 → 作答回传 → 服务端保存。
async function runIsolatedSolve(ctx, exec, qid, options) {
  const kernel = ctx.geoKernel;
  const solveOptions = options && typeof options === 'object' ? options : {};
  const prepared = await kernel.prepareSolve(qid, { fresh: solveOptions.fresh === true });
  if (prepared.status !== 'success') return prepared;
  if (prepared.reused && prepared.answer) {
    return {
      status: 'success',
      questionId: prepared.questionId,
      runId: prepared.runId,
      state: prepared.state,
      reused: true,
      submittedAt: prepared.answer.submittedAt,
      independentAnswer: prepared.answer.answerText,
      keyEvidence: prepared.answer.keyEvidence,
      questionCount: (prepared.questions || []).length,
      imageCount: (prepared.questionImages || []).length,
      imageStatus: 'reused',
      answerHash: prepared.answer.answerHash
    };
  }
  const problem = isolationProblem(ctx, exec);
  if (problem) {
    return { status: 'error', code: 'SOLVER_ISOLATION_UNAVAILABLE', questionId: qid, message: problem + '；为保持答案隔离，本次不回落主会话解题。' };
  }
  const preset = await ensureInternalPreset(ctx);
  if (!preset.ok) {
    return { status: 'error', code: 'SOLVER_ISOLATION_UNAVAILABLE', questionId: qid, message: '隔离解题预设不可用：' + preset.error + '；本次不回落主会话解题。' };
  }
  const refsResult = {
    status: 'success',
    questionId: prepared.questionId,
    hasImages: (prepared.questionImages || []).length > 0,
    images: prepared.questionImages || []
  };
  const imageDelivery = await deliverNativeImages(ctx, refsResult, exec && exec.signal);
  if (imageDelivery.status === 'partial' || imageDelivery.status === 'degraded') {
    const failures = (imageDelivery.failed || []).map((f) => `${f.imageId || '未知图片'}：${f.message || f.code}`).join('；');
    return {
      status: 'error',
      code: 'IMAGE_DELIVERY_INCOMPLETE',
      questionId: qid,
      imageDelivery,
      message: `题面图片未完整载入（${imageDelivery.status}），已暂停解题：${failures || '部分图片载入失败'}。请教师确认题库图片文件后重试。`
    };
  }

  const promptBlocks = [{ type: 'text', text: buildSolvePrompt(prepared) }];
  for (const image of imageDelivery.images || []) {
    promptBlocks.push({ type: 'image', attachment: image.attachment });
  }
  const subagents = ctx.get('subagents');
  let activation = null;
  try {
    activation = await subagents.startActivation({
      provider: 'spawn',
      label: '独立解题',
      request: { prompt: promptBlocks, parent: exec.agent, agentPreset: preset.presetId },
      signal: exec.signal,
      delivery: 'caller'
    });
  } catch (e) {
    return {
      status: 'error',
      code: 'SOLVER_RUN_FAILED',
      questionId: qid,
      message: '隔离解题会话启动失败：' + ((e && e.message) || String(e))
    };
  }
  let result = null;
  let runError = null;
  try {
    result = await activation.result;
  } catch (e) {
    runError = e;
  } finally {
    try { await activation.dispose(); } catch (e) { /* ignore */ }
  }
  if (runError || !result || result.stopReason !== 'completed') {
    return {
      status: 'error',
      code: 'SOLVER_RUN_FAILED',
      questionId: qid,
      stopReason: (result && result.stopReason) || (runError ? 'error' : 'unknown'),
      diagnostic: result && result.diagnostic ? String(result.diagnostic).slice(0, 300) : ((runError && runError.message) || ''),
      message: '隔离解题会话未能完成作答（未取得可用文本）；不采用不完整结果。'
    };
  }
  const answerText = textOfBlocks(result.output).slice(0, 8000);
  if (!answerText) {
    return { status: 'error', code: 'SOLVER_RUN_FAILED', questionId: qid, stopReason: result.stopReason, message: '隔离解题会话返回空作答。' };
  }
  const keyEvidence = extractSection(answerText, '关键依据').slice(0, 2000);
  const recorded = await kernel.recordIndependentAnswer(prepared.runId, {
    answerText,
    keyEvidence,
    childSessionId: activation.childId || ''
  });
  if (recorded.status !== 'success') return recorded;
  return {
    status: 'success',
    questionId: prepared.questionId,
    runId: prepared.runId,
    state: recorded.state,
    reused: false,
    submittedAt: recorded.submittedAt,
    independentAnswer: answerText.slice(0, 4000),
    keyEvidence,
    answerHash: recorded.answerHash,
    questionCount: (prepared.questions || []).length,
    imageCount: (imageDelivery.images || []).length,
    imageStatus: imageDelivery.status
  };
}

// ========== /geo-status：只读状态入口（不调用模型） ==========
function readRuntimeVersion() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const file = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json');
    const info = JSON.parse(readFileSync(file, 'utf8'));
    return info && info.desktopVersion ? String(info.desktopVersion) : 'unknown';
  } catch {
    return 'unknown';
  }
}

const DATA_SOURCE_LABELS = { user: '教师配置', packaged: '随仓库 data/', missing: '缺失' };
const RUN_STATE_LABELS = { question_ready: '题面就绪', submitted: '作答已提交', verified: '核验完成', none: '未开始' };

async function buildStatusText(ctx, kernel) {
  const summary = await kernel.statusSummary();
  const lines = ['地理教师辅助 · 状态'];
  lines.push(`- DSH：${readRuntimeVersion()}`);
  const data = summary.data;
  if (data) {
    lines.push(`- 考点库：${DATA_SOURCE_LABELS[data.knowledgeSource] || data.knowledgeSource}${data.knowledgeBasePath ? '（' + data.knowledgeBasePath + '）' : ''}`);
    lines.push(`- 题库：${DATA_SOURCE_LABELS[data.questionBankSource] || data.questionBankSource}${data.questionBankPath ? '（' + data.questionBankPath + '）' : ''}`);
    lines.push(`- 配置：${data.configFileFound ? data.configPath : '未创建（使用随仓库 data/）'}`);
  }
  const counts = summary.counts || {};
  lines.push(`- 题库题数：${counts.bankQuestions ?? '—'} 小问 / ${counts.bankFiles ?? '—'} 文件｜考点节点：${counts.taxonomyNodes ?? '—'}`);
  const index = summary.index || {};
  lines.push(`- 索引：${index.fromDisk ? '磁盘索引' : '内存重建'}${index.builtAt ? '（' + formatTime(index.builtAt) + '）' : ''}`);
  const runs = summary.recentRuns || [];
  lines.push(runs.length
    ? `- 最近讲题：${runs.map((run) => `${run.questionId} ${RUN_STATE_LABELS[run.state] || run.state}`).join('；')}`
    : '- 最近讲题：无');
  let preset = '未检查';
  try {
    const presets = ctx.get && ctx.get('agentPresets');
    if (presets) {
      const info = await presets.resolve(INTERNAL_SOLVER_PRESET_ID);
      if (info && !info.broken) preset = '可用';
      else preset = '不可用：' + ((info && info.broken) || 'unknown');
    }
  } catch (e) {
    preset = '不可用：' + (((e && e.message) || String(e)).slice(0, 300));
  }
  lines.push(`- 内部解题预设：${preset}（内部使用，请勿手动选择）`);
  if (summary.status !== 'success') {
    lines.push(`- 状态：${summary.status}${summary.message ? ' — ' + summary.message : ''}`);
  }
  return lines.join('\n');
}

// ========== 工具 render：紧凑 Markdown ==========
export function renderSolve(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  lines.push(`# 独立作答 ${d.questionId || ''}（隔离解题会话）`);
  const answerSession = (d.answer && d.answer.childSessionId) || d.answerSessionId || '';
  const origin = d.answerOrigin === 'reused' || d.reused
    ? `复用已有隔离作答（提交于 ${formatTime(d.answer && d.answer.submittedAt)}；本次未重新解题）`
    : `本次新建隔离会话作答（提交于 ${formatTime(d.answer && d.answer.submittedAt)}）`;
  lines.push(`- 运行：${d.runId || '—'}｜状态：${d.state || '—'}｜来源：${origin}${answerSession ? '｜隔离会话：' + answerSession : ''}`);
  lines.push(`- 作答覆盖小问：${d.questionCount || 0} 个｜题面图片：${d.imageStatus || 'none'}（${d.imageCount || 0} 张）`);
  lines.push('');
  // 作答原文自带「## 答案 / ## 关键依据 / ## 推理过程」三段，原样呈现，不再另加同名标题（避免重复）。
  lines.push('## 作答原文');
  lines.push(d.independentAnswer || '（空）');
  if (d.keyEvidence && !/(^|\n)##\s*关键依据/.test(String(d.independentAnswer || ''))) {
    lines.push('');
    lines.push('## 关键依据');
    lines.push(d.keyEvidence);
  }
  lines.push('');
  lines.push('> 以上为隔离会话的独立作答：提交前未读取答案与解析。核验时调用 geo_judge（先开放答案，再传 conclusion 归档）；不要在讲稿里改写这份作答。');
  return [{ type: 'text', text: lines.join('\n') }];
}

export function renderJudge(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  if (d.conclusion) {
    const c = d.conclusion;
    const total = Array.isArray(d.questionIds) ? d.questionIds.length : 1;
    const pending = Array.isArray(d.pendingQuestionIds) ? d.pendingQuestionIds : [];
    lines.push(`# 核验结论已归档 ${d.questionId || ''}`);
    lines.push(`- 判定：${c.verdict}（一致/部分一致/不一致）｜归档时间：${formatTime(c.verifiedAt || d.verifiedAt)}`);
    lines.push(`- 题组核验：${total - pending.length}/${total} 个小问已归档${pending.length ? '；未归档：' + pending.join('、') : '；题组核验完成'}`);
    lines.push(`- 命中：${(c.matched || []).join('；') || '—'}`);
    lines.push(`- 遗漏：${(c.missed || []).join('；') || '—'}`);
    lines.push(`- 错误：${(c.wrong || []).join('；') || '—'}`);
    lines.push(`- 争议：${(c.disputed || []).join('；') || '—'}`);
    if (c.correction) {
      lines.push('');
      lines.push('## 修正结论');
      lines.push(c.correction);
    }
    lines.push('');
    lines.push(pending.length
      ? `> 核验结论按小问保存。题组内还有 ${pending.length} 个小问未归档：对剩余小问继续调用 geo_judge(qid, conclusion)；全部归档后才能生成讲稿。`
      : '> 题组内所有小问的核验结论已按小问保存。现在可以调用 geo_explain 生成讲稿；讲稿只读取这些记录。');
    return [{ type: 'text', text: lines.join('\n') }];
  }
  lines.push(`# 核验材料 ${d.questionId || ''}（答案已开放）`);
  lines.push(`- 运行：${d.runId || '—'}｜状态：${d.state}｜开放时间：${formatTime(d.judgeOpenedAt)}`);
  if (d.independent) {
    lines.push('');
    lines.push('## 你的独立作答（服务端保存）');
    lines.push(d.independent.answerText || '（空）');
  }
  for (const ref of d.reference || []) {
    lines.push('');
    lines.push(`## 参考答案 · ${ref.questionId}${ref.isChoice ? '（选择题）' : '（综合题）'}`);
    lines.push(`- 标准答案：${ref.standardAnswer || '（无）'}`);
    lines.push(`- 解析：${(ref.analysis || '（无）').slice(0, 3000)}`);
    if ((ref.scorePoints || []).length) {
      lines.push('- 倒推采分点：');
      for (const pt of ref.scorePoints) {
        if (pt.type === 'choice') lines.push(`  - [选择题] 正确项 ${pt.option || ''}：${pt.answer || ''}（考点：${pt.knowledgeUnit || '—'}，权重 ${pt.weight || '—'}）`);
        else lines.push(`  - ${pt.point || ''}（维度：${(pt.dimension || []).join('、') || '—'}）`);
      }
    }
    if ((ref.distractorTargets || []).length) {
      lines.push('- 干扰项目标：');
      for (const t of ref.distractorTargets) lines.push(`  - ${t.option}：${t.reason || ''}`);
    }
  }
  lines.push('');
  lines.push('> 逐点对照独立作答与参考答案后，**再次调用 geo_judge** 并传入 conclusion 对象归档核验结论：');
  lines.push('> `{ "verdict": "consistent|partially_consistent|inconsistent", "matched": [], "missed": [], "wrong": [], "disputed": [], "correction": "修正结论" }`');
  lines.push('> 取得参考答案只是核验的开始；未归档 conclusion 前不得生成讲稿。');
  return [{ type: 'text', text: lines.join('\n') }];
}

export function renderExplain(args, value) {
  const d = value || {};
  if (d.status !== 'success') return renderJson(args, value);
  const lines = [];
  const r = d.report || {};
  const audience = d.audience || r.audience || 'student';
  const label = AUDIENCE_LABELS[audience] || audience;
  lines.push(`# 讲题稿骨架 ${d.questionId || ''}`);
  lines.push(`- 讲解对象：${label}（${audience}）${audience === 'student' ? ' · 默认' : ''}`);
  const b = r.basic || {};
  lines.push(`- 题型：${b.type || '—'} · 难度：${b.difficulty || '—'} · 素养：${b.literacy || '—'} · 设问类型：${b.questionType || '—'} · 涉图：${b.hasImage ? '是' : '否'}`);
  lines.push(`- 本小问：${d.questionId || '—'}｜材料维度（整组，供参考，不等于本小问考查要素）：${(b.focusElements || []).join('、') || '—'}`);

  const v = d.verification || {};
  lines.push('');
  lines.push('## 核验状态');
  lines.push(`- 状态：${v.status || '—'}｜verified=${v.verified === true}｜证据来源=${v.evidence || '—'}（按小问保存）`);
  lines.push(`- 运行：${v.runId || '—'}｜提交：${formatTime(v.submittedAt)}｜开放答案：${formatTime(v.judgeOpenedAt)}｜归档：${formatTime(v.verifiedAt)}`);
  if (v.questionCount !== undefined) {
    lines.push(`- 题组核验：${v.verifiedCount ?? '—'}/${v.questionCount} 个小问已归档`);
  }
  if (v.conclusions && typeof v.conclusions === 'object' && Object.keys(v.conclusions).length > 0) {
    lines.push('- 各小问判定：' + Object.keys(v.conclusions).map((id) => `${id.split('-').pop()}（${v.conclusions[id].verdict}）`).join('；'));
  }
  if (v.conclusion) {
    lines.push(`- 本小问判定：${v.conclusion.verdict}；遗漏 ${(v.conclusion.missed || []).length} 项；错误 ${(v.conclusion.wrong || []).length} 项；争议 ${(v.conclusion.disputed || []).length} 项`);
    if (v.conclusion.correction) lines.push(`- 本小问修正结论：${v.conclusion.correction}`);
  }
  if (v.message) lines.push(`- ${v.message}`);

  if ((r.contentRequirements || []).length) {
    lines.push('');
    lines.push('## 内容要求（按此组织，不逐条机械成章）');
    for (const item of r.contentRequirements) lines.push(`- ${item.item}：${item.focus}`);
  }

  const st = r.structure || {};
  const audienceFocus = (section) => {
    if (section && section.audienceFocus) lines.push(`- 本对象侧重：${section.audienceFocus}`);
  };

  if (audience === 'setter') {
    if (st.note) lines.push(`\n> ${st.note}`);
    for (const section of st.sections || []) {
      lines.push(`\n## ${section.title}`);
      for (const item of section.items || []) lines.push(`- ${item}`);
    }
  } else {
    if (st.note) lines.push(`\n> ${st.note}`);
    if (st.locate) {
      lines.push('\n## 题目定位');
      for (const key of Object.keys(st.locate.fields || {})) {
        const val = (st.locate.fields || {})[key];
        if (val) lines.push(`- ${key}：${val}`);
      }
      const kr = st.locate.knowledgeRole;
      if (kr) {
        lines.push(`- 核心考点：${kr.examPoint || '—'}（讲清它在本题解题中起什么作用）`);
        if ((kr.supporting || []).length) lines.push(`- 支撑知识：${kr.supporting.map(s => s.knowledgeUnit).join('、')}`);
        lines.push(`- 知识作用（待填）：${kr.roleInSolving || '该知识点被哪条线索激活、把哪一步推下去'}`);
      }
      audienceFocus(st.locate);
    }
    if (st.examine) {
      lines.push(`\n## 审题提示\n${st.examine.hint || ''}`);
      audienceFocus(st.examine);
    }
    if (st.solve) {
      lines.push(`\n## 破题\n${st.solve.choiceNote || ''}`);
      const scan = st.solve.dimensionScan || {};
      const keys = Object.keys(scan);
      if (keys.length) {
        lines.push('维度扫描：');
        for (const key of keys) { const dim = scan[key]; lines.push(`  - ${dim.name}：${(dim.evidence || []).join('、')}`); }
      }
      audienceFocus(st.solve);
    }
    const cmp = (st.solve && st.solve.comparison) || d.comparison || {};
    lines.push('\n## 同类问题比较（题库检索依据）');
    if ((cmp.basis || []).length) {
      for (const item of cmp.basis) {
        lines.push(`- ${item.groupLabel || ''} ${item.questionId}`);
        if (item.sharedTask) lines.push(`  - 共同点：${item.sharedTask}`);
        if (item.sharedReasoning) lines.push(`  - 推理关系：${item.sharedReasoning}`);
        if (item.sharedMaterial) lines.push(`  - 材料特征：${item.sharedMaterial}`);
        if (item.differences) lines.push(`  - 差异/边界：${item.differences}`);
      }
    } else {
      lines.push('- 题库未检索到可用同类题。');
    }
    if (cmp.insufficient && cmp.gap) lines.push(`- 缺口：${cmp.gap}`);
    if (cmp.citationRule) lines.push(`- 引用要求：${cmp.citationRule}`);
    if (cmp.focus) lines.push(`- 写法：${cmp.focus}`);
    if (st.reflect) {
      lines.push(`\n## 反思与迁移\n核心考点：${st.reflect.coreKnowledgeUnit || '—'}`);
      const tr = st.reflect.transfer || {};
      if (tr.student) lines.push(`- 学生版：${tr.student}`);
      if (tr.teacher) lines.push(`- 教师版：${tr.teacher}`);
      if ((d.variants || []).length) {
        lines.push('同考点变式候选：');
        for (const vv of (d.variants || []).slice(0, 5)) lines.push(`  - ${vv.file}：${(vv.stem || '').slice(0, 60)}`);
      } else lines.push('（题库暂无同考点变式）');
      audienceFocus(st.reflect);
    }
  }

  const plan = r.audiencePlan || {};
  if (audience === 'setter') {
    const layers = plan.interferenceLayers || [];
    if (layers.length) {
      lines.push('\n## 三层干扰辨析（必检）');
      for (const layer of layers) {
        const state = layer.applicable === false ? '不适用' : '待填 findings';
        lines.push(`- **${layer.layer}**｜${state}${layer.note ? '：' + layer.note : ''}`);
      }
    }
    if ((plan.constraints || []).length) {
      lines.push('\n## 命题人约束');
      for (const item of plan.constraints) lines.push(`- ${item}`);
    }
  } else if (audience === 'teacher') {
    lines.push('\n## 教师对象 audiencePlan（待填）');
    lines.push(`- 组织模板：${(plan.nodeTemplate || []).join(' → ')}`);
  } else {
    lines.push('\n## 学生对象 audiencePlan（待填）');
    const flow = plan.flow || [];
    if (flow.length) lines.push(`- 段内教学流程：${flow.join(' → ')}`);
    const placement = plan.stepPlacement || {};
    if (placement.examine || placement.solve || placement.reflect) {
      const placementNote = placement.note ? `（${placement.note}）` : '';
      lines.push(`- 落位：审题＝${placement.examine || '—'}；破题＝${placement.solve || '—'}；反思与迁移＝${placement.reflect || '—'}${placementNote}`);
    }
    const stepTemplate = plan.stepTemplate || [];
    if (stepTemplate.length) {
      lines.push('- 推进步骤（每步：做什么／为什么这么做）：');
      for (const step of stepTemplate) {
        lines.push(`  - ${step.step}：${step.action}`);
        lines.push(`    - 思维锚点（讲给学生听）：${step.anchor}`);
      }
    }
    lines.push(`- 第一步想什么（待填）：${plan.entryQuestion || '拿到这道题第一步做什么、为什么'}`);
    const planSteps = plan.steps || [];
    if (planSteps.length) {
      lines.push('- 推进步骤的具体内容（待填）：');
      for (const item of planSteps) lines.push(`  - ${item}`);
    } else {
      lines.push('- 推进步骤的具体内容（待填）：按①—⑥逐步填：每步的动作＋证据/原理＋结论');
    }
    lines.push(`- 方法边界（待填）：${plan.methodBoundary || '这个方法适用什么条件、什么时候要换方法'}`);
  }
  if (plan.reference) lines.push(`- 写法细则：${plan.reference}`);

  const inter = r.interdisciplinary || {};
  if (inter.status) {
    lines.push(`\n## 跨学科状态\n- 当前状态：${inter.status}（可选 ${(inter.allowedStatus || []).join(' / ')}）`);
    lines.push(`- 展开链：${(inter.chain || []).join(' → ')}`);
    if (inter.note) lines.push(`- ${inter.note}`);
  }

  if (r.audienceDeliverable) lines.push(`\n## 本次交付形态\n${r.audienceDeliverable}`);
  if (r.cacheKey) lines.push(`- 缓存键：${r.cacheKey}`);

  lines.push(audience === 'setter'
    ? '\n> 按上述命题分析结构重组讲稿：逐层检查设问、材料、选项中的干扰并给出位置、错误路径与辨别依据；不虚构选项，不伪造原作者意图或试测数据。'
    : '\n> 按上述内容要求与对象侧重，教学化重组为「题目定位—审题—破题—反思与迁移」四段式讲题稿；同类问题方法必须引用上面检索到的题目与对应关系，不足时写明缺口。不重新解题、不照抄解析。');
  lines.push('> 交付边界：只输出讲稿正文（从第一段正文开始），不写“已完成…/下面是成稿”之类过程说明，不写核验状态、服务端记录、内部标识，不追加“需要切换对象/要我导出吗”一类话术；核验状态只供你判断，不进入讲稿。');
  lines.push('> 引用边界：同类题与变式只能引用上面 comparison.basis 与 variants 中的题目；不得补充记忆中的其他题目；候选不足时按 gap 写明缺口。');
  return [{ type: 'text', text: lines.join('\n') }];
}

export default {
  name: 'geo-analysis',
  inject: ['webServer', 'geoKernel', 'tools', 'fs', 'attachments'],
  apply(ctx) {
    const webServer = ctx.webServer;
    const kernel = ctx.geoKernel;

    const routeDispose1 = webServer.register({
      kind: 'prefix',
      path: '/geo/analysis',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo\/analysis\/?/, '') || 'index';
          switch (action) {
            case 'run':
              return sendJson(res, 200, await kernel.analyzeQuestion(query.qid || ''));
            case 'export':
              return sendJson(res, 200, await kernel.exportAnalysis(query.qid || ''));
            default:
              return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });
    if (typeof ctx.effect === 'function' && typeof routeDispose1 === 'function') ctx.effect(() => routeDispose1);

    // /geo-status：只读状态命令（安装验活、数据来源、题库题数、最近讲题 run）。
    // 注意：DSH 的 commands.register 注册在全局层；预设重新挂载时同名命令可能仍由旧
    // generation 持有，重复注册会抛错并**连带打挂整个 preset 挂载**。这里对重复注册
    // 做幂等处理：保留既有注册，不让 apply 失败。
    const commands = ctx.get ? ctx.get('commands') : undefined;
    if (commands && typeof commands.register === 'function') {
      const definition = {
        name: 'geo-status',
        description: '显示地理教师辅助的安装、数据与题库状态（只读，不调用模型）',
        handler: async () => {
          try {
            return { kind: 'success', text: await buildStatusText(ctx, kernel) };
          } catch (e) {
            return { kind: 'error', text: '读取状态失败：' + ((e && e.message) || String(e)) };
          }
        }
      };
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => commands.register(definition));
        } else {
          commands.register(definition);
        }
      } catch (error) {
        const message = (error && error.message) || String(error);
        if (/already registered/i.test(message)) {
          console.log('geo-analysis: /geo-status 已由既有 generation 注册，跳过重复注册');
        } else {
          console.error('geo-analysis: /geo-status 注册失败（不影响其它工具）：' + message);
        }
      }
    } else {
      console.log('geo-analysis: 缺少 commands 服务，/geo-status 未注册（不影响模型工具）');
    }

    // 模型工具：状态查询（与 /geo-status 同源；用户要求“查看状态”时由模型用正常消息回复）。
    ctx.tools.register({
      name: 'geo_status',
      description: '查看地理教师辅助的安装与数据状态：DSH 版本、考点库/题库来源、题数、索引、最近讲题 run。只读，不触发解题。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(args, value) {
          if (value && value.status === 'success' && typeof value.text === 'string') {
            return [{ type: 'text', text: value.text }];
          }
          return renderJson(args, value);
        }
      },
      async execute() {
        try {
          return { status: 'success', text: await buildStatusText(ctx, kernel) };
        } catch (e) {
          return { status: 'error', message: '读取状态失败：' + ((e && e.message) || String(e)) };
        }
      }
    });

    // 模型工具：真题分析 + 命题蓝图
    ctx.tools.register({
      name: 'geo_analyze',
      description: '真题分析：题型/设问模式/情境/素养/能力/难度/考点映射/干扰项逻辑，并给出下一道题的命题蓝图（情境换新/设问设计/选项设计）。命题研究用它，不走讲题流程。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID（如 2025-广东-地理-...-Q1）' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.analyzeQuestion(args.qid);
      }
    });

    // 模型工具：隔离解题（讲题流水线第 1 步）
    ctx.tools.register({
      name: 'geo_solve',
      description: '讲题第 1 步：在全新隔离会话中独立解题（只给题面与题面图片），返回独立答案与关键依据，服务端保存作答并绑定题面版本。答案与解析在提交后才由 geo_judge 开放。前置：有题库 qid；同题已有提交时复用（reused=true，不新建子会话，作答来自此前的隔离会话）。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID（如 2025-广东-地理-...-Q1）' },
          fresh: { type: 'boolean', description: '强制重新独立作答：新建隔离会话，不复用同指纹的已有作答（默认 false）' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderSolve
      },
      async execute(args, exec) {
        const qid = String((args && args.qid) || '').trim();
        if (!qid) return { status: 'error', code: 'MISSING_QID', message: '缺少 qid' };
        return await runIsolatedSolve(ctx, exec, qid, { fresh: args.fresh === true });
      }
    });

    // 模型工具：核验（讲题流水线第 2 步，两阶段）
    ctx.tools.register({
      name: 'geo_judge',
      description: '讲题第 2 步（核验）：不传 conclusion 时开放标准答案/解析/采分点与独立作答供对照；对照完成后传入 conclusion 归档核验结论（一致/遗漏/错误/争议/修正）。答案只在 geo_solve 提交后开放；未归档不能生成讲稿。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' },
          conclusion: {
            type: 'object',
            description: '核验结论（第二阶段）：{ verdict: consistent|partially_consistent|inconsistent, matched: string[], missed: string[], wrong: string[], disputed: string[], correction: string }',
            properties: {
              verdict: { type: 'string', enum: ['consistent', 'partially_consistent', 'inconsistent'] },
              matched: { type: 'array', items: { type: 'string' } },
              missed: { type: 'array', items: { type: 'string' } },
              wrong: { type: 'array', items: { type: 'string' } },
              disputed: { type: 'array', items: { type: 'string' } },
              correction: { type: 'string' }
            },
            required: ['verdict']
          }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJudge
      },
      async execute(args) {
        const qid = String((args && args.qid) || '').trim();
        if (!qid) return { status: 'error', code: 'MISSING_QID', message: '缺少 qid' };
        const raw = args ? args.conclusion : undefined;
        if (raw !== undefined && raw !== null) {
          if (typeof raw !== 'object' || Array.isArray(raw)) {
            return { status: 'error', code: 'CONCLUSION_INVALID', message: 'conclusion 必须是对象（verdict + 可选数组字段）' };
          }
          return await kernel.recordVerification(qid, raw);
        }
        return await kernel.openReferenceAnswer(qid);
      }
    });

    // 模型工具：讲稿骨架（讲题流水线第 3 步）
    ctx.tools.register({
      name: 'geo_explain',
      description: '讲题第 3 步：按讲解对象（student 默认｜teacher｜setter）输出讲稿骨架与同类题比较依据，附服务端核验记录。前置：同题已完成 geo_solve 与 geo_judge（含 conclusion 归档）；未核验返回明确状态，不冒充已核验。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' },
          audience: { type: 'string', enum: ['student', 'teacher', 'setter'], description: '讲解对象：student 学生（默认）｜teacher 教师｜setter 命题人；仅因为用户是教师不自动选 teacher。' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderExplain
      },
      async execute(args) {
        const aud = normalizeAudience(args && args.audience);
        if (!aud.ok) {
          return { status: 'error', code: 'INVALID_AUDIENCE', questionId: (args && args.qid) || '', message: aud.message };
        }
        const qid = String((args && args.qid) || '').trim();
        if (!qid) return { status: 'error', code: 'MISSING_QID', message: '缺少 qid' };
        const result = await kernel.assembleExplanation(qid, aud.audience);
        if (result.status !== 'success') return result;
        return Object.assign({}, result, { audienceExplicit: aud.explicit });
      }
    });

    // 模型工具：导出分析报告
    ctx.tools.register({
      name: 'geo_export_analysis',
      description: '把真题分析 + 命题蓝图导出为 Markdown 报告文件（写入 outputs 目录），返回保存路径。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID' }
        },
        required: ['qid'],
        additionalProperties: false
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderJson
      },
      async execute(args) {
        return await kernel.exportAnalysis(args.qid);
      }
    });

    console.log('geo-analysis: /geo/analysis 路由与 geo_analyze / geo_solve / geo_judge / geo_explain / geo_export_analysis 工具已注册（内部解题预设由 cordis.patch.yml 声明）');
  }
};
