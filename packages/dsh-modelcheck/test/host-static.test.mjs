// host 半边纯函数单测：/modelcheck/assets 白名单。不依赖 lib/ 与宿主运行时。
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAsset } from '../server/static.js';

test('resolveAsset：bridge.js / icon.svg / 栅格图放行', () => {
  const bridge = resolveAsset('bridge.js');
  assert.ok(bridge);
  assert.match(bridge.contentType, /text\/javascript/);

  const icon = resolveAsset('icon.svg');
  assert.ok(icon);
  assert.equal(icon.contentType, 'image/svg+xml');

  for (const name of ['shot.png', 'photo.jpg', 'photo.jpeg', 'pic.webp', 'anim.gif']) {
    const asset = resolveAsset(name);
    assert.ok(asset, name);
    assert.match(asset.contentType, /^image\//);
  }
});

test('resolveAsset：拒绝任意 SVG 与未知类型', () => {
  assert.equal(resolveAsset('evil.svg'), null);
  assert.equal(resolveAsset('page.html'), null);
  assert.equal(resolveAsset('module.mjs'), null); // 桥接脚本只有 bridge.js，不扩大到任意模块
  assert.equal(resolveAsset('noext'), null);
  assert.equal(resolveAsset('.png'), null);
});

test('resolveAsset：单段文件名，挡掉路径穿越', () => {
  assert.equal(resolveAsset('../secret.png'), null);
  assert.equal(resolveAsset('a/b.png'), null);
  assert.equal(resolveAsset('a\\b.png'), null);
  assert.equal(resolveAsset('..%2fsecret.png'), null);
  assert.equal(resolveAsset(''), null);
  assert.equal(resolveAsset(null), null);
  assert.equal(resolveAsset(42), null);
});

test('resolveAsset：素材路径固定在本包 assets/ 目录', () => {
  const asset = resolveAsset('bridge.js');
  assert.ok(asset);
  assert.match(asset.path.replace(/\\/g, '/'), /packages\/dsh-modelcheck\/assets\/bridge\.js$/);
});
