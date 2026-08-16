# DSH 仓库 Skills 应用方案（deepseek-harness-skills-master）

> 版本：v1.0　日期：2026-08-16　状态：方案已定稿，待实施
> 来源：`E:\geo_edu_agent\deepseek-harness-skills-master`（从 deepseek-harness GitHub 仓库 `.agents/skills` 下载，共 11 个 skill 包）
> 配套：`README.md`、`使用指南.md`、`讲题功能设计.md`、`讲题评测方案.md`、`讲题图像转录方案.md`

## 一、总体结论

这 11 个 skill **全部是 DSH 仓库自身的"开发维护"技能（dogfooding），没有一个是地理业务技能**；但它们的方法论与部分流程对本项目有真实借鉴价值。

**关键风险（必须先声明）**：**不能把这些 SKILL.md 直接拷贝进 geo-teacher 预设**——它们引用大量不存在的仓库路径（`../../../AGENTS.md`、`notes/`）与 pnpm 脚本（`pnpm run change-scope`、`verify-*`），Agent 加载后会读不存在的文件、跑不存在的命令，产生幻觉。**只能提炼方法论做适配版**。

## 二、11 个 Skill 总览

| Skill | 用途（一句话） | 绑定 DSH 仓库程度 | 对本项目价值 |
| :-- | :-- | :-- | :-- |
| `dsh-archive-agent-notes` | 归档/审计决策记录（Agent Notes）生命周期 | 🔴 强（notes/ 结构 + pnpm 校验脚本） | 中（方法论） |
| `dsh-code-review` | 审查仓库 PR（防御模式/生命周期/所有权等） | 🔴 强（AGENTS.md、pnpm change-scope） | 中（审查维度） |
| `dsh-doc-site-sync` | 同步 VitePress 文档网站 | 🔴 强（website/docs.ts、pnpm docs:*） | 低 |
| `dsh-doc-standards` | 仓库文档层级/预算/slop 清理标准 | 🔴 强（docs/AGENTS.md、verify-doc-budgets） | 中（写作思想） |
| `dsh-find-simplifications` | 找死代码/重复/过度设计并写简化提案 | 🔴 强（notes 树 + 依赖策略） | 中高（方法论） |
| `dsh-merging-stacked-prs` | GitHub 官方 stacked-PR 合并 | 🔴 强（gh stack） | 无 |
| `dsh-pre-push-checks` | 推送前选最小验证集 | 🔴 强（pnpm change-scope/vitest） | **高（思想）** |
| `dsh-prose-standard` | 散文写作标准（保留契约、删废话） | 🟡 中（核心方法论通用） | **高** |
| `dsh-translate-docs` | 双语文档翻译工作流（含术语表） | 🔴 强（i18n 配对门禁） | 中（术语表思想） |
| `dsh-trim-cot-leakage` | 修剪"思维链泄漏"散文（作者视角残留） | 🟡 中（方法论通用） | **高** |
| `record-browser-gif` | 录制 Web UI 演示 GIF（状态帧+确定性编码） | 🟡 中（流程通用） | **高** |

## 三、按三个角度分析

### 🛠 开发角度（价值最高）

1. **`dsh-pre-push-checks` + `dsh-code-review` → 项目「改动自检清单」**
   本项目已踩过的坑（应固化为清单项）：
   - 改 `agent.cordis.yml` 导致 standing 换代 → 进程内旧代路由永不释放 → `duplicate exact route` 挂载失败（**必须重启 DSH 才能解决**）；
   - 新增 `ctx.provide()` 的服务未加入 group 的 `isolate` 白名单 → 泄漏根 realm → 挂载审计拒绝；
   - 插件含非法语法（如 `{ baseRunError(...) }`）→ ESM 解析 `Unexpected string` → 挂载失败；
   - 双副本（E: 权威源 / C: 运行时）不同步 → 行为不一致。
   自检清单（改插件/组成后）：
   1. `node --check` 语法；
   2. ESM `import()` 验证（node 直接 import 插件文件）；
   3. mock ctx 直接调用 `apply()`（注册工具/服务不抛错）；
   4. isolate 白名单逐项核对（新增 provide 的服务必须入组）；
   5. 路由唯一性（webServer.register 路径不得与进程内已有路由重复）；
   6. 双副本 hash 一致 + 改动前备份；
   7. 向使用者明确「需重启 DSH 生效」。
   code-review 的"生命周期/所有权/真实入口/测试强度"维度可移植为插件审查条目（本项目 taxonomy/bank/analysis/generator 四处重复的 `sendJson`/`parseQuery`/`renderJson` 正是该抓的点）。

2. **`dsh-find-simplifications` → 定期代码简化审计**
   本项目明显的简化候选：
   - taxonomy/bank/analysis/generator 四处重复的 `sendJson`/`parseQuery`/`renderJson` → 应抽成共享工具（如 `plugins/shared/http.js` 或 core 内提供）；
   - 手写的 `resolveImagePath`/`validateRaw` → 评估是否可用 Node 内置或成熟依赖；
   - 借鉴其"消费者证据"方法论（先证明无生产调用者再删），产出 TODO 清单而非盲目删。

3. **`dsh-archive-agent-notes` → 建立项目决策记录体系**
   本项目已积累大量"踩坑结论"（双副本架构、isolate 白名单、standing 换代机制、Qwen 接入、讲题流水线设计），散落在 README/方案文档中。借鉴其生命周期（proposed / implemented / rejected + 归档），建 `docs/notes/` 决策记录，避免重复踩坑、便于接手。

### 👩🏫 用户使用角度

1. **`record-browser-gif` → 「面板演示录制」技能（适配版）**
   对教师最直接的便利：
   - 给 `使用指南.md` 配 GIF 演示（点考点 → 看题组 → 分析 → 导出 Markdown → 出题助手 → 课程方案）；
   - 教师可自行录制面板操作，用于课堂展示或教研分享。
   适配要点：保留"状态帧故事板 + 真实服务器 + 确定性编码（ffmpeg）"流程，**去掉 PR/assets branch 部分**，输出到 `outputs/demos/`。`deepseek-harness-skills-master\record-browser-gif\scripts\encode_gif.py` 可直接复用。

2. **`dsh-prose-standard` → 「文档与话术写作标准」**
   面向教师的使用指南、技能交付物（五段式题目、讲题稿）应做到"契约完整、无废话、无版本叙述残留"：教师看使用指南能直接知道"说什么 → 得到什么"，技能交付物没有"作者视角"杂质。

3. **`dsh-translate-docs` → 只借鉴「术语表」思想**
   本项目术语混用明显（"考点/知识点""素养/素养立意""设问/题干"）。建 `docs/术语表.md`（类似 terminology.md），让技能、面板、文档、工具 description 用语一致。

### 📊 评测角度

1. **`dsh-trim-cot-leakage` → 讲题稿"教学化重组"合格性检测（高价值）**
   评测 P3 Explainer 的关键是"讲题稿不是照抄解析、不是解题轨迹复读"。CoT 泄漏分类学（作者视角残留、变化叙述、版本痕迹、评审痕迹）可用于检测：讲题稿若出现解析原文痕迹、版本叙述、作者操作记录 → 判定不合格。融入 P4 评测"推理层"指标。

2. **`dsh-prose-standard` → 评测技能交付物完整性**
   出题技能自检（答案-解析一致、干扰项错因完整、五段式齐备）本质是"完整命题保留"——用 proposition-preservation 原则做形式化检查。

3. **`dsh-code-review` → 评测"模型可见输出"质量**
   code-review 的 "Model perspective"（inspect exact prompts, tool schemas, results the model receives）可移植为对 geo 工具返回文本（`geo_solve` 题面、`geo_extract_images` 转录）稳定性的评测点。

4. **`record-browser-gif` → 评测证据留档**
   P4 人工评测时录制"选择题目 → solve → judge → explain"界面流程 GIF，作为可复核证据。

## 四、落地方案（推荐，分优先级）

| 优先级 | 做什么 | 源自 | 形态 |
| :-- | :-- | :-- | :-- |
| **P0** | `geo-dev-checklist`：改动自检清单（语法/import/apply/isolate/路由/双副本/重启） | dsh-pre-push-checks + dsh-code-review + 本项目踩坑记录 | 技能 `skills/geo-dev-checklist.md` |
| **P0** | `geo-demo-gif`：面板演示录制（输出到 outputs/demos） | record-browser-gif（去 PR 部分） | 技能 + 复用 `encode_gif.py` |
| **P1** | `geo-doc-writing`：中文写作标准（契约完整、删废话、术语一致）+ `docs/术语表.md` | dsh-prose-standard + dsh-trim-cot-leakage + dsh-translate-docs(术语表) | 技能 + 术语表文档 |
| **P1** | 讲题稿合格性检测并入 P4 评测 | dsh-trim-cot-leakage | 更新 `docs/讲题评测方案.md` |
| **P2** | 代码简化审计（重复 sendJson/parseQuery 等） | dsh-find-simplifications | 一次性审计 + TODO 清单 |
| **P2** | 决策记录体系 `docs/notes/` | dsh-archive-agent-notes | 项目文档规范 |
| **不用** | dsh-doc-site-sync、dsh-merging-stacked-prs | — | 无适用场景 |

**实施方式**：逐个把方法论改写为适配本项目的中文技能（frontmatter 齐全，放进 `.agent-presets/geo-teacher/skills/` 或工作区 `skills/`），**不直接拷贝原 SKILL.md**。

## 五、明确不做

- 不直接拷贝任何原 SKILL.md 进预设（避免引用不存在的仓库路径/脚本导致幻觉）。
- 不做文档网站（VitePress）建设、不做 stacked-PR 流程（本项目非仓库 PR 协作模式）。
- 不做中英双语文档配对（除非未来有国际化需求，仅保留术语表思想）。
