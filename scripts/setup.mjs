#!/usr/bin/env node
/**
 * scripts/setup.mjs — 本地源码仓库安装器入口（委托给 packages/geospark-ai/bin/cli.mjs）
 *
 * 在源码仓库内运行 `node scripts/setup.mjs [--check|--dry-run|--yes|--uninstall]` 时，
 * 默认启用 `--link <REPO_ROOT>` 符号链接开发模式（也可显式传 `--npm` 或 `--tarball-dir` 覆盖）。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../packages/geospark-ai/bin/cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

try {
  process.exitCode = runCli(process.argv.slice(2), { defaultLinkDir: REPO_ROOT });
} catch (error) {
  console.error('\u001b[31m✗\u001b[0m ' + ((error && error.message) || String(error)));
  process.exitCode = 1;
}
