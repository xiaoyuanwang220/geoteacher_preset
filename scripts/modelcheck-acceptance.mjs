#!/usr/bin/env node
/**
 * modelcheck-acceptance.mjs —— ModelCheck 一期可执行验收
 *
 * 用法：node scripts/modelcheck-acceptance.mjs
 * 退出码：0=全部预期一致  1=有步骤不符合预期
 *
 * 边界（必须如实声明）：
 *   · 本脚本用**合成运行时证据**驱动规则与门禁，验证的是"插件判定逻辑"，不是浏览器取证链路；
 *   · 真实的 iframe/postMessage 取证、点选、投递会话需要在桌面端由用户操作见证（见实施记录 §未验证）；
 *   · 所有写盘都在临时目录里的 fixtures/project 副本上完成，不污染仓库。
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject, findProjectRoot } from '../packages/dsh-modelcheck/lib/project.js';
import { Store } from '../packages/dsh-modelcheck/lib/store.js';
import { evaluateCriteria } from '../packages/dsh-modelcheck/lib/evaluate.js';
import {
  applyCertification,
  evaluateCompletion,
  certificationValid
} from '../packages/dsh-modelcheck/lib/completion.js';
import {
  createBatch,
  sendBatch,
  triageRequest,
  closeByCriteria,
  renderBatchMessage
} from '../packages/dsh-modelcheck/lib/annotations.js';
import { recordRound } from '../packages/dsh-modelcheck/lib/budget.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURE = join(ROOT, 'packages', 'dsh-modelcheck', 'fixtures', 'project');
const OUT_DIR = join(ROOT, 'outputs', 'modelcheck-acceptance');

const steps = [];
function check(name, condition, detail) {
  steps.push({ name, ok: Boolean(condition), detail: detail === undefined ? '' : detail });
  console.log((condition ? '  OK  ' : ' FAIL ') + name + (detail ? ' — ' + detail : ''));
}

function syntheticEvidence({ gapPx, directionDeg, buildHash, sourceHash }) {
  return {
    buildHash,
    sourceHash,
    adapterVersion: 'modelcheck-acceptance/synthetic-1',
    context: { step: 'end', mode: 'normal', view: 'default' },
    components: {
      'nh-trade-winds': {
        unit: 'px',
        visible: true,
        directionDeg,
        endpoints: { start: { x: 320, y: 120, z: 0 }, end: { x: 220, y: 220, z: 0 } },
        worldPosition: { x: 220, y: 220, z: 0 }
      },
      'nh-westerlies': {
        unit: 'px',
        visible: true,
        endpoints: {
          start: { x: 220, y: 220 + gapPx, z: 0 },
          end: { x: 520, y: 220 + gapPx, z: 0 }
        },
        worldPosition: { x: 220, y: 220 + gapPx, z: 0 }
      }
    },
    coverage: [
      { id: 'nh-trade-winds', props: ['endpoints', 'directionDeg', 'worldPosition'] },
      { id: 'nh-westerlies', props: ['endpoints', 'worldPosition'] }
    ],
    errors: []
  };
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'modelcheck-acceptance-'));
  const projectRoot = join(work, 'project');
  await cp(FIXTURE, projectRoot, { recursive: true });
  const store = new Store(projectRoot);
  await store.ensureLayout();

  const buildHash = 'sha256:' + 'c'.repeat(64);
  let project = await loadProject(projectRoot, { store });
  const realSourceHash = project.hashes.sourceHash;

  // 1. 0.035 闭合缝 → fail；方向 225° → pass；文案 → pass
  let evidence = syntheticEvidence({ gapPx: 35, directionDeg: 225, buildHash, sourceHash: realSourceHash });
  let evaluation = await evaluateCriteria(project, {
    store,
    ctxFactory: async () => evidence
  });
  let results = evaluation.results;
  check('闭合判据复现 0.035 世界单位的缝隙 → fail',
    results['GEO-CLOSE-01'].status === 'fail' && Math.abs(results['GEO-CLOSE-01'].measured.distance - 0.035) < 1e-9,
    JSON.stringify(results['GEO-CLOSE-01'].measured));
  check('方向判据用运行时实际方向 225° → pass',
    results['GEO-DIR-01'].status === 'pass',
    JSON.stringify(results['GEO-DIR-01'].measured));
  check('配置类文案判据 → pass', results['GEO-TEXT-01'].status === 'pass');

  // 2. 未修复时完成门禁必须拒绝
  let completion = evaluateCompletion(project);
  check('存在阻塞 fail 时完成门禁拒绝认证',
    completion.certified === false && completion.blocking.some((item) => item.id === 'GEO-CLOSE-01'),
    (completion.reasons || []).join('; '));

  // 3. 修复闭合缝到 0.015 → pass；方向被渲染旋转成 45° → fail（配置正确但运行时错误）
  project = await loadProject(projectRoot, { store });
  evidence = syntheticEvidence({ gapPx: 15, directionDeg: 45, buildHash, sourceHash: realSourceHash });
  evaluation = await evaluateCriteria(project, { store, full: true, ctxFactory: async () => evidence });
  results = evaluation.results;
  check('修复到 0.015 后闭合判据 → pass', results['GEO-CLOSE-01'].status === 'pass',
    JSON.stringify(results['GEO-CLOSE-01'].measured));
  check('配置未变但运行时方向旋转 → fail（不被配置检查掩盖）',
    results['GEO-DIR-01'].status === 'fail', JSON.stringify(results['GEO-DIR-01'].measured));

  // 4. 方向修好后全过 → 认证；改动源码后认证失效
  project = await loadProject(projectRoot, { store });
  evidence = syntheticEvidence({ gapPx: 15, directionDeg: 225, buildHash, sourceHash: realSourceHash });
  evaluation = await evaluateCriteria(project, { store, full: true, ctxFactory: async () => evidence });
  check('全部判据 pass', evaluation.summary.byStatus.pass === 3, JSON.stringify(evaluation.summary.byStatus));
  completion = evaluateCompletion(project);
  check('全过时完成门禁签发认证', completion.certified === true, (completion.reasons || []).join('; '));
  if (completion.certified) {
    const certification = await applyCertification(project, { store });
    check('认证写入 certification.json 并绑定版本',
      certification.certified === true && existsSync(join(projectRoot, '.modelcheck', 'certification.json')));
    check('同一构建认证有效',
      certificationValid(certification, {
        contractVersion: completion.contractVersion,
        buildHash: completion.buildHash,
        sourceHash: completion.sourceHash
      }) === true);
    check('换了构建哈希后认证失效',
      certificationValid(certification, {
        contractVersion: completion.contractVersion,
        buildHash: 'sha256:' + 'e'.repeat(64),
        sourceHash: completion.sourceHash
      }) === false);
  }

  // 5. 依赖变化 → 证据 stale，必须复验
  const configPath = join(projectRoot, 'src', 'config.js');
  await writeFile(configPath, (await readFile(configPath, 'utf8')) + '\n// 验收：修改依赖文件\n', 'utf8');
  project = await loadProject(projectRoot, { store });
  evaluation = await evaluateCriteria(project, { store, ctxFactory: async () => syntheticEvidence({ gapPx: 15, directionDeg: 225, buildHash, sourceHash: realSourceHash }) });
  check('依赖文件变化 → 旧证据不复用（重跑或有 stale 记录）',
    evaluation.results['GEO-TEXT-01'].reused !== true,
    'reused=' + String(evaluation.results['GEO-TEXT-01'].reused));

  // 6. 标注通道：批次 → 投递文本 → 整理 → 关闭
  let annotations = { schemaVersion: 1, nextBatchSeq: 1, nextRequestSeq: 1, batches: [], requests: [] };
  const created = createBatch(annotations, {
    projectId: 'fixture-circulation',
    modelVersion: { buildHash },
    items: [{ componentId: 'nh-trade-winds', label: '北半球东北信风箭头', locator: { file: 'index.html', symbol: 'nh-trade-winds' }, userText: '这个箭头方向反了，应该从东北吹向西南' }]
  });
  annotations = created.annotations;
  const message = renderBatchMessage(created.batch, project.components);
  check('标注批次文本含组件 id、中文标签、代码位置与原话',
    message.includes('nh-trade-winds') && message.includes('北半球东北信风箭头') &&
    message.includes('index.html') && message.includes('这个箭头方向反了'),
    message.split('\n')[0]);
  const sent = sendBatch(annotations, created.batch.id);
  annotations = sent.annotations;
  const sentAgain = sendBatch(annotations, created.batch.id);
  check('重复发送同一批次保持幂等', sentAgain.idempotent === true);
  const requestId = created.batch.items[0].requestId;
  annotations = triageRequest(annotations, requestId, {
    claim: '北半球东北信风箭头方向应为西南向（方位角 225°±10°）',
    criteriaIds: ['GEO-DIR-01'],
    acceptance: 'auto'
  });
  check('整理为可判定 claim', annotations.requests[0].claim.length > 0 && annotations.requests[0].state === 'triaged');
  annotations = closeByCriteria(annotations, { 'GEO-DIR-01': 'pass' });
  check('关联判据全 pass → 请求进入待验收', annotations.requests[0].state === 'review', annotations.requests[0].state);
  annotations = closeByCriteria(annotations, { 'GEO-DIR-01': 'pass' });
  check('再次确认后请求关闭', annotations.requests[0].state === 'closed', annotations.requests[0].state);

  // 7. 轮次/空转：连续 3 轮无改善且同策略 → 禁止继续该策略
  let rounds = [];
  let verdict = null;
  for (let i = 0; i < 4; i += 1) {
    const recorded = recordRound(rounds, {
      phase: 'production',
      target: '闭合缝',
      metricBefore: 0.035,
      metricAfter: 0.035,
      strategy: '重设坐标',
      newPass: false,
      unknownReduced: false,
      metricImproved: false
    });
    rounds = recorded.rounds;
    verdict = recorded.verdict;
  }
  check('连续无改善 + 重复策略 → 禁止/停止并给恢复梯子',
    verdict.action === 'forbid-strategy' || verdict.action === 'stop',
    verdict.action + '：' + verdict.message.slice(0, 60));

  // 8. 空项目零干预（无 .modelcheck）
  const emptyRoot = join(work, 'empty');
  await cp(FIXTURE, emptyRoot, { recursive: true });
  await rm(join(emptyRoot, '.modelcheck'), { recursive: true, force: true });
  const emptyRootDetected = await findProjectRoot(emptyRoot).catch(() => undefined);
  check('没有 .modelcheck 的项目不会被识别为 ModelCheck 项目（插件不干预）', emptyRootDetected === null);

  await rm(work, { recursive: true, force: true });

  const failed = steps.filter((step) => !step.ok);
  const report = {
    kind: 'modelcheck-acceptance',
    at: new Date().toISOString(),
    dshVersion: '0.2.1-rc.2',
    adapterVersion: 'modelcheck-acceptance/synthetic-1',
    note: '合成运行时证据；不冒充浏览器取证。iframe/点选/投递需在桌面端人工见证。',
    steps,
    summary: { total: steps.length, pass: steps.length - failed.length, fail: failed.length }
  };
  await cp(FIXTURE, join(OUT_DIR, 'fixture-copy'), { recursive: true }).catch(() => {});
  await writeFile(join(OUT_DIR, 'acceptance-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('');
  console.log(`modelcheck-acceptance: ${report.summary.pass}/${report.summary.total} 项符合预期（报告已写入 outputs/modelcheck-acceptance/acceptance-report.json）`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('验收脚本异常:', error);
  process.exit(1);
});
