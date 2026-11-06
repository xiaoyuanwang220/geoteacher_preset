// /geo-status 命令：注册位置、只读输出与错误兜底。
import test from 'node:test';
import assert from 'node:assert/strict';

import analysisPlugin from '../.agent-presets/geo-teacher/plugins/analysis/index.js';

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
      if (name === 'commands') return { register(definition) { commands.push(definition); return () => {}; } };
      if (name === 'agentPresets') return { resolve: async (id) => ({ id, broken: null }) };
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
