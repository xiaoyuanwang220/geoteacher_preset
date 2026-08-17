# 地理教师 Agent 插件化与课程方案生成方案

> 状态：方案稿（待分析确认）　日期：2026-08-14
> 保存自 DSH 会话计划评审稿；后续迭代请在本文件上修订。

## 一、目标与成功标准

**目标**：把当前"单个 `geo-teacher-plugin` 大插件"重构为「内核服务 + 按功能拆分的小插件」的可扩展架构；新增**课程方案生成**能力；最终形成统一的**地理教师 Agent**（模型可直接调用工具 + 教师浏览器面板 + 可加载的技能库），并预留后续继续加插件的通道。

**成功标准**：
1. `agent.cordis.yml` 通过 `agentPresets.standingKeyFor('geo-teacher')` 挂载校验（所有行激活、无服务泄漏到根 realm）。
2. `/geo-teacher` 仪表盘可访问，含导航区：考点树 / 真题库 / 真题分析 / 出题 / 课程方案。
3. 模型侧出现可调用工具：`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_analyze`、`geo_export_analysis`、`geo_style_profile`、`geo_lesson_*`。
4. 技能目录中可加载：`geo-question-generator`（修复 frontmatter 后真正被发现）、`cn-high-school-geography-lesson-planning`（新增）。
5. 端到端：教师说"设计一节……的课"→ 技能驱动 → `lesson.json` → docx/html 输出到 `<WORKSPACE>\outputs`。
6. 回归：既有考点树 / 真题分析 / 出题功能在真实会话中行为不变（同一 questionId 分析结果一致）。

## 二、现状与结论（探索发现）

| 资产 | 位置 | 状态 |
| --- | --- | --- |
| 地理教师预设 `geo-teacher` | `<DSH_HOME>\.agent-presets\geo-teacher\`（用户自有，可改） | ✅ 挂载中；内置单插件 + 1 技能 |
| 单插件实现 | `geo-teacher-plugin/index.js`（673 行：解析器 + 题库加载 + 分析/蓝图引擎 + `/geo-teacher` 页面 + `/geo-teacher/api/*`） | ✅ 可用，待拆分 |
| 出题技能 | `skills/geo-question-generator.md` | ⚠️ **无 frontmatter**，skill-filesystem 会以 "missing YAML frontmatter" 忽略——当前很可能实际未被发现，需修复 |
| 课程方案技能包 | `<WORKSPACE>\cn-high-school-geography-lesson-planning\`（SKILL.md + references/ + scripts/ 渲染管线 → docx/html） | ✅ 资产完整，但 SKILL.md 依赖 ima/WorkBuddy MCP（DSH 中不存在），需适配 |
| 出题技能包（另一份） | `<WORKSPACE>\question-assistant\` | 重复资产，只留参考 |
| 旧动态插件草稿 | `<WORKSPACE>\host.js / client.js / geo-teacher-agent.js / geo-teacher-client.js / plugin.json / package.json` | 已被持久化插件取代，归档 |
| 数据源 | `<KB_ROOT>\config\knowledge_taxonomy_*.yaml`、`<KB_ROOT>\obsidian_vault\04_题目`（动态增长） | ✅ 现状路径，内核配置集中管理 |
| 输出目录 | `<WORKSPACE>\outputs` | ✅ 分析与蓝图导出位置 |
| 会话技能 | `geo-teaching-model`（网页教学模型）、`matplotlib` 等 | 未来功能候选 |

**关键结论**：
- 预设内插件行 `name: './xxx/index.js'` 是"加一行 = 加一个插件"的既有扩展机制，沿用。
- skill-filesystem 只发现「平铺 `.md`」或「`<根>/<名>/SKILL.md`」两种形态，且**必须带 frontmatter（name/description）**；课程方案包以目录包形式放入 preset 的 `skills/` 即符合规范。
- 预设内自有服务必须放进带 `isolate` realm 的 group，消费它的插件同组——这是文档化的正确模式（预设里已有 planning/compaction/delegation 三个先例）。
- 渲染管线（Python docx/html）由模型经 `pwsh` 工具执行（skill 已文档化命令与解释器路径），插件不做 shell-out，避免绕过审批栈。

## 三、总体架构

一个 agent preset = 一个 agent。所有地理能力都收在 `<DSH_HOME>\.agent-presets\geo-teacher\` 内：

```
geo-teacher/
  preset.yml                     # name/description（改描述）
  agent.cordis.yml               # 组成：persona + 基础行 + geo group（isolate realm）+ 课程方案技能发现
  skills/                        # 技能（skill-filesystem 发现；一律带 frontmatter）
    geo-question-generator.md    # 出题（修复 frontmatter）
    cn-high-school-geography-lesson-planning/   # 课程方案：SKILL.md + references/ + scripts/ + config/
  plugins/
    core/                        # geo-core：内核服务 geo.kernel（数据层）+ /geo/health
    taxonomy/                    # 考点树 API + 模型工具 geo_taxonomy
    bank/                        # 真题索引/详情 API + geo_search_questions / geo_question_detail
    analysis/                    # 真题分析+命题蓝图 API + geo_analyze / geo_export_analysis
    generator/                   # 风格档案 API + geo_style_profile（供出题技能调用）
    lesson/                      # 课程方案 API（模板/校验/输出清单）+ geo_lesson_*
    ui/                          # /geo-teacher 仪表盘（单入口 + 左导航），页面仍为纯 HTML/JS，无构建步骤
```

**组成方式（agent.cordis.yml）**：新增一个 group 行（结构同预设内 delegation 先例）：

```yaml
- id: geo
  name: cordis:group
  group: true
  isolate:
    geoKernel: true
  config:
    - id: geo-core
      name: './plugins/core/index.js'
      config: { knowledgeBasePath: '<KB_ROOT>/config', questionBankPath: '<KB_ROOT>/obsidian_vault/04_题目', outputPath: '<WORKSPACE>/outputs' }
    - id: geo-taxonomy
      name: './plugins/taxonomy/index.js'
    - id: geo-bank
      name: './plugins/bank/index.js'
    - id: geo-analysis
      name: './plugins/analysis/index.js'
    - id: geo-generator
      name: './plugins/generator/index.js'
    - id: geo-lesson
      name: './plugins/lesson/index.js'
    - id: geo-ui
      name: './plugins/ui/index.js'
```

旧行 `geo-teacher-agent`（`./geo-teacher-plugin/index.js`）在迁移验证通过后删除；旧目录 `geo-teacher-plugin/` 同时移除（先做整目录时间戳备份）。

## 四、内核服务契约（geo.kernel）

`plugins/core/index.js` 从现 `index.js` **原样搬移**解析器与数据层（`parseTaxonomyNodes`、`collectMdFiles`、`parseFrontmatter`、`parseQuestionFileFull`、`parseOneQuestion`、`parseKmBlock`、分析/蓝图引擎、`loadBank`、`groupInfo`），行为零改动，通过 `ctx.provide('geo.kernel', api)` 发布。方法：

- `getTaxonomyTree()` → 三级考点树
- `searchQuestions(knowledgeId, keyword)` → 题目索引列表（题型+卷别题号+questionIds）
- `getQuestionDetail(questionId)` → 题组材料 + 全部小题
- `analyzeQuestion(questionId)` → `{ analysis, blueprint }`
- `exportAnalysis(questionId)` → 写 md 到 outputs，返回路径
- `styleProfile(region, years)` → 七维度风格档案（基于现有 detect* 引擎 + 真题检索，**新增**，供出题技能/工具用）
- `health()` → `{ taxonomyNodes, bankFiles, bankQuestions }` 计数（冒烟用）

数据路径从插件 config 读取（如上 `config` 块），不再硬编码。实现细节：core 先保持单文件；若相对 ESM import 验证可用，再按需拆 `parsers.js/bank.js`（拆前先验证，不预支风险）。

## 五、功能插件划分

每个功能插件：`inject: ['fs','webServer','geo.kernel']`（ui 只注入 fs/webServer），职责单一，路由一律 `webServer.register` prefix `/geo/<feature>/`：

| 插件 | 路由（JSON API） | 模型工具（注册进 host `tools` 注册表） |
| --- | --- | --- |
| taxonomy | `/geo/taxonomy/tree`、`/geo/taxonomy/node?id=` | `geo_taxonomy` |
| bank | `/geo/bank/search?kp=&keyword=`、`/geo/bank/detail?qid=` | `geo_search_questions`、`geo_question_detail` |
| analysis | `/geo/analysis/run?qid=`、`/geo/analysis/export?qid=` | `geo_analyze`、`geo_export_analysis` |
| generator | `/geo/generator/style?region=&years=` | `geo_style_profile` |
| lesson | `/geo/lesson/templates`、`/geo/lesson/validate`（lesson.json 最小 schema 校验）、`/geo/lesson/outputs`（列 outputs 目录） | `geo_lesson_plan`（引导/清单，主路径仍是技能） |
| core | `/geo/health` | — |
| ui | `/geo-teacher` 页面（唯一 HTML 入口） | — |

工具注册：复用 editing-cordis-compositions 技能中的既有模式（`harness.registerTool(ctx, harness.defineTool({...}))`，通过 host `tools` 注册表）；**实施第一步用 Inspect Provider（host `Service.listService` / `Tool.listTools`）核实 `tools` 服务与 webServer 注册的确切签名**，若持久化插件上下文无 `harness` 全局则改用 `ctx.tools` 等价 API（已确认宿主存在 tools 注册表行）。

## 六、课程方案生成（新增能力）

**策略：技能优先、插件轻量。**

1. **拷贝技能包进 preset**：将 `<WORKSPACE>\cn-high-school-geography-lesson-planning\` 整体复制为 `geo-teacher/skills/cn-high-school-geography-lesson-planning/`（目录包形态，符合 skill-filesystem 发现规则；references/scripts/config 子资源随包，模型可用 read/pwsh 访问 preset 路径）。
2. **适配 SKILL.md 到 DSH 现实**（删掉 ima/WorkBuddy/MCP 假设，保留 0–5 步工作流、`lesson.json` 统一材料源、渲染命令与红线）：
   - 数据源改为：本地考点库（`<KB_ROOT>\config`）、本地真题库（`<KB_ROOT>\obsidian_vault\04_题目`，现场扫描）、包内 `references/`（课标/写法/地图政策）、`web_search` 工具（时事/数据核验）。
   - 渲染命令保持既有形式：`& 'E:\Miniconda3\envs\myenv\python.exe' scripts\render_documents.py lesson.json --format both --outdir <outputs>`（模型经 pwsh 工具执行，绝对路径指向 preset 内脚本）。
   - 补 frontmatter：`name: cn-high-school-geography-lesson-planning` + description + whenToUse。
3. **lesson 插件**只做仪表盘辅助（模板列表、lesson.json 校验、outputs 清单），不做渲染 shell-out。
4. **明确不做**（本迭代）：HARNESS_PLAN.md v0.3 的 MCP 检索编排、证据包门禁、状态机——列为后续演进，不进本轮。

## 七、出题技能修复与整合

- 给 `skills/geo-question-generator.md` 补 YAML frontmatter（name/description/whenToUse），使其被 skill-filesystem 真正发现；挂载后用 `Tool.listTools` 或新会话确认出现在技能目录。
- `generator` 插件提供 `geo_style_profile` 工具，技能原文已预留"可选风格档案接口"，接线即可（输入 region/years → 七维度档案）。
- 权威副本收敛到 preset `skills/`；`<WORKSPACE>\question-assistant\`、`<WORKSPACE>\skills\geo-question-generator.md` 降级为历史参考，避免多份漂移。

## 八、Agent 人格与会话集成

- `persona` 行文本从 coding-agent 改为**地理教师助手**人格：说明身份（高中地理教师辅助 Agent）、能力清单（考点树/真题库/真题分析/出题/课程方案）、**路由规则**（"出题"→ geo-question-generator 技能；"设计课/教案"→ 课程方案技能；"这个考点有哪些题"→ geo_search_questions 工具；"为什么这样考"→ geo_analyze），并保留 coding 能力（fs/pwsh/tools 供技能落地）。
- 保留预设其余基础行不变（bash/pwsh、fs、jobs、skills、delegation、planning、compaction 等均照抄现状）。
- 预设 `preset.yml` 的 description 同步更新。

## 九、Web 面板改造

- `page.html` 重做为单页仪表盘：左侧导航（考点树 / 真题库 / 真题分析 / 出题 / 课程方案），各区块 fetch 对应 `/geo/<feature>/` API；复用现有 `geo-plugin-card` 等样式与主题变量，纯原生 JS（React 可选，不强上），无构建步骤。
- 保持 `/geo-teacher` 为唯一入口（沿用已验证的 webServer 页面模式）；**不用** slots/客户端插件（需客户端重建与审批流），列为后续选项。

## 十、实施步骤（分阶段，每阶段含验证门）

- **P0 准备**：整目录备份 `geo-teacher/` → `geo-teacher.bak-<时间戳>`；用 Inspect Provider 核实 `tools` 服务、`webServer.register`、`ctx.provide` 签名；通读 shipped `standard/agent.cordis.yml` 与 `code` 预设作对照。
- **P1 内核**：新建 `plugins/core`（搬移数据层，行为零改动）；agent.cordis.yml 加 geo group（先只含 core）；`standingKeyFor` 挂载校验通过；`/geo/health` 返回正确计数。
- **P2 功能插件**：依次拆 taxonomy/bank/analysis/generator/ui；每拆一个即挂载校验 + HTTP 冒烟（`Invoke-WebRequest http://127.0.0.1:3080/geo/...`）；全部就绪后删除旧 `geo-teacher-agent` 行与 `geo-teacher-plugin/` 目录；确认 `/geo-teacher` 面板各区块可用。
- **P3 技能**：修复出题技能 frontmatter；拷入并适配课程方案技能包；新会话/`skill` 目录确认两个技能均可加载。
- **P4 课程方案端到端**：lesson 插件 + 面板区块；用 pwsh 验证渲染管线（现有 python 环境）；真实走一单："设计一节高中地理《农业区位因素》的课" → docx/html 落盘 outputs。
- **P5 人格与打磨**：persona 改写；回归全部既有功能（同一 questionId 的 analyze 输出前后一致）；更新 preset.yml 与 `<WORKSPACE>\README.md`。
- **P6 清理**：把工作区旧草稿（host.js、client.js、geo-teacher-agent.js、geo-teacher-client.js、plugin.json、package.json、question-assistant/、skills/geo-question-generator.md）归档到 `<WORKSPACE>\legacy\`，`plugin_definition.md` 保留为历史。

## 十一、验证与验收

1. `standingKeyFor('geo-teacher')` 正常返回（四类失败均为 0）。
2. HTTP 冒烟全绿：`/geo/health`、`/geo/taxonomy/tree`、`/geo/bank/search?kp=<已知考点ID>`、`/geo/analysis/run?qid=<已知题ID>`、`/geo/generator/style`、`/geo/lesson/templates`、`/geo-teacher` 均 200 且 JSON/HTML 合法。
3. 技能目录含两个新技能且 `skill()` 可加载；模型工具列表含 `geo_*`（`Tool.listTools` 验证）。
4. 课程方案 E2E：产出非空 docx + html（每份文档 ≥ 1 处非空正文）。
5. 回归：迁移前后同一 questionId 的 analysis JSON 逐字段一致。

## 十二、未来扩展预留（本轮不做）

- 教学模型生成（复用 `geo-teaching-model` 技能 → `plugins/model`）
- 试卷讲评 / 学情分析 / 复习规划 / 作业批改 / 试题难度标定
- 课程方案子代理（host 侧 `agents` 注册表 + spawn/fork 后端已就绪）
- HARNESS_PLAN v0.3 内容驱动 Harness（证据包/门禁）作为课程方案演进
- 其他学科复用：复制 geo group 到新 preset 即得新学科 agent
- 客户端插件（slots 侧边栏）替换独立页面

## 十三、假设、风险与回退

**假设**：`<KB_ROOT>` 路径不变；`E:\Miniconda3\envs\myenv\python.exe` 存在且能跑渲染脚本；预设内相对路径插件行可注入 host 服务并注册 webServer 路由（现状已证明）；`harness`/`ctx.tools` 至少一条路可注册模型工具（P0 核实，两条路都不通则退化为"技能 + 面板"交付，工具注册列为 P2 可选）。

**风险与缓解**：
- 技能 frontmatter 缺失 → 技能静默不出现（现出题技能很可能已处于此状态）：P3 修复并显式验证目录。
- realm/group 写错 → 挂载拒绝（报错含服务名）：每阶段 `standingKeyFor` 兜底；core 与全部消费插件必须同组。
- 迁移中断 → 面板不可用：P2 每插件独立验证后才删旧行；P0 有整目录备份可回退。
- webServer 路由冲突（其他 preset 占用 `/geo/*`）：前缀 + P2 冒烟确认。
- 预设改动对已开会话不生效：完成后需新开会话验证（README 注明）。

---

## 附录 A：预设目录迁移记录（方案 A，2026-08-14）

**决策**：用户 C 盘空间紧张，将 `geo-teacher` 预设主目录迁至项目工作区，统一纳入项目管理。

**已执行**：
1. `<DSH_HOME>\.agent-presets\geo-teacher\` → 复制到 `<WORKSPACE>\.agent-presets\geo-teacher\`（6 个文件，SHA256 字节一致校验通过）。
2. 在 host 组成补丁 `<DSH_HOME>\profiles\web\cordis.patch.yml` 为 `agent-presets` 行配置 `roots: [{ path: '<WORKSPACE>/.agent-presets', trust: user }]`，并照抄回 `default: standard`（patch 整段替换 config）。YAML 已用 `yaml` 包解析校验。

**原理依据**（dsh-agent-presets README）：`roots` 支持任意路径；配置根目录按序优先于推导出的 `<dshHome>/.agent-presets` 用户根（重复 id 靠前根胜出）；相对路径插件行与 `skills/` 均相对预设自身目录解析，迁移后无需改内部路径；包名从宿主组装解析，不受位置影响。

**待办（需 DSH web 进程重启后生效）**：
- 重启后 roster 将从 E: 根解析 `geo-teacher`（E: 根优先，C: 旧副本被遮蔽）。
- 确认新会话能选到「地理教师辅助」预设后，删除 C: 旧副本 `<DSH_HOME>\.agent-presets\geo-teacher\`（约 66KB）以彻底释放 C 盘；删除需 C 盘写权限。
- 此后预设的权威副本 = `<WORKSPACE>\.agent-presets\geo-teacher\`，建议纳入 git 管理；`agent.cordis.yml` 注释中说明"这是项目内副本"以免误改 C: 遗留目录。
- 本方案的实施（插件化重构 P0–P6）仍按上文各阶段进行，操作对象改为 E: 副本。

---

## 附录 B：预设双副本架构（方案 A 修正，2026-08-14）

**结论**：方案 A（`agent-presets.roots` 指向 E:）对 `dsh web` **无效**；最终采用「E: 权威源 + C: 运行时副本」双副本架构。

**调查过程与根因**：
1. **`dsh web` 强制覆盖 roots**：`dsh` 的 `profile-boot`（`lib/profile-boot-*.js` `composeProfile`）在组合的最后**无条件注入**一条 overlay：把 `agent-presets` 的 `config.roots` 覆盖为 `[{ path: SHIPPED_PRESET_ROOT, trust: 'system' }]`（`config/agent-presets/` 部署根）。因此任何 patch 层的 `roots` 配置（profile patch / home patch）都会被覆盖。已验证：`dsh --profile web --dump-config` 显示 patch 生效（roots 含 E:），但运行进程的 loader entry config 是 `roots:[shipped]`。
2. **junction 不被发现**：AgentPresets 发现用 Node 原生 `readdir(dir, {withFileTypes:true})` + `child.isDirectory()`；Windows junction 在 Dirent 里 `isSymbolicLink()=true`、`isDirectory()=false` → 被跳过（skill-filesystem 有 followSymlinks 选项，agent-presets 没有）。
3. **唯一可靠入口**：`includeUserRoot` 恒为 true，`<dshHome>/.agent-presets` 用户根**始终被扫描**（在 config.roots 之外固定追加）。所以预设必须真实存在于该用户根。

**最终架构**：
- 权威源：`<WORKSPACE>\.agent-presets\geo-teacher\`（git 管理、开发编辑）。
- 运行时副本：`<DSH_HOME>\.agent-presets\geo-teacher\`（DSH 实际加载，约 110KB）。
- 同步命令：`Copy-Item 'E:\...\geo-teacher\*' 'C:\...\geo-teacher\' -Recurse -Force`。
- `profiles\web\cordis.patch.yml` 已还原为 `[]`（无效配置已撤销）。

**附带修复（P2 验证中发现）**：
- 插件回调签名：`apply(ctx, config)`（配置是第二参数；`ctx.config` 抛 "without inject"）。
- 服务访问：`ctx['服务名']`；服务名与 `isolate:` 键必须一致（`geo.kernel` 带点导致隔离审计失败 → 改为 `geoKernel`）。
- 内核插件写 `outputs\` 需显式传沙箱策略（standing mount 无会话上下文，fs 用默认 workspaceRoot `<DEPLOY_ROOT>`）：`fs.writeText(target, md, undefined, undefined, { mode:'workspace-write', workspaceRoot:'<WORKSPACE>' })`。
