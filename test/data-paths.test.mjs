import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import core from '../.agent-presets/geo-teacher/plugins/core/index.js';
import bank from '../.agent-presets/geo-teacher/plugins/bank/index.js';
import dataPkg, { questionBankDir, attachmentsDir, resolveDataPaths } from '../packages/dsh-geo-teacher-data/index.js';

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

test('缺配置时使用随仓库 data/（与 Obsidian 同源），健康检查与检索都成功', async t => {
  const { mount } = fixture(t);
  const { api, search } = mount();
  const health = await api.health();
  // 仓库 data/ 随附（见 docs/engineering/本地安装与数据接线契约.md）；若在裁剪过的检出里运行，本用例应显式失败。
  assert.equal(health.status, 'success');
  assert.equal(health.config.knowledgeSource, 'packaged');
  assert.equal(health.config.questionBankSource, 'packaged');
  assert.ok(health.taxonomyNodes > 0);
  assert.ok(health.bankQuestions > 0);
  assert.equal((await search.execute({ keyword: '热力环流' })).status, 'success');
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

test('独立真题数据包符合 DSH 非 bundle 规范，且涉图题相对路径可解析到真实图片', async t => {
  const pkgJson = JSON.parse(fs.readFileSync(new URL('../packages/dsh-geo-teacher-data/package.json', import.meta.url), 'utf8'));
  assert.equal(pkgJson.name, '@geo-edu/dsh-geo-teacher-data');
  assert.equal(Boolean(pkgJson.dsh && pkgJson.dsh.bundle), false, '纯数据包不得声明 dsh.bundle');
  assert.equal(pkgJson.exports['.'], './index.js');
  assert.equal(pkgJson.exports['./package.json'], './package.json');
  assert.equal(dataPkg.questionBankDir, questionBankDir);
  assert.equal(resolveDataPaths().attachmentsDir, attachmentsDir);
  assert.equal(fs.statSync(questionBankDir).isDirectory(), true);
  assert.equal(fs.statSync(attachmentsDir).isDirectory(), true);

  const { mount } = fixture(t);
  const { api } = mount();
  const refs = await api.imageRefs('2024-广东-地理-2024年广东高考地理真题-Q17-1');
  assert.equal(refs.status, 'success');
  assert.equal(refs.hasImages, true);
  for (const img of refs.images) {
    assert.equal(fs.existsSync(img.sourcePath), true, `题面图片应存在：${img.sourcePath}`);
  }
});

test('profile node_modules 安装独立真题数据包时，core 优先从 profile 解析该包', async t => {
  const f = fixture(t);
  const profileDir = join(f.root, 'profiles', 'desktop');
  const installedDataPkg = join(profileDir, 'node_modules', '@geo-edu', 'dsh-geo-teacher-data');
  const installedBank = join(installedDataPkg, 'obsidian_vault', '04_题目');
  fs.mkdirSync(installedBank, { recursive: true });
  fs.writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true }));
  fs.writeFileSync(join(installedDataPkg, 'package.json'), JSON.stringify({
    name: '@geo-edu/dsh-geo-teacher-data',
    version: '0.1.0',
    type: 'module',
    exports: { '.': './index.js', './package.json': './package.json' }
  }));
  fs.writeFileSync(join(installedBank, 'sample.md'), [
    '---',
    'year: 2025',
    'region: 测试省',
    'question_numbers: 1',
    '---',
    '## 题组材料',
    '某地推进生态修复。',
    '## 第1题',
    'question_id: "2025-测试省-Q1"',
    '**题干**：该地修复的首要措施是（ ）',
    '**选项**：',
    '- A. 退耕还草',
    '- B. 围湖造田',
    '- C. 毁林开荒',
    '- D. 陡坡垦殖',
    '**答案**：A',
    '**解析**：生态修复应退耕还草。'
  ].join('\n'));

  const { api } = f.mount();
  const health = await api.health();
  assert.equal(health.status, 'success');
  assert.equal(health.config.questionBankSource, 'packaged');
  assert.equal(resolve(health.config.questionBankPath), resolve(installedBank));
  assert.equal(health.bankQuestions, 1);
});

test('题库根目录迁移（文件数相同且 mtime 更旧）时，旧索引自动失效并按新目录解析图片', async t => {
  const f = fixture(t);
  const bankA = join(f.configDir, 'bank-a', '04_题目', '省', '2025');
  const imgA = join(f.configDir, 'bank-a', '90_附件');
  const bankB = join(f.configDir, 'bank-b', '04_题目', '省', '2025');
  const imgB = join(f.configDir, 'bank-b', '90_附件');
  fs.mkdirSync(bankA, { recursive: true });
  fs.mkdirSync(imgA, { recursive: true });
  fs.mkdirSync(bankB, { recursive: true });
  fs.mkdirSync(imgB, { recursive: true });

  const mdContent = [
    '---',
    'year: 2025',
    'region: 迁移省',
    'question_numbers: 1',
    '---',
    '## 题组材料',
    '![示意图](../../../90_附件/fig1.png)',
    '## 第1题',
    'question_id: "2025-迁移省-Q1"',
    '**题干**：读图判断（ ）',
    '**选项**：',
    '- A. 甲',
    '- B. 乙',
    '**答案**：A',
    '**解析**：略。'
  ].join('\n');
  const fileA = join(bankA, 'q1.md');
  const fileB = join(bankB, 'q1.md');
  fs.writeFileSync(fileA, mdContent);
  fs.writeFileSync(join(imgA, 'fig1.png'), 'png-a');
  fs.writeFileSync(fileB, mdContent);
  fs.writeFileSync(join(imgB, 'fig1.png'), 'png-b');
  // 把 B 的 mtime 设得比现在更早，模拟拆包/安装包内的历史时间戳
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(fileB, past, past);

  f.writeConfig({ ...f.config, questionBankPath: join(f.configDir, 'bank-a', '04_题目') });
  const mountedA = f.mount();
  await mountedA.api.health();

  // 删除旧目录 A 并把配置切到目录 B
  fs.rmSync(join(f.configDir, 'bank-a'), { recursive: true, force: true });
  f.writeConfig({ ...f.config, questionBankPath: join(f.configDir, 'bank-b', '04_题目') });
  const mountedB = f.mount();
  const healthB = await mountedB.api.health();
  assert.equal(healthB.status, 'success');
  assert.equal(healthB.indexFromDisk, false, 'bankRoot 变化后应重建索引而非命中旧磁盘索引');
  const refsB = await mountedB.api.imageRefs('2025-迁移省-Q1');
  assert.equal(refsB.status, 'success');
  assert.equal(resolve(refsB.images[0].sourcePath), resolve(join(imgB, 'fig1.png')));
});
