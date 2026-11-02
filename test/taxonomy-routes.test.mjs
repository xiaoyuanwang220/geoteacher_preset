// 考点树路由的行为测试（node --test test/taxonomy-routes.test.mjs）
//
// 背景（2026-10-20 桌面实测暴露的真实缺陷）：`/geo/taxonomy/meta` 与 `/geo/taxonomy/query`
// 返回 500，正文 `res.writeHead is not a function`。原因是 case 块内
// `const res = await kernel.getTaxonomy()` 遮蔽了 HTTP 响应对象 `res`，
// 于是 `sendJson(res, …)` 拿到的是内核结果对象。
//
// 为什么一直没被发现：M1 当时只在**未重启**的进程里探测到 404（插件还没加载），
// 于是把这条记为「待重启后确认」；重启后第一次真实探测才发现不是 404 而是 500。
// 「未加载」和「加载了但执行抛错」是两种完全不同的状态，404 不能作为前者的证明。
//
// 这组测试锁住三件事：路由不得 500；返回体就是内核载荷；内核报错时如实 503。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import plugin from '../.agent-presets/geo-teacher/plugins/taxonomy/index.js';

const OK_KERNEL = {
  async getTaxonomy(opts = {}) {
    const targeted = Boolean(opts.ids || opts.query);
    return {
      status: 'success',
      matchKind: targeted ? 'exact' : 'tree',
      meta: { taxonomyVersions: [{ file: 'x.yaml', version: 'v0.2-draft' }] },
      sources: [{ file: 'x.yaml', version: 'v0.2-draft', status: 'draft', parser: 'legacy' }],
      errors: [],
      roots: [{ id: 'DM-NAT', level: 'domain', name: '自然地理', children: [] }],
      matches: targeted ? [{ id: 'KU-NAT-ATM-HEAT-005', name: '大气热力环流' }] : [],
    };
  },
  async getTaxonomyTree() {
    return [{ id: 'DM-NAT', level: 'domain', name: '自然地理', children: [] }];
  },
};

const ERR_KERNEL = {
  async getTaxonomy() {
    return { status: 'error', message: '考点库不可读', errors: [{ file: 'x.yaml', kind: 'read', message: 'ENOENT' }] };
  },
  async getTaxonomyTree() { return []; },
};

function boot(kernel) {
  let route = null;
  const ctx = {
    webServer: { register(r) { route = r; return () => {}; } },
    geoKernel: kernel,
    tools: { register() { return () => {}; } },
  };
  plugin.apply(ctx, {});
  assert.ok(route, '未注册 /geo/taxonomy 路由');
  return route;
}

/** 用假的 req/res 调一次路由，返回 { status, body }。 */
async function call(route, url) {
  const out = { status: 0, raw: null };
  const res = {
    writeHead(status) { out.status = status; },
    end(body) { out.raw = body; },
  };
  await route.handler({ url }, res);
  out.body = typeof out.raw === 'string' ? JSON.parse(out.raw) : null;
  return out;
}

describe('考点树路由：不得 500，返回体就是内核载荷', () => {
  test('meta 返回 200 且带 sources 与 meta', async () => {
    const r = await call(boot(OK_KERNEL), '/geo/taxonomy/meta');
    assert.equal(r.status, 200, 'meta 不得 500（历史上的 res 遮蔽缺陷）：' + r.raw);
    assert.equal(r.body.status, 'success');
    assert.ok(Array.isArray(r.body.sources) && r.body.sources.length > 0, '应带逐文件 sources');
    assert.ok(r.body.meta, '应带 meta');
  });

  test('query 带 ids 返回 200 且原样回传内核载荷', async () => {
    const r = await call(boot(OK_KERNEL), '/geo/taxonomy/query?ids=KU-NAT-ATM-HEAT-005');
    assert.equal(r.status, 200, 'query 不得 500：' + r.raw);
    assert.equal(r.body.matchKind, 'exact');
    assert.ok(Array.isArray(r.body.matches) && r.body.matches.length > 0);
  });

  test('query 带 q 也能走通', async () => {
    const r = await call(boot(OK_KERNEL), '/geo/taxonomy/query?q=热力环流');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'success');
  });

  test('tree 仍返回 200（旧消费者不回归）', async () => {
    const r = await call(boot(OK_KERNEL), '/geo/taxonomy/tree');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('考点库不可读时 meta 如实返回 503，而不是 500 或 success', async () => {
    const r = await call(boot(ERR_KERNEL), '/geo/taxonomy/meta');
    assert.equal(r.status, 503);
    assert.equal(r.body.status, 'error');
  });

  test('未知 action 返回 404', async () => {
    const r = await call(boot(OK_KERNEL), '/geo/taxonomy/nope');
    assert.equal(r.status, 404);
  });

  test('全部 action 在运行期都不触发 500', async () => {
    const route = boot(OK_KERNEL);
    for (const u of ['/geo/taxonomy/meta', '/geo/taxonomy/query?q=x', '/geo/taxonomy/tree', '/geo/taxonomy/node?id=DM-NAT', '/geo/taxonomy/nope']) {
      const r = await call(route, u);
      assert.notEqual(r.status, 500, u + ' 触发了 500：' + r.raw);
    }
  });
});
