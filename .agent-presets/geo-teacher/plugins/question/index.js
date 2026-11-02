// GeoTeacher Agent — 命题包校验工具插件（geo-question）
// 模型工具：geo_question_validate
//
// 归属：`docs/geography-question-generation-execution-plan.md` §8.2。
// 实现只有一份：`plugins/question/package.js`（与 CLI `skills/geo-question-generator/scripts/check-package.mjs` 同源）。
// 本插件只做两件事：解析任务目录、调用实现、把报告交给模型。**不下载来源、不生成图、不自动改稿。**
//
// 包内相对 import 允许（同包内辅助模块）；不 import 任何宿主包。
// 未实现 HTTP 路由，因此不注入 webServer、不增加 isolate 项（§8.2）。
import { join, dirname, isAbsolute } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  SCHEMA_VERSION,
  validatePackage,
  buildValidationReport,
  buildStudentProjection,
  buildTeacherProjection,
  renderMarkdown,
  resolveTaskDir,
  toLosslessJson,
} from './package.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESET_ROOT = join(HERE, '..', '..');
const SCHEMA_FILE = join(HERE, 'package.schema.json');

function renderJson(args, value) {
  const text = JSON.stringify(value, null, 2);
  const capped = text.length > 16000 ? text.slice(0, 16000) + '\n...[截断，总长 ' + text.length + ']' : text;
  return [{ type: 'text', text: capped }];
}

function renderReport(args, value) {
  if (!value || value.status === 'error') return renderJson(args, value);
  const r = value.report;
  const lines = [];
  lines.push('# 命题包校验：' + r.taskId + '（revision ' + r.packageRevision + '，题型 ' + r.questionType + '）');
  lines.push('');
  lines.push('- 结构：**' + (r.structureOk ? '通过' : '不通过') + '**（fail ' + r.summary.fail + ' / warn ' + r.summary.warn + ' / info ' + r.summary.info + '）');
  lines.push('- 完成度：声明 `' + r.declaredReadiness + '`，结构可支撑 `' + r.effectiveReadiness + '`'
    + (r.readinessClaim === 'equal' ? '' : r.readinessClaim === 'over' ? '　⚠️ **声明高于结构可支撑**' : '　（声明保守，低于结构可支撑）'));
  lines.push('- 目标 `' + value.target + '`：' + (value.targetMet ? '已满足' : '**未满足**'));
  lines.push('');
  lines.push('| 门禁 | 结构 | 语义 |');
  lines.push('| :-- | :-- | :-- |');
  for (const g of r.gates) lines.push('| ' + g.id + ' ' + g.name + ' | ' + g.structural + ' | ' + g.semantic + ' |');
  if (r.usableBlockers.length) {
    lines.push('');
    lines.push('**阻止「可使用」的项**');
    for (const b of r.usableBlockers) lines.push('- ' + b);
  }
  if (r.findings.length) {
    lines.push('');
    lines.push('**发现**');
    for (const f of r.findings) lines.push('- `[' + f.level + ']` ' + f.gate + ' `' + f.pointer + '` ' + f.message);
  }
  lines.push('');
  lines.push('> 语义项一律 `pending`：**结构通过不等于质量通过**，校验器只能核对所提供的评审记录与版本一致性，不能证明评审真实发生。');
  if (value.targetReasons && value.targetReasons.length) {
    lines.push('');
    lines.push('目标未满足的原因：');
    for (const x of value.targetReasons) lines.push('- ' + x);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

export default {
  name: 'geo-question',
  inject: ['fs', 'tools'],
  apply(ctx, config) {
    const fsService = ctx.fs;
    const cfg = config || {};
    // ── 输出根解析（与 core 同一优先级链，键名 questionOutputRoot） ──────────
    // 插件 config ＞ 用户配置 <DSH_HOME>/geo-teacher/config.json ＞ 明确报错。
    // 不写死作者机器路径；相对路径以配置文件的目录为基准。
    const CONFIG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'geo-teacher', 'config.json');
    const CONFIG_DIR = dirname(CONFIG_PATH);

    function readUserConfig() {
      try {
        if (!existsSync(CONFIG_PATH)) return {};
        const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch { return {}; }
    }
    const fileCfg = readUserConfig();
    const pick = (key) => {
      for (const v of [cfg[key], fileCfg[key]]) if (v !== undefined && v !== null && v !== '') return v;
      return null;
    };
    const toAbs = (p) => (isAbsolute(p) ? p : join(CONFIG_DIR, p));
    let OUTPUT_ROOT = null;
    let OUTPUT_ROOT_FROM = null;
    if (pick('questionOutputRoot')) { OUTPUT_ROOT = toAbs(pick('questionOutputRoot')); OUTPUT_ROOT_FROM = 'questionOutputRoot'; }
    else if (pick('outputPath')) { OUTPUT_ROOT = join(toAbs(pick('outputPath')), '出题'); OUTPUT_ROOT_FROM = 'outputPath + /出题'; }
    else if (pick('workspaceRoot')) { OUTPUT_ROOT = join(toAbs(pick('workspaceRoot')), 'outputs', '出题'); OUTPUT_ROOT_FROM = 'workspaceRoot + /outputs/出题'; }

    let schemaCache = null;
    function loadSchema() {
      if (schemaCache) return schemaCache;
      try {
        schemaCache = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        schemaCache = null;
        console.error('geo-question: 无法读取 ' + SCHEMA_FILE + '：' + ((e && e.message) || e));
      }
      return schemaCache;
    }

    ctx.tools.register({
      name: 'geo_question_validate',
      description:
        '校验 `outputs/出题/<taskId>/package.json` 命题包是否满足 package.schema.json（schemaVersion ' + SCHEMA_VERSION + '）与跨字段一致性：分值三级求和、采分点/小问/来源/图表等 ID 引用是否可解析、学生投影是否夹带答案侧字段、确认与评审的版本绑定、readiness 与门禁是否自洽、v1 题包是否需迁移。'
        + '只给**结构结论**：语义项（答案唯一性、材料充分性、科学性、答案边界可判定、四翼与难度依据）一律返回 pending，需人工或独立核验。'
        + '默认只校验、不写盘；`render:true` 才生成 draft.md / student.json / teacher.json / validation.json。不接受任意目录，只按 taskId 在配置的出题输出根下定位。',
      parameters: {
        type: 'object',
        properties: {
          taskId: {
            type: 'string',
            description: '出题任务 id，形如 2026-1004-ecofragile-01（' + '/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/' + '）',
          },
          target: {
            type: 'string',
            enum: ['concepts', 'draft', 'usable'],
            description: '本次要核到的目标阶段：concepts=三构思与教师选定；draft=完整题组与说明的结构齐备；usable=结构上是否支撑「可使用」。默认 draft',
          },
          render: {
            type: 'boolean',
            description: 'true 时在任务目录内生成 draft.md / student.json / teacher.json / validation.json（默认 false，只校验不写盘）',
          },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: renderReport,
      },
      async execute(args) {
        const a = args || {};
        const target = a.target || 'draft';
        if (target === 'usable' && a.render) {
          return { status: 'error', message: 'target=usable 时不允许同时 render：可能把尚不可使用的题组落成产物。请先只校验。' };
        }
        if (!OUTPUT_ROOT) {
          return {
            status: 'error',
            message: '未配置出题输出根（questionOutputRoot 或 outputPath/workspaceRoot）：请在 ' + CONFIG_PATH + ' 写入该键。',
          };
        }
        const resolved = resolveTaskDir(OUTPUT_ROOT, a.taskId);
        if (!resolved.ok) return { status: 'error', message: resolved.error };

        let pkg;
        try {
          const target0 = await fsService.resolve(join(resolved.dir, 'package.json'));
          const text = await fsService.readText(target0);
          pkg = JSON.parse(String(text).replace(/^\uFEFF/, ''));
        } catch (e) {
          return { status: 'error', message: '读取或解析 ' + resolved.dir + '/package.json 失败：' + ((e && e.message) || e) };
        }

        const schema = loadSchema();
        if (!schema) {
          return { status: 'error', message: '无法读取 package.schema.json（' + SCHEMA_FILE + '）：校验必须按契约进行，不降级为"凭记忆检查"。' };
        }

        const findings = validatePackage(pkg, { schema });
        const report = buildValidationReport(pkg, findings, {
          validator: 'plugins/question/package.js',
          validatedAt: new Date().toISOString(),
        });

        const targetReasons = [];
        if (target === 'concepts') {
          if (!(pkg.concepts || []).some(Boolean) || (pkg.concepts || []).length < 3) targetReasons.push('构思不足 3 个');
          if (!pkg.selectedConcept) targetReasons.push('尚未记录教师选定的构思（selectedConcept 为空）');
          if (!(pkg.confirmations || []).some((c) => c && c.type === 'concept_selection')) targetReasons.push('没有 concept_selection 确认记录');
        } else if (target === 'draft') {
          if (!pkg.questionSet) targetReasons.push('缺 questionSet');
          if (!pkg.design) targetReasons.push('缺 design');
          if (!pkg.simulations || !pkg.simulations.length) targetReasons.push('缺 simulations');
          for (const f of findings) if (f.level === 'fail' && ['G4', 'schema'].includes(f.gate)) targetReasons.push('结构失败：' + f.pointer + ' ' + f.message);
        } else if (target === 'usable') {
          if (report.effectiveReadiness !== 'usable') targetReasons.push('结构可支撑的完成度是 ' + report.effectiveReadiness + '，不是 usable');
          targetReasons.push(...report.usableBlockers);
        }

        const result = {
          status: 'success',
          target,
          targetMet: targetReasons.length === 0,
          targetReasons,
          outputRoot: OUTPUT_ROOT,
          outputRootFrom: OUTPUT_ROOT_FROM,
          taskDir: resolved.dir,
          wrote: [],
          report,
        };

        if (a.render === true) {
          const outputs = [
            ['draft.md', renderMarkdown(pkg)],
            ['student.json', JSON.stringify(buildStudentProjection(pkg), null, 2) + '\n'],
            ['teacher.json', JSON.stringify(buildTeacherProjection(pkg), null, 2) + '\n'],
            ['validation.json', JSON.stringify(report, null, 2) + '\n'],
          ];
          try {
            for (const [name, content] of outputs) {
              const t = await fsService.resolve(join(resolved.dir, name));
              await fsService.writeText(t, content, undefined, undefined, { mode: 'workspace-write', workspaceRoot: resolved.root });
              result.wrote.push(name);
            }
          } catch (e) {
            return toLosslessJson({ status: 'error', message: '写盘失败：' + ((e && e.message) || e), wrote: result.wrote, report });
          }
          if (!report.structureOk) result.renderWarning = '结构未通过：已写出的文件仅供排查，不得作为交付物。';
        }

        // DSH 的工具边界要求返回值是 lossless JSON：对象里值为 undefined 的键会被
        // JSON.stringify 丢掉，导致整个调用被判 INVALID_TOOL_OUTPUT（2026-10-12 桌面实测命中过）。
        // 因此在边界前统一规整；发现不可无损化的类型时 toLosslessJson 会抛错并指明路径。
        return toLosslessJson(result);
      },
    });

    console.log('geo-question: geo_question_validate 工具已注册（输出根 ' + (OUTPUT_ROOT || '未配置') + '）');
  }
};
