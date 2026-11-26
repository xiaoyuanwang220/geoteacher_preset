// 输入区 UI 插件（@geo-edu/dsh-geo-teacher-ui）：移除出题按钮、按会话隔离状态、宿主动态上下文注入回归测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import uiHostPlugin, {
  UI_CONTEXT_NAME,
  UI_STATE_PATH,
  VALID_MODES,
  createUiStateRegistry,
  formatSelectionContext,
  normalizeUiSelection
} from '../packages/dsh-geo-teacher-ui/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_JS_PATH = join(HERE, '..', 'packages', 'dsh-geo-teacher-ui', 'client.js');

function loadClientPlugin(customFetch) {
  let registered = null;
  const fakeReact = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      return [initial, () => {}];
    },
    useEffect() {},
    useRef(initial) {
      return { current: initial };
    }
  };
  const sandbox = {
    console,
    fetch: customFetch,
    Promise,
    Object,
    Array,
    Set,
    String,
    JSON,
    window: {
      __ModuleLoader__: {
        load(spec) {
          registered = spec;
        }
      },
      setTimeout,
      clearTimeout,
      setInterval: () => 1,
      clearInterval() {}
    }
  };
  vm.runInNewContext(readFileSync(CLIENT_JS_PATH, 'utf8'), sandbox, { filename: CLIENT_JS_PATH });
  assert.ok(registered && typeof registered.factory === 'function', 'client.js 应通过 __ModuleLoader__.load 注册工厂');
  const plugin = registered.factory((mod) => {
    if (mod === 'react') return fakeReact;
    throw new Error('unexpected require: ' + mod);
  });
  return plugin;
}

function invokeRoute(handler, { method = 'GET', url = UI_STATE_PATH, headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.headers = headers;

    let status = 200;
    let resHeaders = {};
    const chunks = [];
    const res = {
      writeHead(code, hdrs) {
        status = code;
        resHeaders = hdrs || {};
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* plain text */ }
        resolve({ status, headers: resHeaders, raw, json });
      }
    };

    Promise.resolve(handler(req, res)).catch(reject);
    queueMicrotask(() => {
      if (body !== null) {
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        req.emit('data', Buffer.from(payload, 'utf8'));
      }
      req.emit('end');
    });
  });
}

test('客户端定义：已移除「出题」UI，仅保留「讲题」与「课程方案」且默认学生/高一/45分钟', () => {
  const clientSrc = readFileSync(CLIENT_JS_PATH, 'utf8');
  assert.ok(!clientSrc.includes('setDraft'), '不得再调用 inputActions.setDraft 污染输入框或破坏 @文件 引用胶囊');

  const plugin = loadClientPlugin(async () => ({ ok: true }));
  assert.deepEqual(VALID_MODES, ['explain', 'lesson']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plugin.MODES.map((m) => ({ id: m.id, name: m.name })))),
    [
      { id: 'explain', name: '讲题' },
      { id: 'lesson', name: '课程方案' }
    ]
  );
  assert.equal(plugin.INITIAL_VALUES.audience, '学生');
  assert.equal(plugin.INITIAL_VALUES.grade, '高一');
  assert.equal(plugin.INITIAL_VALUES.duration, '45分钟');
  assert.equal('type' in plugin.INITIAL_VALUES, false, '不应残留出题题型字段');
  assert.equal('difficulty' in plugin.INITIAL_VALUES, false, '不应残留出题难度字段');
});

test('客户端状态与同步：按 sessionId 隔离，首次挂载即同步默认 45 分钟，切换选项立即上报且幂等去重', async () => {
  const calls = [];
  const plugin = loadClientPlugin(async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true };
  });

  const store = plugin.createStore();
  // 会话 A 挂载（未手动点下拉，保持默认讲题/学生），Settings 与 FunctionSelector 重复调用 syncSession 只发 1 次请求
  store.syncSession('sess-a', 'geo-teacher');
  store.syncSession('sess-a', 'geo-teacher');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, {
    sessionId: 'sess-a',
    preset: 'geo-teacher',
    active: 'explain',
    values: { audience: '学生', grade: '高一', duration: '45分钟' }
  });

  // 会话 A 切到「课程方案」（保持默认 45 分钟不点时间下拉，也必须立即把 45 分钟同步给宿主！）
  store.switchMode('sess-a', 'geo-teacher', 'lesson');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, {
    sessionId: 'sess-a',
    preset: 'geo-teacher',
    active: 'lesson',
    values: { audience: '学生', grade: '高一', duration: '45分钟' }
  });

  // 会话 B 独立切换为「高二 + 10分钟」，不得篡改会话 A 的「高一 + 45分钟」
  store.switchMode('sess-b', 'geo-teacher', 'lesson');
  store.changeValue('sess-b', 'geo-teacher', 'grade', '高二');
  store.changeValue('sess-b', 'geo-teacher', 'duration', '10分钟');
  assert.deepEqual(JSON.parse(JSON.stringify(store.getForSession('sess-a').values)), { audience: '学生', grade: '高一', duration: '45分钟' });
  assert.deepEqual(JSON.parse(JSON.stringify(store.getForSession('sess-b').values)), { audience: '学生', grade: '高二', duration: '10分钟' });

  // 会话切回非 geo-teacher 预设时通知宿主清理
  store.syncSession('sess-b', 'standard');
  assert.deepEqual(calls.at(-1).body, { sessionId: 'sess-b', preset: 'standard' });
});

test('宿主插件端到端：POST /geo-teacher-ui/state → systemPrompt.context 实时投影，且隔离解题子会话零泄漏', async () => {
  const routes = new Map();
  const contexts = new Map();
  const disposers = [];

  uiHostPlugin.apply({
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`;
        assert.equal(routes.has(key), false, `路由不应重复: ${key}`);
        routes.set(key, route.handler);
        return () => routes.delete(key);
      }
    },
    systemPrompt: {
      context(entry) {
        contexts.set(entry.name, entry);
        return () => contexts.delete(entry.name);
      }
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    }
  });

  const stateHandler = routes.get(`exact:${UI_STATE_PATH}`);
  const contextEntry = contexts.get(UI_CONTEXT_NAME);
  assert.ok(stateHandler, '应注册 /geo-teacher-ui/state 路由');
  assert.ok(contextEntry, '应注册 systemPrompt.context 动态上下文');
  assert.equal(contextEntry.interpolate, false, '动态上下文须关闭模板插值以防 {{…}} 误解析');

  // 1. 教师在会话 sess-lesson 选择「课程方案 + 高一 + 45分钟」
  const postLesson = await invokeRoute(stateHandler, {
    method: 'POST',
    headers: { host: '127.0.0.1:51234', origin: 'http://127.0.0.1:51234' },
    body: {
      sessionId: 'sess-lesson',
      preset: 'geo-teacher',
      active: 'lesson',
      values: { audience: '学生', grade: '高一', duration: '45分钟' }
    }
  });
  assert.equal(postLesson.status, 200);
  assert.equal(postLesson.json.ok, true);

  const lessonCtxText = contextEntry.text({ agent: { id: 'sess-lesson', session: { id: 'sess-lesson' } } });
  assert.match(lessonCtxText, /输入区选中功能：课程方案/);
  assert.match(lessonCtxText, /授课年级（学段）：高一/);
  assert.match(lessonCtxText, /授课时间（课时）：45分钟/);
  assert.match(lessonCtxText, /严禁再次向教师询问授课时间\/课时或年级\/学段/);

  // 2. 同一会话中途改为「高三 + 10分钟」，下一轮 refreshContext 立即拿到新值
  await invokeRoute(stateHandler, {
    method: 'POST',
    body: {
      sessionId: 'sess-lesson',
      preset: 'geo-teacher',
      active: 'lesson',
      values: { audience: '学生', grade: '高三', duration: '10分钟' }
    }
  });
  const updatedText = contextEntry.text({ agent: { id: 'sess-lesson' } });
  assert.match(updatedText, /授课年级（学段）：高三/);
  assert.match(updatedText, /授课时间（课时）：10分钟/);

  // 3. 讲题模式映射 audience 枚举（教师 -> teacher）
  await invokeRoute(stateHandler, {
    method: 'POST',
    body: {
      sessionId: 'sess-explain',
      preset: 'geo-teacher',
      active: 'explain',
      values: { audience: '教师', grade: '高一', duration: '45分钟' }
    }
  });
  const explainText = contextEntry.text({ agent: { id: 'sess-explain' } });
  assert.match(explainText, /输入区选中功能：讲题/);
  assert.match(explainText, /audience="teacher"/);

  // 4. 隔离解题子会话（独立 childSessionId）与未知会话必须返回空串（零泄漏）
  assert.equal(contextEntry.text({ agent: { id: 'solver-child-session-999' } }), '');
  assert.equal(contextEntry.text({}), '');

  // 5. 跨源 POST 被拒绝（403）
  const crossOrigin = await invokeRoute(stateHandler, {
    method: 'POST',
    headers: { host: '127.0.0.1:51234', origin: 'https://evil.example.com' },
    body: { sessionId: 'sess-lesson', preset: 'geo-teacher', active: 'explain', values: {} }
  });
  assert.equal(crossOrigin.status, 403);

  // 6. 切出 geo-teacher 预设后清理状态
  await invokeRoute(stateHandler, {
    method: 'POST',
    body: { sessionId: 'sess-lesson', preset: 'standard' }
  });
  assert.equal(contextEntry.text({ agent: { id: 'sess-lesson' } }), '');

  // 7. 卸载时清理路由与 context
  for (const dispose of disposers) dispose();
  assert.equal(routes.size, 0);
  assert.equal(contexts.size, 0);
});

test('输入校验兜底：非法 mode/audience/duration 回落安全默认值，LRU 容量受控', () => {
  const norm = normalizeUiSelection({
    active: 'questions',
    values: { audience: '未知', grade: '初一', duration: '90分钟' }
  });
  assert.deepEqual(norm, {
    active: 'explain',
    values: { audience: '学生', grade: '高一', duration: '45分钟' }
  });
  assert.match(formatSelectionContext(norm), /audience="student"/);

  const reg = createUiStateRegistry(2);
  reg.set('s1', { active: 'explain' });
  reg.set('s2', { active: 'lesson' });
  reg.set('s3', { active: 'lesson' });
  assert.equal(reg.size(), 2);
  assert.equal(reg.get('s1'), null, '超出上限时淘汰最旧会话');
  assert.ok(reg.get('s2'));
  assert.ok(reg.get('s3'));
});
