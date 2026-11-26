#!/usr/bin/env node
/**
 * scripts/release-dry-run.mjs — 发布前四包打包白名单与体积演练检查
 *
 * 对 geospark-ai、geospark-ai-preset、geospark-ai-ui、geospark-ai-data 依次执行
 * `npm pack --dry-run --json`，校验：
 *   1) 包名、无 private 标记、含 publishConfig.access="public"；
 *   2) 打包文件清单不含教材原文（课本与课标/）、备份（.backups/）、运行产物（outputs/）、.env 或缓存文件；
 *   3) 课程方案技能的 Apache-2.0 LICENSE 与 NOTICE 包含在 geospark-ai-preset 发布清单内。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const PACKAGES = [
  { name: 'geospark-ai', dir: 'packages/geospark-ai' },
  { name: 'geospark-ai-preset', dir: '.agent-presets/geo-teacher' },
  { name: 'geospark-ai-ui', dir: 'packages/dsh-geo-teacher-ui' },
  { name: 'geospark-ai-data', dir: 'packages/dsh-geo-teacher-data' }
];

const FORBIDDEN_PATTERNS = [
  /^课本与课标\//,
  /^\.backups\//,
  /^outputs\//,
  /(?:^|\/)\.env(?:\.|$)/i,
  /__pycache__/,
  /\.pyc$/i
];

let failed = false;
console.log('GeoSparkAI · npm 四包发布演练（dry-run）\n');

for (const item of PACKAGES) {
  const absDir = join(ROOT, item.dir);
  const pkgJson = JSON.parse(readFileSync(join(absDir, 'package.json'), 'utf8'));
  if (pkgJson.name !== item.name) {
    console.error(`❌ ${item.dir}: package.json name="${pkgJson.name}"（期望 "${item.name}"）`);
    failed = true;
  }
  if (pkgJson.private) {
    console.error(`❌ ${item.name}: 仍含 "private": true，无法发布到 npm`);
    failed = true;
  }
  if (!pkgJson.publishConfig || pkgJson.publishConfig.access !== 'public') {
    console.error(`❌ ${item.name}: 缺少 publishConfig.access="public"`);
    failed = true;
  }

  const raw = execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', `./${item.dir}`, '--dry-run', '--json'],
    { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' }
  );
  const info = JSON.parse(raw)[0];
  const files = (info.files || []).map((f) => f.path);

  for (const file of files) {
    if (FORBIDDEN_PATTERNS.some((re) => re.test(file))) {
      console.error(`❌ ${item.name}: 命中禁入文件 "${file}"`);
      failed = true;
    }
  }

  if (item.name === 'geospark-ai-preset') {
    for (const required of [
      'data/config/knowledge_taxonomy_natural_geography.yaml',
      'data/config/knowledge_taxonomy_human_geography.yaml',
      'data/config/knowledge_taxonomy_regional_development.yaml',
      'data/config/knowledge_taxonomy_resources_environment_national_security.yaml',
      'skills/cn-high-school-geography-lesson-planning/LICENSE',
      'skills/cn-high-school-geography-lesson-planning/NOTICE'
    ]) {
      if (!files.includes(required)) {
        console.error(`❌ ${item.name}: 打包清单缺少必需文件 "${required}"`);
        failed = true;
      }
    }
  }

  if (item.name === 'geospark-ai-data') {
    if (pkgJson.dsh && pkgJson.dsh.bundle) {
      console.error(`❌ ${item.name}: 纯数据包不得声明 dsh.bundle`);
      failed = true;
    }
    const leakedVaultNotes = files.filter((f) => /^obsidian_vault\/0[013]_/.test(f));
    if (leakedVaultNotes.length > 0) {
      console.error(`❌ ${item.name}: 混入了非运行所需的图谱笔记 ${leakedVaultNotes[0]}`);
      failed = true;
    }
  }

  const sizeMb = (info.size / (1024 * 1024)).toFixed(2);
  console.log(`  ✅  ${info.name}@${info.version} — ${files.length} 个文件，压缩包 ${sizeMb} MB`);
}

console.log();
if (failed) {
  console.error('演练未通过，请修复上述问题后再执行 npm publish。');
  process.exit(1);
}
console.log('全部 4 个包通过白名单、许可文件与体积检查！');
