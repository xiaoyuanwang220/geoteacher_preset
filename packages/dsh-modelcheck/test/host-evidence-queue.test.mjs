// host 半边纯函数/队列单测：取证请求的排队、校验、单次有效与超时。不依赖宿主运行时。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EvidenceQueue,
  validateEvidenceResponse,
  stableJson
} from '../server/evidence-queue.js';

function baseResponse(request, overrides = {}) {
  return {
    requestId: request.requestId,
    projectId: request.projectId,
    sessionId: request.sessionId,
    buildHash: request.expected.buildHash,
    sourceHash: request.expected.sourceHash,
    adapterVersion: 'modelcheck-adapter/1',
    context: request.context,
    components: { 'nh-trade-winds': { visible: true, worldPosition: { x: 0, y: 0, z: 0 } } },
    coverage: [],
    errors: [],
    capturedAt: '2026-10-22T00:00:00.000Z',
    ...overrides
  };
}

test('stableJson：键顺序无关', () => {
  assert.equal(stableJson({ a: 1, b: ['x', { c: 2, d: 3 }] }), stableJson({ b: ['x', { d: 3, c: 2 }], a: 1 }));
});

test('validateEvidenceResponse：合法响应通过并规范化', () => {
  const request = {
    requestId: 'mc-1',
    sessionId: 's1',
    projectId: 'p1',
    expected: { buildHash: 'b1', sourceHash: 's1h' },
    context: { step: 'end', mode: 'normal' }
  };
  const checked = validateEvidenceResponse(baseResponse(request), request);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.buildHash, 'b1');
  assert.equal(checked.value.evidenceKind, 'runtime');
  assert.deepEqual(checked.value.errors, []);
});

test('validateEvidenceResponse：requestId / 会话 / 项目 / 构建哈希 / 上下文不符都拒绝', () => {
  const request = {
    requestId: 'mc-1',
    sessionId: 's1',
    projectId: 'p1',
    expected: { buildHash: 'b1', sourceHash: 's1h' },
    context: { step: 'end' }
  };
  assert.equal(validateEvidenceResponse(baseResponse(request, { requestId: 'mc-old' }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { sessionId: 's2' }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { projectId: 'p2' }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { buildHash: 'old-build' }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { context: { step: 'start' } }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { components: null }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { adapterVersion: '' }), request).ok, false);
  assert.equal(validateEvidenceResponse(baseResponse(request, { capturedAt: undefined }), request).ok, false);
  assert.equal(validateEvidenceResponse(null, request).ok, false);
  // 没有构建哈希时不比对该字段
  const loose = { ...request, expected: { buildHash: null, sourceHash: null } };
  assert.equal(validateEvidenceResponse(baseResponse(request), loose).ok, true);
});

test('队列：poll 取请求 → submit 回填 → promise 收到证据；二次提交被拒', async () => {
  const queue = new EvidenceQueue();
  const promise = queue.createRequest({
    sessionId: 's1',
    projectId: 'p1',
    expected: { buildHash: 'b1', sourceHash: 'h1' },
    components: [{ id: 'c1', pick: '[data-mc-id="c1"]' }],
    context: { step: 'end' },
    timeoutMs: 5000
  });
  const polled = await queue.poll('s1', 0);
  assert.ok(polled.request);
  assert.equal(polled.request.requestId.length > 0, true);
  assert.equal(polled.request.components[0].id, 'c1');
  assert.equal(queue.panelOnline('s1'), true);

  const accepted = queue.submit('s1', baseResponse(polled.request));
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true);
  const evidence = await promise;
  assert.equal(evidence.components['nh-trade-winds'].visible, true);

  const again = queue.submit('s1', baseResponse(polled.request));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'unknown-request');
  queue.dispose();
});

test('队列：构建哈希不符 → 拒绝且 promise 得到 null（判据 inconclusive）', async () => {
  const queue = new EvidenceQueue();
  const promise = queue.createRequest({
    sessionId: 's1',
    projectId: 'p1',
    expected: { buildHash: 'b1', sourceHash: 'h1' },
    context: {},
    timeoutMs: 5000
  });
  const polled = await queue.poll('s1', 0);
  const rejected = queue.submit('s1', baseResponse(polled.request, { buildHash: 'old-build' }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'evidence-rejected');
  assert.equal(await promise, null);
  assert.equal(queue.pendingCount('s1'), 0);
  queue.dispose();
});

test('队列：长轮询在请求入队后被唤醒', async () => {
  const queue = new EvidenceQueue();
  const waiting = queue.poll('s1', 3000);
  setTimeout(() => {
    queue.createRequest({ sessionId: 's1', projectId: 'p1', expected: {}, context: {}, timeoutMs: 5000 });
  }, 20);
  const result = await waiting;
  assert.ok(result.request, '长轮询应取到后入队的请求');
  queue.dispose();
});

test('队列：超时返回 null，之后到达的响应成为 stale 被拒', async () => {
  const queue = new EvidenceQueue();
  const promise = queue.createRequest({ sessionId: 's1', projectId: 'p1', expected: {}, context: {}, timeoutMs: 1000 });
  const polled = await queue.poll('s1', 0);
  const value = await promise; // 最少 1000ms 后超时
  assert.equal(value, null);
  const late = queue.submit('s1', baseResponse(polled.request));
  assert.equal(late.ok, false);
  assert.equal(late.code, 'unknown-request');
  queue.dispose();
});

test('validateEvidenceResponse：静态单状态页可声明不可观测上下文（fail-closed 仅限静态页）', () => {
  const request = {
    requestId: 'mc-static',
    sessionId: 's1',
    projectId: 'p1',
    expected: { buildHash: 'b1', sourceHash: 'h1' },
    context: { step: 'end', mode: 'normal', view: 'default' }
  };
  const staticContext = {
    route: 'svg', viewport: { width: 1280, height: 720 }, static: true,
    unobservable: ['step', 'mode', 'view']
  };
  const staticResponse = baseResponse(request, { context: staticContext });
  assert.equal(validateEvidenceResponse(staticResponse, request).ok, true);

  // 动态页面（three）不允许用同一豁免：static 必须为 false → 仍判不符
  const dynamicResponse = baseResponse(request, {
    context: { ...staticContext, static: false }
  });
  assert.equal(validateEvidenceResponse(dynamicResponse, request).ok, false);

  // 未声明不可观测的键仍须严格一致（step 观测到 start，与请求 end 不符）
  const partial = baseResponse(request, {
    context: { static: true, unobservable: ['mode', 'view'], step: 'start', mode: 'normal', view: 'default' }
  });
  assert.equal(validateEvidenceResponse(partial, request).ok, false);
});

test('队列：dispose 后等待中的取证请求得到 null，不再挂起', async () => {
  const queue = new EvidenceQueue();
  const promise = queue.createRequest({ sessionId: 's1', projectId: 'p1', expected: {}, context: {}, timeoutMs: 30000 });
  queue.dispose();
  assert.equal(await promise, null);
});
