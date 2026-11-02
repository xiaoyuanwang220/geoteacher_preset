// ModelCheck —— 工具层集成测试（不启动 DSH、不改 profile）
//
// 用最小 ctx 装配 index.js，再用真实的 7 个工具对夹具项目副本执行：
// 项目识别、配置类判据、运行时判据 fail-closed、完成门禁拒绝、轮次预算、标注/组件读取。
// 运行时不取证（ctxFactory 无面板）→ 几何判据必须是 inconclusive，而不是 pass。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import plugin from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'project');

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), 'modelcheck-tools-'));
  await cp(FIXTURE, root, { recursive: true });
  const routes = [];
  const tools = new Map();
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') {
        return {
          ensure: async () => root,
          get: () => root,
          defaultDirectory: root,
          set: async () => root
        };
      }
      return undefined;
    },
    on() { return () => {}; },
    effect(callback) { callback(); return () => {}; },
    webServer: {
      getOrigin() { return 'http://127.0.0.1:0'; },
      register(route) { routes.push(route); return () => {}; }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => {};
      }
    }
  };
  plugin.apply(ctx);
  const exec = { agent: { id: 'session-test-tools' }, signal: new AbortController().signal };
  return { root, tools, routes, exec };
}

function parseToolResult(raw) {
  // 工具返回对象；这里只做断言用的浅拷贝，避免依赖具体渲染。
  assert.ok(raw && typeof raw === 'object', '工具应返回对象');
  return raw;
}

test('工具层：识别夹具项目并列出组件', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  const status = parseToolResult(await harness.tools.get('modelcheck_status').execute({}, harness.exec));
  assert.equal(status.status, 'ok');
  assert.equal(status.project.projectId, 'fixture-circulation');
  assert.equal(status.contract.confirmed, true);

  const components = parseToolResult(await harness.tools.get('modelcheck_components').execute({ action: 'list' }, harness.exec));
  assert.equal(components.status, 'ok');
  assert.equal(components.components.length, 2);
  assert.ok(components.components.every((item) => typeof item.fingerprint === 'string' || item.id));
});

test('工具层：verify 复现闭合 0.035 fail 与方向缺证据 inconclusive', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  const verify = parseToolResult(await harness.tools.get('modelcheck_verify').execute({ timeoutMs: 1000, allowOffline: true }, harness.exec));
  assert.equal(verify.status, 'ok');
  const results = verify.evaluation.results;

  // 纯配置判据可独立得到 pass。
  assert.equal(results['GEO-TEXT-01'].status, 'pass');
  // 运行时判据在没有面板取证时必须 inconclusive，不得被配置值替代。
  assert.equal(results['GEO-CLOSE-01'].status, 'inconclusive');
  assert.equal(results['GEO-DIR-01'].status, 'inconclusive');
  assert.match(results['GEO-CLOSE-01'].detail, /运行时取证|取证/);
  assert.equal(verify.runtime.responses, 0);
});

test('工具层：complete 拒绝未认证并给出阻塞与补救指令', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  await harness.tools.get('modelcheck_verify').execute({ timeoutMs: 1000, allowOffline: true }, harness.exec);
  const complete = parseToolResult(await harness.tools.get('modelcheck_complete').execute({}, harness.exec));
  const report = complete.completion || complete;
  assert.equal(report.certified, false);
  assert.ok(Array.isArray(report.blocking) && report.blocking.length > 0, '应列出阻塞项');
  assert.ok(report.blocking.some((item) => item.id === 'GEO-CLOSE-01'), '闭合判据应阻塞');
  const serialized = JSON.stringify(report);
  assert.match(serialized, /补救|remedy|inconclusive|未取得/);
  // 不认证时不应写 certification.json 为已认证。
  const certPath = join(harness.root, '.modelcheck', 'certification.json');
  if (existsSync(certPath)) {
    const cert = JSON.parse(await readFile(certPath, 'utf8'));
    assert.notEqual(cert.certified, true);
  }
});

test('工具层：round 记录轮次并返回预算判定', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  const round = parseToolResult(await harness.tools.get('modelcheck_round').execute({
    phase: 'dev',
    target: '闭合缝',
    metricBefore: 0.035,
    metricAfter: 0.028,
    strategy: '调整端点坐标',
    newPass: true
  }, harness.exec));
  assert.equal(round.status, 'ok');
  assert.ok(round.verdict && typeof round.verdict.action === 'string');
  assert.ok(['continue', 'remind', 'forbid-strategy', 'stop'].includes(round.verdict.action));
  assert.ok(typeof round.verdict.message === 'string' && round.verdict.message.length > 0);
  assert.ok(round.recovery || round.ladder || round.verdict.message);
});

test('工具层：annotations 与 contract 读取不伪造确认', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  const annotations = parseToolResult(await harness.tools.get('modelcheck_annotations').execute({ action: 'list' }, harness.exec));
  assert.equal(annotations.status, 'ok');
  assert.deepEqual(annotations.pending, []);

  const contract = parseToolResult(await harness.tools.get('modelcheck_contract').execute({ action: 'read' }, harness.exec));
  assert.equal(contract.status, 'ok');
  assert.equal(contract.contract.status, 'confirmed');
  // 工具面没有、也不接受用户确认字段。
  const schema = JSON.stringify(harness.tools.get('modelcheck_contract').parameters);
  assert.doesNotMatch(schema, /confirmedBy/);
  assert.doesNotMatch(schema, /confirmedAt/);
});

/** 以指定目录作为会话工作目录装配插件（用于 init / 多项目场景）。 */
function createRootHarness(root, sessionId) {
  const tools = new Map();
  const ctx = {
    get(name) {
      if (name === 'workingDirectory') {
        return { ensure: async () => root, get: () => root, defaultDirectory: root, set: async () => root };
      }
      return undefined;
    },
    on() { return () => {}; },
    effect(callback) { callback(); return () => {}; },
    webServer: { getOrigin: () => 'http://127.0.0.1:0', register: () => () => {} },
    tools: { register(definition) { tools.set(definition.name, definition); return () => {}; } }
  };
  plugin.apply(ctx);
  const exec = { agent: { id: sessionId || 'session-test-init' }, signal: new AbortController().signal };
  return { root, tools, exec };
}

test('工具层：modelcheck_init 扫描多模型工作区、初始化并绑定会话项目', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'modelcheck-init-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const demo = join(work, 'models', 'demo');
  await mkdir(join(demo, 'src'), { recursive: true });
  await writeFile(join(demo, 'package.json'), JSON.stringify({ name: 'demo-model', description: '演示模型' }), 'utf8');
  await writeFile(join(demo, 'index.html'), '<html><body><svg><path data-mc-id="wind" data-mc-label="信风" d="M0,0 L10,10"/></svg></body></html>', 'utf8');
  await writeFile(join(demo, 'src', 'app.js'), "const arrow = {}; arrow.name = '北半球信风';\n", 'utf8');

  const harness = createRootHarness(work, 'session-init-demo');
  const init = harness.tools.get('modelcheck_init');
  assert.ok(init, '应注册 modelcheck_init 工具');

  const scan = parseToolResult(await init.execute({ action: 'scan' }, harness.exec));
  assert.equal(scan.status, 'ok');
  assert.equal(scan.mode, 'workspace');
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].relativeRoot, 'models/demo');

  const applied = parseToolResult(await init.execute({ action: 'apply', path: 'models/demo' }, harness.exec));
  assert.equal(applied.status, 'ok');
  assert.ok(applied.written.includes('config.json'));
  assert.ok(applied.written.includes('components.json'));
  assert.ok(existsSync(join(demo, '.modelcheck', 'config.json')));
  assert.equal(applied.selected, true);

  // 初始化后，同一会话的 modelcheck_status 应能直接看到该项目（不依赖 cwd 向上查找）。
  const status = parseToolResult(await harness.tools.get('modelcheck_status').execute({}, harness.exec));
  assert.equal(status.status, 'ok');
  assert.equal(status.project.projectId, 'demo-model');
  assert.equal(status.contract.confirmed, false);

  // 幂等：再次 apply 不覆盖。
  const again = parseToolResult(await init.execute({ action: 'apply', path: 'models/demo' }, harness.exec));
  assert.equal(again.status, 'ok');
  assert.deepEqual(again.written, []);
  assert.equal(again.skipped.length, 2);
});

test('工具层：modelcheck_contract action=scaffold 生成待用户确认的契约草稿', async (t) => {
  const work = await mkdtemp(join(tmpdir(), 'modelcheck-contract-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const demo = join(work, 'demo');
  await mkdir(join(demo, 'src'), { recursive: true });
  await writeFile(join(demo, 'index.html'), '<html><body><svg><path data-mc-id="wind" d="M0,0 L10,10"/></svg></body></html>', 'utf8');
  await writeFile(join(demo, 'src', 'app.js'), "export const LABEL = '北半球信风';\n", 'utf8');

  const harness = createRootHarness(work, 'session-contract-demo');
  await harness.tools.get('modelcheck_init').execute({ action: 'apply', path: 'demo' }, harness.exec);
  const scaffold = parseToolResult(await harness.tools.get('modelcheck_contract').execute({
    action: 'scaffold',
    sourceDocs: [],
    criteria: [{
      claim: '教学数据包含「北半球信风」命名',
      rule: { kind: 'text', file: 'src/app.js', mode: 'matches', pattern: '北半球信风' }
    }]
  }, harness.exec));
  assert.equal(scaffold.status, 'ok');
  assert.equal(scaffold.written, 'contract.proposed.json');
  assert.equal(scaffold.requiresUserConfirmation, true);
  assert.equal(scaffold.criteriaCount, 1);
  assert.ok(existsSync(join(demo, '.modelcheck', 'contract.proposed.json')));

  const read = parseToolResult(await harness.tools.get('modelcheck_contract').execute({ action: 'read' }, harness.exec));
  assert.equal(read.status, 'ok');
  assert.ok(read.proposed && read.proposed.contract, '应能读回待确认草稿');
  assert.equal(read.proposed.contract.status, 'proposed');

  // scaffold 不接受“确认”字段；草稿仍是 proposed。
  const draft = read.proposed.contract;
  assert.notEqual(draft.status, 'confirmed');
  assert.equal(draft.confirmedBy, undefined);
});

test('工具层：verify 面板离线时立即 blocked；dryRun 只列证据要求', async (t) => {
  const harness = await createHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));

  // 夹具契约是 confirmed，且含运行时判据；没有面板轮询时必须立刻说明原因，而不是等 8s 超时。
  const blocked = parseToolResult(await harness.tools.get('modelcheck_verify').execute({ timeoutMs: 1000 }, harness.exec));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /面板|取证/);
  assert.match(blocked.remedy, /标注/);
  assert.ok(Array.isArray(blocked.runtimeCriteria) && blocked.runtimeCriteria.length > 0);
  assert.ok(blocked.readiness && Array.isArray(blocked.readiness.checks));

  // dryRun 不执行、不等待，只返回需要什么证据。
  const dry = parseToolResult(await harness.tools.get('modelcheck_verify').execute({ dryRun: true }, harness.exec));
  assert.equal(dry.status, 'ok');
  assert.equal(dry.dryRun, true);
  assert.ok(dry.criteria.length >= 3);
  assert.ok(dry.runtimeCriteria.includes('GEO-CLOSE-01'));
  assert.ok(dry.criteria.every((criterion) => criterion.requiredEvidence === null || typeof criterion.requiredEvidence === 'string'));
});
