// GeoTeacher Agent — 视觉预处理插件（geo-vision，V1）
// 分层职责：
//   · SiliconFlow / Qwen3-VL-8B = 视觉模型 Provider（只读图转 JSON，不做解题推理）
//   · geoVision 服务     = 底层业务 Service：读图 → Qwen JSON → schema 校验 → 生产 GeoVisionResult
//                          → imageHash 缓存 + index → run 日志 → 降级。供内部消费者复用。
//   · geo_extract_images = 给 DeepSeek 主 Agent 的工具薄壳（execute 仅调 geoVision.extract(qid)）。
// geo_solve（analysis）直接调 geoVision.extract(qid)，不绕经本工具。
// 注意：不 import 宿主包/第三方（C: 用户根无 node_modules）；Qwen JSON 用轻量手写校验，不用 zod。
// 配置：provider / model / promptVersion / schemaVersion / cacheDir / maxBytesPerImage。
// 运行时开关：enabled 可通过 /geo/vision/toggle 动态切换（UI 面板），初始值来自配置。

// ========== 轻量 schema 校验（V1） ==========
function isStr(v) { return typeof v === 'string'; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

const ALLOWED_FIELD = new Set(['label', 'legend', 'numeric', 'symbol', 'line', 'annotation', 'spatial', 'other']);
const ALLOWED_CAT = new Set(['observed', 'uncertain', 'inferred']);
const ALLOWED_TYPE = new Set(['region', 'isoline', 'chart', 'schematic', 'photo', 'unknown']);

function validateRaw(raw) {
  // raw 应为 { imageType?, items: [...] }
  const errs = [];
  if (!isObj(raw)) { return { ok: false, errs: ['top-level not object'] }; }
  const items = raw.items;
  if (!Array.isArray(items)) { return { ok: false, errs: ['items not array'] }; }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!isObj(it)) { errs.push(`items[${i}] not object`); continue; }
    const category = it.category;
    const field = it.field;
    const text = it.text;
    if (!ALLOWED_CAT.has(category)) { errs.push(`items[${i}].category invalid: ${category}`); continue; }
    if (!ALLOWED_FIELD.has(field)) { errs.push(`items[${i}].field invalid: ${field}`); continue; }
    if (!isStr(text) || !text.trim()) { errs.push(`items[${i}].text missing`); continue; }
    if (category === 'uncertain' && !isStr(it.reason)) { errs.push(`items[${i}].uncertain missing reason`); continue; }
    if (it.modelConfidence !== undefined && !isNum(it.modelConfidence)) { errs.push(`items[${i}].modelConfidence not number`); continue; }
    out.push({
      category, field, text: text.trim(),
      unit: isStr(it.unit) ? it.unit : undefined,
      modelConfidence: isNum(it.modelConfidence) ? it.modelConfidence : undefined,
      reason: isStr(it.reason) ? it.reason : undefined
    });
  }
  let imageType = raw.imageType;
  if (imageType !== undefined && !ALLOWED_TYPE.has(imageType)) { errs.push(`imageType invalid: ${imageType}`); imageType = undefined; }
  return { ok: errs.length === 0, errs, items: out, imageType };
}

// ========== 图片格式魔数嗅探（真实格式优先于扩展名） ==========
// 处理"webp/jpg 内容 + .png 扩展名"等命名失误：mediaType 必须与字节内容一致，
// 否则 OpenAI 兼容端点按错误格式解码会失败或乱码。嗅探失败时返回 null，由调用方按扩展名兜底。
function sniffImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: "GIF8"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  // WebP: "RIFF" .... "WEBP"（bytes 8-11）
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

// ========== 渲染：GeoVisionResult -> DeepSeek 用 Markdown（多图分段） ==========
function renderToMarkdown(results) {
  if (!Array.isArray(results) || results.length === 0) return '';
  const parts = [];
  for (const r of results) {
    const header = `【图 ${r.imageId} · ${r.caption || '无图注'}】`;
    const lines = [header];
    for (const it of r.observed || []) {
      const conf = it.modelConfidence !== undefined ? `(自评${it.modelConfidence})` : '';
      const unit = it.unit ? ` ${it.unit}` : '';
      lines.push(`- ${it.text}${unit}${conf}`);
    }
    for (const it of r.uncertain || []) {
      lines.push(`- 【不确定】${it.text}${it.reason ? '（' + it.reason + '）' : ''}`);
    }
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

// ========== 配置/常量（可由 config 覆盖） ==========
const DEFAULT_PROMPT_VERSION = 'qwen-visual-transcribe-v1';
const DEFAULT_SCHEMA_VERSION = 'geovision-obs-v1';

// ========== HTTP 辅助（与其它 geo 插件一致） ==========
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

export default {
  name: 'geo-vision',
  inject: ['fs', 'geoKernel', 'webServer'],
  apply(ctx, config) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;
    // llm / attachments 是可选的（host 服务，经 ctx.get 穿透 isolate realm；缺失时 geoVision 不启用）。
    const llm = ctx.get('llm');
    const attachments = ctx.get('attachments');
    const kernel = ctx.geoKernel;
    const cfg = config || {};
    // 可变的运行时开关：初始由配置决定，可通过 /geo/vision/toggle 动态切换
    let enabledState = !!cfg.enabled && !!llm && !!attachments;
    const CACHE_DIR = cfg.cacheDir || 'E:/geo_edu_agent/outputs/visionCache';
    const MAX_BYTES = cfg.maxBytesPerImage || 8 * 1024 * 1024; // 8MB
    const PROMPT_VERSION = cfg.promptVersion || DEFAULT_PROMPT_VERSION;
    const SCHEMA_VERSION = cfg.schemaVersion || DEFAULT_SCHEMA_VERSION;
    const FORCE_PROVIDER = cfg.provider || '';
    const FORCE_MODEL = cfg.model || 'qwen3.6-plus';
    if (cfg.enabled && !enabledState) {
      console.log(`geo-vision: enabled 但依赖缺失（llm=${!!llm}, attachments=${!!attachments}），geoVision 不启用`);
    }

    // 结构化运行日志（JSONL）
    async function appendRun(run) {
      try {
        const dir = await fsService.resolve(CACHE_DIR + '/runs');
        const runLine = JSON.stringify({ ...run, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION });
        const rel = await fsService.resolve(CACHE_DIR + '/runs/vision-runs.jsonl');
        const existing = await fsService.readText(rel).catch(() => '');
        await fsService.writeText(rel, (existing ? existing.trimEnd() + '\n' : '') + runLine, undefined, undefined, WRITE_POLICY()).catch(() => {});
      } catch (e) { /* 日志失败不影响主流程 */ }
    }

    function WRITE_POLICY() {
      return { mode: 'workspace-write', workspaceRoot: cfg.workspaceRoot || 'E:/geo_edu_agent' };
    }

    // 自动发现：provider 路由名 + 模型 id（优先 Qwen3.6 Plus，且必须声明图像输入能力）
    function enumerateProviders() {
      try { return llm.listProviders() || []; } catch (e) { return []; }
    }
    function providerKey(p) {
      if (!p) return '';
      if (typeof p === 'string') return p;
      return p.name || p.id || p.provider || p.key || '';
    }
    function modelLabel(m) {
      return String((m && (m.name || m.id || m.model)) || '');
    }
    // 返回 { provider, model, source, modalities? }；失败时返回带 error 字段的对象（不再静默回退）。
    async function resolveVisionModel() {
      // 优先配置指定 provider/model（推荐固定，避免自动发现漂移）
      if (FORCE_PROVIDER) {
        try {
          const info = await llm.resolveModelInfo(FORCE_PROVIDER, FORCE_MODEL);
          const mods = info && info.inputModalities;
          if (Array.isArray(mods) && mods.includes('image')) {
            return { provider: FORCE_PROVIDER, model: FORCE_MODEL, source: 'config', modalities: mods };
          }
          return { provider: FORCE_PROVIDER, model: FORCE_MODEL, source: 'config',
            error: 'configured model has no image input modality: ' + JSON.stringify(mods || null) };
        } catch (e) {
          return { provider: FORCE_PROVIDER, model: FORCE_MODEL, source: 'config',
            error: 'resolveModelInfo failed: ' + String((e && (e.code || e.message)) || e) };
        }
      }
      const providers = enumerateProviders();
      const failures = [];
      for (const p of providers) {
        const pk = providerKey(p);
        if (!pk) continue;
        let models = [];
        try { models = await llm.listModels(pk) || []; }
        catch (e) { failures.push(pk + ':list:' + String((e && e.message) || e)); continue; }
        // 精确找 Qwen3.6 Plus：name="Qwen3.6 Plus"、id="qwen3.6-plus"（注意连字符，勿用空格正则匹配 id）
        const byName = models.find(m => /Qwen3\.6\s*Plus/i.test(String((m && m.name) || '')));
        const byId = models.find(m => /^qwen3\.6[\s_-]*plus$/i.test(String((m && m.id) || '')));
        const cand = byName || byId ||
                     models.find(m => /Qwen3\.6/i.test(modelLabel(m))) ||
                     models.find(m => /qwen/i.test(modelLabel(m)));
        if (!cand) continue;
        const modelId = String(cand.id || cand.name || cand.model || '');
        if (!modelId) continue;
        try {
          const info = await llm.resolveModelInfo(pk, modelId);
          const mods = info && info.inputModalities;
          if (Array.isArray(mods) && mods.includes('image')) {
            return { provider: pk, model: modelId, source: 'auto', modalities: mods };
          }
          failures.push(pk + ':' + modelId + ':no-image-modality(' + JSON.stringify(mods || null) + ')');
        } catch (e) {
          failures.push(pk + ':' + modelId + ':' + String((e && (e.code || e.message)) || e));
        }
      }
      // 没有任何可用视觉模型：明确失败（带候选与原因），不再静默回退
      return { provider: '', model: '', source: 'none',
        error: 'no_vision_model: ' + (failures.length ? failures.join(' | ') : 'no providers') };
    }

    async function readImageBytes(sourcePath) {
      const target = await fsService.resolve(sourcePath);
      const bytes = await fsService.readBytes(target, null, MAX_BYTES);
      if (!bytes || !bytes.length) throw new Error('empty image bytes');
      return bytes; // Uint8Array
    }
    function imageContentType(path) {
      const ext = String(path).split('.').pop().toLowerCase();
      return ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
    }
    function newMessageId() {
      try {
        const c = globalThis.crypto;
        if (c && typeof c.randomUUID === 'function') return 'msg-' + c.randomUUID();
      } catch (e) { /* fallthrough */ }
      return 'msg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    // ========== single image: Qwen JSON -> 生产 GeoVisionResult ==========
    async function transcribeOne(img, visionModel) {
      const start = Date.now();
      const base = {
        ts: new Date().toISOString(), imageId: img.imageId, sourcePath: img.sourcePath,
        provider: visionModel.provider, model: visionModel.model, cacheHit: false,
        status: 'failed', schemaOk: null
      };
      // 读图（魔数嗅探优先：webp 伪装成 png/jpg 扩展名时仍能正确声明 mediaType）
      let bytes, contentType;
      try {
        bytes = await readImageBytes(img.sourcePath);
        const extType = imageContentType(img.sourcePath);
        contentType = sniffImageType(bytes) || extType;
        if (contentType !== extType) {
          console.log(`geo-vision: 图片格式与扩展名不符 ${img.sourcePath} (扩展名判 ${extType}, 内容实为 ${contentType})`);
        }
      } catch (e) {
        await appendRun({ ...base, error: 'read_image: ' + (e && e.message || e), durationMs: (Date.now() - start) });
        return { status: 'degraded', imageId: img.imageId, error: 'read_image: ' + (e && e.message || e) };
      }

      // 图片字节上限：以 attachments.imageLimits 为准（默认 maxImageBytes 5MB），避免 saveImage 校验失败
      const limits = attachments ? attachments.imageLimits : null;
      const maxBytes = limits && limits.maxImageBytes ? Math.min(MAX_BYTES, limits.maxImageBytes) : MAX_BYTES;
      if (bytes.length > maxBytes) {
        await appendRun({ ...base, error: 'image_too_large: ' + bytes.length + ' > ' + maxBytes, durationMs: (Date.now() - start) });
        return { status: 'degraded', imageId: img.imageId, error: 'image_too_large: ' + bytes.length + ' > ' + maxBytes };
      }

      // 规范 ImageBlock 契约：图必须经 durable attachments 服务落地为引用（不能传 OpenAI 线格式 source）
      let ref;
      try {
        ref = await attachments.saveImage({ data: bytes, mediaType: contentType, name: img.caption || img.imageId });
      } catch (e) {
        const reason = 'save_image: ' + String((e && (e.code || e.message)) || e);
        await appendRun({ ...base, error: reason, durationMs: (Date.now() - start) });
        return { status: 'degraded', imageId: img.imageId, error: reason };
      }

      const prompt = buildTranscribePrompt();
      const content = [
        { type: 'image', attachment: ref },
        { type: 'text', text: prompt }
      ];
      const messages = [{ id: newMessageId(), role: 'user', content, source: { kind: 'user' } }];

      // 调 llm.stream：消费类型化 chunk（text-delta/reasoning-delta），finish 错误块转成真实异常；
      // 仅对可重试错误码重试 1 次（确定性错误如 UNSUPPORTED_CONTENT/UNKNOWN_MODEL 不重试）。
      let rawText = '';
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        rawText = '';
        lastErr = null;
        try {
          const gen = llm.stream({ provider: visionModel.provider, model: visionModel.model, messages });
          for await (const chunk of gen) {
            if (!chunk || typeof chunk !== 'object') continue;
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
              if (typeof chunk.text === 'string' && chunk.text) rawText += chunk.text;
            } else if (chunk.type === 'finish') {
              const reason = chunk.reason;
              if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
                const f = reason.failure || {};
                throw new Error('vision_llm ' + (f.code || reason.kind) + ': ' + (f.message || ''));
              }
            }
          }
          break; // 无异常 → 成功
        } catch (e) {
          lastErr = e;
          const msg = String((e && e.message) || e);
          const codeMatch = /^vision_llm (\S+)/.exec(msg);
          const code = codeMatch ? codeMatch[1] : '';
          const retryable = !code || !/^(UNSUPPORTED_|UNKNOWN_|MISSING_|INVALID_)/.test(code);
          if (attempt === 0 && retryable) continue; // 重试一次
          break;
        }
      }
      if (lastErr) {
        const reason = 'llm_stream: ' + String((lastErr && lastErr.message) || lastErr);
        await appendRun({ ...base, error: reason, durationMs: (Date.now() - start), rawText });
        return { status: 'degraded', imageId: img.imageId, error: reason };
      }

      // 提取 JSON：容忍 fenced code block
      let parsedRaw = null;
      let schemaResult = null;
      const rawTrim = (rawText || '').trim();
      const fenceMatch = rawTrim.match(/```(?:json)?\s*([\s\S]*?)```/);
      const jsonStr = fenceMatch ? fenceMatch[1] : stripToJson(rawTrim);
      try {
        parsedRaw = JSON.parse(jsonStr);
        schemaResult = validateRaw(parsedRaw);
      } catch (e) {
        await appendRun({ ...base, error: 'json_parse: ' + (e && e.message || e), durationMs: (Date.now() - start), rawText });
        return { status: 'degraded', imageId: img.imageId, error: 'json_parse: ' + (e && e.message || e), rawText };
      }

      if (!schemaResult.ok) {
        await appendRun({ ...base, schemaOk: false, error: 'schema: ' + (schemaResult.errs || []).join('; '), durationMs: (Date.now() - start), rawText });
        return { status: 'degraded', imageId: img.imageId, error: 'schema: ' + (schemaResult.errs || []).join('; '), rawText };
      }

      // schema ok -> 组装生产 GeoVisionResult（丢弃 inferred）
      const observed = [];
      const uncertain = [];
      for (const it of schemaResult.items) {
        if (it.category === 'observed') observed.push(dropCategory(it));
        else if (it.category === 'uncertain') uncertain.push(dropCategory(it));
        // inferred: 丢弃（不进入生产视图）
      }
      const result = {
        imageId: img.imageId,
        caption: img.caption || '',
        sourcePath: img.sourcePath,
        imageType: schemaResult.imageType || 'unknown',
        contentType,
        observed,
        uncertain,
        uncertainties: uncertain.map(u => u.reason ? u.text + '(' + u.reason + ')' : u.text)
      };
      await appendRun({ ...base, status: 'success', schemaOk: true, durationMs: (Date.now() - start),
        resultSummary: `observed=${observed.length}, uncertain=${uncertain.length}, inferred-discarded=${schemaResult.items.length - observed.length - uncertain.length}`,
        rawText });
      return { status: 'success', result };
    }

    function dropCategory(it) {
      const { category, ...rest } = it;
      return rest;
    }
    function stripToJson(s) {
      // 去掉可能的 markdown 包裹后整体解析
      const st = s.trim();
      const a = st.indexOf('{');
      const b = st.lastIndexOf('}');
      const arrA = st.indexOf('[');
      const arrB = st.lastIndexOf(']');
      const start = a >= 0 && (arrA < 0 || a <= arrA) ? a : arrA;
      const end = b >= 0 && (arrB < 0 || b >= arrB) ? b : arrB;
      if (start >= 0 && end > start) return st.slice(start, end + 1);
      return s;
    }
    function buildTranscribePrompt() {
      return [
        '你是一个"图像转录器"。看这张图后，直接返回一个 JSON 对象，不要自由文本、不要 markdown 代码块。',
        'JSON 结构：{"imageType":"region|isoline|chart|schematic|photo|unknown","items":[{...}]}',
        '每个 item：{"category":"observed|uncertain|inferred","field":"label|legend|numeric|symbol|line|annotation|spatial|other","text":"...","unit":"可选","modelConfidence":0.0~1.0,"reason":"仅 uncertain 必填"}',
        'category 语义：observed=图中明确可见可核对；uncertain=难以确读（模糊/遮挡/压线/字号小）须填 reason；inferred=你的推断/结论（因果、优劣、说明…、可能…、更…）',
        '只转录 坐标/数值/图例/符号/线型/图斑/注记/空间位置关系；不回答任何设问、不评价。',
        'inferred 项也要照常给出（系统会识别并丢弃）。modelConfidence 仅是你对自己这条转录可信度的自评 0–1。'
      ].join('\n');
    }

    // ========== 缓存（key = imageHash + index） ==========
    async function sha256Hex(str) {
      // 运行时内置无 crypto? 用 btoa 不可用于 hash。做 FNV-1a 退避（若 TextEncoder+crypto 不可用）。
      try {
        const buf = new TextEncoder().encode(str);
        // 尝试 crypto.subtle
        const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
        const arr = new Uint8Array(digest);
        let hex = '';
        for (const x of arr) hex += x.toString(16).padStart(2, '0');
        return hex;
      } catch (e) {
        // FNV-1a fallback
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
        return 'fnv' + (h >>> 0).toString(16);
      }
    }
    // v2.1：cacheKey = 图片内容 hash（不限 sourcePath/model/prompt，同图内容跨题跨配置一个 key）。
    // 读取时用配套 index.json（记录 modelId/promptVersion/schemaVersion/ts）判定是否过期。
    async function imageContentHash(sourcePath) {
      const bytes = await readImageBytes(sourcePath);
      const hexBytes = [];
      for (let i = 0; i < bytes.length; i++) hexBytes.push(bytes[i].toString(16).padStart(2, '0'));
      return sha256Hex(hexBytes.join(''));
    }
    async function readCacheIndex(dir, key) {
      try {
        const idx = await fsService.readText(await fsService.resolve(dir + '/' + key + '.index.json'));
        return JSON.parse(idx);
      } catch (e) { return null; }
    }
    async function writeCacheIndex(dir, key, viewMeta) {
      try {
        const idx = { modelId: viewMeta.model, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, ts: new Date().toISOString() };
        await fsService.writeText(await fsService.resolve(dir + '/' + key + '.index.json'), JSON.stringify(idx), undefined, undefined, WRITE_POLICY());
      } catch (e) { /* 索引写失败不阻塞 */ }
    }

    // ========== geoVision API ==========
    const api = {
      get enabled() { return enabledState; },
      // 生产视图：对每张图做可见提取 -> GeoVisionResult[]；失败单图降级、不阻塞整批
      async extract(qid) {
        if (!enabledState) return { status: 'disabled', message: 'vision.enabled=false' };
        try {
          const refs = await kernel.imageRefs(qid);
          if (refs.status !== 'success' || !refs.hasImages) {
            return { status: 'success', questionId: qid, hasImages: false, images: [] };
          }
          const visionModel = await resolveVisionModel();
          if (!visionModel || visionModel.error) {
            const reason = visionModel ? visionModel.error : 'no_vision_model';
            await appendRun({ ts: new Date().toISOString(), imageId: refs.images[0].imageId, sourcePath: refs.images[0].sourcePath, provider: (visionModel && visionModel.provider) || '', model: (visionModel && visionModel.model) || '', cacheHit: false, durationMs: 0, status: 'degraded', schemaOk: null, error: reason });
            return { status: 'degraded', questionId: qid, error: reason, providers: enumerateProviders() };
          }
          // 缓存 key = 图片内容 hash（v2.1），用 index.json 校验过期
          const results = [];
          const viewMeta = { model: visionModel.model, provider: visionModel.provider, source: visionModel.source };
          for (const img of refs.images) {
            try {
              let hkey = await imageContentHash(img.sourcePath);
              const cachePath = CACHE_DIR + '/' + hkey + '.json';
              const index = await readCacheIndex(CACHE_DIR, hkey);
              // 命中条件：有缓存结果 且 index 记录与本配置一致（model/promptVersion/schemaVersion）
              let cached = null;
              if (index && index.modelId === visionModel.model && index.promptVersion === PROMPT_VERSION && index.schemaVersion === SCHEMA_VERSION) {
                try {
                  cached = await fsService.readText(await fsService.resolve(cachePath)).catch(() => null);
                } catch (e) { cached = null; }
              }
              if (cached) {
                const parsed = JSON.parse(cached);
                await appendRun({ ts: new Date().toISOString(), imageId: img.imageId, sourcePath: img.sourcePath, provider: visionModel.provider, model: visionModel.model, status: 'success', schemaOk: null, durationMs: 0, cacheHit: true, resultSummary: 'cache' });
                results.push({ ok: true, result: parsed.result });
                continue;
              }
              const t = await transcribeOne(img, visionModel);
              if (t.status === 'success') {
                results.push({ ok: true, result: t.result });
                try {
                  await fsService.writeText(await fsService.resolve(cachePath), JSON.stringify({ schemaVersion: SCHEMA_VERSION, result: t.result }), undefined, undefined, WRITE_POLICY());
                  await writeCacheIndex(CACHE_DIR, hkey, viewMeta);
                } catch (e) { /* 缓存写失败不阻塞 */ }
              } else {
                results.push({ status: 'degraded', imageId: img.imageId, error: t.error });
              }
            } catch (e) {
              results.push({ status: 'degraded', imageId: img.imageId, error: String((e && e.message) || e) });
            }
          }
          const view = results.filter(r => r.ok).map(r => r.result);
          const degraded = results.filter(r => !r.ok && r.status === 'degraded').map(r => ({ imageId: r.imageId, error: r.error }));
          // visionOk：有图且至少一张成功；全部失败时 markdown 为空、visionOk=false（不静默伪装成功）
          const visionOk = degraded.length < results.length;
          // 供 DeepSeek 与工具消费
          return {
            status: 'success',
            questionId: qid,
            hasImages: true,
            images: view,
            degraded,
            visionOk,
            markdown: renderToMarkdown(view),
            meta: viewMeta
          };
        } catch (e) {
          return { status: 'error', message: 'geoVision.extract 失败：' + (e && e.message ? e.message : e) };
        }
      },
      // 供其他插件/测试：把 GeoVisionResult[] 渲染成 Markdown
      render(results) { return renderToMarkdown(results); }
    };

    // 发布 geoVision 服务（供 analysis.geo_solve 内部消费；同 group 同 isolate realm）
    try {
      ctx.provide('geoVision', api);
    } catch (e) { /* 若 realm 已存在同名服务则忽略，不阻断挂载 */ }
    // 注：V1.2 起不再注册 geo_extract_images 工具——读图统一由 geo_solve 自动带图（vision 字段），
    // 避免"Agent 主动读图"与"solve 自动带图"双入口导致重复调用（决策见 docs/视觉与工作流修复方案.md D2）。

    // ========== 运行时开关路由（UI 面板用） ==========
    webServer.register({
      kind: 'exact',
      path: '/geo/vision/status',
      handler: (req, res) => {
        sendJson(res, 200, {
          enabled: api.enabled,
          provider: FORCE_PROVIDER,
          model: FORCE_MODEL,
          depsOk: !!(llm && attachments)
        });
      }
    });
    webServer.register({
      kind: 'exact',
      path: '/geo/vision/toggle',
      handler: (req, res) => {
        const q = parseQuery(req.url || '/');
        const v = q.enabled;
        if (v !== undefined) {
          // ?enabled=1|true|0|false
          const on = v === '1' || v === 'true';
          if (on && !llm) { sendJson(res, 400, { ok: false, error: 'llm 服务不可用' }); return; }
          if (on && !attachments) { sendJson(res, 400, { ok: false, error: 'attachments 服务不可用' }); return; }
          enabledState = !!on;
          console.log(`geo-vision: 运行时切换 enabled=${enabledState}`);
        }
        sendJson(res, 200, { enabled: api.enabled });
      }
    });
    console.log('geo-vision: /geo/vision/status 与 /geo/vision/toggle 路由已注册');
  }
};
