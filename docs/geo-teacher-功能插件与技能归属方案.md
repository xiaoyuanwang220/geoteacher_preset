# geo-teacher 功能插件与技能归属方案

> 日期：2026-10-08
> 状态：**方案（未实施，本文件不含任何代码改动）**
> 触发：用户问「preset 里的三个功能大部分是工具与 skill 的形式，集合成各个插件会不会更合适」
> 现行对照物：`.agent-presets/geo-teacher/cordis.patch.yml`（`geo` group 六个 entry）、预设技能根 `.agent-presets/geo-teacher/skills/`
> 证据来源：DSH 官方子系统文档与包文档（§11 列出链接）；本机宿主 `skills` 服务契约与 profile 配置实测；源码核对 `plugins/*/index.js`、`scripts/geo-verify.mjs`、`plugins/panel/page.html`；`docs/术语表.md`、`docs/决策记录.md`

---

## 1. 结论

1. **「插件」与「工具／技能」不在同一层，不构成二选一。** 插件是装配单位；工具与技能是插件注册出来的模型可见契约单位。当前 preset 里的工具**已经是**插件形态（`geo` group 下的 taxonomy／bank／analysis／generator），没有归到插件的只有技能。
2. 因此要做的不是"把三个功能集合成插件"，而是**把每个功能的技能收归该功能的插件自己注册**，使一个功能只有一处归属、一种生命周期。
3. **本方案把两件事拆开**（§5）：修「课程方案」缺口的代价很小、收益确定，建议单独先做；「技能归属收归插件」是架构整理，代价集中在 `geo-verify.mjs` 重写与失去技能文件的热更新，需单独决策。
4. **不采用**：把工具合并成大工具、拆成三个独立 npm 包、把技能正文内联进 JS 字符串。理由见 §9。

---

## 2. 分层判据

| 层 | DSH 中的单位 | 注册入口 | 模型可见性 | 回收 |
| :-- | :-- | :-- | :-- | :-- |
| 装配 | Cordis entry（插件） | `cordis.patch.yml` 插件行 + `apply(ctx)` | 不可见 | fiber 归还时回滚 |
| 模型契约·工具 | `ToolDefinition` | `ctx.tools.register` | 每个请求可见完整 schema | 随 fiber |
| 模型契约·技能 | `SkillProvider` / `SkillRegistration` | `ctx.skills.registerProvider` / `ctx.skills.register` | 目录只露 `name` + `description`，正文按需加载 | 随 fiber |
| 界面 | `WebRoute` | `ctx.webServer.register` | 浏览器可见 | 随 fiber |

后三层都必须由插件注册，所以插件是它们的**载体**，不是替代形态。判断一个功能该不该有独立插件，看的是它的**装配边界**（配置、隔离、能否整块启停），不是它暴露工具还是技能。

---

## 3. 现状盘点

### 3.1 插件、工具与路由

| entry id | 包子路径 | 注册的工具 | 路由 | 技能 |
| :-- | :-- | :-- | :-- | :-- |
| `geo-core` | `plugins/core` | 无（`ctx.provide('geoKernel')`） | `/geo/core/*` | — |
| `geo-taxonomy` | `plugins/taxonomy` | `geo_taxonomy` | `/geo/taxonomy` | — |
| `geo-bank` | `plugins/bank` | `geo_search_questions`、`geo_question_detail` | `/geo/bank` | — |
| `geo-analysis` | `plugins/analysis` | `geo_analyze`、`geo_solve`、`geo_judge`、`geo_explain`、`geo_export_analysis` | `/geo/analysis` | 无（在预设技能根） |
| `geo-generator` | `plugins/generator` | `geo_style_profile` | `/geo/generator` | 无（在预设技能根） |
| `geo-panel` | `plugins/panel` | 无 | `/geo-teacher`、`/geo-teacher/assets` | — |

合计 9 个模型工具。`geo-core` 提供的 `geoKernel` 由 `isolate: geoKernel` 限定为本 preset 私有。

### 3.2 技能的发现根与优先级

官方子系统文档给出本地提供者的扫描顺序（`<projectRoot>/.agents/skills` 中的开发技能即由此发现）：

| rank | source | 根 |
| :-- | :-- | :-- |
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` |

未找到 git 根时，`projectRoot` 取当前 cwd。本工作区无 git，故 `projectRoot` = `E:\geo_edu_agent`。

预设技能根（rank 300）下的技能：

| 技能 | 形态 | 文件 |
| :-- | :-- | :-- |
| `geo-solver` | 平铺 `.md` | `skills/geo-solver.md` |
| `geo-question-explainer` | 平铺 `.md` ＋**根级共享** `references/` | `skills/geo-question-explainer.md`、`skills/references/explainer-audiences.md` |
| `geo-question-generator` | 目录包 | `skills/geo-question-generator/SKILL.md` 加 4 份 `references/` |

`skills/references/explainer-audiences.md` 属 `geo-question-explainer`，却存放在技能**根**——平铺形态的技能以技能根为资源基准，这是形态造成的，不是设计选择。

### 3.3 三个功能与载体的对应

工作台三个 tab 取自 `plugins/panel/page.html` 的 `MODES`（`讲题`／`出题`／`课程方案`）。

| 功能 | 工具 | 技能 | 归属现状 |
| :-- | :-- | :-- | :-- |
| 讲题 | `geo_solve`、`geo_judge`、`geo_explain`（另有 `geo_export_analysis`） | `geo-solver`、`geo-question-explainer` | 工具在 `geo-analysis`，技能在预设技能根 → **两处** |
| 出题 | `geo_style_profile` | `geo-question-generator` | 工具在 `geo-generator`，技能在预设技能根 → **两处** |
| 课程方案 | 无 | `cn-high-school-geography-lesson-planning` | **未加载**（见下） |

### 3.4 「课程方案」技能为何没有加载

`E:\geo_edu_agent\skills\cn-high-school-geography-lesson-planning\`（`SKILL.md` ＋ 7 份 `references/`）不在 §3.2 的任何一个根下：它既不是 `<projectRoot>/.dsh/skills`，也不是 `<projectRoot>/.agents/skills`；桌面 profile 的 `cordis.patch.yml` 与 `package.json` 全文无技能相关配置，也没有第二个 `customSkillDirs` 声明；`bundledSkillDir` 未配置。三处证据一致，与 `docs/决策记录.md` 2026-10-08 行的口径相同。

`README.md` 的目录结构表把该目录标为「课程方案技能**源**工作区」，即项目已知它是源目录而非运行时发现根——但没有任何一层把它接上，故运行时不可加载。

这处停在两个位置规定之间：`docs/harness-skills-应用方案.md` §三-B 把出题/解题/讲题/**课程方案**并列为四类「教师运行 Skill」，§九 验收标准第 5 项按四个教师 SKILL.md 验收，而第 3 项只对开发技能规定了位置（`.agents/skills/`，且不得进预设）。课程方案技能于是停在仓库根 `skills/`——既不是开发技能的位置，也不是预设技能根。

### 3.5 三个功能之外的能力

`geo_analyze` 与 `geo_export_analysis`（真题分析＋命题蓝图，persona 路由中的「命题研究」）不属于三个 tab 的任何一个，随 `geo-analysis` 一起装配。本方案不改它的归属，只在 §7.1 说明它随讲题插件一起存在。

---

## 4. 官方契约依据

DSH 公开文档给出的四条与本方案直接相关的约定。

**① 预设内插件注册的技能落在该 preset 层。**
> "a plugin mounted by an agent preset's standing composition lands in that preset's layer"

与 `isolate: geoKernel` 想达到的私有性一致：技能不会外泄给其它 preset。

**② 两种注册形态，分别对应「内嵌」与「提供者」。**

- `ctx.skills.register(skill)`——包文档称为 *Embedded skills*：插件注册内存中的技能，注册表补上默认 `invocation` 与 `runtime` 提供者标签。
- `ctx.skills.registerProvider(create)`——注册一个提供者，`list()` 出候选、`get()` 按需加载正文。

**③ 已装箱的官方先例正好是本方案要的形态。** `@deepseek-ai/dsh-skill-badge` 的描述是：

> "registers one fixed candidate at the bundled skill rank (600) under the provider name `dsh-badge`, exposes its packaged `assets/` directory as the skill's directory resource base, and reads the skill body from the packaged `assets/dsh-badge.md` file on every load."

即：**插件自带技能文件 → 注册一个固定候选 → 把自带目录作为 `resourceBase` → 每次加载重读正文**。本方案可以直接照此实现，不必自创形态。

**④ 正文不缓存，目录缓存。** 
> "Definitions are never cached — every load asks the provider for the current body."

> "The registry has no TTL: only a provider calling its registration-scoped `invalidate()`, or a runtime registration or disposal, clears completed catalogs."

由此得出一条**必须一并承担的职责**：正文改动天然即时生效；但**目录级改动**（增删技能、改 `description`）需要提供者自己调用 `control.invalidate()`。文件系统提供者用 Chokidar 代劳了这件事，自带技能的插件没有。

---

## 5. 两条可分开的目标

| 目标 | 内容 | 代价 | 建议 |
| :-- | :-- | :-- | :-- |
| **A. 修课程方案缺口** | 让 `cn-high-school-geography-lesson-planning` 在预设内可加载 | 无（见 §6） | 先做，独立于本方案其余部分 |
| **B. 技能归属收归插件** | 三个功能的技能由各自插件注册 | §8.1 的断言重写 ＋ §8.2 的热更新损失 | 单独决策 |

两者互不依赖：A 不需要改任何插件，B 也不自动修好 A。

---

## 6. 目标 A：修课程方案缺口

三种修法，推荐第一种。

| 修法 | 做法 | 代价与后果 |
| :-- | :-- | :-- |
| **① 物理移入预设技能根（推荐）** | 把 `skills/cn-high-school-geography-lesson-planning/` 整体移入 `.agent-presets/geo-teacher/skills/` | 零配置改动——它落进已有的 rank 300 根；与 `harness-skills-应用方案.md` §三-B 把课程方案列为四类「教师运行 Skill」之一的原始意图一致；预设保持可移植 |
| ② 追加 `customSkillDirs` | 在预设 `skill-filesystem` 行的 `customSkillDirs` 数组追加一项，指向它现在的父目录 | 不动文件；但把**宿主绝对路径**写进预设包，非 `link:` 安装即失效，破坏可移植性 |
| ③ 新建技能插件 | 按 §7 建 `plugins/lesson-plan` | 只有与目标 B 一并做时才划算 |

修法 ① 的连带工作：`scripts/geo-verify.mjs` §8 按目录形态发现技能，移动后自动覆盖新技能，其 frontmatter 与两项预算随即进入检查；`geo-verify` §10 的 `deploy` 提示要求 link 目标含 `skills/`，仍然成立。文档侧需同步 `README.md` 的目录结构表（`skills\` 行）与「相关文档」区。仓库根 `skills/` 目录移动后若为空可直接删除。

---

## 7. 目标 B：技能随功能插件注册

### 7.1 目标形态

| 插件 | 归位后 |
| :-- | :-- |
| `plugins/analysis`（讲题） | 注册现有 4 个工具 ＋ 经 provider 注册 `geo-solver`、`geo-question-explainer`；`geo-question-explainer` 升为目录包，吸纳现根级 `skills/references/explainer-audiences.md` |
| `plugins/generator`（出题） | 注册 `geo_style_profile` ＋ 注册 `geo-question-generator`（含 4 份 `references/`） |
| `plugins/lesson-plan`（新增） | **只注册技能**；不注册工具、不 `provide` 服务 |
| `plugins/taxonomy`、`plugins/bank` | 不变：纯工具插件，不配技能（单步工具不配技能，见 §9） |
| `plugins/panel` | 不变：只交付界面，不消费 `geoKernel`、不注册工具 |
| 预设技能根 `skills/` ＋ `skill-filesystem` 行 | 可退场；若保留，定位收窄为"跨功能共享技能"落点 |

### 7.2 实现形态：照 `dsh-skill-badge` 的模式

每个功能插件注册一个固定候选的提供者：自带技能目录作为 `resourceBase`，`get()` 时读取该技能文件的正文。技能文件仍以 Markdown 存在插件目录内，frontmatter 的 `name`／`description`／`whenToUse` 成为候选字段，正文成为 `content`。

**不取 `ctx.skills.register`（内嵌式）**，理由是仓库既定纪律：插件在 `apply` 期不做 I/O（`plugins/panel/index.js` 头部明写「插件自身不做任何耗时 I/O，页面在请求时才读取」）。内嵌式要求在 `apply` 期就拿到正文；提供者式的文件读取发生在 `get()`，符合该纪律。若某技能正文改由代码内联，内嵌式才是更简的形态。

**必须承担 `invalidate()` 职责**（§4 第 ④ 条）：文件系统提供者的 Chokidar 会跟踪技能条目的增删与目录级改动，自带技能的插件没有这层。可接受的处理是接受"改 `description` 需重启"，若要保留热更新则提供者需自行监听文件并调用 `control.invalidate()`。

### 7.3 组合文件与包导出的连带改动

1. `package.json` 的 `exports` 增 `"./plugins/lesson-plan": "./plugins/lesson-plan/index.js"`（本地插件必须走包子路径导出：声明行 baseUrl 是 profile 目录，相对插件名会 `ERR_MODULE_NOT_FOUND`）。`geo-verify.mjs` 的 `exports` 断言会按 `cordis.patch.yml` 的行自动核对新增项。
2. `cordis.patch.yml` 的 `geo` group 增 `id: geo-lesson-plan` 一行。
3. 若技能根退场，`skill-filesystem` 行连同其 `!!js createRequire(...)` 表达式一并移除。该表达式是为绕开「baseUrl 是 profile 目录」而存在，技能改由插件自带后不再需要。
4. `exports-self`（`package.json` 必须导出 `./package.json`）的**存在理由消失**——它当前的唯一用途就是让 `createRequire` 定位本包（`scripts/geo-verify.mjs` L342-345）。
5. 三个功能插件若采用 `inject` 取服务，取硬依赖 `skills`；若用 `ctx.get('skills')`，须做 undefined 检查（宿主契约标注该访问为 optional）。

---

## 8. 目标 B 的成本与风险

### 8.1 `scripts/geo-verify.mjs` 断言重写清单

这是目标 B 的主要成本。漏改的后果不是报错而是**静默空转**——检查仍在跑，却不再检查技能。

| 位置 | 现行断言 | 为何受影响 | 处理方向 |
| :-- | :-- | :-- | :-- |
| L30 | `SKILLS_DIR = join(PRESET_SRC, 'skills')` | `geo-verify` §8 的唯一数据源 | 改为从插件注册的技能清单取数据 |
| L251-281 | `checkApply` 的 mock ctx（`fs`／`attachments`／`tools`／`webServer`／`geoKernel`／`get`／`provide`／`on`／`effect`） | **无 `skills` 成员**，`get()` 恒返回 `undefined`；插件一旦取 `ctx.skills` 即抛错，apply 冒烟由绿转红 | 补 `skills` 记录器（`register`／`registerProvider`），把技能名并入汇总输出 |
| L291-297 | 仅 `plugins/core` 获得 cfg | 新增插件若需配置，mock 不会传 | 为新增插件补 cfg 分支 |
| L342-345 | `exports-self`：要求导出 `./package.json`，理由写作"技能根解析依据" | 理由随 `createRequire` 表达式一起失效 | 随表达式退役，或改述为包子路径导出自检 |
| L346-347 | `skills-dir`：`skills/` 必须存在 | 技能根退场后该断言恒假 | 删除，或改判"技能清单非空" |
| L443-514 | `geo-verify` §8 `checkSkills()`：平铺／目录包发现、`skills-unique`、frontmatter 的 `name`／`description`、`skills-name-match`、`skills-desc-budget`（≤500 字符）、`skills-body-budget`（≤6000 码点） | 发现逻辑绑死目录形态 | **保留检查内容**，改数据来源；≤500 的出处是消费者配置 `catalogDescriptionMaxLength`（默认 500），仍应保留；`skills-unique` 重述为"同一技能名不得由两处注册" |
| L599 | `deploy` 提示要求 link 目标同时存在 `cordis.patch.yml` 与 `skills/` | 技能根退场后提示恒为"目标缺少…" | 改判 `cordis.patch.yml`（若保留技能根则并查） |
| L725 | 尾部提示"仅改 references 等支持文件不刷新技能目录" | 归属改变后语义需重述 | 重述为"技能目录由插件注册：改 `description` 或增删技能须重启；正文与 `references/` 从不缓存，改后下次加载即生效" |

不受影响：`geo-verify` §6 `isolate` 白名单（新插件不 `provide` 服务）、§7 路由静态扫描、§9 讲题纪律、§10 部署形态。仓库无硬编码的工具名或技能名清单，故工具归属调整不触发别的断言。

### 8.2 相对现状的净损失

1. **失去技能文件的热更新。** 现状见 `README.md`「改完何时生效」表：改技能文件「技能发现器监听入口，改后重新加载技能即可，无需例行重启」。改由插件自带后，目录级改动（增删技能、改 `description`）需重启；正文改动不受影响，正文从不缓存。这是把「技能文件」从文件系统资产变成「插件资产」的直接代价。
2. **生命周期绑定变紧**：停用出题插件会同时停掉出题技能。对讲题与出题这是预期行为；若将来课程方案需要跨 preset 复用，需重新考虑归属。
3. **技能来源标签由 `custom` 变为 `runtime`（内嵌式）或提供者名（提供者式）**，rank 也随之改变。现有三个技能名在整个可见目录里唯一，不触发同名遮蔽；改动只影响展示标签与同层排序。

### 8.3 未验证项

以下各项**必须在完整重启桌面后实测**，本方案不含运行时证据。

| 编号 | 项 | 为何未验证 | 验证方式 |
| :-- | :-- | :-- | :-- |
| U1 | 提供者式注册的正文与 `resourceBase` 目录能解析 `references/` 相对链接 | 官方先例（`dsh-skill-badge`）证明该形态可行，但本 preset 的分层（`geo` group ＋ `isolate`）未实测 | 注册后召唤技能，确认正文与 `references/` 均可读 |
| U2 | `geo` group 内 `ctx.skills` 可用性 | `isolate` 白名单只声明 `geoKernel`，`skills` 理论上 inherit（同 `tools`／`fs` 已在组内可用） | 重启后冒烟：技能目录出现三项 |
| U3 | 换代（recompose）不产生重复条目 | 契约称同层同名首胜＋警告＋no-op disposer | 切换到其它预设再切回，确认无重复、无警告 |
| U4 | `invalidate()` 的实际效果 | 提供者主动失效是本方案的职责缺口（§8.2-1） | 改一次 `description`，确认目录是否刷新；不刷新即确认需重启 |

**已解除**：原先怀疑"课程方案技能会与仓库根 `skills/` 形成两份候选"。§3.2 的官方优先级表表明仓库根 `skills/` 不是任何一个发现根，`bundledSkillDir` 也未配置，故不存在双份候选；修法 ① 移动文件后更不可能。

---

## 9. 不采用的做法

| 做法 | 不采用的理由 |
| :-- | :-- |
| 把工具合并成大工具 | 插件是装配单位、工具是模型可见契约单位。单步工具不配技能是既定原则（`docs/harness-skills-应用方案.md` §三-B 与 §十「明确不做」）；合并会破坏渐进披露 |
| 拆成三个独立 npm 包 | 单部署、profile 用 `link:` 直连仓库（`docs/决策记录.md` 2026-09-27 行）。拆包只增加版本与安装成本，不带来收益 |
| 技能正文内联进 JS 字符串 | 失去按文件编辑／评审、`references/` 目录与正文预算检查 |
| 用技能取代工具，或反之 | 模型可见性不同：工具是每请求完整 schema，技能是目录＋按需正文。讲题的 `solve→judge→explain` 顺序纪律靠技能承载，取题与发图能力靠工具承载，二者不可互替 |
| 把课程方案做成带工具的插件 | 该功能当前无机器可调能力。为凑齐"一功能一插件"而造工具，属于无消费者的抽象 |

---

## 10. 实施顺序与验收标准

### 实施顺序

1. **先补术语表**：`功能插件` 一词已见于 `cordis.patch.yml:110` 注释但未入 `docs/术语表.md` §七；按写作规范「新增术语须先在术语表追加，再在产出中使用」，实施时先补该词与"技能归属"。
2. **目标 A**：按 §6 修法 ① 移动课程方案技能，跑 `npm run verify:geo -- --source` 确认其 frontmatter 进入检查。
3. **目标 B（若采纳）**：先改 `scripts/geo-verify.mjs`——补 mock `skills` 记录器，按 §8.1 改述断言，让检查先能表达新形态；再逐个功能迁移归属，一次一个插件（`geo-analysis` → `geo-generator`）。
4. 清理 `skill-filesystem` 行与 `exports-self`，按 §8.1 收尾。
5. 完整重启桌面，跑 `npm run verify:geo -- --runtime`，覆盖 §8.3 的 U1–U4。

### 验收标准

1. `npm run verify:geo -- --source` 退出码 0，且技能相关断言在新数据源下**仍能失败**（用一个故意的坏 frontmatter 反证，确认未空转）。
2. 重启后技能目录含 `geo-solver`、`geo-question-explainer`、`geo-question-generator`、`cn-high-school-geography-lesson-planning` 四项，各一份。
3. 三项技能的 `references/` 均可读（U1）。
4. 讲题与出题的既有回归（`npm run test:explainer`、`npm run test:native-images`）通过。
5. 停用 `geo-generator` 后，出题工具与出题技能同时从目录消失，其余功能不受影响。
6. `geo-verify` 中不再有以 `skills/` 目录为唯一数据源的断言。

---

## 11. 官方依据

| 文档 | 用途 |
| :-- | :-- |
| [docs/subsystems/skills.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/skills.md) | 发现优先级表、分层、`SkillProvider`／`SkillRegistration`／`resourceBase`／`SkillSource` 的权威定义、Chokidar 行为、消费者 `catalogDescriptionMaxLength` 默认 500 |
| [packages/skill/skill/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill/README.md) | registry 合并／缓存／失效语义；"Definitions are never cached"；"no TTL" |
| [packages/skill/skill-badge/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-badge/README.md) | 插件自带技能、固定候选、目录型 `resourceBase`、每次加载重读正文的官方先例 |

---

## 12. 与其他文档的关系

- 本方案**不改**工作台三个 tab 的功能与文案；`plugins/panel` 的入口不变。
- 本方案**不改**讲题流水线的纪律（`solve→judge→explain`）、工具契约与原生图片交付。
- 本方案与 `docs/geo-teacher-原生UI插件方案.md` 是**两条正交的路线**：那份评估客户端 UI 形态，本份评估宿主侧装配与技能归属，可各自独立实施。
- 本方案若采纳，需在 `docs/术语表.md` §七补入术语，并在 `docs/决策记录.md` 追加决策行。
