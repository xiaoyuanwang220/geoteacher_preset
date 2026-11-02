// 考点树解析的归一化契约（node --test test/taxonomy-parse.test.mjs）
//
// 背景（2026-10-20 运行时实测暴露）：`/geo/taxonomy/meta` 返回 `needsReview` 为**全部 162 个节点**，
// 而逐个查 `needs_review` 却是字符串 `"false"`。原因是降级解析路径
// `parseTaxonomyDocumentLegacy` 只做 `current[field] = unquoteScalar(raw)`，
// `needs_review: false` 留成字符串 "false"——非空字符串为真，于是
// `filter(n => n.needs_review)` 命中所有节点。
//
// 后果不只是元数据不准：出题流程要靠 needs_review 判断「哪些考点不得无提示地交付」，
// 全部标成待复核等于让每一次出题都撞上这条红线。
//
// 这组测试锁住两条可观察契约，与具体走 YAML 还是降级解析无关：
//   1) 节点上的 needs_review 必须是布尔；
//   2) meta.needsReview 只包含 needs_review 为真的节点。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import core from '../.agent-presets/geo-teacher/plugins/core/index.js';

// 与真实 taxonomy 文件同构的最小夹具：meta 段 + nodes 段，缩进与字段层一致。
const FIXTURE = `meta:
  version: v0.0-test
  status: draft
  constructed_at: 2026-10-20

nodes:
  - id: KU-TEST-001
    level: knowledge_unit
    name: 测试节点甲
    parent_id: null
    definition: 用于校验归一化的测试节点。
    includes:
      - 子项一
      - 子项二
    excludes: []
    aliases: []
    status: draft
    confidence: high
    needs_review: false
    review_note: ""

  - id: KU-TEST-002
    level: knowledge_unit
    name: 测试节点乙
    parent_id: null
    definition: 待复核的测试节点。
    includes: []
    excludes:
      - 不属于本节点
    aliases: []
    status: draft
    confidence: medium
    needs_review: true
    review_note: "边界待确认"
`;

function bootWithFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'geo-tax-parse-'));
  const file = join(dir, 'knowledge_taxonomy_fixture.yaml');
  writeFileSync(file, FIXTURE, 'utf8');

  const fsMock = {
    resolve: async (p) => ({ path: p }),
    listDir: async () => [{ name: 'knowledge_taxonomy_fixture.yaml', target: { path: file } }],
    readText: async (t) => readFileSync(t.path, 'utf8'),
    writeText: async () => {},
  };

  let api = null;
  const ctx = {
    fs: fsMock,
    webServer: {
      register() {}, registerUpgrade() {}, registerFallback() {},
      tapIndex() { return () => {}; },
    },
    provide(name, value) { if (name === 'geoKernel') api = value; },
    get() { return undefined; },
    on() { return () => {}; },
    effect(cb) { try { return cb(); } catch { /* 忽略 */ } },
    tools: { register() {} },
  };
  core.apply(ctx, { knowledgeBasePath: dir, outputPath: join(dir, 'outputs'), workspaceRoot: dir });
  assert.ok(api, 'core 未提供 geoKernel 服务');
  return { api, dir };
}

describe('考点树解析：needs_review 必须归一到布尔', () => {
  test('节点上的 needs_review 是布尔，且 true/false 各自正确', async () => {
    const { api, dir } = bootWithFixture();
    try {
      const a = await api.getTaxonomy({ ids: ['KU-TEST-001'] });
      assert.equal(a.status, 'success');
      assert.equal(a.matches.length, 1);
      assert.equal(typeof a.matches[0].needs_review, 'boolean',
        'needs_review 必须是布尔；降级解析曾把它留成字符串 "false"');
      assert.equal(a.matches[0].needs_review, false);

      const b = await api.getTaxonomy({ ids: ['KU-TEST-002'] });
      assert.equal(typeof b.matches[0].needs_review, 'boolean');
      assert.equal(b.matches[0].needs_review, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('meta.needsReview 只列 needs_review 为真的节点，不是整棵树', async () => {
    const { api, dir } = bootWithFixture();
    try {
      const res = await api.getTaxonomy({});
      assert.ok(Array.isArray(res.meta.needsReview), 'meta.needsReview 应为数组');
      assert.deepEqual(res.meta.needsReview, ['KU-TEST-002'],
        'needs_review=false 的节点不得进入 meta.needsReview（曾被全量列出）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('两条解析路径产出的节点形态一致（含 includes/excludes 列表）', async () => {
    const { api, dir } = bootWithFixture();
    try {
      const a = await api.getTaxonomy({ ids: ['KU-TEST-001'] });
      const n = a.matches[0];
      assert.deepEqual(n.includes, ['子项一', '子项二'], 'includes 应解析为列表');
      assert.deepEqual(n.excludes, [], 'excludes: [] 应解析为空列表');
      assert.deepEqual(n.aliases, []);
      assert.equal(n.name, '测试节点甲');
      assert.equal(n.definition, '用于校验归一化的测试节点。');
      assert.equal(typeof n.id, 'string');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('元数据带逐文件版本与状态（不假设四份同版）', async () => {
    const { api, dir } = bootWithFixture();
    try {
      const res = await api.getTaxonomy({});
      assert.ok(Array.isArray(res.sources) && res.sources.length === 1);
      assert.equal(res.sources[0].version, 'v0.0-test');
      assert.equal(res.sources[0].status, 'draft');
      assert.match(res.sources[0].contentHash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(res.meta.finalised, false, 'draft 状态不得被当成定稿');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
