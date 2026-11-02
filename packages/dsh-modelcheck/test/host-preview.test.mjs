// host 半边纯函数单测：预览路径防护、bridge 注入、MIME。不依赖 lib/ 与宿主运行时。
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  PREVIEW_MIME,
  bridgeTag,
  injectBridge,
  normalizeRelPath,
  resolveInsideRoot,
  shouldInjectBridge
} from '../server/preview.js';

test('normalizeRelPath：拒绝任何上跳与非法编码', () => {
  assert.equal(normalizeRelPath('../secret.txt'), null);
  assert.equal(normalizeRelPath('a/../../secret.txt'), null);
  assert.equal(normalizeRelPath('..%2fsecret.txt'), null);
  assert.equal(normalizeRelPath('%2e%2e/secret.txt'), null);
  assert.equal(normalizeRelPath('a\\..\\..\\secret.txt'), null);
  assert.equal(normalizeRelPath('a%00b'), null);
  assert.equal(normalizeRelPath('%E0%A4%A'), null); // 非法百分号编码
});

test('normalizeRelPath：允许正常相对路径与目录形态', () => {
  assert.equal(normalizeRelPath('index.html'), 'index.html');
  assert.equal(normalizeRelPath('src/scene.js'), 'src/scene.js');
  assert.equal(normalizeRelPath('./src/./scene.js'), 'src/scene.js');
  assert.equal(normalizeRelPath('src//scene.js'), 'src/scene.js');
  assert.equal(normalizeRelPath('/etc/passwd'), 'etc/passwd'); // 绝对路径被降为项目内相对路径
});

test('resolveInsideRoot：项目内文件通过、越界被拒', () => {
  const root = join(tmpdir(), 'modelcheck-root-test');
  const ok = resolveInsideRoot(root, 'src/scene.js');
  assert.equal(ok.ok, true);
  assert.equal(ok.rel, 'src/scene.js');
  assert.equal(ok.abs.toLowerCase(), join(root, 'src', 'scene.js').toLowerCase());

  assert.equal(resolveInsideRoot(root, '../outside.txt').ok, false);
  assert.equal(resolveInsideRoot(root, '').ok, false);
  assert.equal(resolveInsideRoot(root, '../outside.txt').reason, 'invalid-path');
});

test('resolveInsideRoot：Windows 盘符前缀不能骗过包含检查', () => {
  const root = join(tmpdir(), 'modelcheck-root-prefix');
  // 形如 <root>evil 的兄弟目录不能因为字符串前缀而被放行
  const attempt = resolveInsideRoot(root, '../modelcheck-root-prefix-evil/x.js');
  assert.equal(attempt.ok, false);
});

test('shouldInjectBridge：__VERIFY__ 与 injectBridge 的优先级', () => {
  assert.equal(shouldInjectBridge('1', { preview: { injectBridge: false } }), true);
  assert.equal(shouldInjectBridge('0', { preview: { injectBridge: true } }), false);
  assert.equal(shouldInjectBridge(null, { preview: { injectBridge: false } }), false);
  assert.equal(shouldInjectBridge(null, { preview: { injectBridge: true } }), true);
  assert.equal(shouldInjectBridge(null, {}), true);
  assert.equal(shouldInjectBridge(null, null), true);
});

test('bridgeTag：带 data-mc-build / data-mc-session 且过滤非法字符', () => {
  const tag = bridgeTag({ buildHash: 'sha256:abc123', sessionId: 'session-1' });
  assert.match(tag, /src="\/modelcheck\/assets\/bridge\.js"/);
  assert.match(tag, /data-mc-build="sha256:abc123"/);
  assert.match(tag, /data-mc-session="session-1"/);
  const sanitized = bridgeTag({ buildHash: 'x" onload="alert(1)', sessionId: '<q>' });
  assert.equal(sanitized.includes('onload='), false);
  assert.equal(sanitized.includes('<q>'), false);
});

test('bridgeTag：没有构建哈希时不写 data-mc-build', () => {
  const tag = bridgeTag({ buildHash: null, sessionId: 's1' });
  assert.equal(tag.includes('data-mc-build'), false);
  assert.match(tag, /data-mc-session="s1"/);
});

test('injectBridge：注入到 </body> 之前，没有 body 时追加', () => {
  const html = '<!doctype html><html><body><canvas></canvas></body></html>';
  const injected = injectBridge(html, { buildHash: 'b', sessionId: 's' });
  assert.ok(injected.indexOf('bridge.js') < injected.toLowerCase().indexOf('</body>'));
  assert.ok(injected.startsWith('<!doctype html>'));

  const noBody = '<div>hi</div>';
  assert.ok(injectBridge(noBody, { buildHash: 'b', sessionId: 's' }).endsWith('</script>'));
});

test('PREVIEW_MIME：设计要求的扩展名都有 MIME', () => {
  for (const ext of ['.html', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.webp', '.gif', '.svg', '.woff2']) {
    assert.equal(typeof PREVIEW_MIME[ext], 'string', ext);
    assert.ok(PREVIEW_MIME[ext].length > 0, ext);
  }
  assert.match(PREVIEW_MIME['.js'], /javascript/);
  assert.match(PREVIEW_MIME['.mjs'], /javascript/);
  assert.match(PREVIEW_MIME['.woff2'], /font\/woff2/);
  // 未知扩展不能落到 text/html
  assert.equal(PREVIEW_MIME['.exe'], undefined);
});
