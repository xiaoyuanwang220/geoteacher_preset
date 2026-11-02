// ModelCheck —— 宿主半边装配冒烟测试（不启动 DSH、不写 profile）
//
// 目的：在安装前证明 index.js 能用最小 ctx 完成注册，且 7 个工具与
// /modelcheck 路由都声明了模型可见/面板需要的结构。真实挂载与槽位渲染属于安装后验收。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import plugin from '../index.js';

function createMockContext() {
  const routes = [];
  const tools = [];
  const events = [];
  const disposers = [];
  const ctx = {
    get() { return undefined; },
    on(name) {
      events.push(name);
      const dispose = () => {};
      disposers.push(dispose);
      return dispose;
    },
    effect(callback) {
      const dispose = callback();
      if (typeof dispose === 'function') disposers.push(dispose);
      return () => {};
    },
    webServer: {
      getOrigin() { return 'http://127.0.0.1:0'; },
      register(route) {
        routes.push(route);
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      }
    },
    tools: {
      register(definition) {
        tools.push(definition);
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      }
    }
  };
  return { ctx, routes, tools, events, disposers };
}

test('插件可装配：声明 inject 与 name', () => {
  assert.equal(plugin.name, 'modelcheck');
  assert.ok(Array.isArray(plugin.inject));
  assert.ok(plugin.inject.includes('webServer'));
  assert.ok(plugin.inject.includes('tools'));
  assert.equal(typeof plugin.apply, 'function');
});

test('apply 用最小 ctx 注册 8 个工具与 /modelcheck 路由', () => {
  const mock = createMockContext();
  plugin.apply(mock.ctx);

  const names = mock.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'modelcheck_annotations',
    'modelcheck_complete',
    'modelcheck_components',
    'modelcheck_contract',
    'modelcheck_init',
    'modelcheck_round',
    'modelcheck_status',
    'modelcheck_verify'
  ]);

  for (const tool of mock.tools) {
    assert.ok(tool.description && tool.description.length > 20, tool.name + ' 缺少可读描述');
    assert.equal(typeof tool.execute, 'function', tool.name + ' 缺少 execute');
    assert.ok(tool.parameters && typeof tool.parameters === 'object', tool.name + ' 缺少参数 schema');
    assert.ok(tool.output && typeof tool.output.schema === 'object', tool.name + ' 缺少输出 schema');
    assert.equal(typeof tool.output.render, 'function', tool.name + ' 缺少输出渲染');
  }

  const paths = mock.routes.map((route) => route.path);
  const prefixes = paths.join(' ');
  assert.match(prefixes, /\/modelcheck/);
  for (const route of mock.routes) {
    assert.ok(['exact', 'prefix'].includes(route.kind), '路由 kind 非法: ' + route.path);
    assert.equal(typeof route.handler, 'function', '路由缺少 handler: ' + route.path);
  }

  // 装配完成后应记录 turn-stopping 监听（只记录/提醒，不抛错）。
  assert.ok(mock.events.includes('agent/turn-stopping'), '缺少 agent/turn-stopping 监听');
});

test('apply 在服务缺失的退化环境下不抛错', () => {
  const get = () => undefined;
  const ctx = {
    get,
    on() { return () => {}; },
    effect(callback) { callback(); return () => {}; },
    webServer: { register() { return () => {}; }, getOrigin() { return 'http://127.0.0.1:0'; } },
    tools: { register() { return () => {}; } }
  };
  assert.doesNotThrow(() => plugin.apply(ctx));
});

test('工具 schema 只暴露 JSON 可表达的参数类型', () => {
  const mock = createMockContext();
  plugin.apply(mock.ctx);
  const allowed = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
  function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    if (node.type && !allowed.has(node.type)) assert.fail(path + ' 使用了非法类型 ' + node.type);
    if (node.properties) {
      for (const [key, value] of Object.entries(node.properties)) walk(value, path + '.' + key);
    }
    if (node.items) walk(node.items, path + '[]');
  }
  for (const tool of mock.tools) walk(tool.parameters, tool.name);
});
