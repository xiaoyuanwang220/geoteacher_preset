# GeoEduAgent · 高中地理教师辅助 Agent

GeoEduAgent 是运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）上的**高中地理教学预设**：它在会话里提供一套地理教师工具链与技能，让模型基于**本地真题库、考点树、课标与教材原文**工作，而不是凭记忆生成教学内容。

它解决的是「通用大模型能写教案，但写不准」的落差：考点要能对到自己的考点库，真题要能对到原题与答案，命题要能过结构校验，讲题要先把答案隔离在解题完成之后。所以本项目把三件事分开做——**工具的确定性部分交给代码，教学判断交给模型，人工评审保留人工**。

数据（考点库、真题库）由使用者自行提供并在本机绑定，不随仓库分发。

> *English summary: GeoEduAgent is a high-school geography teaching agent preset for DeepSeek Harness — question explaining, exam-item authoring, lesson planning and model-completion verification, grounded in a local exam bank and curriculum taxonomy.*

## 能做什么

| 功能 | 你能得到 | 状态 |
| :-- | :-- | :-- |
| **讲题助手** | 先独立解题、再核验、最后成稿的三段式讲题流程；讲题稿按对象分版：学生（默认）／教师／命题人 | 开发完成，按真实使用反馈迭代 |
| **出题助手** | 按考点与真题风格命制材料型**选择题组**或**综合题**（一个题包只用一种题型），产出教师版与学生版投影，并可做结构校验 | 开发中：完整流程已跑通，语义质量评审待做 |
| **课程方案** | 依据课标与教材原文生成教学设计、学生学习材料与课堂观察记录，可渲染为 DOCX／HTML | 技能已就位，端到端未验收 |
| **建模完成判定（ModelCheck）** | 给地理模型（Three.js／SVG／单页 HTML）定义可执行的完成判据、运行时取证与完成门禁 | 一期已上线，真机验证待做 |

如需单独使用课程方案中的某项功能，请明确说明，例如：“请使用课程方案功能，只做课标解读，不生成完整教案。”

另有 `/geo-teacher` 工作台（纯静态页面，把需求整理成可粘贴的提示词）与会话输入区的功能选择器，二者都不连模型、不写盘。

> ⚠️ **本项目处于开发阶段**，接口、数据契约与技能内容仍会变化；数字、结论与「已验证／未验证」的边界逐条记录在 [决策记录](docs/决策记录.md)，不以规划代替现状。

## 环境要求

| 项 | 要求 |
| :-- | :-- |
| DSH | Desktop **`0.2.1-rc.2`**（0.2.1 起桌面端端口由系统分配，以环境变量 `DSH_WEB_URL` 为准） |
| 平台 | Windows（本机验证平台）；核心逻辑为纯 Node ESM，其他平台未验证 |
| Node | 随桌面附带（实测 `v24.21.0`）；仓库脚本只用 ESM 与 `node:test` |
| Python | `3.12`（仅课程方案的文档渲染需要，依赖 `python-docx`） |
| 数据 | 自备**考点库**（含 `knowledge_taxonomy_*.yaml` 的目录）与**真题库**（真题 Markdown 根目录）；课标与教材已随仓库提供 |

## 快速开始

```sh
git clone https://github.com/xiaoyuanwang220/geoteacher_preset.git geo_edu_agent
```

1. **接线到 profile**：在 `$DSH_HOME\profiles\desktop\package.json` 里加入三个包，并同时列入 `dsh.profile.bundles`（只加依赖不加 bundles 不会被加载）。把 `<克隆路径>` 换成实际绝对路径，Windows 下用正斜杠（如 `E:/geo_edu_agent`）：

   ```json
   {
     "dependencies": {
       "@geo-edu/dsh-geo-teacher-preset": "link:<克隆路径>/.agent-presets/geo-teacher",
       "@geo-edu/dsh-geo-teacher-ui": "link:<克隆路径>/packages/dsh-geo-teacher-ui",
       "@geo-edu/dsh-modelcheck": "link:<克隆路径>/packages/dsh-modelcheck"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@geo-edu/dsh-geo-teacher-preset",
           "@geo-edu/dsh-geo-teacher-ui",
           "@geo-edu/dsh-modelcheck"
         ]
       }
     }
   }
   ```

2. **安装**：用 DSH 面板的插件管理逐包安装，或 `plugin_manager action=install_bundle target=<克隆路径>/<包目录>`。`link:` 直连源码，**改仓库即改运行时**。
3. **绑定数据路径**：首次使用前，向负责安装的 Agent 提供 4 个绝对目录（考点库、真题库、产物目录、工作区根目录），由它写入 `<DSH_HOME>\geo-teacher\config.json`。填写规则、可直接复制的请求与 Agent 步骤见下一节；字段参考见 [配置模板](geo-teacher.config.example.json)。
4. **完整重启 DSH**（关闭窗口可能只是隐藏），重启后核对 `/geo/core/health` 的 `config` 字段与会话工具表。
5. **自检**：

   ```sh
   npm run verify:geo                       # 确定性静态检查
   node --test "test/*.test.mjs"             # 教师功能行为测试
   npm run test:modelcheck                   # ModelCheck 单元测试
   ```

## 配置数据路径（clone 后必做）

**首次使用前，用户向负责安装配置的 Agent 提供以下 4 个绝对目录路径，由 Agent 逐项写入本机配置。四项均明确填写，不依赖缺省值。** Agent 不自动搜索磁盘、不识别数据目录、不根据目录名或历史记录猜测路径；信息缺失时向用户询问。

| 用户提供的目录 | 配置键 | 用途与要求 |
| :-- | :-- | :-- |
| 考点库目录 | `knowledgeBasePath` | 包含 `knowledge_taxonomy_*.yaml` 的目录 |
| 真题库目录 | `questionBankPath` | 真题 Markdown 所在的根目录，保留原有子目录与图片相对位置 |
| 产物目录 | `outputPath` | 保存题库索引、真题分析导出等产物 |
| 工作区根目录 | `workspaceRoot` | 允许写入产物的根目录；`outputPath` 必须位于其中或与其相同 |

考点库和题库可以继续放在项目外，不要求移入工作区；工作区根目录只规定写盘范围，不代表数据源都必须放在其中。

**直接发给 Agent 的请求**（把四项替换为自己的实际路径）：

```text
请为地理教师助手绑定以下 4 个路径：
1. 考点库目录：<我的考点库绝对路径>
2. 真题库目录：<我的真题库绝对路径>
3. 产物目录：<我的产物绝对路径>
4. 工作区根目录：<我的工作区绝对路径>

请按我提供的值填写本机配置，不自动搜索、识别或推断其他目录。
如果缺少信息或目录不可用，请指出具体项目并问我，不要自行换成其他路径。
```

**Agent 的配置步骤**：

1. 收齐四个路径；只检查这些指定目录是否存在、是否可读，以及产物目录是否位于工作区根目录内。检查不等于自动识别或另选目录；产物目录尚不存在时，说明后按用户指定位置创建。
2. 以 [配置模板](geo-teacher.config.example.json) 为字段参考，把四个值写入 `<DSH_HOME>/geo-teacher/config.json`；已有文件只更新这四个绑定值，保留其他配置。不要把示例路径当真实配置，也不要把本机路径写回仓库。
3. `DSH_HOME` 按环境变量取值，未设置时使用 `<用户目录>/.dsh`；该规则用于定位配置文件，不用于推断数据目录。
4. 告知用户完整退出 DSH（包括后台进程）后重新打开——插件在加载时读取配置，只改文件不会更新当前进程。
5. 重启后核对 `/geo/core/health` 的 `config` 字段，并通过 `geo_taxonomy`、`geo_search_questions` 验证读取。目录或读取错误必须如实报告；不要把错误解释成「没有相关题目」，也不要自动改绑其他目录。

若 `geo-core` 插件的 `config` 里显式设置了同名字段，它们优先于本机配置；Agent 应指出这一覆盖关系，按用户指定值调整，不能报告未生效的绑定已完成。从固定路径版本升级时，用户提供原有目录即可，数据文件不必搬动。

**不在仓库内的数据**：考点库与真题库计划与项目同步开源，目前仍存放在仓库外的目录，尚未纳入本仓库；用户告知实际位置后分别绑定到 `knowledgeBasePath` 与 `questionBankPath`。

## 怎么用

**工作台**：在桌面端浏览器打开 `<DSH_WEB_URL>/geo-teacher`（Host 地址由 DSH 分配，取运行时环境变量 `DSH_WEB_URL`），选功能、填需求、选参数，复制生成的提示词到会话发送。

**输入区**：在 `geo-teacher` 预设的会话里，输入框上方出现功能选择与参数设置，选完会把前缀直接写进原生输入框。

**对话**：选中「地理教师辅助」预设后直接用自然语言提需求，模型按需调用工具与技能：

- 讲题——「2025 年广东卷第 10 题怎么讲给学生听」：模型依次 `geo_solve`（独立解题，答案不进入上下文）→ `geo_judge`（核验）→ `geo_explain`（按对象成稿）。
- 出题——「出一道材料型综合题，考生态脆弱区的综合治理」：模型加载 `geo-question-generator` 技能，先给三个构思，经你确认后成稿，并可用 `geo_question_validate` 或 CLI 做结构校验。
- 检索与分析——「人口迁移这个考点近几年考得多吗」：`geo_taxonomy` → `geo_search_questions` → `geo_question_detail` → `geo_analyze`。

**建模判定**：装了 ModelCheck 的会话会出现「建模判定」页签与 8 个 `modelcheck_*` 工具；没有 `.modelcheck\` 目录的项目完全不受影响。

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
数据源与产物：由 <DSH_HOME>/geo-teacher/config.json 解析，/geo/core/health 回显实际路径
```

仓库中有三个 bundle，都通过 profile 依赖挂载：

| 包 | 作用 |
| :-- | :-- |
| `@geo-edu/dsh-geo-teacher-preset` | 预设本体：7 个功能插件 + 4 个教师技能 + 组合文件 |
| `@geo-edu/dsh-geo-teacher-ui` | 会话输入区的功能选择与参数设置（零构建客户端） |
| `@geo-edu/dsh-modelcheck` | 建模完成判定：工具、面板、预览与取证 |

## 仓库结构

```text
.agent-presets/geo-teacher/   预设包：plugins/（core,taxonomy,bank,analysis,generator,question,panel）+ skills/ + cordis.patch.yml
packages/dsh-geo-teacher-ui/  输入区 UI 插件
packages/dsh-modelcheck/      建模完成判定插件（lib/ + server/ + client.js + 测试）
docs/                         运行基线、当前规范、需求与设计、验收待办
课本与课标/                    课标与教材正文（课标核验与共同知识依据）
scripts/                      verify 与验收脚本
test/                         教师功能行为测试
```

## 开发

- 确定性检查：`npm run verify:geo`（预设接线、技能 frontmatter、工具契约、命题包样例回归等）。
- 行为测试：`node --test "test/*.test.mjs"`；ModelCheck 另见 `npm run test:modelcheck` 与 `scripts/modelcheck-acceptance.mjs`。
- 修改后何时生效：技能文件改完重新加载即可；**插件 JS、组合文件、包导出必须完整重启桌面**。
- 开发规约（代码审查、开发清单、文档规范）在 `.agents/skills/`，见 [Skills 应用方案](docs/harness-skills-应用方案.md)。

## 文档

- [文档索引](docs/README.md) —— 现行规范、实施状态与历史记录的入口
- [使用指南](docs/使用指南.md) —— 三个入口、话术示例、能力边界、故障排查
- [DSH 0.2.1-rc.2 基线](docs/DSH-0.2.1-rc.2-基线.md) —— 运行版本与包装形态的事实来源
- [决策记录](docs/决策记录.md) —— 逐条记录决策、原因、证据与关联文件
- [出题功能](docs/geography-question-generation-product-requirements.md)／[技术设计](docs/geography-question-generation-technical-design.md)／[执行方案](docs/geography-question-generation-execution-plan.md)
- [讲题功能设计](docs/讲题功能设计.md)／[评测方案](docs/讲题评测方案.md)
- [ModelCheck 需求规格书](docs/建模完成判定插件-需求规格书.md)／[实施记录](docs/modelcheck/实施记录.md)／[接入指南](docs/modelcheck/接入指南-给agent.md)
- [术语表](docs/术语表.md) —— 地理与交付术语的唯一权威
- 历史方案与迁移记录通过 Git 历史追溯。

## 已知限制

- **讲题**：仅剩「四题三对象」的人工学科内容评审未做；讲题稿只在会话工具模式产出。
- **出题**：结构校验不等于质量通过——语义项恒为 `pending`；语义内容评审、来源指纹回填、跨主题与恢复验证未完成；正式制图与 Word/PDF 作品包不在 V1。
- **课程方案**：技能已进入预设技能根，但桌面端加载与渲染链路未验收。
- **ModelCheck**：真机 `InstancedMesh` 实例命中与取证、面板点选全链路、真实模型上的拦截行为、多会话并发隔离均未验证；点选按设计只作用于模型几何，不含文字标签与二维控件。
- **数据与引用**：考点库与真题库不随仓库分发；联网正文能否读取取决于运行环境，只拿到链接或摘要时不得声称读过全文。

## 反馈与贡献

- 问题与建议走 GitHub Issues；提问前先看 [决策记录](docs/决策记录.md)——多数取舍已有记录与理由。
- 提交改动请附验证：`npm run verify:geo` 与相关行为测试；涉及插件、组合或包导出的改动，需要完整重启桌面后的实测记录。
- 不以「文档已改」代替「功能已完成」：教学正确性、答案唯一性这类语义质量必须人工或独立核验。

## 许可与致谢

- 仓库主体采用 **MIT**，见 [LICENSE](LICENSE)。
- 课程方案技能 `.agent-presets/geo-teacher/skills/cn-high-school-geography-lesson-planning/` 采用 **Apache-2.0**，派生自 *Agent Skills for K-12 Teachers*（Copyright 2026 Anthropic PBC and Learning Commons）；该目录内自带 `LICENSE` 与 `NOTICE`，分发时须一并保留。
- `课本与课标/` 收录课标与教材正文：课标属教育部官方文件，教材正文权利归原出版方；对外再分发前请自行确认授权。
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的 Agent 与插件框架；第三方参考材料 `deepseek-harness-skills-master/` 不随仓库发布（`.gitignore` 已排除），来源见 [Skills 应用方案](docs/harness-skills-应用方案.md)。
