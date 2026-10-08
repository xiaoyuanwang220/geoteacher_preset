# GeoEduAgent — 高中地理教师辅助 Agent

基于 DeepSeek Harness (DSH) 构建的高中地理教师辅助系统，运行于 DSH Desktop（本机 Host 地址 `http://127.0.0.1:19387`，profile = `desktop`）。

## 当前优先级（2026-10-08）

| 功能 | 状态 | 说明 |
| :--- | :--- | :--- |
| **讲题助手** | ✅ **开发完成，进入反馈迭代** | `geo_solve`/`geo_judge`/`geo_explain` 三工具 + 讲题三对象已落地；不再按规划新增功能，按用户反馈持续修改 |
| **出题助手** | 🔨 **正在开发** | 范围与格式已定（V1 含选择题组与综合题两种题型，一包一题型；命题包 `schemaVersion: 2`）；技能、schema 与双样例已落地，**校验器／投影／渲染尚未实现**，M1 桌面验收与 M2 端到端闭环待补 |
| **工作台 UI** | ✅ **已完成** | `/geo-teacher` 任务受理台（`plugins\panel`）交付「讲题／出题／课程方案」三个入口；另有桌面端输入区 UI 插件 `packages\dsh-geo-teacher-ui`，在会话输入区就地提供功能选择与参数设置 |
| 课程方案 | ⏸️ 技能待重构 | 旧课程方案技能已删除；界面入口保留，预设内没有对应技能可加载 |
| 题库检索 / 真题分析 | ✅ 可用 | 经会话工具链提供（`geo_taxonomy`/`geo_search_questions`/`geo_question_detail`/`geo_analyze`） |

> ⚠️ **工作台三个入口的可用程度不同**：讲题入口可直接用；出题入口会把需求整理成可粘贴的提示词交给会话，技能已支持两种题型，但**产出的题包目前无法自动校验**（命题包校验器未实现）；课程方案入口在预设内没有对应技能，**提交后不会有结果**。工作台本身零构建、不写盘、不连模型，只把需求整理成提示词。

> 📌 **出题的范围与数据格式已于 2026-10-04 定案，2026-10-08 起进入开发**：
> ① **综合题已纳入 V1**——**一个题包只用一种题型**，由题包顶层 `questionType` 声明；
> ② **命题包数据格式已升 `schemaVersion: 2`**——顶层 `questionType` 声明题型、题组项 `itemType` 判别，综合题以「1 道大题 + 2—4 个小问」承载分值／采分点／评分标准／开放答案边界。
>
> 开发进度如实四分：**已落地（源码）**技能目录包、schema v2、双样例、术语表口径；**未实现**命题包校验器、学生与教师投影、Markdown 渲染器（`plugins/question` 下只有 schema，全仓没有程序读取它）；**未验收** M1 桌面重启验收与 4 份 references 的语义评审；**未跑通** M2 端到端闭环。详见 `docs\决策记录.md`、`docs\examples\README.md`（含 v1→v2 迁移说明）与 `docs\geography-question-generation-execution-plan.md`。

## 当前状态

- ✅ **插件化重构（方案 P0–P2）已完成并挂载验证通过**：`geo-core`（内核服务 geoKernel）+ taxonomy / bank / analysis / generator / panel 六个插件。
- ✅ **模型工具链已实现**（9 个，注册到 geo-teacher 预设层）：`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_analyze`、`geo_export_analysis`、`geo_style_profile`、`geo_solve`、`geo_judge`、`geo_explain`。
- 🔨 **出题技能（开发中）**：`geo-question-generator`（DSH 本地数据源，目录包入口：`SKILL.md` + 4 份 references；支持**选择题组**与**综合题**两种题型）。范围与数据格式已于 2026-10-04 定案并落地为源码（技能说明 + 命题包 `schemaVersion: 2` + 双样例 + 术语表口径）；**校验器／投影／渲染尚未实现**，M1 桌面验收与 M2 端到端闭环待补。见上方优先级说明。
- ✅ **M0 基线与可用性已记录**（2026-09-27）：桌面版本 / profile / 预设解析路径、证据渠道实测可用层级、旧形态退役清点 → `docs\geography-question-generation-m0-baseline.md`。
- 📌 **工具注册技术要点**：preset 插件**不能裸 import 宿主包**（用户根无 `node_modules`，Node 标准解析失败）；`ctx.tools.register` 接受直接构造的 `ToolDefinition` 对象（不要求 `defineTool`），`output.schema` 用标准 JSON Schema（如 `{type:'object', additionalProperties:true}`）。
- ✅ **讲题三对象**（2026-09-28）：`geo_explain` 增 `audience`（`student` 默认／`teacher`／`setter`）；学生与教师沿用「题目定位—审题—破题—反思与迁移」四段式并在段内融入知识/解题/方法/跨学科，命题人用设计评价结构 + 三层干扰辨析。讲题稿**只在会话工具模式产出**；`/geo-teacher` 工作台提供「讲题」需求受理入口（含讲题对象选择），只把需求整理成可粘贴的提示词，不渲染讲题稿。→ `docs\讲题三对象改造-实施记录.md`
- ✅ **讲题助手开发完成（2026-10-08）**：讲题不再按规划新增功能，转入**用户反馈迭代**阶段——按教师实际使用中出现的问题持续修改。**仅剩「四题三对象内容评审」（人工学科评审）未做**：§6.3 的确定性命令（`verify:geo` 0 失败 / 4 提示 / 27 通过、`test:explainer` 17/17）与 §6.4 桌面全清单 8 项已于 2026-09-30 完成回填，涉图题的原生图片附件亦经实测可用。余项（§6.6 运行时复验、核验材料交接形态、第二阶段「生成题包只读适配」）见 `docs\讲题三对象改造-实施记录.md` §八。
- 🧹 **已下线并删除（2026-09-30）**：① 旧视觉插件运行时副本 `$DSH_HOME\plugins\dsh-plugin-vision`（生产链路自 2026-08-21 起已是 DSH 原生多模态，该插件从未在会话中暴露工具）；② 地理工作台客户端扩展 `@geo-edu/dsh-geo-workbench`——源码包、`scripts\geo-workbench-check.mjs`、`npm run verify:workbench`、`web` profile 的依赖/bundle 与 node_modules 副本、相关文档引用一并移除，后续重新设计。决策与证据见 `docs\决策记录.md`。
- 🆕 **UI 已成型（2026-10-03 工作台 / 2026-10-08 输入区插件）**：① 旧 `/geo-teacher` 仪表盘插件 `geo-ui` 退役，改由 `plugins\panel`（`geo-panel`）交付「讲题 / 出题 / 课程方案」任务受理台，纯 HTML/CSS/JS、零构建、不写盘、不调模型（需求整理成提示词，由教师复制到对话）；旧仪表盘的数据浏览能力（考点树/题库检索/分析导出）随之下线，会话工具链不受影响。② 桌面端输入区 UI 插件 `packages\dsh-geo-teacher-ui` 已成品化：在 `conversation.input.left/right` 两处槽位提供功能选择与参数设置，把前缀直接写进原生输入框。设计原型应用已完成使命并停止维护（不随仓库发布）。
- 🔜 **下一步**：**讲题进入用户反馈迭代**——不再按规划新增功能，按教师实际使用中的问题持续修改。**出题继续开发**，当前第一件事是 M3 的命题包校验器：格式已定而全仓仍无程序读取 `package.schema.json`，跨字段约束（分值三级求和、采分点与小题 ID 引用、投影版本、v1→v2 迁移）目前只能靠人工核对。执行方案 `docs\geography-question-generation-execution-plan.md` 的阶段计划继续有效。
- 📄 **出题文档入口**：需求与范围 `docs\geography-question-generation-product-requirements.md`；技术设计 `docs\geography-question-generation-technical-design.md`；阶段与验收 `docs\geography-question-generation-execution-plan.md`；数据契约 `.agent-presets\geo-teacher\plugins\question\package.schema.json`；双样例与迁移说明 `docs\examples\README.md`；术语 `docs\术语表.md`；进度记录 `docs\geography-question-generation-m0-baseline.md`、`docs\geography-question-generation-m1-record.md`。

## 预设的部署方式（重要）

预设通过 **profile 依赖**挂载。本机为 `link:` 直连仓库：

| 项 | 值 |
| :--- | :--- |
| 运行 profile | `$DSH_HOME\profiles\desktop`（另有 `web` profile，不含本预设） |
| 依赖声明 | `"@geo-edu/dsh-geo-teacher-preset": "link:<你的克隆路径>/.agent-presets/geo-teacher"`（本机为 `E:/geo_edu_agent/.agent-presets/geo-teacher`） |
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

## 配置数据路径（clone 后必做）

**首次使用前，用户向负责安装配置的 Agent 提供以下 4 个绝对目录路径，由 Agent 逐项写入本机配置。四项均明确填写，不依赖缺省值。** Agent 不自动搜索磁盘、不识别数据目录、不根据目录名或历史记录猜测路径；信息缺失时向用户询问。

### 用户需要提供的 4 个路径

| 用户提供的目录 | 配置键 | 用途与要求 |
| :--- | :--- | :--- |
| 考点库目录 | `knowledgeBasePath` | 包含 `knowledge_taxonomy_*.yaml` 的目录 |
| 真题库目录 | `questionBankPath` | 真题 Markdown 所在的根目录，保留原有子目录与图片相对位置 |
| 产物目录 | `outputPath` | 保存题库索引、真题分析导出等产物 |
| 工作区根目录 | `workspaceRoot` | 允许写入产物的根目录；`outputPath` 必须位于其中或与其相同 |

考点库和题库可以继续放在项目外；不要求把它们移入工作区。工作区根目录只规定写盘范围，不代表数据源都必须放在其中。

### 直接发给 Agent 的配置请求

把下面四项替换为自己的实际路径后，发送给有本机文件操作权限的 Agent：

```text
请为地理教师助手绑定以下 4 个路径：
1. 考点库目录：<我的考点库绝对路径>
2. 真题库目录：<我的真题库绝对路径>
3. 产物目录：<我的产物绝对路径>
4. 工作区根目录：<我的工作区绝对路径>

请按我提供的值填写本机配置，不自动搜索、识别或推断其他目录。
如果缺少信息或目录不可用，请指出具体项目并问我，不要自行换成其他路径。
```

### Agent 的配置步骤

1. 收齐用户提供的四个路径；只检查这些指定目录是否存在、是否可读，以及产物目录是否位于工作区根目录内。检查不等于自动识别或另选目录。产物目录尚不存在时，说明后按用户指定位置创建。
2. 以 [配置模板](geo-teacher.config.example.json) 为字段参考，将四个值写入 `<DSH_HOME>/geo-teacher/config.json`。已有文件只更新这四个绑定值，保留其他配置。不要把示例路径直接当作真实配置，也不要把本机路径写回共享预设或提交到仓库。
3. `DSH_HOME` 按已设置的环境变量取值，未设置时使用 `<用户目录>/.dsh`；这是配置文件的固定存放规则，不用于推断数据目录。用户使用自定义 DSH 配置目录但未提供其位置时，向用户询问。
4. 告知用户完整退出 DSH（包括后台进程）后重新打开。插件在加载时读取配置，仅修改文件不会更新当前进程。
5. 重启后检查 `/geo/core/health` 的 `config` 字段，逐项对照用户提供的路径，并通过 `geo_taxonomy`、`geo_search_questions` 验证读取。目录或读取错误必须如实报告；不要把错误解释成“没有相关题目”，也不要自动改绑其他目录。

普通安装使用上述本机配置。已有部署若在 `geo-core` 的插件 `config` 中显式设置了同名字段，它们优先于本机配置；Agent 应指出这一覆盖关系，按用户指定值调整，不能报告未生效的绑定已完成。

从固定路径版本升级时，用户提供原有目录即可，数据文件不必搬动。上述四项全部填写是本项目的安装操作约定；不依赖代码为兼容其他部署保留的缺省路径。

### 不在仓库内的数据

考点库与真题库计划与项目同步开源，目前仍存放在仓库外的目录，尚未纳入本仓库。用户告知 Agent 自己保存数据的实际位置，分别绑定到 `knowledgeBasePath` 和 `questionBankPath`；后续获取开源数据时也按此流程绑定。

## 目录结构

| 路径 | 说明 |
| :--- | :--- |
| `.agent-presets\geo-teacher\` | **预设包**：`plugins\{core,taxonomy,bank,analysis,generator,panel}` + `skills\` + `cordis.patch.yml` + `package.json` |
| `packages\dsh-geo-teacher-ui\` | **桌面端输入区 UI 插件**（`@geo-edu/dsh-geo-teacher-ui`）：在会话输入区就地提供「讲题／出题／课程方案」的功能选择与参数设置，并把前缀写进原生输入框；零构建、无配置，见其 [README](packages/dsh-geo-teacher-ui/README.md) |
| `docs\` | 文档（见下方「相关文档」） |
| `scripts\geo-verify.mjs` | 确定性检查程序（`npm run verify:geo`） |
| `geo-teacher.config.example.json` | **数据路径配置模板** —— 复制到 `<DSH_HOME>/geo-teacher/config.json`，见「配置数据路径」一节 |
| `LICENSE` | MIT |
| `.agent-presets\geo-teacher\geo-teacher-plugin\` | 早期单体插件，**已退役**（不在 `exports` 中，不会被加载）；可安全删除 |
| `outputs\` | 产物输出（真题分析 Markdown、讲题稿、出题任务包）。**不随仓库发布**（`.gitignore` 已排除） |

## 数据源

| 数据 | 位置 | 说明 |
| :--- | :--- | :--- |
| 考点库（KPS） | 用户提供目录，绑定到 `knowledgeBasePath` | 4 份 `knowledge_taxonomy_*.yaml`；domain → theme → knowledge_unit 三级，节点带 `id/name/definition`；当前 `meta.version: v0.2-draft`、`status: draft` |
| 真题库 | 由 `questionBankPath` 指定 | 当前位于外部目录，计划同步开源。按 `省份/年份/题组单页.md` 组织，动态增长（数量以实际扫描结果为准）。题面只能经 `geo_solve` / `geo_question_detail` 取，**不得直读文件** |
| 课标与教材 | `课本与课标\`（随仓库发布） | `课标.md` + `必修一.md`/`必修二.md` + `选必一/二/三.md`；用于**课标条目核验**与**教材共同知识依据**（出题时"必备知识是否在高中共同知识范围内"的证据来源） |

## 架构（当前，插件化）

```
桌面会话 / /geo-teacher 工作台
   │  HTTP
   ▼
/geo/taxonomy/*  /geo/bank/*  /geo/analysis/*  /geo/generator/*  /geo/core/health
   │  功能插件（webServer 路由，注入 geoKernel 服务）
   ▼
geo-core（内核服务 geoKernel：考点树 / 题库加载 / 真题分析 / 命题蓝图 / 风格档案）
   │  fs 服务
   ▼
数据源与产物目录：由 `<DSH_HOME>/geo-teacher/config.json` 解析，`/geo/core/health` 回显实际路径与存在性
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
- `docs\geo-teacher-原生UI插件方案.md` — **桌面端原生 UI 插件方案**（方案阶段文档）：原型对应的真实槽位实测、三条实现路径与风险分级、未验证项清单与两步走建议；其「独立主面板」一步已落地为 `packages\dsh-geo-teacher-ui`（见该包 README）
- `packages\dsh-geo-teacher-ui\README.md` — **输入区 UI 插件说明**（现行成品）：槽位落点、安装与 profile 接线、无配置说明、已知边界
- `docs\geo-teacher-功能插件与技能归属方案.md` — **功能插件与技能归属方案**（方案阶段，未实施）：工具已是插件形态、未归到插件的只有技能；技能收归功能插件的目标形态与代价、官方 `dsh-skill-badge` 先例与未验证项，以及「课程方案」技能未加载的缺口与三种修法
- `docs\决策记录.md` — 轻量决策记录
- `geo-teacher.config.example.json` — **数据路径配置模板**（复制到 `<DSH_HOME>\geo-teacher\config.json`，见「配置数据路径」）
- `LICENSE` — MIT

- [文档索引](docs/README.md) — 现行规范、实施状态与历史记录的入口。
- [历史归档](docs/archive/README.md) — 已完成迁移、早期插件方案与故障证据，不作为现行操作步骤。
