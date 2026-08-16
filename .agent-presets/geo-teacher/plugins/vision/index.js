// GeoTeacher Agent — 视觉预处理插件（geo-vision，V1）
// 分层职责：
//   · Qwen3.6 Plus      = 视觉模型 Provider（只读图转 JSON，不做解题推理）
//   · geoVision 服务     = 底层业务 Service：读图 → Qwen JSON → schema 校验 → 生产 GeoVisionResult
//                          → imageHash 缓存 + index → run 日志 → 降级。供内部消费者复用。
//   · geo_extract_images = 给 DeepSeek 主 Agent 的工具薄壳（execute 仅调 geoVision.extract(qid)）。
// geo_solve（analysis）将来直接调 geoVision.extract(qid)，不绕经本工具。
// 注意：不 import 宿主包/第三方（C: 用户根无 node_modules）；Qwen JSON 用轻量手写校验，不用 zod。
// 配置（vision.enabled 默认关）：provider / model(Qwen3.6 Plus) / promptVersion / schemaVersion /
//                              cacheDir(outputs\visionCache) / maxBytesPerImage。

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

export default {
  name: 'geo-vision',
  inject: ['fs', 'tools', 'geoKernel'],
  apply(ctx, config) {
    const fsService = ctx.fs;
    // llm 是可选的（host 服务，可能在 isolate 组内不可 resolve）。缺失时 geoVision 不启用。
    const llm = ctx.get('llm');
    const kernel = ctx.geoKernel;
    const cfg = config || {};
    const ENABLED = !!cfg.enabled && !!llm;
    const CACHE_DIR = cfg.cacheDir || 'E:/geo_edu_agent/outputs/visionCache';
    const MAX_BYTES = cfg.maxBytesPerImage || 8 * 1024 * 1024; // 8MB
    const PROMPT_VERSION = cfg.promptVersion || DEFAULT_PROMPT_VERSION;
    const SCHEMA_VERSION = cfg.schemaVersion || DEFAULT_SCHEMA_VERSION;
    const FORCE_PROVIDER = cfg.provider || '';
    const FORCE_MODEL = cfg.model || 'Qwen3.6 Plus';

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

    // 自动发现：provider 路由名 + 模型 id（找 Qwen3.6 Plus）
    function enumerateProviders() {
      try { return llm.listProviders() || []; } catch (e) { return []; }
    }
    function providerKey(p) {
      if (!p) return '';
      if (typeof p === 'string') return p;
      return p.name || p.id || p.provider || p.key || '';
    }
    async function resolveVisionModel() {
      // 优先配置指定 provider
      if (FORCE_PROVIDER) return { provider: FORCE_PROVIDER, model: FORCE_MODEL, source: 'config' };
      const providers = enumerateProviders();
      // 找含 qwen / opencode 的 provider
      let pick = providers.find(p => /qwen/i.test(providerKey(p))) ||
                 providers.find(p => /opencode/i.test(providerKey(p))) ||
                 providers[0];
      if (!pick) return null;
      const pk = providerKey(pick);
      try {
        const models = await llm.listModels(pk);
        if (Array.isArray(models)) {
          // 找 Qwen3.6 Plus 精确 id
          let model = models.find(m => /Qwen3\.6\s*Plus/i.test(String(m && (m.id || m.name || m.model))));
          if (!model) model = models.find(m => /qwen/i.test(String(m && (m.id || m.name || m.model))));
          if (model) return { provider: pk, model: (model.id || model.name || model.model), source: 'auto' };
        }
        // 列表都取不到精确 id，退回配置默认名，让 run 记录候选清单便于排查
        return { provider: pk, model: FORCE_MODEL, source: 'auto-fallback', candidates: models };
      } catch (e) {
        return { provider: pk, model: FORCE_MODEL, source: 'auto-err', error: String((e && e.message) || e) };
      }
    }

    async function readImageBase64(sourcePath) {
      const target = await fsService.resolve(sourcePath);
      const bytes = await fsService.readBytes(target, null, MAX_BYTES);
      if (!bytes || !bytes.length) throw new Error('empty image bytes');
      return bytes; // Uint8Array
    }
    function bytesToBase64(bytes) {
      // 用 TextDecoder/二进制安全的方式
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    function imageContentType(path) {
      const ext = String(path).split('.').pop().toLowerCase();
      return ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : 'image/png';
    }

    // ========== single image: Qwen JSON -> 生产 GeoVisionResult ==========
    async function transcribeOne(img, visionModel) {
      const start = Date.now();
      const base = {
        ts: new Date().toISOString(), imageId: img.imageId, sourcePath: img.sourcePath,
        provider: visionModel.provider, model: visionModel.model, cacheHit: false,
        status: 'failed', schemaOk: null
      };
      // 读图
      let b64, contentType;
      try {
        const bytes = await readImageBase64(img.sourcePath);
        b64 = bytesToBase64(bytes);
        contentType = imageContentType(img.sourcePath);
      } catch (e) {
        await appendRun({ ...base, error: 'read_image: ' + (e && e.message || e), durationMs: (Date.now() - start) });
        return { status: 'degraded', imageId: img.imageId, error: 'read_image: ' + (e && e.message || e) };
      }

      const prompt = buildTranscribePrompt();
      const content = [
        { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
        { type: 'text', text: prompt }
      ];
      const messages = [{ role: 'user', content }];

      // 调 llm.stream 收集极简全文（仅取文本增量）
      let rawText = '';
      try {
        const gen = llm.stream({ provider: visionModel.provider, model: visionModel.model, messages });
        for await (const chunk of gen) {
          // StreamChunk 形态依 DSH 而定；尽量取 text/增量
          const t = chunk && (chunk.text !== undefined ? chunk.text : chunk.delta !== undefined ? chunk.delta : (typeof chunk === 'string' ? chunk : ''));
          if (t) rawText += t;
        }
      } catch (e) {
        await appendRun({ ...base, error: 'llm_stream: ' + (e && e.message || e), durationMs: (Date.now() - start) });
        return { status: 'degraded', imageId: img.imageId, error: 'llm_stream: ' + (e && e.message || e) };
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
      const bytes = await readImageBase64(sourcePath);
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
      enabled: ENABLED,
      // 生产视图：对每张图做可见提取 -> GeoVisionResult[]；失败单图降级、不阻塞整批
      async extract(qid) {
        if (!ENABLED) return { status: 'disabled', message: 'vision.enabled=false' };
        try {
          const refs = await kernel.imageRefs(qid);
          if (refs.status !== 'success' || !refs.hasImages) {
            return { status: 'success', questionId: qid, hasImages: false, images: [] };
          }
          const visionModel = await resolveVisionModel();
          if (!visionModel) {
            const runs = { providers: enumerateProviders() };
            await appendRun({ ts: new Date().toISOString(), imageId: refs.images[0].imageId, sourcePath: refs.images[0].sourcePath, provider: '', model: '', cacheHit: false, durationMs: 0, status: 'degraded', schemaOk: null, error: 'no_vision_model: ' + JSON.stringify(runs.providers) });
            return { status: 'degraded', questionId: qid, error: 'no_vision_model', providers: runs.providers };
          }
          if (!Array.isArray(visionModel.candidates)) visionModel.candidates = undefined;
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
                results.push(parsed.result);
                continue;
              }
              const t = await transcribeOne(img, visionModel);
              if (t.status === 'success') {
                results.push(t.result);
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
          const view = results.map(r => r.result ? r.result : null).filter(Boolean);
          // 供 DeepSeek 与工具消费
          return {
            status: 'success',
            questionId: qid,
            hasImages: true,
            images: view,
            degraded: results.filter(r => r.status === 'degraded').map(r => ({ imageId: r.imageId, error: r.error })),
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

    // 发布 geoVision 服务（供 analysis.geo_solve、工具薄壳消费；同 group 同 isolate realm）
    try {
      ctx.provide('geoVision', api);
    } catch (e) { /* 若 realm 已存在同名服务则忽略，不阻断挂载 */ }

    // ========== Agent 工具薄壳（与其它 geo 插件一致：直接 register） ==========
    ctx.tools.register({
      name: 'geo_extract_images',
      description: '读图转录：解析指定题目的图片，用视觉模型(Qwen3.6 Plus)提取图中可观察信息为结构化结果（含图例/数值/符号/空间关系等）。返回每张图的 GeoVisionResult + Markdown；供 DeepSeek 在图类型直观判断或需引图信息时调用。不含任何解题推理（推理由 DeepSeek 完成）。',
      parameters: {
        type: 'object',
        properties: {
          qid: { type: 'string', description: '题目 ID（如 2025-安徽-地理-...-Q17-1）' }
        },
        required: ['qid']
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          const text = JSON.stringify(value, null, 2);
          const capped = String(text).length > 16000 ? String(text).slice(0, 16000) + '\n...[截断]' : text;
          return [{ type: 'text', text: capped }];
        }
      },
      async execute(args) {
        const result = await api.extract(args.qid);
        return result;
      }
    });
  }
};
