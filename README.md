# GeoSparkAI · 高中地理教师辅助 Agent

GeoSparkAI 是运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）上的**高中地理教学预设**：它在会话里提供一套地理教师工具链与技能，让模型基于**本地真题库、考点树、课标与教材原文**工作，而不是凭记忆生成教学内容。

它解决的是「通用大模型能写教案，但写不准」的落差：考点要能对到自己的考点库，真题要能对到原题与答案，命题要能过结构校验，讲题要先把答案隔离在解题完成之后。所以本项目把三件事分开做——**工具的确定性部分交给代码，教学判断交给模型，人工评审保留人工**。

数据（考点库、真题库）由使用者自行提供并在本机绑定，不随仓库分发。

> *English summary: GeoSparkAI is a high-school geography teaching agent preset for DeepSeek Harness — question explaining, exam-item authoring, lesson planning, grounded in a local exam bank and curriculum taxonomy.*

## 能做什么

| 功能 | 你能得到 | 状态 |
| :-- | :-- | :-- |
| **讲题助手** | 先独立解题、再核验、最后成稿的三段式讲题流程；讲题稿按对象分版：学生（默认）／教师／命题人 | 已实现（隔离解题 + 两阶段核验）；真实题组的运行时复验待做 |
| **出题助手** | 按考点与真题风格命制材料型**选择题组**或**综合题**（一个题包只用一种题型），产出教师版与学生版投影，并可做结构校验 | 开发中：完整流程已跑通，语义质量评审待做 |
| **课程方案** | 依据课标与教材原文生成教学设计、学生学习材料与课堂观察记录，可渲染为 DOCX／HTML | 技能已就位，仍需不断优化 |

另有 `/geo-teacher` 静态页（把需求整理成可粘贴的提示词）与会话输入区的功能选择器，二者都不连模型、不写盘。

> ⚠️ **本项目处于开发阶段**，接口、数据契约与技能内容仍会变化；数字、结论与「已验证／未验证」的边界逐条记录在 [决策记录](docs/决策记录.md)，不以规划代替现状。

## 环境要求

| 项 | 要求 |
| :-- | :-- |
| DSH | Desktop **`0.2.2-rc.1`**（已验证版本；2026-11-07 实测预设挂载、`/geo-teacher` 与 `/geo/core/health` 正常）；`0.2.1` 系列可安装但未完整验证；0.2.1 起桌面端端口由系统分配，以环境变量 `DSH_WEB_URL` 为准 |
| 平台 | Windows（本机验证平台）；核心逻辑为纯 Node ESM，其他平台未验证 |
| Node | 随桌面附带（实测 `v24.21.0`）；仓库脚本只用 ESM 与 `node:test` |
| Python | `3.12`（仅课程方案的文档渲染需要，依赖 `python-docx`） |
| 数据 | **随仓库提供**：考点库 `data/config/`、真题库 `data/obsidian_vault/04_题目/`（含题图）；可改用自己目录，见下方「配置数据路径」 |

## 快速开始

```sh
git clone https://github.com/xiaoyuanwang220/geoteacher_preset.git geo_edu_agent
cd geo_edu_agent
node scripts/setup.mjs --check     # 只读检查：DSH 版本、profile、包与仓库数据
node scripts/setup.mjs --yes       # 备份 profile 清单 → 写入 → pnpm 安装并建立链接 → 静态校验
```

1. **运行安装器**：`--check` 不写任何文件；`--yes` 会备份 `profile/package.json` 与 `pnpm-lock.yaml`，把两个包以 `link:<仓库路径>` 写进目标 profile 的依赖与 `dsh.profile.bundles`，再用运行时自带 pnpm 在 profile 目录安装一次，生成 `node_modules` 链接。
2. **完整重启 DSH**（关闭窗口可能只是隐藏，请确认进程已退出）。
3. **开始使用**：新建「地理教师辅助」会话，输入框上方会出现功能选择；先发 `/geo-status`（或直接说「查看状态」，由 `geo_status` 工具回复）确认版本、数据来源与题库题数。

卸载：`node scripts/setup.mjs --uninstall --yes`（只移除本项目的两个依赖与两个 bundle 项；保留配置、数据、产物与运行记录，不承诺“恢复原状”）。

自检：

```sh
node scripts/setup.mjs --check          # 安装接线与数据是否就绪
node scripts/geo-verify.mjs --source    # 确定性静态检查
node --test "test/*.test.mjs"           # 教师功能行为测试
```

## 配置数据路径（可选）

默认使用仓库内的 `data/`（与维护者 Obsidian 中的题库、题图、考点库同一份数据），**不配置也能用**。需要换用自己的目录时，在 `<DSH_HOME>/geo-teacher/config.json` 中填写，同名键会覆盖默认数据：

| 配置键 | 用途 | 缺省行为 |
| :-- | :-- | :-- |
| `knowledgeBasePath` | 考点库目录（含 `knowledge_taxonomy_*.yaml`） | `data/config/` |
| `questionBankPath` | 真题 Markdown 根目录（保留原有子目录与图片相对位置） | `data/obsidian_vault/04_题目/` |
| `outputPath` | 题库索引、真题分析导出等产物目录 | `<DSH_HOME>/geo-teacher/outputs/` |
| `workspaceRoot` | 允许写入产物的根目录；`outputPath` 必须位于其中或与其相同 | 配置文件所在目录 |

- 相对路径以配置文件所在目录为基准；插件 `config` 里显式设置的同名字段优先于本机配置。
- `/geo-status` 与 `/geo/core/health` 会显示实际生效的路径与来源（教师配置 / 随仓库 data/）。
- 出现「数据不可用」时，先确认对应目录存在；不要把读取错误解释成「没有相关题目」。

## 怎么用

**工作台**：在桌面端浏览器打开 `<DSH_WEB_URL>/geo-teacher`（Host 地址由 DSH 分配，取运行时环境变量 `DSH_WEB_URL`），选功能、填需求、选参数，复制生成的提示词到会话发送。

**输入区**：在 `geo-teacher` 预设的会话里，输入框上方出现功能选择与参数设置，选完会把前缀直接写进原生输入框。

**对话**：选中「地理教师辅助」预设后直接用自然语言提需求，模型按需调用工具与技能：

- 讲题——「这道题怎么做」：`geo_solve` 在隔离解题会话中独立作答，只返回独立答案与关键依据；「把这道题讲给学生听」：连续 `geo_solve` → `geo_judge`（开放答案）→ `geo_judge`（归档核验结论）→ `geo_explain`（按对象成稿），中途不询问是否继续；答案只在作答提交后开放。
- 出题——「出一道材料型综合题，考生态脆弱区的综合治理」：模型加载 `geo-question-generator` 技能，先给三个构思，经你确认后成稿，并可用 `geo_question_validate` 或 CLI 做结构校验。
- 检索与分析——「人口迁移这个考点近几年考得多吗」：`geo_taxonomy` → `geo_search_questions` → `geo_question_detail` → `geo_analyze`。


详细的入口说明、话术示例与故障排查见 [使用指南](docs/使用指南.md)。

## 架构

```text
桌面会话 / /geo-teacher 工作台
   │  HTTP
   ▼
/geo/taxonomy/*  /geo/bank/*  /geo/analysis/*  /geo/generator/*  /geo/core/health
   │  功能插件（webServer 路由，注入 geoKernel 服务）
   ▼
geo-core（内核：考点树 / 题库加载 / 真题分析 / 命题蓝图 / 风格档案）
   │  fs
   ▼
数据源与产物：默认 `<仓库>/data/`（题库、题图、考点库），可被 <DSH_HOME>/geo-teacher/config.json 覆盖；/geo/core/health 与 /geo-status 回显实际路径与来源
```

仓库中有两个 bundle，都通过 profile 依赖挂载：

| 包 | 作用 |
| :-- | :-- |
| `@geo-edu/dsh-geo-teacher-preset` | 预设本体：7 个功能插件 + 4 个教师技能 + 组合文件 |
| `@geo-edu/dsh-geo-teacher-ui` | 会话输入区的功能选择与参数设置（零构建客户端） |

## 仓库结构

```text
.agent-presets/geo-teacher/   预设包：plugins/（core,taxonomy,bank,analysis,generator,question,panel,solver-isolation）+ skills/ + cordis.patch.yml
packages/dsh-geo-teacher-ui/  输入区 UI 插件
data/                         随仓库数据：config/（考点库）+ obsidian_vault/（题库、题图、图谱笔记与导航）
docs/                         运行基线、当前规范、需求与设计、验收待办
课本与课标/                    课标与教材正文（课标核验与共同知识依据）
scripts/                      setup 安装器、verify 与验收脚本
test/                         教师功能行为测试
```

## 开发

- 确定性检查：`npm run verify:geo`（预设接线、技能 frontmatter、工具契约、命题包样例回归等）。
- 行为测试：`node --test "test/*.test.mjs"`。
- 安装器自测：`node scripts/setup.mjs --check`（只读）与 `--dry-run`（展示清单差异）。
- 修改后何时生效：技能文件改完重新加载即可；**插件 JS、组合文件、包导出必须完整重启桌面**。
- 开发规约（代码审查、开发清单、文档规范）在 `.agents/skills/`，见 [Skills 应用方案](docs/harness-skills-应用方案.md)。

## 文档

- [文档索引](docs/README.md) —— 现行规范、实施状态与历史记录的入口
- [使用指南](docs/使用指南.md) —— 三个入口、话术示例、能力边界、故障排查
- [DSH 基线](docs/DSH-0.2.1-rc.2-基线.md) —— 运行版本与包装形态的事实来源（现行验证版本 `0.2.2-rc.1`）
- [决策记录](docs/决策记录.md) —— 逐条记录决策、原因、证据与关联文件
- [出题功能](docs/geography-question-generation-product-requirements.md)／[技术设计](docs/geography-question-generation-technical-design.md)／[执行方案](docs/geography-question-generation-execution-plan.md)
- [讲题功能设计](docs/讲题功能设计.md)／[评测方案](docs/讲题评测方案.md)／[讲题优化计划](docs/讲题优化计划.md)
- [工作台聚合与一键安装方案](docs/工作台聚合与一键安装方案.md) —— 安装器、随仓库数据、`/geo-status` 与后续范围
- [上传试卷讲题方案](docs/上传试卷讲题方案.md) —— 教师上传学生版试卷 + 答案、指定题组或小问的 V0 设计（方案阶段）
- [仓库更新-给agent的提示词](docs/geo-teacher-仓库更新-给agent的提示词.md) —— 已安装用户更新时，把这篇文章交给 Agent，由它代教师完成同步与验证
- [术语表](docs/术语表.md) —— 地理与交付术语的唯一权威
- 历史方案与迁移记录通过 Git 历史追溯。

## 已知限制

- **讲题**：讲题优化（隔离解题会话、服务端 run 状态机与两阶段核验、题答分离）**源码已实现，真实题组的运行时复验待做**；未做「四题三对象」人工学科内容评审与运行时实测；讲题稿只在会话工具模式产出；教师上传图片题未纳入本轮隔离解题。
- **出题**：结构校验不等于质量通过——语义项恒为 `pending`；语义内容评审、来源指纹回填、跨主题与恢复验证未完成；正式制图与 Word/PDF 作品包不在 V1。
- **课程方案**：技能已进入预设技能根，但桌面端加载与渲染链路未验收。
- **数据与引用**：题库、题图与考点库随仓库提供（`data/`），维护者当前使用同一份数据；联网正文能否读取取决于运行环境，只拿到链接或摘要时不得声称读过全文。

## 反馈与贡献

- 问题与建议走 GitHub Issues；提问前先看 [决策记录](docs/决策记录.md)——多数取舍已有记录与理由。
- 提交改动请附验证：`npm run verify:geo` 与相关行为测试；涉及插件、组合或包导出的改动，需要完整重启桌面后的实测记录。
- 不以「文档已改」代替「功能已完成」：教学正确性、答案唯一性这类语义质量必须人工或独立核验。

## 许可与致谢

- 仓库主体采用 **MIT**，见 [LICENSE](LICENSE)。
- 课程方案技能 `.agent-presets/geo-teacher/skills/cn-high-school-geography-lesson-planning/` 采用 **Apache-2.0**，派生自 *Agent Skills for K-12 Teachers*（Copyright 2026 Anthropic PBC and Learning Commons）；该目录内自带 `LICENSE` 与 `NOTICE`，分发时须一并保留。
- `课本与课标/` 收录课标与教材正文：课标属教育部官方文件，教材正文权利归原出版方；对外再分发前请自行确认授权。
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的 Agent 与插件框架；第三方参考材料 `deepseek-harness-skills-master/` 不随仓库发布（`.gitignore` 已排除），来源见 [Skills 应用方案](docs/harness-skills-应用方案.md)。
