/**
 * ModelCheck 预算与空转治理模块（设计文档 §2.12）
 *
 * 职责：
 * - 判定当前阶段（science/dev/prototype/production/delivery）与轮次/时间预算；
 * - 记录每轮尝试，产出「继续 / 提醒 / 禁止重复策略 / 停止」的裁决；
 * - 空转判定：连续多轮无新增 pass、unknown 未减少、指标未改善且策略重复；
 * - 停止时明确「只停止插件自有任务，宿主任务未确认停止」。
 *
 * 约束：纯 ESM、只用 node: 内置模块、不修改入参。
 */
import { nowIso, isPlainObject, clampInt } from './util.js';

/** 阶段取值。 */
export const BUDGET_PHASES = ['science', 'dev', 'prototype', 'production', 'delivery'];

/** 各阶段默认轮次与时间预算（分钟）。 */
export const PHASE_DEFAULTS = {
  science: { maxRounds: 3, maxMinutes: 90 },
  dev: { maxRounds: 3, maxMinutes: 120 },
  prototype: { maxRounds: 5, maxMinutes: 180 },
  production: { maxRounds: 8, maxMinutes: 240 },
  delivery: { maxRounds: 3, maxMinutes: 60 }
};

/** 连续空转达到该轮数 → 禁止重复策略。 */
export const STAGNATION_FORBID = 3;

/** 连续空转达到该轮数 → 停止。 */
export const STAGNATION_STOP = 5;

/** 动作 → 中文标签。 */
const ACTION_LABELS = {
  continue: '继续',
  remind: '提醒',
  'forbid-strategy': '禁止重复策略',
  stop: '停止'
};

/** 是否为合法阶段。 */
function isPhase(value) {
  return typeof value === 'string' && BUDGET_PHASES.includes(value);
}

/** 数值兜底。 */
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 计数兜底：布尔按 0/1，数组按长度，数字取整且非负。 */
function countOf(value) {
  if (value === true) return 1;
  if (value === false || value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return 0;
}

/** 解析 rounds 入参：兼容数组与 rounds.json 包装文档两种形态。 */
function roundsView(input) {
  if (Array.isArray(input)) return { wrapped: false, doc: null, list: input };
  if (isPlainObject(input) && Array.isArray(input.rounds)) {
    return { wrapped: true, doc: input, list: input.rounds };
  }
  return { wrapped: false, doc: null, list: [] };
}

/** 分钟数保留一位小数。 */
function roundMinutes(value) {
  return Math.round(value * 10) / 10;
}

/** 从项目 / 配置中取阶段；缺省时按项目形态推断。 */
export function budgetPhase(project) {
  const config = isPlainObject(project?.config) ? project.config : {};
  const explicit = [
    isPlainObject(config.budget) ? config.budget.phase : undefined,
    config.phase,
    project?.phase,
    isPlainObject(project?.meta) ? project.meta.phase : undefined,
    project?.contract?.phase
  ].find(isPhase);
  if (explicit) return explicit;

  // 推断：无契约 = 科学阶段；已认证 = 交付阶段；其余按开发阶段。
  // 注意：只有 certified === true 的记录才算「已认证」，失败记录不能把阶段抬到 delivery。
  if (!isPlainObject(project?.contract)) return 'science';
  if (project?.certification?.certified === true) return 'delivery';
  return 'dev';
}

/** 从配置读数值预算，支持数字或按阶段取值。 */
function readBudgetNumber(value, phase, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return clampInt(value, 1, 10000, fallback);
  }
  if (isPlainObject(value)) {
    return readBudgetNumber(value[phase], phase, fallback);
  }
  return fallback;
}

/** 计算累计耗时（分钟）：按时间戳；时间戳缺失时退化为逐轮数值累加。 */
function elapsedMinutesOf(rounds, endAt) {
  if (!Array.isArray(rounds) || rounds.length === 0) return 0;
  const start = Date.parse(rounds[0]?.at ?? '');
  const endRaw = endAt ?? rounds[rounds.length - 1]?.at;
  const end = Date.parse(endRaw ?? '');
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    return roundMinutes((end - start) / 60000);
  }
  let sum = 0;
  for (const round of rounds) {
    const value = numberOrNull(round?.elapsedMinutes);
    if (value !== null && value > 0) sum += value;
  }
  return roundMinutes(sum);
}

/** 有效轮次（排除 wait）按时间顺序。 */
function effectiveRounds(rounds) {
  return (Array.isArray(rounds) ? rounds : []).filter((round) => round?.wait !== true);
}

/** 本轮是否有实质进展。 */
function hasProgress(round) {
  if (!isPlainObject(round)) return false;
  if (countOf(round.newPass) > 0) return true;
  if (countOf(round.unknownReduced) > 0) return true;
  return round.metricImproved === true;
}

/** 连续空转轮数（跳过 wait；文字进度不重置计数）。 */
function stagnantCountOf(rounds) {
  const effective = effectiveRounds(rounds);
  let count = 0;
  for (let i = effective.length - 1; i >= 0; i -= 1) {
    if (hasProgress(effective[i])) break;
    count += 1;
  }
  return count;
}

/** 策略是否与上一有效轮次重复（progressNote 变化不算重复）。 */
function isRepeatedStrategy(rounds) {
  const effective = effectiveRounds(rounds);
  if (effective.length < 2) return false;
  const last = effective[effective.length - 1];
  const prev = effective[effective.length - 2];
  const lastStrategy = typeof last?.strategy === 'string' ? last.strategy : '';
  const prevStrategy = typeof prev?.strategy === 'string' ? prev.strategy : '';
  if (lastStrategy !== prevStrategy) return false;
  const lastNote = last?.progressNote ?? null;
  const prevNote = prev?.progressNote ?? null;
  return lastNote === prevNote;
}

/**
 * 计算预算裁决（内部共用）。
 */
function computeVerdict(phase, rounds, { maxRounds, maxMinutes, endAt } = {}) {
  const defaults = PHASE_DEFAULTS[phase] ?? PHASE_DEFAULTS.dev;
  const limitRounds = clampInt(maxRounds ?? defaults.maxRounds, 1, 100, defaults.maxRounds);
  const limitMinutes = typeof maxMinutes === 'number' && Number.isFinite(maxMinutes) && maxMinutes > 0
    ? maxMinutes
    : defaults.maxMinutes;

  const list = Array.isArray(rounds) ? rounds : [];
  const round = list.length;
  const remaining = Math.max(0, limitRounds - round);
  const elapsedMinutes = elapsedMinutesOf(list, endAt);
  const stagnantCount = stagnantCountOf(list);
  const repeated = isRepeatedStrategy(list);
  const lastStrategy = effectiveRounds(list).length > 0
    ? (effectiveRounds(list)[effectiveRounds(list).length - 1]?.strategy ?? '')
    : '';

  let action = 'continue';
  let allowed = true;
  let message = `继续推进：剩余 ${remaining} 轮（阶段 ${phase}）。`;

  if (elapsedMinutes > limitMinutes) {
    action = 'stop';
    allowed = false;
    message = `已用 ${elapsedMinutes} 分钟，超过时间预算 ${limitMinutes} 分钟：只停止插件自有任务，宿主任务未确认停止。`;
  } else if (round > limitRounds) {
    action = 'stop';
    allowed = false;
    message = `已用 ${round} 轮，超过轮次预算 ${limitRounds} 轮：停止继续试错，先向用户汇报现状与已知缺陷。`;
  } else if (stagnantCount >= STAGNATION_STOP) {
    action = 'stop';
    allowed = false;
    message = `连续 ${stagnantCount} 轮没有新增通过项、unknown 未减少、指标未改善，判定为空转：停止插件自有动作（宿主任务未确认停止）。`;
  } else if (stagnantCount >= STAGNATION_FORBID && repeated) {
    action = 'forbid-strategy';
    message = `连续 ${stagnantCount} 轮无改善且重复同一策略「${lastStrategy || '未命名'}」：禁止继续该策略，必须更换实现路径或证据通道。`;
  } else if (stagnantCount >= STAGNATION_FORBID) {
    action = 'remind';
    message = `连续 ${stagnantCount} 轮无新增通过项，虽然策略已变化，仍建议缩小目标并明确本轮要改善的指标。`;
  } else if (stagnantCount >= 2) {
    action = 'remind';
    message = `连续 ${stagnantCount} 轮无新增通过项，注意及时换策略或缩小目标。`;
  } else if (remaining <= 1) {
    action = 'remind';
    message = `剩余 ${remaining} 轮预算，请先收敛到最小可验证目标。`;
  }

  return {
    allowed,
    action,
    round,
    remaining,
    stagnantCount,
    elapsedMinutes,
    message,
    phase,
    maxRounds: limitRounds,
    maxMinutes: limitMinutes,
    repeatedStrategy: repeated,
    strategy: lastStrategy
  };
}

/**
 * 记录一轮尝试并给出裁决。
 * 入参：{ phase, target, metricBefore, metricAfter, strategy, progressNote,
 *        wait, newPass, unknownReduced, metricImproved, apiErrors, now,
 *        maxRounds?, maxMinutes?, metricDirection? }
 * 返回 { rounds, verdict }。
 */
export function recordRound(rounds, options = {}) {
  const view = roundsView(rounds);
  const list = view.list.slice();
  const optionsObject = isPlainObject(options) ? options : {};
  const phase = isPhase(optionsObject.phase) ? optionsObject.phase : 'dev';
  const at = typeof optionsObject.now === 'string' && optionsObject.now.length > 0
    ? optionsObject.now
    : nowIso();

  const metricBefore = numberOrNull(optionsObject.metricBefore);
  const metricAfter = numberOrNull(optionsObject.metricAfter);
  let metricImproved = optionsObject.metricImproved === true;
  if (!metricImproved && optionsObject.metricDirection === 'lower' && metricBefore !== null && metricAfter !== null) {
    metricImproved = metricAfter < metricBefore;
  }
  if (!metricImproved && optionsObject.metricDirection === 'higher' && metricBefore !== null && metricAfter !== null) {
    metricImproved = metricAfter > metricBefore;
  }

  const round = {
    round: list.length + 1,
    at,
    phase,
    target: optionsObject.target ?? null,
    metricBefore,
    metricAfter,
    strategy: typeof optionsObject.strategy === 'string' ? optionsObject.strategy : '',
    progressNote: typeof optionsObject.progressNote === 'string' ? optionsObject.progressNote : null,
    wait: optionsObject.wait === true,
    newPass: countOf(optionsObject.newPass),
    unknownReduced: countOf(optionsObject.unknownReduced),
    metricImproved,
    apiErrors: countOf(optionsObject.apiErrors)
  };

  const nextRounds = [...list, round];
  const verdict = computeVerdict(phase, nextRounds, {
    maxRounds: optionsObject.maxRounds,
    maxMinutes: optionsObject.maxMinutes,
    endAt: at
  });

  // 保持入参形态：数组进数组出；rounds.json 包装文档进包装文档出。
  const nextValue = view.wrapped
    ? { ...view.doc, rounds: nextRounds, updatedAt: at }
    : nextRounds;

  return { rounds: nextValue, verdict };
}

/**
 * 预算汇总（不追加轮次）：阶段、上限、剩余、已用时间、空转计数与当前裁决。
 */
export function budgetSummary(project, rounds) {
  const safeProject = isPlainObject(project) ? project : {};
  const view = roundsView(rounds ?? safeProject.rounds);
  const list = view.list.slice();
  const phase = budgetPhase(safeProject);
  const defaults = PHASE_DEFAULTS[phase];
  const config = isPlainObject(safeProject.config?.budget) ? safeProject.config.budget : {};

  const maxRounds = readBudgetNumber(config.maxRounds, phase, defaults.maxRounds);
  const maxMinutes = readBudgetNumber(config.maxMinutes, phase, defaults.maxMinutes);
  const verdict = computeVerdict(phase, list, {
    maxRounds,
    maxMinutes,
    endAt: list.length > 0 ? list[list.length - 1]?.at : undefined
  });

  const totals = { newPass: 0, unknownReduced: 0, metricImproved: 0, apiErrors: 0 };
  for (const round of list) {
    totals.newPass += countOf(round?.newPass);
    totals.unknownReduced += countOf(round?.unknownReduced);
    if (round?.metricImproved === true) totals.metricImproved += 1;
    totals.apiErrors += countOf(round?.apiErrors);
  }

  return {
    phase,
    maxRounds,
    maxMinutes,
    round: list.length,
    remaining: verdict.remaining,
    elapsedMinutes: verdict.elapsedMinutes,
    stagnantCount: verdict.stagnantCount,
    repeatedStrategy: verdict.repeatedStrategy,
    waitRounds: list.filter((round) => round?.wait === true).length,
    totals,
    verdict,
    note:
      verdict.action === 'stop'
        ? '只停止插件自有任务，宿主任务未确认停止。'
        : '插件自有动作仍在预算内。'
  };
}

/**
 * 恢复阶梯：三步中文建议（空转/超预算时展示给模型与用户）。
 */
export function recoveryLadder(verdict) {
  const value = isPlainObject(verdict) ? verdict : {};
  const round = Number.isFinite(value.round) ? value.round : '?';
  const action = typeof value.action === 'string' && ACTION_LABELS[value.action]
    ? ACTION_LABELS[value.action]
    : '继续';
  return [
    `恢复阶梯（第 ${round} 轮，预算动作：${action}）`,
    '1. 缩小目标：本轮只保留一条最小可验证判据，重现失败并记录 measured 与证据键，先拿到确定结论。',
    '2. 换策略：禁止重复上一轮策略，改为更换证据通道（运行时→静态/截图）或实现路径，并写明预期改善的指标。',
    '3. 升级上报：若下一步仍无新增 pass、unknown 未减少、指标未改善，则停止插件自有动作，并向用户说明「宿主任务未确认停止」。'
  ].join('\n');
}
