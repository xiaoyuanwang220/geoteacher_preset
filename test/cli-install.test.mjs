// geospark-ai CLI 一键安装 / 升级 / 检查 / 卸载与旧包名平滑迁移测试
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIRROR_REGISTRY,
  buildDesiredManifest,
  parseCliArgs,
  runCli,
  verifyProfileInstallation
} from '../packages/geospark-ai/bin/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

test('parseCliArgs：支持 install/update/check/uninstall、--mirror、--no-data 与 --link', () => {
  const a = parseCliArgs(['install', '--mirror', '--yes']);
  assert.equal(a.action, 'install');
  assert.equal(a.registry, MIRROR_REGISTRY);
  assert.equal(a.yes, true);

  const b = parseCliArgs(['update', '--no-data', '-y']);
  assert.equal(b.action, 'update');
  assert.equal(b.noData, true);
  assert.equal(b.yes, true);

  const c = parseCliArgs(['--uninstall', '--profile', 'demo', '--yes']);
  assert.equal(c.action, 'uninstall');
  assert.equal(c.profile, 'demo');
  assert.equal(c.yes, true);
});

test('buildDesiredManifest：写入 geospark-ai-*、严禁数据包入 bundles、清理旧包名且保留用户私有包', () => {
  const before = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {
      '@geo-edu/dsh-geo-teacher-preset': 'link:/old/preset',
      '@geo-edu/dsh-geo-teacher-ui': 'link:/old/ui',
      '@geo-edu/dsh-geo-teacher-data': 'link:/old/data',
      '@geo-edu/dsh-modelcheck': 'link:/private/modelcheck'
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          '@geo-edu/dsh-geo-teacher-preset',
          '@geo-edu/dsh-geo-teacher-ui',
          '@geo-edu/dsh-geo-teacher-data'
        ]
      }
    }
  };

  const after = buildDesiredManifest(before, { tag: 'latest', noData: false, linkDir: '' });
  assert.deepEqual(after.dependencies, {
    '@geo-edu/dsh-modelcheck': 'link:/private/modelcheck',
    'geospark-ai-preset': 'latest',
    'geospark-ai-ui': 'latest',
    'geospark-ai-data': 'latest'
  });
  assert.deepEqual(after.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'geospark-ai-preset',
    'geospark-ai-ui'
  ]);
  assert.equal(after.dsh.profile.bundles.includes('geospark-ai-data'), false, '纯数据包绝不可列入 bundles');

  // --no-data 模式只装 preset + ui
  const noDataManifest = buildDesiredManifest(after, { tag: 'latest', noData: true, linkDir: '' });
  assert.equal('geospark-ai-data' in noDataManifest.dependencies, false);
  assert.equal(noDataManifest.dependencies['geospark-ai-preset'], 'latest');
});

test('隔离 DSH_HOME 端到端闭环：link 安装 → check 通过 → uninstall 干净移除并保留个人配置与其他插件', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'geospark-cli-e2e-'));
  try {
    const profileDir = join(fakeHome, 'profiles', 'desktop');
    const userGeoDir = join(fakeHome, 'geo-teacher');
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(userGeoDir, { recursive: true });
    writeFileSync(join(userGeoDir, 'config.json'), JSON.stringify({ outputPath: './my-outputs' }));
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@geo-edu/dsh-geo-teacher-preset': 'link:' + join(REPO_ROOT, '.agent-presets', 'geo-teacher').replace(/\\/g, '/')
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@geo-edu/dsh-geo-teacher-preset']
        }
      }
    }, null, 2));

    const logs = [];
    const installCode = runCli(['install', '--link', REPO_ROOT, '--yes'], {
      dshHome: fakeHome,
      skipVersionCheck: true,
      stdout: (s) => logs.push(s),
      stderr: (s) => logs.push(s)
    });
    assert.equal(installCode, 0, 'install 应成功退出：\n' + logs.join('\n'));

    const verified = verifyProfileInstallation(profileDir, { linkDir: REPO_ROOT });
    assert.deepEqual(verified.problems, []);

    const checkCode = runCli(['check', '--link', REPO_ROOT], {
      dshHome: fakeHome,
      skipVersionCheck: true,
      stdout: () => {},
      stderr: () => {}
    });
    assert.equal(checkCode, 0, '安装后 check 应返回 0');

    const uninstallCode = runCli(['uninstall', '--yes'], {
      dshHome: fakeHome,
      skipVersionCheck: true,
      stdout: () => {},
      stderr: () => {}
    });
    assert.equal(uninstallCode, 0, 'uninstall 应返回 0');

    const finalManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    assert.equal('geospark-ai-preset' in (finalManifest.dependencies || {}), false);
    assert.equal('geospark-ai-ui' in (finalManifest.dependencies || {}), false);
    assert.equal('geospark-ai-data' in (finalManifest.dependencies || {}), false);
    assert.deepEqual(finalManifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
    assert.equal(existsSync(join(userGeoDir, 'config.json')), true, '卸载后必须保留用户个人配置');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
