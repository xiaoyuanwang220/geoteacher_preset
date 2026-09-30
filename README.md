# GeoEduAgent — 高中地理教师辅助 Agent

基于 DeepSeek Harness (DSH) 构建的高中地理教师辅助系统，运行于 DSH Desktop（本机 Host 地址 `http://127.0.0.1:19387`，profile = `desktop`）。

## 当前状态

- ✅ **插件化重构（方案 P0–P2）已完成并挂载验证通过**：`geo-core`（内核服务 geoKernel）+ taxonomy / bank / analysis / generator / ui 六个插件。
- ✅ **模型工具链已实现**（9 个，注册到 geo-teacher 预设层）：`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_analyze`、`geo_export_analysis`、`geo_style_profile`、`geo_solve`、`geo_judge`、`geo_explain`。
- ✅ **出题技能**：`geo-question-generator`（DSH 本地数据源，目录包入口；M1 源码已落地，桌面验收待补齐）。
- ✅ **M0 基线与可用性已记录**（2026-09-27）：桌面版本 / profile / 预设解析路径、证据渠道实测可用层级、旧形态退役清点 → `docs\geography-question-generation-m0-baseline.md`。
- 📌 **工具注册技术要点**：preset 插件**不能裸 import 宿主包**（用户根无 `node_modules`，Node 标准解析失败）；`ctx.tools.register` 接受直接构造的 `ToolDefinition` 对象（不要求 `defineTool`），`output.schema` 用标准 JSON Schema（如 `{type:'object', additionalProperties:true}`）。
- ✅ **讲题三对象**（2026-09-28）：`geo_explain` 增 `audience`（`student` 默认／`teacher`／`setter`）；学生与教师沿用「题目定位—审题—破题—反思与迁移」四段式并在段内融入知识/解题/方法/跨学科，命题人用设计评价结构 + 三层干扰辨析。**仅会话工具模式**（面板无讲题入口）。→ `docs\讲题三对象改造-实施记录.md`
- 🧹 **已下线并删除（2026-09-30）**：① 旧视觉插件运行时副本 `$DSH_HOME\plugins\dsh-plugin-vision`（生产链路自 2026-08-21 起已是 DSH 原生多模态，该插件从未在会话中暴露工具）；② 地理工作台客户端扩展 `@geo-edu/dsh-geo-workbench`——源码包、`scripts\geo-workbench-check.mjs`、`npm run verify:workbench`、`web` profile 的依赖/bundle 与 node_modules 副本、相关文档引用一并移除，后续重新设计。决策与证据见 `docs\决策记录.md`。
- 🔜 **下一步**：出题功能 M1 桌面验收（schema、目录包技能和考点树扩展已落地），验收后推进 M2 首个完整题组→ 见 `docs\geography-question-generation-execution-plan.md`；讲题三对象待 M3 桌面验证与内容评审。

## 预设的部署方式（重要）

预设通过 **profile 依赖**挂载。本机为 `link:` 直连仓库：

| 项 | 值 |
| :--- | :--- |
| 运行 profile | `$DSH_HOME\profiles\desktop`（另有 `web` profile，不含本预设） |
| 依赖声明 | `"@geo-edu/dsh-geo-teacher-preset": "link:E:/geo_edu_agent/.agent-presets/geo-teacher"` |
| 组合文件 | `.agent-presets\geo-teacher\cordis.patch.yml`（声明行形态；`package.json` 的 `dsh.bundle.patch` 指向它） |
| 技能根 | `createRequire(baseUrl).resolve('<包>/package.json')` → `<包>\skills\` |
| 本地插件引用 | 一律用包子路径导出（`@geo-edu/dsh-geo-teacher-preset/plugins/<name>`），**不得**写 `./plugins/x/index.js` |

**改仓库即改运行时**（link 直连），因此本机**不需要** E:→C: 双副本同步。

> ⚠️ 旧文档描述的 `$DSH_HOME\.agent-presets\geo-teacher\` 运行时副本机制**已退役**：rc.2 不再读取该目录形态（源码说明 "Nothing reads that directory any more"）。`agent.cordis.yml` 与 `preset.yml` 已退役，归档说明见 `.backups\geo-teacher-legacy-preset-20260927\README.md`（含取代关系、消费者清点与落地命令）；`geo-verify.mjs` 现按 `cordis.patch.yml` 校验，并加 `retired-form` 回归保护。

**改完何时生效**：

| 改动 | 生效方式 |
| :--- | :--- |
| 技能文件（`<name>.md` / `<name>\SKILL.md`） | 技能发现器监听入口，改后重新加载技能即可，无需例行重启 |
| `references\` 等支持文件 | 不触发技能目录刷新；下次显式读取取得新内容 |
| 插件 JS、`cordis.patch.yml`、包导出或依赖 | **完整重启桌面**后验收（关闭主窗口可能只是隐藏，需确认进程已退出） |

修改后运行 `npm run verify:geo`。校验脚本中部署形态只输出提示——link 是本机开发部署方式，其他安装可为包安装，不因此判源码失败。

## 目录结构

| 路径 | 说明 |
| :--- | :--- |
| `.agent-presets\geo-teacher\` | **预设包**：`plugins\{core,taxonomy,bank,analysis,generator,ui}` + `skills\` + `cordis.patch.yml` + `package.json` |
| `docs\` | 文档（见下方「相关文档」） |
| `scripts\geo-verify.mjs` | 确定性检查程序（`npm run verify:geo`） |
| `skills\` | 课程方案技能源工作区（`cn-high-school-geography-lesson-planning\`）；出题技能在预设包的 `skills/geo-question-generator/` |
| `outputs\` | 产物输出（真题分析 Markdown、讲题稿、出题任务包） |
| `.backups\` | 阶段备份（如 `geo-teacher-20260814-221212\`，P2 前状态） |

## 数据源

| 数据 | 路径 | 说明 |
| :--- | :--- | :--- |
| 考点库（KPS） | `E:\知识图谱\config\knowledge_taxonomy_*.yaml` | 4 份；domain → theme → knowledge_unit 三级，节点带 `id/name/definition`；当前 `meta.version: v0.2-draft`、`status: draft` |
| 真题库 | `E:\知识图谱\obsidian_vault\04_题目` | 按 `省份/年份/题组单页.md` 组织，动态增长（数量以实际扫描结果为准） |
| 课标与教材 | `E:\geo_edu_agent\课本与课标\` | `课标.md` + `必修一.md`/`必修二.md` + `选必一/二/三.md`；用于**课标条目核验**与**教材共同知识依据**（出题时"必备知识是否在高中共同知识范围内"的证据来源） |

## 架构（当前，插件化）

```
桌面会话 / /geo-teacher 仪表盘
   │  HTTP
   ▼
/geo/taxonomy/*  /geo/bank/*  /geo/analysis/*  /geo/generator/*  /geo/core/health
   │  功能插件（webServer 路由，注入 geoKernel 服务）
   ▼
geo-core（内核服务 geoKernel：考点树 / 题库加载 / 真题分析 / 命题蓝图 / 风格档案）
   │  fs 服务
   ▼
本地数据源（E:\知识图谱）· 输出（E:\geo_edu_agent\outputs）
```

- `cordis.patch.yml` 中 geo group 用 `isolate: geoKernel` 隔离内核服务（预设私有）；`ctx.provide('geoKernel')` 与 isolate 键必须一致。
- 关键经验：插件回调签名是 `apply(ctx, config)`（配置是第二参数，不是 `ctx.config`）；服务访问 `ctx['服务名']`；服务名与 isolate 键必须一致（避免点号）。

## 相关文档

- `docs\使用指南.md` — **使用指南**（Web 面板 / 对话工具 / 出题技能三种用法 + 话术示例）
- `docs\geography-question-generation-execution-plan.md` — **出题功能 DSH 桌面端执行方案**（M0–M5 阶段、需求契约、命题包与确认记录、校验质量门、验证与验收）
- `docs\geography-question-generation-m0-baseline.md` — **出题功能 M0 基线与可用性记录**（环境基线 / 预设解析路径 / 证据渠道实测 / 旧形态退役清点）
- `docs\geography-question-generation-product-requirements.md`、`docs\geography-question-generation-technical-design.md` — 出题功能产品需求与技术设计
- `docs\讲题功能设计.md` — **讲题功能设计**（设问先行/定向读材料、地理思维逻辑、一线教师评审修订、四段式讲题稿模型、技术落地与实施步骤；§十一 为讲题三对象现行规则）
- `docs\讲题评测方案.md` — **讲题真题评测方案**（P4：分层抽样清单 + 五项指标打分表 + §八 三对象内容评审 + 通过门槛）
- `docs\讲题三对象改造-实施记录.md` — **讲题三对象改造实施记录**（M0 现状 / M1–M2 变更清单 / M3 验证状态与阻塞 / 恢复方式 / 未完成项）
- `docs\讲题功能三对象改造方案-DSH-0.1.7-rc.2.md` — 讲题三对象改造方案（执行依据；第一阶段=题库 qid 三对象讲解与命题方法融合，第二阶段=生成题包只读适配）
- `docs\harness-skills-应用方案.md` — **DSH 仓库 Skills 应用方案**（开发维护技能职责与现行验证入口）
- `docs\决策记录.md` — 轻量决策记录

- [文档索引](docs/README.md) — 现行规范、实施状态与历史记录的入口。
- [历史归档](docs/archive/README.md) — 已完成迁移、早期插件方案与故障证据，不作为现行操作步骤。
