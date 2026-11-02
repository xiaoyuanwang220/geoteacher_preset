// ModelCheck —— 接入就绪（readiness）与注册表 v2（kind/parts/instances）测试
//
// 覆盖 P0：初始化/verify 前能说清“缺哪根线”；交付入口与校验入口分离；
// 以及 P1 的数据结构：组件 kind、子单元 parts/instances 的规范与校验。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanProject, buildConfig, buildComponents } from '../lib/scaffold.js';
import { computeReadiness, extractSceneNames, suggestHookLocation } from '../lib/readiness.js';
import { KINDS, normalizeRegistry, validateRegistry } from '../lib/registry.js';

async function makeThreeProject() {
  const root = await mkdtemp(join(tmpdir(), 'modelcheck-ready-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'tools'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'ready-three', description: '就绪测试模型' }), 'utf8');
  await writeFile(join(root, 'index.html'), '<!doctype html><html><body><canvas></canvas><script>const r = new THREE.WebGLRenderer();</script></body></html>', 'utf8');
  await writeFile(join(root, 'tools', 'verify-build.html'), [
    '<!doctype html><html><body><canvas></canvas>',
    '<script>window.__MC_PREVIEW__ = { scene, camera, renderer, THREE };</script>',
    '</body></html>'
  ].join('\n'), 'utf8');
  await writeFile(join(root, 'src', 'main.js'), [
    'const scene = new THREE.Scene();',
    'const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);',
    'const renderer = new THREE.WebGLRenderer();',
    "earth.name = 'mcearth';",
    "const belt = new THREE.Group(); belt.name = 'mcbelt-nh-trade';",
    "const arrow = { name: 'mcarrow-nh-trade-3' };",
    ''
  ].join('\n'), 'utf8');
  return root;
}

test('scanProject：识别交付入口与校验入口，并把它们写进 config', async (t) => {
  const root = await makeThreeProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const scan = await scanProject(root);
  assert.equal(scan.route, 'three');
  assert.equal(scan.previewEntry, 'index.html');
  assert.equal(scan.deliveryEntry, 'index.html');
  assert.equal(scan.verifyEntry, 'tools/verify-build.html');

  const config = buildConfig(scan);
  assert.equal(config.preview.entry, 'index.html');
  assert.equal(config.preview.deliveryEntry, 'index.html');
  assert.equal(config.preview.verifyEntry, 'tools/verify-build.html');
});

test('readiness：入口/钩子/产物/pick 接线逐项给出结论与补救', async (t) => {
  const root = await makeThreeProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const scan = await scanProject(root);
  const config = buildConfig(scan);
  const components = {
    components: [
      { id: 'earth', label: '地球', pick: 'mcearth', route: 'three', locator: { file: 'src/main.js', symbol: 'earth', line: 4 } },
      { id: 'trade', label: '北半球东北信风带', pick: 'mcbelt-nh-trade', route: 'three', locator: { file: 'src/main.js', symbol: 'belt', line: 5 } },
      { id: 'broken', label: '写错名字的组件', pick: '不存在的对象名', route: 'three', locator: { file: 'src/main.js', symbol: 'x', line: 1 } }
    ]
  };
  const readiness = await computeReadiness({ root, config, components, contract: null, scan });
  const byId = Object.fromEntries(readiness.checks.map((check) => [check.id, check]));

  assert.equal(byId.project.ok, true);
  assert.equal(byId.verifyEntry.ok, true, '有校验版入口时应通过');
  assert.equal(byId.hook.ok, true, '校验版含 __MC_PREVIEW__ 时应通过');
  assert.equal(byId.buildOutputs.ok, false);
  assert.equal(byId.buildOutputs.severity, 'warn');
  assert.equal(byId.pickWiring.ok, false);
  assert.equal(byId.pickWiring.wiring.length, 1, '只有一个组件 pick 未接线');
  assert.equal(byId.pickWiring.wiring[0].id, 'broken');
  assert.equal(byId.contract.ok, false);
  assert.ok(readiness.nextActions.length > 0);
  assert.ok(readiness.nextActions.some((text) => text.includes('build.outputs')) || readiness.nextActions.some((text) => text.includes('契约')));
});

test('readiness：three 缺校验版/缺钩子时是 block，并给出插入位置', async (t) => {
  const root = await makeThreeProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, 'tools', 'verify-build.html'), { force: true });

  const scan = await scanProject(root);
  const config = buildConfig(scan);
  assert.equal(scan.verifyEntry, null);
  const readiness = await computeReadiness({ root, config, components: { components: [] }, contract: null, scan });
  const byId = Object.fromEntries(readiness.checks.map((check) => [check.id, check]));

  assert.equal(byId.verifyEntry.ok, false);
  assert.equal(byId.verifyEntry.severity, 'block');
  assert.equal(byId.hook.ok, false);
  assert.equal(byId.hook.severity, 'block');
  assert.ok(byId.hook.suggestion && byId.hook.suggestion.file === 'src/main.js');
  assert.match(byId.hook.suggestion.snippet, /__MC_PREVIEW__/);
  assert.equal(readiness.ok, false);

  // 场景对象名提取与钩子插入位置建议
  const sources = [{ rel: 'src/main.js', text: await readFile(join(root, 'src', 'main.js'), 'utf8') }];
  const names = extractSceneNames(sources);
  assert.ok(names.includes('mcearth'));
  assert.ok(names.includes('mcbelt-nh-trade'));
  assert.ok(names.includes('mcarrow-nh-trade-3'));
  const location = suggestHookLocation(sources);
  assert.equal(location.camera.file, 'src/main.js');
  assert.equal(location.camera.line, 2);
});

test('buildComponents：给候选补 kind（启发式，供界面分组）', async (t) => {
  const root = await makeThreeProject();
  t.after(() => rm(root, { recursive: true, force: true }));

  const scan = await scanProject(root);
  const registry = buildComponents(scan);
  const kinds = registry.components.map((component) => component.kind);
  assert.ok(kinds.every((kind) => KINDS.includes(kind)));
  assert.ok(registry.components.length > 0);
});

test('readiness：前缀拼接的对象名（mcbelt- + id）不误判为未接线', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'modelcheck-prefix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><html><body><canvas></canvas><script>const r = new THREE.WebGLRenderer();</script></body></html>', 'utf8');
  await writeFile(join(root, 'src', 'main.js'), [
    'const group = new THREE.Group();',
    "group.name = 'mcbelt-' + belt.id;",
    "earth.name = 'mcearth';",
    "const wrong = { name: 'mcwrong-name' };",
    ''
  ].join('\n'), 'utf8');

  const scan = await scanProject(root);
  const config = buildConfig(scan);
  const components = {
    components: [
      { id: 'belt-eq-low', label: '赤道低压带', pick: 'mcbelt-eqLow', route: 'three', locator: { file: 'src/main.js', symbol: 'group', line: 2 } },
      { id: 'earth', label: '地球', pick: 'mcearth', route: 'three', locator: { file: 'src/main.js', symbol: 'earth', line: 3 } },
      { id: 'wrong', label: '写错的组件', pick: 'mcnope-123', route: 'three', locator: { file: 'src/main.js', symbol: 'wrong', line: 4 } }
    ]
  };
  const readiness = await computeReadiness({ root, config, components, contract: null, scan });
  const byId = Object.fromEntries(readiness.checks.map((check) => [check.id, check]));

  assert.equal(byId.pickWiring.ok, false);
  assert.match(byId.pickWiring.detail, /1\/3/, '只有真正对不上的组件计入 unwired');
  assert.match(byId.pickWiring.detail, /前缀模板/);
  assert.equal(readiness.wiring.unwired.length, 1);
  assert.equal(readiness.wiring.unwired[0].id, 'wrong');
  assert.ok(readiness.wiring.prefixWired.some((item) => item.id === 'belt-eq-low' && item.matchedTemplate === 'mcbelt-'));
});

test('registry v2：kind/parts/instances 合法；重复 key、非法 kind 会报错', () => {
  const valid = {
    schemaVersion: 1,
    components: [{
      id: 'trade-belt',
      label: '北半球东北信风带',
      kind: 'belt',
      route: 'three',
      locator: { file: 'src/main.js', symbol: 'belt', line: 5 },
      pick: 'mcbelt-nh-trade',
      annotatable: true,
      parts: [
        { key: 'ring-north', label: '北边界线', locator: { file: 'src/main.js', symbol: 'ring', line: 6 } },
        { key: 'ring-south', label: '南边界线' }
      ],
      instances: [
        { key: 'arrow-3', label: '信风箭头 #3', instanceId: 3, locator: { file: 'src/main.js', symbol: 'arrow', line: 7 } }
      ]
    }]
  };
  const check = validateRegistry(valid);
  assert.equal(check.ok, true, JSON.stringify(check.errors));

  const normalized = normalizeRegistry(valid);
  assert.equal(normalized.components[0].kind, 'belt');
  assert.equal(normalized.components[0].parts.length, 2);
  assert.equal(normalized.components[0].instances[0].instanceId, 3);

  const duplicate = JSON.parse(JSON.stringify(valid));
  duplicate.components[0].instances[0].key = 'ring-north'; // 与 parts 重复
  const dupCheck = validateRegistry(duplicate);
  assert.equal(dupCheck.ok, false);
  assert.ok(dupCheck.errors.some((error) => error.code === 'component/unit-key-duplicate'));

  const badKind = JSON.parse(JSON.stringify(valid));
  badKind.components[0].kind = 'label';
  const kindCheck = validateRegistry(badKind);
  assert.equal(kindCheck.ok, false);
  assert.ok(kindCheck.errors.some((error) => error.code === 'component/kind'));

  const badInstance = JSON.parse(JSON.stringify(valid));
  badInstance.components[0].instances[0].instanceId = '3';
  const instanceCheck = validateRegistry(badInstance);
  assert.equal(instanceCheck.ok, false);
  assert.ok(instanceCheck.errors.some((error) => error.code === 'component/unit-instance-id'));
});
