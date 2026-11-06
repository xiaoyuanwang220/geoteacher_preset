---
name: geo-dev-checklist
description: Use when modifying geo-teacher plugins, composition, or skills — before committing and after restarting the DSH Desktop host. Covers three verification layers — `npm run verify:geo` deterministic static and runtime checks, manual review items the script cannot cover, and session-trajectory review of what the model actually did in a real preset session. Semantic code review belongs to geo-code-review. Not a teacher-facing skill.
---

# 地理教师 Agent 开发自检

本技能面向**开发/维护**本项目的 Agent，不进教师运行预设。

## 确定性检查（自动）

运行 `npm run verify:geo`（参数见下表），确认输出 0 项失败：

| 命令 | 用途 |
| :-- | :-- |
| `npm run verify:geo` | 全量检查（源码 + 运行时冒烟） |
| `npm run verify:geo -- --source` | 仅源码静态检查（不需重启） |
| `npm run verify:geo -- --skip-runtime` | 源码检查 + 跳过运行时冒烟 |
| `npm run verify:geo -- --json` | 输出机器可读 JSON |

脚本针对 rc.2 的**声明行形态**（`.agent-presets\geo-teacher\cordis.patch.yml`）做检查，**不依赖旧 `agent.cordis.yml`，也不要求存在 C: 运行时副本**：

| 组 | 检查项 |
| :-- | :-- |
| 插件 | 语法（`process.execPath --check`，不依赖 PATH 中的 `node`）/ ESM 导入 / apply 冒烟（mock ctx） |
| 接线 | `dsh.bundle.patch` 指向存在 / patch 声明行完整（`config.id` + `config.plugins`）/ 插件行均有 `name` / 无相对路径插件名 |
| 导出 | `cordis.patch.yml` 引用的每个包子路径都有 `exports` 且目标文件存在 / `./package.json` 可导出（技能根解析依据）/ `skills\` 存在 |
| 隔离 | 每个 `ctx.provide('X')` 都在 patch 的 isolate 中被声明 |
| 路由 | `/geo/*` 源码内无重复路径 |
| 技能 | 两个技能根（预设 + 开发）的入口唯一与跨根重名 / frontmatter 的 `name` 与 `description` 必填 / `description` ≤ 500 字符（运行时静默截断）与「: 」YAML 陷阱 / 正文 ≤ 8192 码点（压缩裁剪阈值）/ 消费方式申报 / `references`、`scripts` 引用可达 |
| 回归 | 讲题流水线断言（solve 无答案泄漏 / 原生图片交付契约 / 旧视觉链路已移除 / 独立答案编排 / 解析层修复断言 / 索引数据完整性） |
| 提示 | 部署形态（link 或包安装，**不作为失败项**）/ `tool-web` 的 fetch 开关 / 正文按消费方式的软上限、单节长度与可跳读性 / `.backups` |
| 运行时 | `/geo/core/health` + `/geo-teacher`（仅 `--runtime`） |

**⚠️ 静态检查边界**：`cordis.patch.yml` 含 `!!js` 表达式，脚本只做**结构扫描、不求值**——表达式语义与 Loader 实际挂载结果只能靠重启后验收。路由静态扫描也只能发现当前源码内的重复路径，不能发现运行进程中旧路径仍被占用的问题。

## 会话轨迹审查（端到端，第三层）

`verify:geo` 查的是静态结构，代码审查查的是代码写得对不对；**两者都查不出模型在真实会话里到底做了什么**。凡是改动**模型可见行为**（技能正文与 `references`、工具 `description`、persona／系统提示、校验器的判定与返回措辞），跑一轮真实任务再回来读轨迹。

**为什么需要这一层**——2026-10-21 的 M2 实测，三个缺陷全部躲过了 89 项单元测试与 28 项静态检查：

| 现象 | 静态检查为何看不见 |
| :-- | :-- |
| 构思阶段没有题组却被判 `fail`，模型连改三轮修不掉、换包重来 | 单元测试只喂「合理输入」，覆盖不到「合法但为空」的阶段状态 |
| 语义项全 `pending` 时仍输出 `effectiveReadiness: usable`，还提示「声明保守」 | 这是**产物内部自相矛盾**，不在任何断言里 |
| 模型在同一任务里换了 `taskId`，旧包成孤儿 | 这是**模型行为**，不是代码 |

### 做法

1. 跑之前先写下**预期行为**（该调哪些工具、该出现几次校验、完成度应是什么）。
2. 导出并读取轨迹。两个来源读法不同，见 `references/session-trajectory-review.md`（含「多帧 zstd 只解第一帧」这个坑）。
3. 按 A／B／C 三个维度审，**每条落到证据**（行号／入参／返回正文），不凭印象。

### A 工具调用序列
- [ ] 预期该调的工具都出现了吗？（例：改出题校验后，`geo_question_validate` 应被真实调用）
- [ ] 顺序对吗？（例：讲题必须 solve → judge → explain）
- [ ] 有 `UNKNOWN_TOOL` 吗？——模型幻觉了预设里不存在的工具，说明文案或 `description` 给了错误暗示。
- [ ] 有同一调用反复重试吗？**重试次数是症状指标**：模型修不掉某个 `fail` 时会一直重试（见上表第 1 行）。

### B 失败项与错误码
- [ ] 逐个列出 `isError` / `error.code`：`FS_NOT_FOUND`、`FS_AMBIGUOUS_EDIT`、`INVALID_TOOL_OUTPUT`、`ERR_MODULE_NOT_FOUND`……
- [ ] 分清**模型失误**与**被工具坑了**：前者记 TODO；后者必须改工具或文案。
- [ ] `INVALID_TOOL_OUTPUT: value is not lossless JSON` 一律算工具缺陷（返回值含 `undefined` 键），不是模型参数错。

### C 模型宣称 vs 报告事实
- [ ] 模型说的完成度，与 `validation.json` 的 `declaredReadiness`／`effectiveReadiness` 一致吗？
- [ ] 语义未评审时有没有宣称「可使用」？——完成度口径失守，校验器的措辞要背一部分责任。
- [ ] 有没有把「结构通过」说成「质量通过」？
- [ ] 派生产物是否**由校验器／渲染器生成**（`draft.md` 六章节、`student.json` 不含答案侧字段），而不是模型手写？

### 审完之后
- 修工具／文案／技能的 → 回到「确定性检查」重跑，并按 §1 重启后冒烟。
- 修模型的（幻觉工具、换 `taskId` 之类）→ 改技能或 `references` 把它写死，别指望模型下次自己记住。
- **改过任何技能的 frontmatter，先确认该技能仍在目录里**：`description` 里出现 `: `（冒号 + 空格）会让 YAML 把它当成映射键，技能被**静默**从目录剔除。`verify:geo` 自 2026-11-05 起覆盖开发技能根，这类写法会由 `skills-desc-yaml` 提示；但技能是否**真的**进入目录，仍只有实际调用或看目录能确认。（2026-10-21 改本技能描述时踩过。）

## 人工判断项（程序无法覆盖）

### 1. 重启后冒烟
- 改 `cordis.patch.yml` / 插件 JS / 包导出或依赖后，**完整重启 DSH Desktop**（关闭主窗口可能只是隐藏到后台，需确认应用与 Host 进程已退出），再跑 `npm run verify:geo -- --runtime`。
- 若运行时冒烟失败（duplicate route），说明旧 generation 路由仍被持有——再等几秒重试，或确认进程已完全重启。
- 仅改技能文档（`SKILL.md`、平铺 `<name>.md`）由技能发现器监听入口，不需要例行重启；改 `references\` 等支持文件**不刷新技能目录**，下次显式读取即取得新内容。

### 2. isolate 白名单
- 新增 `ctx.provide('X')` 时，必须同步在 `cordis.patch.yml` 的 geo group `isolate` 里加 `X: true`。
- 运行时会报 `row(s) published process-global service(s) [X]` → 立即加白名单。

### 3. 新增 webServer 路由
- 路由 path 不得与已有路由重复（`/geo/*` 前缀已被占用）。
- 运行时 duplicate route 错误无法通过静态扫描发现——只能靠重启后冒烟。

### 4. 新增插件/工具
- 本地插件一律走**包子路径导出**：先在 `package.json` 的 `exports` 加 `./plugins/<name>`，再在 `cordis.patch.yml` 的 geo group 写 `@geo-edu/dsh-geo-teacher-preset/plugins/<name>`。
  **不要**写 `./plugins/<name>/index.js`——声明行的 `baseUrl` 是 profile 目录，相对路径会 `ERR_MODULE_NOT_FOUND`，导致整个 preset 挂载失败并写入 `record.broken`。
- 工具 `ctx.tools.register({ name: 'geo_*', ... })` 前，先用 `ctx.get('tools')` 检查注册表是否存在。
- 若工具注册失败（报 "without inject"），需在插件声明 `inject: ['tools']`。
- 服务 `ctx.provide` 必须落在带 `isolate` 的 group 内。

### 5. 语义代码审查（交给 geo-code-review）
判断代码与设计是否正确的**语义审查**（生命周期 / 所有权 / 真实入口 / 模型可见契约 / 讲题流水线纪律 / 缓存新鲜度等完整维度）由 `.agents/skills/geo-code-review/SKILL.md` 负责，触发词："review / 代码审查 / 审查改动 / 检查 diff / 找回归风险"。
本技能只负责**确定性验证**与提交前 / 重启后检查；`npm run verify:geo` 全绿**不能证明**语义正确，代码审查也不替代静态检查和运行时冒烟。

### 6. 简化候选提醒
发现以下模式时记录为 TODO（不要在本会话直接删改）：
- 多个插件重复相同的 `sendJson`/`parseQuery`/`renderJson` 函数 → 应抽成共享模块。
- 手写路径解析/JSON Schema 校验 → 评估用 Node 内置或成熟依赖替换。
- 注释里的版本叙述（"v2.0 修订""之前改成"）→ 删除或移入决策记录。

## 术语引用

所有开发产出（提交信息、PR 描述、文档、工具 description）中的地理术语以 `docs/术语表.md` 为准。
