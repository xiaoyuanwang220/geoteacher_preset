#!/usr/bin/env node
/**
 * check-image-types.mjs — 图片伪装文件审计
 *
 * 扫题库/知识库目录下所有图片文件，读文件头魔数识别**真实格式**，
 * 与扩展名推定的格式比对，列出"扩展名与实际内容不符"的伪装文件
 * （典型：webp 内容 + .png 扩展名，会导致视觉识别按错误 mediaType 解码失败）。
 *
 * 用法：node scripts/check-image-types.mjs [--root <dir>] [--json]
 *   --root  要扫描的目录（默认 $env:GEO_KB_ROOT，未设置则 E:/知识图谱/obsidian_vault）
 *   --json  输出机器可读 JSON
 * 退出码：0=未发现伪装  1=发现伪装  2=用法/参数错误
 */
import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
let root = process.env.GEO_KB_ROOT || 'E:/知识图谱/obsidian_vault';
let json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') json = true;
  else if (args[i] === '--root') { i++; root = args[i] || ''; }
  else { console.error(`未知参数: ${args[i]}（用法: node scripts/check-image-types.mjs [--root <dir>] [--json]）`); process.exit(2); }
}
if (!root) { console.error('缺少扫描目录（--root <dir>）'); process.exit(2); }

// 扩展名 -> 推定 MIME
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;

// 魔数嗅探（与 vision 插件同源逻辑，另含 bmp/tiff 便于审计分类）
function sniff(bytes) {
  if (!bytes || bytes.length < 4) return null;
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)) return 'image/tiff';
  return null;
}

function readHead(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    return n > 0 ? buf.subarray(0, n) : null;
  } catch { return null; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
}

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && IMG_EXT.test(e.name)) out.push(p);
  }
}

// ── 扫描 ──
const files = [];
walk(root, files);
const mismatches = [];
const unknown = [];
let okCount = 0;
for (const f of files) {
  const ext = extname(f).slice(1).toLowerCase();
  const extMime = EXT_MIME[ext] || null;
  const bytes = readHead(f);
  const real = sniff(bytes);
  if (real === null) { unknown.push(f); continue; }
  if (extMime && real === extMime) { okCount++; continue; }
  const realExt = real === 'image/jpeg' ? 'jpg' : real.split('/')[1];
  mismatches.push({ file: relative(root, f), ext, extMime: extMime || '(扩展名未识别)', real, suggested: '.' + realExt });
}

// ── 输出 ──
if (json) {
  console.log(JSON.stringify({ root, scanned: files.length, ok: okCount, mismatches, unknown: unknown.map(u => relative(root, u)) }, null, 2));
} else {
  console.log(`图片伪装文件审计 — 根目录: ${root}`);
  console.log(`扫描 ${files.length} 个图片文件 | 正常 ${okCount} | 伪装 ${mismatches.length} | 无法识别内容 ${unknown.length}\n`);
  if (mismatches.length > 0) {
    console.log('【伪装文件】扩展名与实际内容不符（建议改名为实际格式扩展名）：');
    for (const m of mismatches) {
      console.log(`  ❌ ${m.file}`);
      console.log(`     扩展名 .${m.ext} → ${m.extMime}，实际内容 ${m.real}，建议改名为 ${m.suggested}`);
    }
  }
  if (unknown.length > 0) {
    console.log(`\n【无法识别内容】${unknown.length} 个（文件头既非 PNG/JPEG/GIF/WebP/BMP/TIFF，可能是损坏或非常规格式）：`);
    for (const u of unknown) console.log(`  ? ${relative(root, u)}`);
  }
  if (mismatches.length === 0 && unknown.length === 0) console.log('✅ 未发现伪装文件。');
}
process.exit(mismatches.length > 0 ? 1 : 0);
