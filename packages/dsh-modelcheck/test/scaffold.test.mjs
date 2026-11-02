// ModelCheck —— 项目发现与 .modelcheck 脚手架测试
//
// 覆盖痛点场景：已有模型项目 / 一个工作区多个模型目录 → 扫描候选、生成 config+components、
// 幂等不覆盖、契约草稿（轻量 criteria → 完整契约），以及 Blender 路线的明确拒绝。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyScaffold,
  buildComponents,
  buildConfig,
  buildContractDraft,
  discoverCandidates,
  inspectModelcheck,
  isProjectDir,
  scanProject,
  ScaffoldError
} from '../lib/scaffold.js';
import { loadProject } from '../lib/project.js';
import { Store } from '../lib/store.js';
import { validateContract } from '../lib/contract.js';
import { validateRegistry } from '../lib/registry.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'modelcheck-scaffold-'));
  const alpha = join(root, 'models', 'alpha');
  const beta = join(root, 'models', 'beta');
  const gamma = join(root, '16测试', 'gamma');
  const blender = join(root, 'models', 'blender-only');
  await mkdir(join(alpha, 'src'), { recursive: true });
  await mkdir(join(beta, 'dist'), { recursive: true });
  await mkdir(gamma, { recursive: true });
  await mkdir(blender, { recursive: true });

  await writeFile(join(root, 'README.md'), '# 工作区\n', 'utf8');
  await writeFile(join(alpha, 'package.json'), JSON.stringify({ name: 'alpha-model', description: '阿尔法教学模型' }), 'utf8');
  await writeFile(join(alpha, 'index.html'), [
    '<!doctype html><html><body>',
    '<svg viewBox="0 0 100 100">',
    '  <path data-mc-id="wind-a" data-mc-label="北半球信风" d="M10,10 L90,90" />',
    '  <path data-role="isobar" d="M0,50 L100,50" />',
    '</svg>',
    '</body></html>'
  ].join('\n'), 'utf8');
  await writeFile(join(alpha, 'src', 'app.js'), [
    'const arrow = {};',
    "arrow.name = '北半球盛行西风';",
    "const cfg = { name: '赤道低压' };",
    '// 通用对象不应成为组件',
    "const scene = {}; scene.name = 'scene';",
    ''
  ].join('\n'), 'utf8');

  await writeFile(join(beta, 'package.json'), JSON.stringify({ name: 'beta-model' }), 'utf8');
  await writeFile(join(beta, 'dist', 'index.html'), [
    '<!doctype html><html><body><canvas></canvas>',
    '<script>const r = new THREE.WebGLRenderer();</script>',
    '</body></html>'
  ].join('\n'), 'utf8');
  await writeFile(join(beta, 'dist', 'main.js'), '/* built */\n', 'utf8');

  // 老项目形态：单文件构建在根目录、入口名不是 index.html。
  await writeFile(join(gamma, 'package.json'), JSON.stringify({ name: 'gamma-single-file' }), 'utf8');
  await writeFile(join(gamma, '三圈环流教学模型.html'), [
    '<!doctype html><html><body><canvas></canvas>',
    '<script>const r = new THREE.WebGLRenderer();</script>',
    '</body></html>'
  ].join('\n'), 'utf8');

  await writeFile(join(blender, 'a.blend'), 'not a real blend', 'utf8');
  // 老项目形态：单文件构建在根目录、入口名不是 index.html；只有空 .modelcheck 目录。
  const delta = join(root, '16测试', '三圈环流尝试');
  await mkdir(join(delta, '.modelcheck'), { recursive: true });
  await mkdir(join(delta, '模型源码'), { recursive: true });
  await writeFile(join(delta, '三圈环流模型.html'), [
    '<!doctype html><html><body><canvas></canvas>',
    '<script>const r = new THREE.WebGLRenderer();</script>',
    '</body></html>'
  ].join('\n'), 'utf8');
  await writeFile(join(delta, '模型源码', 'scene.js'), "const band = {}; band.name = '赤道低压';\n", 'utf8');
  await writeFile(join(delta, '科学性文档.md'), '# 科学性文档\n', 'utf8');
  return { root, alpha, beta, gamma, delta, blender };
}

test('discoverCandidates：一个工作区下发现多个模型项目', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  const found = await discoverCandidates(ws.root);
  const rels = found.candidates.map((item) => item.relativeRoot);
  assert.ok(rels.includes('models/alpha'), '应发现 alpha：' + rels.join(','));
  assert.ok(rels.includes('models/beta'), '应发现 beta：' + rels.join(','));
  assert.ok(!rels.includes('models/blender-only'), '只有 .blend 的目录不应成为候选');

  const alpha = found.candidates.find((item) => item.relativeRoot === 'models/alpha');
  assert.equal(alpha.route, 'svg');
  assert.equal(alpha.previewEntry, 'index.html');
  assert.equal(alpha.hasModelcheck, false);

  const beta = found.candidates.find((item) => item.relativeRoot === 'models/beta');
  assert.equal(beta.route, 'three');
  assert.equal(beta.previewEntry, 'dist/index.html');
  assert.ok(beta.buildOutputs.includes('dist/main.js'));

  // 老项目形态：入口名不是 index.html 时回退探测到根目录唯一的 HTML，并从内容判定路线。
  const gamma = found.candidates.find((item) => item.relativeRoot === '16测试/gamma');
  assert.ok(gamma, '应发现单文件入口的老项目：' + rels.join(','));
  assert.equal(gamma.route, 'three');
  assert.equal(gamma.previewEntry, '三圈环流教学模型.html');
  assert.ok(gamma.warnings.some((text) => text.includes('回退探测')), '应提示入口由回退探测得到');
  // 有 dist 构建的候选应排在只有源码的候选前面
  assert.ok(found.candidates[0].score >= found.candidates[1].score);
});

test('scanProject：探测入口/路线/源码/组件候选（含中文 name）', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  const scan = await scanProject(ws.alpha);
  assert.equal(scan.projectId, 'alpha-model');
  assert.equal(scan.title, '阿尔法教学模型');
  assert.equal(scan.route, 'svg');
  assert.equal(scan.previewEntry, 'index.html');
  assert.ok(scan.sources.includes('index.html'));
  assert.ok(scan.sources.includes('src/app.js'));
  assert.ok(scan.docs.includes('README.md') === false, 'README 在工作区根，不在项目内');

  const ids = scan.components.map((item) => item.id);
  assert.ok(ids.includes('wind-a'), 'data-mc-id 应成为候选：' + ids.join(','));
  assert.ok(ids.includes('isobar'), 'data-role 应成为候选：' + ids.join(','));
  assert.ok(ids.includes('北半球盛行西风'), '中文 .name 应成为候选：' + ids.join(','));
  const wind = scan.components.find((item) => item.id === 'wind-a');
  assert.equal(wind.pick, '[data-mc-id="wind-a"]');
  assert.equal(wind.label, '北半球信风');
  assert.equal(wind.locator.file, 'index.html');
  assert.ok(!ids.includes('scene'), '通用对象名不应成为组件');

  const blender = await scanProject(ws.blender);
  assert.ok(blender.warnings.some((text) => text.includes('Blender')), 'Blender 路线应明确警告');

  const gamma = await scanProject(ws.gamma);
  assert.equal(gamma.route, 'three');
  assert.equal(gamma.previewEntry, '三圈环流教学模型.html');
  assert.ok(gamma.warnings.some((text) => text.includes('回退探测')));
});

test('buildConfig / buildComponents：生成的配置能通过项目校验', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  const scan = await scanProject(ws.alpha);
  const config = buildConfig(scan);
  assert.equal(config.route, 'svg');
  assert.equal(config.preview.entry, 'index.html');
  assert.equal(config.build.entry, 'index.html');
  assert.equal(config.budget.maxRounds.production, 8);
  assert.ok(config.sources.length > 0);

  const components = buildComponents(scan);
  const check = validateRegistry(components);
  assert.equal(check.ok, true, JSON.stringify(check.errors));
  assert.ok(components.components.every((item) => item.route === 'svg'));
  assert.ok(components.components.every((item) => Array.isArray(item.observables) && item.observables.length > 0));
});

test('applyScaffold：写入 .modelcheck、幂等不覆盖、force 覆盖', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  const first = await applyScaffold(ws.alpha);
  assert.deepEqual(first.written, ['config.json', 'components.json']);
  assert.ok(existsSync(join(ws.alpha, '.modelcheck', 'config.json')));
  assert.ok(existsSync(join(ws.alpha, '.modelcheck', 'components.json')));

  const project = await loadProject(ws.alpha, { store: new Store(ws.alpha) });
  assert.equal(project.config.projectId, 'alpha-model');
  assert.equal(project.config.preview.entry, 'index.html');
  assert.ok(project.components.components.length >= 3);
  assert.equal(project.contract, null, '脚手架不生成契约');

  const second = await applyScaffold(ws.alpha);
  assert.deepEqual(second.written, []);
  assert.equal(second.skipped.length, 2);

  const forced = await applyScaffold(ws.alpha, { force: true, overrides: { title: '覆盖后的标题' } });
  assert.deepEqual(forced.written, ['config.json', 'components.json']);
  const reloaded = JSON.parse(await readFile(join(ws.alpha, '.modelcheck', 'config.json'), 'utf8'));
  assert.equal(reloaded.title, '覆盖后的标题');
});

test('buildContractDraft：轻量 criteria → 合法契约草稿（proposed、含依赖与哈希）', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));
  const scan = await scanProject(ws.alpha);

  const draft = await buildContractDraft({
    sourceDocs: ['README.md'],
    criteria: [
      {
        claim: '教学数据包含「北半球信风」命名',
        level: 'P1',
        rule: { kind: 'text', file: 'src/app.js', mode: 'matches', pattern: '北半球' }
      },
      {
        claim: '信风箭头方向应为西南向',
        level: 'P0',
        rule: { kind: 'direction', component: 'wind-a', expectedAzimuthDeg: 225, toleranceDeg: 10 }
      }
    ]
  }, scan);

  assert.equal(draft.status, 'proposed');
  assert.equal(draft.criteria.length, 2);
  assert.equal(draft.criteria[0].depends[0], 'src/app.js');
  assert.equal(draft.criteria[0].requiredEvidence, 'config');
  assert.equal(draft.criteria[1].requiredEvidence, 'runtime');
  assert.equal(draft.criteria[1].component, 'wind-a');
  assert.match(draft.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(validateContract(draft).ok, true);

  // 非法 criteria → 结构化错误（不写盘）
  await assert.rejects(
    () => buildContractDraft({ criteria: [{ claim: '没有规则' }] }, scan),
    (error) => error instanceof ScaffoldError && error.code === 'contract/rule'
  );
});

test('夹具项目也能被扫描为 svg 项目并生成组件候选', async () => {
  const scan = await scanProject(join(HERE, '..', 'fixtures', 'project'));
  assert.equal(scan.route, 'svg');
  assert.equal(scan.previewEntry, 'index.html');
  const ids = scan.components.map((item) => item.id);
  assert.ok(ids.includes('nh-trade-winds'), '夹具的 data-mc-id 应被识别：' + ids.join(','));
  assert.ok(ids.includes('nh-westerlies'));
  assert.ok((await isProjectDir(join(HERE, '..', 'fixtures', 'project'))) === true);
});

test('空 .modelcheck 目录不算已初始化：状态 empty，apply 补齐', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  // 目录存在但没有任何文件（用户反馈的 16测试/三圈环流尝试 形态）。
  const state = await inspectModelcheck(ws.delta);
  assert.equal(state.dirExists, true);
  assert.equal(state.empty, true);
  assert.equal(state.state, 'empty');
  assert.deepEqual(state.missing, ['config.json', 'components.json']);
  assert.equal(await isProjectDir(ws.delta), true, '只有单文件 HTML 的项目也应被发现');

  const found = await discoverCandidates(ws.root);
  const delta = found.candidates.find((item) => item.relativeRoot === '16测试/三圈环流尝试');
  assert.ok(delta, '空 .modelcheck 的项目应出现在候选里：' + found.candidates.map((item) => item.relativeRoot).join(','));
  assert.equal(delta.hasModelcheck, false, '空目录不能算已初始化');
  assert.equal(delta.needsInit, true);
  assert.equal(delta.modelcheck.state, 'empty');
  assert.equal(delta.previewEntry, '三圈环流模型.html');
  assert.equal(delta.route, 'three');
  assert.ok(delta.componentsCount >= 1, '一级源码目录（模型源码/）里的对象名也应被识别：' + delta.componentsCount);

  const applied = await applyScaffold(ws.delta);
  assert.equal(applied.before.state, 'empty');
  assert.deepEqual(applied.written, ['config.json', 'components.json']);
  assert.equal(applied.after.state, 'ready');
  assert.ok(applied.notes.some((text) => text.includes('空 .modelcheck')));
  assert.ok(existsSync(join(ws.delta, '.modelcheck', 'config.json')));
  assert.ok(existsSync(join(ws.delta, '.modelcheck', 'components.json')));
  const config = JSON.parse(await readFile(join(ws.delta, '.modelcheck', 'config.json'), 'utf8'));
  assert.equal(config.preview.entry, '三圈环流模型.html');
  assert.match(config.projectId, /^mc-[0-9a-f]{8}$/, '中文目录名应生成稳定短哈希 id，而不是通用 modelcheck-project');

  // 补齐后再次 apply 幂等。
  const again = await applyScaffold(ws.delta);
  assert.deepEqual(again.written, []);
  assert.equal(again.skipped.length, 2);
  assert.equal(again.after.state, 'ready');
});

test('半初始化只补缺的；坏 JSON 视为未初始化并修复', async (t) => {
  const ws = await makeWorkspace();
  t.after(() => rm(ws.root, { recursive: true, force: true }));

  // alpha 先完整初始化，再删掉 components.json → partial，只补 components。
  await applyScaffold(ws.alpha);
  await rm(join(ws.alpha, '.modelcheck', 'components.json'), { force: true });
  const partial = await inspectModelcheck(ws.alpha);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.missing, ['components.json']);
  const repos = await applyScaffold(ws.alpha);
  assert.deepEqual(repos.written, ['components.json']);
  assert.equal(repos.skipped.length, 1);
  assert.ok(repos.skipped[0].includes('config.json'));

  // beta 写入坏 JSON → 不能当已初始化，apply 修复。
  await mkdir(join(ws.beta, '.modelcheck'), { recursive: true });
  await writeFile(join(ws.beta, '.modelcheck', 'config.json'), '{ broken json', 'utf8');
  const broken = await inspectModelcheck(ws.beta);
  assert.equal(broken.state, 'partial');
  assert.ok(broken.issues.some((text) => text.includes('config.json')));
  const repaired = await applyScaffold(ws.beta);
  assert.ok(repaired.written.includes('config.json'));
  assert.equal(repaired.after.state, 'ready');
});
