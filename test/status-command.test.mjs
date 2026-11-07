// /geo-status 命令：注册位置、只读输出与错误兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import analysisPlugin, { readDshVersion } from '../.agent-presets/geo-teacher/plugins/analysis/index.js';

function mountHarness(options = {}) {
  const registered = new Map();
  const commands = [];
  const ctx = {
    webServer: { register() {} },
    geoKernel: {
      statusSummary: options.statusSummary || (async () => ({
        status: 'success',
        message: '',
        data: {
          knowledgeSource: 'packaged',
          questionBankSource: 'packaged',
          knowledgeBasePath: '/repo/data/config',
          questionBankPath: '/repo/data/obsidian_vault/04_题目',
          configPath: '/home/.dsh/geo-teacher/config.json',
          configFileFound: false,
          outputPath: '/home/.dsh/geo-teacher/outputs'
        },
        counts: { taxonomyNodes: 162, bankFiles: 115, bankQuestions: 279 },
        index: { builtAt: '2026-11-06T00:00:00.000Z', fromDisk: true },
        recentRuns: [{ questionId: '2025-安徽-地理-2025年安徽高考地理真题-Q18-1', state: 'verified', submittedAt: 1, verifiedAt: 2 }]
      }))
    },
    tools: { register(definition) { registered.set(definition.name, definition); return () => {}; } },
    fs: {},
    attachments: {},
    get(name) {
      if (name === 'commands') {
        return {
          register(definition) {
            if (options.commandRegisterError) throw new Error(options.commandRegisterError);
            commands.push(definition);
            return () => {};
          }
        };
      }
      if (name === 'agentPresets') return { resolve: async (id) => ({ id, broken: options.presetBroken || null }) };
      return undefined;
    },
    effect(callback) {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    }
  };
  analysisPlugin.apply(ctx, {});
  return { commands, tools: registered };
}

test('/geo-status 注册为宿主命令，返回安装/数据/题库/最近讲题状态', async () => {
  const { commands } = mountHarness();
  assert.equal(commands.length, 1, '应注册一个状态命令');
  const definition = commands[0];
  assert.equal(definition.name, 'geo-status');
  assert.match(definition.description, /状态/);

  const result = await definition.handler({});
  assert.equal(result.kind, 'success');
  for (const token of [
    'DSH：',
    '考点库：随仓库 data/',
    '题库：随仓库 data/',
    '279 小问 / 115 文件',
    '考点节点：162',
    '核验完成',
    '内部解题预设：可用'
  ]) {
    assert.ok(result.text.includes(token), `缺少：${token}`);
  }
});

test('/geo-status 读取状态失败时返回 error，不抛出错', async () => {
  const { commands } = mountHarness({
    statusSummary: async () => { throw new Error('kernel 不可用'); }
  });
  const result = await commands[0].handler({});
  assert.equal(result.kind, 'error');
  assert.match(result.text, /读取状态失败/);
  assert.match(result.text, /kernel 不可用/);
});

test('geo_status 工具与命令同源，返回同样的只读状态文本', async () => {
  const { tools } = mountHarness();
  const tool = tools.get('geo_status');
  assert.ok(tool, '应注册 geo_status 工具');
  assert.match(tool.description, /状态/);
  const value = await tool.execute({});
  assert.equal(value.status, 'success');
  for (const token of ['DSH：', '考点库：随仓库 data/', '279 小问 / 115 文件', '内部解题预设：可用']) {
    assert.ok(value.text.includes(token), `缺少：${token}`);
  }
  const rendered = tool.output.render({}, value);
  assert.equal(rendered[0].text, value.text);
});

test('命令重复注册不导致 preset 挂载失败（幂等兜底）', () => {
  assert.doesNotThrow(() => mountHarness({ commandRegisterError: 'command "geo-status" is already registered' }));
  const { tools } = mountHarness({ commandRegisterError: 'command "geo-status" is already registered' });
  assert.ok(tools.get('geo_status'), '命令重复也不影响模型工具注册');
});

test('内部预设不可用时，状态文本带出 broken 原因', async () => {
  const { commands } = mountHarness({ presetBroken: 'solver-isolation 挂载失败：restrict 不可用' });
  const result = await commands[0].handler({});
  assert.match(result.text, /内部解题预设：不可用：solver-isolation 挂载失败/);
});

test('版本读数优先安装包内置 runtime，其次旧版 dsh-runtimes 副本', () => {
  const root = mkdtempSync(join(tmpdir(), 'geo-dsh-version-'));
  try {
    const install = join(root, 'install');
    const runtimeDir = join(install, 'resources', 'runtime', 'primary-runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.2-rc.1' }));
    const home = join(root, 'home');
    const legacy = join(home, 'dsh-runtimes', 'dsh-primary-runtime');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'runtime.json'), JSON.stringify({ desktopVersion: '0.2.1-rc.5' }));

    assert.equal(
      readDshVersion({ execPath: join(install, 'DeepSeek Harness.exe'), resourcesPath: '', dshHome: home }),
      '0.2.2-rc.1',
      '安装包内置 runtime 应优先于旧副本'
    );
    assert.equal(
      readDshVersion({ execPath: join(runtimeDir, 'dependencies', 'node', 'bin', 'node.exe'), resourcesPath: '', dshHome: join(root, 'empty-home') }),
      '0.2.2-rc.1',
      'execPath 位于安装目录 resources 下时也能定位'
    );
    assert.equal(
      readDshVersion({ execPath: join(root, 'no-install', 'node.exe'), resourcesPath: '', dshHome: home }),
      '0.2.1-rc.5',
      '安装目录不存在时回落到旧版副本'
    );
    assert.equal(
      readDshVersion({ execPath: join(root, 'no-install', 'node.exe'), resourcesPath: '', dshHome: join(root, 'empty-home') }),
      'unknown',
      '两处都缺失时如实返回 unknown'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
