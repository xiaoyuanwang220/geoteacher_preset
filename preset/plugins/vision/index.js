// GeoTeacher 视觉适配层。
// 通用图像读取、附件持久化、模型调用、缓存、渐进式 OCR/定位和结果校验均由
// 宿主服务 dshVision 负责；本插件只把 VisionResult 映射为 GeoTeacher 既有契约。

const FIELD_BY_KIND = {
  text: 'label',
  number: 'numeric',
  object: 'other',
  symbol: 'symbol',
  relation: 'spatial',
  layout: 'spatial',
  other: 'other'
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function parseQuery(url) {
  const queryIndex = String(url || '').indexOf('?');
  const result = {};
  if (queryIndex < 0) return result;
  for (const pair of String(url).slice(queryIndex + 1).split('&')) {
    if (!pair) continue;
    const equalsIndex = pair.indexOf('=');
    const key = equalsIndex < 0 ? pair : pair.slice(0, equalsIndex);
    const value = equalsIndex < 0 ? '' : pair.slice(equalsIndex + 1);
    result[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return result;
}

function renderToMarkdown(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  return images.map((image) => {
    const lines = [`【图 ${image.imageId} · ${image.caption || '无图注'}】`];
    for (const item of image.observed || []) lines.push(`- ${item.text}`);
    for (const item of image.uncertain || []) {
      lines.push(`- 【不确定】${item.text}${item.reason ? `（${item.reason}）` : ''}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

function safeTaskContext(problem) {
  if (!problem || typeof problem !== 'object') return '';
  const safe = {
    material: problem.material || '',
    questions: Array.isArray(problem.questions)
      ? problem.questions.map((question) => ({
          questionId: question.questionId,
          stem: question.stem,
          options: question.options
        }))
      : []
  };
  return JSON.stringify(safe).slice(0, 8000);
}

function toGeoItem(item) {
  return {
    field: FIELD_BY_KIND[item.kind] || 'other',
    text: item.text,
    modelConfidence: item.confidence,
    reason: item.reason,
    region: item.region,
    trust: item.trust,
    sourceStage: item.sourceStage
  };
}

function mapVisionResult(result, refs) {
  const byAsset = new Map();
  for (const item of result.evidence || []) {
    const index = Number.isInteger(item.assetIndex) ? item.assetIndex : 0;
    const bucket = byAsset.get(index) || { observed: [], uncertain: [] };
    if (item.category === 'observed') bucket.observed.push(toGeoItem(item));
    if (item.category === 'uncertain') bucket.uncertain.push(toGeoItem(item));
    byAsset.set(index, bucket);
  }

  return refs.map((ref, index) => {
    const bucket = byAsset.get(index) || { observed: [], uncertain: [] };
    const asset = Array.isArray(result.assets) ? result.assets[index] : null;
    return {
      imageId: ref.imageId,
      caption: ref.caption || '',
      sourcePath: ref.sourcePath,
      imageType: 'unknown',
      contentType: asset && asset.mediaType,
      observed: bucket.observed,
      uncertain: bucket.uncertain,
      uncertainties: bucket.uncertain.map((item) => item.reason ? `${item.text}(${item.reason})` : item.text)
    };
  });
}

export default {
  name: 'geo-vision-adapter',
  inject: ['geoKernel', 'webServer', 'dshVision'],
  apply(ctx, config = {}) {
    const kernel = ctx.geoKernel;
    const webServer = ctx.webServer;
    const dshVision = ctx.dshVision || ctx.get('dshVision');
    let enabledState = config.enabled !== false && !!dshVision;

    if (config.enabled !== false && !dshVision) {
      console.log('geo-vision-adapter: dshVision 服务不可用，视觉功能处于降级状态');
    }

    const api = {
      get enabled() { return enabledState; },

      async extract(qid, context = {}) {
        if (!enabledState) {
          return { status: 'disabled', questionId: qid, message: 'dshVision unavailable or vision disabled' };
        }
        try {
          const refs = await kernel.imageRefs(qid);
          if (refs.status !== 'success') return refs;
          if (!refs.hasImages) {
            return { status: 'success', questionId: qid, hasImages: false, images: [], visionOk: true, markdown: '' };
          }

          const problem = context.problem || await kernel.questionData(qid);
          const task = [
            '提取这些图片中与题面有关的可直接核对信息，包括文字、数值、图例、符号、线型、布局与空间关系。',
            '不要回答题目，不要生成地理结论；无法可靠辨认的内容标为 uncertain。',
            safeTaskContext(problem)
          ].filter(Boolean).join('\n');

          const result = await dshVision.inspect({
            taskId: `geo-${qid}`,
            inputs: refs.images.map((image) => ({ type: 'path', path: image.sourcePath, name: image.caption || image.imageId })),
            task,
            // GeoTeacher needs one evidence-transcription pass. Avoid the
            // generic auto router's inspect + OCR serial follow-up.
            mode: 'ocr',
            policy: { evidenceOnly: true, allowInference: false }
          });

          if (!result || result.status === 'error') {
            return {
              status: 'degraded',
              questionId: qid,
              hasImages: true,
              visionOk: false,
              error: result && result.degraded && result.degraded[0]
                ? result.degraded[0].error
                : 'dshVision returned no usable result',
              degraded: (result && result.degraded) || []
            };
          }

          const images = mapVisionResult(result, refs.images);
          const markdown = renderToMarkdown(images);
          return {
            status: 'success',
            questionId: qid,
            hasImages: true,
            images,
            degraded: result.degraded || [],
            visionOk: markdown.length > 0,
            markdown,
            meta: result.meta,
            visionResult: {
              schemaVersion: result.schemaVersion,
              taskId: result.taskId,
              operation: result.operation,
              conflicts: result.conflicts || []
            }
          };
        } catch (error) {
          return {
            status: 'error',
            questionId: qid,
            message: `geoVision.extract 失败：${String(error && error.message || error)}`
          };
        }
      },

      render(images) { return renderToMarkdown(images); },
      health() {
        return {
          enabled: enabledState,
          adapter: 'geoVision',
          downstream: dshVision && typeof dshVision.health === 'function' ? dshVision.health() : null
        };
      }
    };

    ctx.provide('geoVision', api);

    webServer.register({
      kind: 'exact',
      path: '/geo/vision/status',
      handler: (_req, res) => sendJson(res, 200, api.health())
    });
    webServer.register({
      kind: 'exact',
      path: '/geo/vision/toggle',
      handler: (req, res) => {
        const value = parseQuery(req.url).enabled;
        if (value !== undefined) {
          const on = value === '1' || value === 'true';
          if (on && !dshVision) {
            sendJson(res, 400, { ok: false, error: 'dshVision 服务不可用' });
            return;
          }
          enabledState = on;
        }
        sendJson(res, 200, { enabled: api.enabled });
      }
    });

    console.log(`geo-vision-adapter: dshVision=${!!dshVision} enabled=${api.enabled}`);
  }
};
