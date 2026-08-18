---
name: geo-code-review
description: >-
  Use when reviewing local geo-teacher changes — diffs, commits, plugins, cordis composition, tools, skills, UI, and related docs; triggered by requests like "review"、"代码审查"、"审查改动"、"检查 diff"、"找回归风险". Performs semantic review of correctness and design against project contracts, decision records, and the pipeline discipline; reports findings first and never modifies code unless the user explicitly asks. Not for feature implementation, pre-commit mechanical verification (use geo-dev-checklist), or teacher business content evaluation.
---

# 地理教师 Agent 语义代码审查（geo-code-review）

本技能面向**开发/维护**本项目的 Agent，不进教师运行预设。**默认只审查和报告，不修改代码**；只有用户明确要求修复时才动手。

## 定位与触发边界

**触发**：用户提出 "review、代码审查、审查改动、检查 diff、找回归风险" 等请求，且对象是 geo-teacher 的**本地改动**。

**审查对象**：
- 本地改动：diff（staged / unstaged）、提交（commit）与补丁；
- 插件代码：`.agent-presets/geo-teacher/plugins/*/index.js`、`plugins/ui/page.html` 等；
- composition 与 isolate 配置：`.agent-presets/geo-teacher/agent.cordis.yml`；
- 模型工具：`geo_*` 工具的 description / 输入输出 schema / render；
- Skill：`.agents/skills/` 下开发 Skill、`.agent-presets/geo-teacher/skills/` 下教师 Skill；
- 相关文档：README、`docs/`、使用指南、决策记录。

**不适用**：
- 普通功能实现（去实现，不审查）；
- 提交前机械验证与重启后冒烟（`geo-dev-checklist`）；
- 教师业务内容评价：题目、讲题稿、课程方案的地理内容质量评价需领域 Rubric，不是代码审查；
- 文档 / Skill / 工具描述 / 可见文本的写作审查（`geo-doc-writing`）。

## 与其它开发 Skill 的分工

| Skill | 职责 | 何时使用 |
| :-- | :-- | :-- |
| `geo-code-review` | **语义审查**：判断代码和设计是否正确（正确性 / 契约 / 回归风险） | 用户要求 review、审查改动、检查 diff |
| `geo-dev-checklist` | **确定性验证**：`npm run verify:geo`、提交前检查、重启后冒烟 | 改动提交前、重启 DSH 后 |
| `geo-doc-writing` | **写作审查**：文档、Skill、工具描述、可见文本 | 涉及文档与可见字符串 |

**边界（必须遵守）**：
- `npm run verify:geo` 全绿 **不能证明语义正确**（脚本只能查语法 / 导入 / apply 冒烟 / 双副本哈希 / YAML / isolate 白名单 / 静态路由 / 索引数据，查不出设计错误）；
- 代码审查**不替代**静态检查和运行时冒烟：修改插件 / composition 后必须重启 DSH 才能验证生效，未重启不得声称生效；
- 可以按改动范围读取上述两个 Skill，但不复制它们的完整内容；涉及文档和可见文本时引用 `geo-doc-writing` 的命题保留与术语规则（`docs/术语表.md` 为唯一权威）。

## 审查工作流

### 1. 确定审查范围

优先使用用户明确指定的文件、diff、提交或范围。

若用户只说"review 当前改动"，检查：
- staged diff（`git diff --staged`）；
- unstaged diff（`git diff`）；
- 相关的 untracked 文件（`git status --porcelain` 列出后逐一核对）。

若工作区干净，**说明没有当前 diff**，并按用户请求决定审查指定提交（`git show` / `git diff <commit>`）或指定模块，**不得擅自把整个仓库当作审查范围**。

本仓库不一定配置远程仓库或 GitHub PR，**不得强依赖 PR、`origin/main`、GitHub CLI 或固定 base**；只有实际存在远程（`git remote`）或用户明确指定 PR 时才使用对应信息。

### 2. 理解设计和调用路径

**不能只读 diff**，还要读取足够的上下文：
- 调用方和消费者：工具 `execute` → `geoKernel` / `geoVision` 服务 → 其它插件 / UI / 教师 Skill；
- composition 与 isolate 配置（`agent.cordis.yml` 的 geo group）；
- 工具输入输出 schema 与 render 函数；
- HTTP 路由及 UI 消费方（`page.html` 的 fetch 端点）；
- 相关 Skill（教师技能如何描述与调用工具）；
- 决策记录和设计文档（`docs/决策记录.md`、`docs/*修复方案.md`）；
- 缓存、索引、磁盘数据和运行时副本关系（双副本、`outputs/question-index.json`、`outputs/visionCache`）。

**审查重点是当前改动是否破坏既有契约**（返回值结构、字段名、路由、服务名、工具名、行为顺序），而不是罗列风格问题。

### 3. 项目专属审查维度

#### DSH 生命周期与服务边界
- `inject` / `ctx.get()` / `ctx.provide()` 是否正确：可选服务用 `ctx.get()` + undefined 检查；硬依赖才声明 `inject`；
- `ctx.provide()` 的服务名必须同步加入 `agent.cordis.yml` geo group 的 **isolate 白名单**（`geoKernel: true`、`geoVision: true`），否则服务泄漏到根 realm，挂载审计拒绝；
- 注册、副作用、清理是否属于正确生命周期：`ctx.effect()` 是否返回 disposer、`ctx.on()` 是否清理、`webServer.register` 是否挂在当前 fiber；
- 重载或旧 generation：standing generation 在进程存活期内**永不 dispose**，改 `agent.cordis.yml` 后旧代路由 / 服务仍占用 → 重复路由只能靠重启释放；审查时区分"源码内重复"与"进程内旧代残留"；
- 跨插件通信必须经 `geoKernel` / `geoVision` 正式服务接口，**不得**直接 import 对方模块或宿主包（C: 运行时副本无 node_modules，裸 import 会失败），不得形成隐式耦合（共享模块变量、以文件读写当通信通道）。

#### 工具和模型可见契约
- 工具 description 是否准确：触发词、铁律、参数含义、返回值说明与实现一致；
- 输入 schema、必填字段、返回结构是否稳定：改动字段名 / 结构是否会破坏依赖它的教师 Skill 或 UI；
- 错误、降级、不可用状态是否显式且可被模型识别：`status: 'error' / 'degraded' / 'disabled'` 是否带 message，不得静默返回空或把失败伪装成成功；
- 模型是否拥有完成下一步所需的信息：solve 阶段的返回是否足以独立解题、judge 是否开放答案、各步是否衔接同一 qid；
- UI、工具返回、文档对同一字段的定义是否一致（questionId/qid、stem、选项格式、状态字段）。

#### 讲题流水线纪律（solve → judge → explain）
- 顺序：solve（独立解题）→ judge（核验，传 `independentAnswer`）→ explain（重组，传 `independentAnswer` + `judgeReport`）；不得跳步；
- solve 阶段是否可能读取答案、解析或解析派生信息：`distractorClues`、knowledgePoints 的 role/evidence、选项正确性提示；
- judge / explain 是否消费**相同 qid** 的结果；explain 不得重新解题、不得直接拿解析原文推导讲法；
- 视觉模型只做图像转录：prompt 引导"只转录、不回答设问、不评价"，`inferred` 类条目丢弃，不得越权解题；
- 备用路径审查：`geo_question_detail`、文件读取、`imageRefs` 降级遍历、read/glob/pwsh 直读题库 md（`E:\知识图谱\obsidian_vault\04_题目` 下所有 .md 均含答案/解析，直读等同读取答案）——任何路径都不能绕过答案隔离。

#### 数据、缓存和新鲜度
- qid、题干、答案和解析解析是否正确：question_id 引号兼容、`stemMark[2]`（真实题干）、MANAGED-KM 块跳过（inKm）、综合题答案拆分；
- 磁盘索引是否会陈旧：`question-index.json` 的 version 代际 + fileCount + mtime（builtAt）新鲜度检查；索引写失败是否有提示；
- 缓存键是否包含影响结果的要素：visionCache 以图片内容 hash 为 key，`index.json` 记录 modelId / promptVersion / schemaVersion；改模型 / prompt / schema 后旧缓存必须失效；
- 缓存失效和写失败是否被正确处理：写失败不阻塞运行，但不得把"命中旧缓存"伪装成"本次转写成功"；
- 权威源与运行时副本：E: 权威源与 C: 运行时副本不一致时改动未生效（双副本架构），审查不得假定已同步；
- 降级路径是否把失败伪装成成功：`visionOk` 显式标记、markdown 为空时 usable=false、无视觉模型时明确报错。

#### 安全与文件边界
- 路径是否限制在允许的工作区、题库或输出目录（OUTPUT_PATH、CACHE_DIR、knowledgeBasePath、questionBankPath）；拼接路径是否有穿越风险（`..`、盘符、绝对路径注入）；
- HTML/UI 是否存在未转义内容注入：`page.html` 对后端返回文本（题目、材料、文件名）用 textContent 而非 innerHTML 直插；
- 日志、错误和 raw output 是否可能泄露密钥或不应暴露的数据（vision rawText、provider/model 信息、完整文件路径）。

#### 测试与真实入口
- 是否通过真实 Loader、composition、HTTP 路由或模型工具入口验证；mock `apply()`、`node --check`、正则扫描**不能替代**真实入口（查不出动态加载失败、路由冲突、服务未挂载）；
- 测试是否会在目标回归出现时真正失败：断言检查外部状态 / 行为而非复述实现；**不得把文档中的"已验证"或 Agent 的报告当作测试证据**；
- `geo-verify.mjs` 的运行时冒烟（`/geo/core/health`、`/geo-teacher`）必须在重启 DSH 后执行才有意义。

#### 文档和 Skill 一致性
- 涉及文档、Skill、工具 description 或可见字符串时，使用 `geo-doc-writing` 的命题保留和术语规则（`docs/术语表.md` 为唯一权威）；
- README、使用指南、决策记录和实际代码是否一致：已实现功能是否仍写成"待实现 / 待重启生效"；行数、工具数量、端点、模型和实施状态是否过时；
- 教师 Skill 是否调用真实存在的工具、描述是否与工具实现一致（`geo_solve` / `geo_judge` / `geo_explain` / `geo_question_detail` 等）；
- 不得把作者会话、评审过程或版本叙述留在当前状态文档中（"v2 修订"、"本次改动"、"reviewer 指出"）。

### 4. 验证边界

按改动范围选择**最小而有效**的检查。可以调用 `geo-dev-checklist` 并运行适用的检查（如 `npm run verify:geo -- --source`），但必须遵守：
- 仅文档或开发 Skill 改动，**不得无理由要求重启 DSH**；
- 修改插件或 composition 后，**源码验证与重启后运行时冒烟必须分开报告**；
- **未重启时不得声称运行时改动已经生效**；
- 检查未运行、无法运行或结果不完整时要明确说明；
- 自动检查通过**不等于**审查无问题。

## 报告格式（findings-first）

Review 输出必须 findings-first。每个问题包含：
- **严重级别**；
- **精确文件**和尽可能小的**行号范围**；
- **缺陷是什么**；
- **会造成什么实际影响**；
- **证据或可复现路径**；
- 必要时给出**最小修复方向**，但默认不直接修改。

严重级别：
- **P0**：安全、数据破坏、答案泄漏或系统级严重事故（如直读题库泄露答案、路径穿越、密钥泄露）；
- **P1**：核心流程错误、主要功能不可用或结果明显错误（如流水线跳步、工具返回结构破坏、契约不匹配）；
- **P2**：边缘场景错误、状态漂移、缓存/生命周期风险（如索引陈旧、缓存键不全、副作用未清理）；
- **P3**：非阻断维护性或简化建议。

要求：
- 阻断问题与建议**分开**；
- 不报告已被确定性检查完整覆盖且已经通过的纯机械问题；
- 不为了凑数量输出无影响的风格 nit；
- 没有发现问题时明确写"**未发现实质性问题**"，并列出**仍未验证的风险**（如"未重启，运行时行为未验证""题库索引未重建，解析结果未实测"）；
- 默认只审查和报告，除非用户明确要求修复；
- 审查请求**不得隐含**提交、推送、同步运行时副本或重启 DSH 的授权。

## 术语引用

所有开发产出中的地理术语以 `docs/术语表.md` 为准。
