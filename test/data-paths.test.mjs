import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import core from '../.agent-presets/geo-teacher/plugins/core/index.js';
import bank from '../.agent-presets/geo-teacher/plugins/bank/index.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'geo-path-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\geo-path-test-') ||
      resolve(root).startsWith(resolve(tmpdir()) + '/geo-path-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const configDir = join(root, 'geo-teacher');
  const knowledge = join(configDir, 'knowledge');
  const questions = join(configDir, 'bank');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(questions, { recursive: true });
  fs.writeFileSync(join(knowledge, 'knowledge_taxonomy_test.yaml'),
    'meta:\n  version: test\n  status: draft\nnodes:\n  - id: KU-TEST\n    level: knowledge_unit\n    name: 热力环流\n');
  const config = { knowledgeBasePath: './knowledge', questionBankPath: './bank', outputPath: './outputs', workspaceRoot: '.' };
  function writeConfig(value = config, bom = false) {
    fs.writeFileSync(join(configDir, 'config.json'), (bom ? '\uFEFF' : '') + JSON.stringify(value));
  }
  const service = {
    resolve: async p => p,
    listDir: async p => fs.readdirSync(p, { withFileTypes: true }).map(e => ({
      name: e.name, kind: e.isDirectory() ? 'directory' : 'file', target: join(p, e.name)
    })),
    readText: async p => fs.readFileSync(p, 'utf8'),
    stat: async p => fs.statSync(p),
    processPath: p => p,
    writeText: async (p, text) => {
      assert.ok(resolve(p).startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/')));
      fs.mkdirSync(dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
  };
  function mount(overrides = {}, fsOverrides = {}) {
    const savedHome = process.env.DSH_HOME;
    let api;
    const routes = [];
    const tools = [];
    try {
      process.env.DSH_HOME = root;
      core.apply({ fs: { ...service, ...fsOverrides }, webServer: { register: r => routes.push(r) }, provide: (_, v) => { api = v; } }, overrides);
    } finally {
      if (savedHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedHome;
    }
    bank.apply({ geoKernel: api, webServer: { register: r => routes.push(r) }, tools: { register: tool => tools.push(tool) } });
    return { api, search: tools.find(v => v.name === 'geo_search_questions'), routes };
  }
  return { root, configDir, knowledge, questions, config, writeConfig, mount };
}

test('缺配置时，健康检查与检索工具都返回可见错误', async t => {
  const { mount } = fixture(t);
  const { api, search } = mount();
  assert.equal((await api.health()).configured, false);
  const result = await search.execute({ keyword: '热力环流' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /questionBankPath/);
  assert.equal('results' in result, false);
});

test('不存在的目录不能成为成功的空题库，也不能通过健康检查', async t => {
  const f = fixture(t);
  f.writeConfig({ ...f.config, questionBankPath: './missing-bank' });
  const { api, search } = f.mount();
  assert.equal((await search.execute({ keyword: 'test' })).status, 'error');
  const health = await api.health();
  assert.equal(health.status, 'error');
  assert.equal(health.config.questionBankPathExists, false);
  assert.equal(fs.existsSync(join(f.configDir, 'outputs', 'question-index.json')), false);
});

test('健康检查不能忽略考点库不可用', async t => {
  const f = fixture(t);
  f.writeConfig({ ...f.config, knowledgeBasePath: './missing-knowledge' });
  const { api } = f.mount();
  assert.equal((await api.getTaxonomy({})).status, 'error');
  assert.equal((await api.health()).status, 'error');
});

test('路径指向普通文件时给出明确目录错误', async t => {
  const f = fixture(t);
  f.writeConfig({ ...f.config, questionBankPath: './knowledge/knowledge_taxonomy_test.yaml' });
  const result = await f.mount().search.execute({ keyword: 'test' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /不是目录/);
});

test('读取被拒绝时，工具与 HTTP 路由都保留失败状态', async t => {
  const f = fixture(t);
  f.writeConfig();
  const { search, routes } = f.mount({}, { listDir: async () => { throw new Error('EACCES: access denied'); } });
  const result = await search.execute({ keyword: 'test' });
  assert.equal(result.status, 'error');
  assert.match(result.message, /EACCES/);
  let status, body;
  await routes.find(r => r.path === '/geo/bank').handler({ url: '/geo/bank/search?keyword=test' }, {
    writeHead: code => { status = code; }, end: text => { body = JSON.parse(text); }
  });
  assert.equal(status, 500);
  assert.equal(body.status, 'error');
});

test('自定义 DSH_HOME、相对路径和 UTF-8 BOM 配置均可用；正常无匹配仍返回成功', async t => {
  const f = fixture(t);
  f.writeConfig(f.config, true);
  const { api, search } = f.mount();
  const health = await api.health();
  assert.equal(health.status, 'success');
  assert.equal(health.config.knowledgeBasePath, f.knowledge);
  assert.equal(health.config.questionBankPath, f.questions);
  assert.equal(health.config.outputPath, join(f.configDir, 'outputs'));
  assert.equal(health.taxonomyNodes, 1);
  assert.equal((await api.getTaxonomy({ query: '热力环流' })).status, 'success');
  assert.deepEqual(await search.execute({ keyword: '不存在的内容' }), { status: 'success', results: [] });
});

test('插件配置继续优先于配置文件', async t => {
  const f = fixture(t);
  f.writeConfig({ ...f.config, questionBankPath: './wrong-bank' });
  const health = await f.mount({ questionBankPath: f.questions }).api.health();
  assert.equal(health.status, 'success');
  assert.equal(health.config.questionBankPath, f.questions);
});
