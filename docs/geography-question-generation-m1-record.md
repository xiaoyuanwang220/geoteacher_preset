# 出题功能 M1 实施记录（数据与最小技能）

> 记录日期：2026-09-27
> 对应阶段：M1「数据与最小技能」（见 [执行方案](geography-question-generation-execution-plan.md) §9）
> M1 完成标准：**数据样例可表达完整初稿；旧 taxonomy 消费者正常；只出现一个技能入口**
> 前置：M0 已结（见 [M0 基线与可用性记录](geography-question-generation-m0-baseline.md)）

---

## 1. 交付物

| # | 文件 | 内容 |
| :-- | :-- | :-- |
| 1 | `plugins/question/package.schema.json` | **命题包数据契约**（JSON Schema 2020-12）：唯一编辑源字段、枚举、`additionalProperties:false`、`stage/readiness` 条件约束、`$defs.fourWings`/`$defs.distractor` |
| 2 | `docs/examples/question-package.sample.json` | **完整初稿样例**：3 个构思、3 道小题、3 名模拟学生、来源、视觉提案、确认、评审、风险 |
| 3 | `docs/examples/README.md` | 样例说明与「这是样例不是交付物」声明 |
| 4 | `skills/geo-question-generator/SKILL.md` | **薄路由**（目录包形态）：边界、两种用途、两个确认点、真源与写权限、质量红线、完成条件、资源路由 |
| 5 | `skills/geo-question-generator/references/workflow.md` | 阶段、确认、回退、跨会话恢复（94 行） |
| 6 | `skills/geo-question-generator/references/evidence-policy.md` | 课标/教材、热点/论文、来源范围与降级（109 行） |
| 7 | `skills/geo-question-generator/references/item-writing.md` | 构思比较、题组、干扰项与学情对应（113 行） |
| 8 | `skills/geo-question-generator/references/delivery-format.md` | 六大章节、投影边界、图表提案、题包字段（115 行） |
| 9 | `plugins/core/index.js` | taxonomy 解析集中化：`meta` + 节点（含 `includes`/`excludes`/`aliases`）、`needs_review` 归一化为布尔、逐文件 `sources[{file,version,status,contentHash,readAt,parser}]`、失败与无匹配分开；新增 `getTaxonomy()` |
| 10 | `plugins/taxonomy/index.js` | `geo_taxonomy` 新增可选 `query`/`ids`/`limit`（无参数仍返回 `status`+`roots`）；新增 `/geo/taxonomy/meta`、`/geo/taxonomy/query` |
| 11 | `package.json`（预设包） | 声明 `dependencies.yaml` |
| 12 | `docs/术语表.md` | 补齐/修订：小题 vs 小问、旧五段式与六大章节、认知障碍、四翼、命题包、学生/教师投影、readiness 四态、出题任务包 |
| 13 | `docs/geography-question-generation-m0-baseline.md` | 修正两处事实缺陷（见 §5） |

**未改**：`plugins/{bank,analysis,generator,ui}`、`cordis.patch.yml`、`geo-solver.md`/`geo-question-explainer.md`、讲题三工具。

---

## 2. 完成标准对照

| 标准 | 状态 | 依据 |
| :-- | :-- | :-- |
| 数据样例可表达完整初稿 | ✅ | `stage=draft_ready`、`readiness=draft_complete` 的样例含全部必填字段与 3 道小题；含 `confirmations`/`reviews`/`risks`，可完整表达"初稿完成但不可宣称可使用" |
| 旧 taxonomy 消费者正常 | ⏳ **部分验证** | `/geo/core/health` 与 `/geo/taxonomy/tree` 均正常（2026-09-27 探测）；但 `getTaxonomy()` 新接口尚未加载（新路由 404），须重启后确认，见 §3.3 |
| 只出现一个技能入口 | ✅ **已达成** | 平铺入口已删除；`skills-unique` 通过（平铺 2 个 / 目录包 1 个，无同名） |

---

## 3. 待执行命令

### 3.1 删除平铺技能入口 —— ✅ 已执行（2026-09-27）

已由本地执行完成。说明：本会话工具集无删除能力；此前 `pwsh` 失败的**真实原因不是 pwsh 坏了，而是沙箱运行器不可用**（`windows-acl-run: --temp is not an existing directory: …\dsh-iSnyUu`）。改用 `danger-full-access` 单次授权后命令成功：

```powershell
Remove-Item 'E:\geo_edu_agent\.agent-presets\geo-teacher\skills\geo-question-generator.md' -Force
```

结果：`Test-Path` → `False`；`skills\` 目录现为 `geo-question-generator\`（目录包）、`geo-question-explainer.md`、`geo-solver.md`。

### 3.2 可选：在预设包内安装 YAML 依赖

```powershell
$pnpm = 'C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$node = 'C:\Users\<user>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node $pnpm add yaml --dir 'E:\geo_edu_agent\.agent-presets\geo-teacher'
```

装与不装都能工作：装了走真实 YAML 解析（`parser: "yaml"`），不装走扩展行解析（`parser: "legacy"`），接口里如实标注。**详见 §4 决定 1。**

### 3.3 验证

**源码检查已执行（2026-09-27）：退出码 0 —— 0 项失败 / 4 项提示 / 27 项通过。**

| 关键结果 | 值 |
| :-- | :-- |
| `skills-unique` | ✅ 平铺 2 个 / 目录包 1 个，无同名 |
| `skills-fm` | ✅ 3 个技能入口，`name`/`description` 齐备 |
| `retired-form` | ✅ 预设包内无 `agent.cordis.yml` / `preset.yml` |
| 导出 / 隔离 / patch 声明 | ✅ 6 个包子路径引用均有导出；1 个服务在 isolate 内；声明行 `id=geo-teacher`、36 个插件行 |
| 插件语法 / ESM 导入 / apply 冒烟 | ✅ 6 个插件；注册 9 个工具、提供 1 个服务（**同时验证 M1 的 core/taxonomy 改动不破坏加载**） |
| 4 项提示 | 均为预期：`!!js` 静态边界、`fetch: true`、`profile desktop` link 形态、`.backups` |
| `skills-body-budget` | **未出现**——技能拆为目录包后根正文已在 6000 码点预算内（M0 时该项为提示） |

**运行时探测（同日，未重启）：**

| 端点 | 结果 | 说明 |
| :-- | :-- | :-- |
| `/geo/core/health` | ✅ `status: success`；taxonomy 4 文件 / 162 节点；题库 104 文件 / 255 题 | 进程正常 |
| `/geo/taxonomy/tree` | ✅ HTTP 200（36 KB） | 旧路由未回归 |
| **`/geo/taxonomy/meta`** | ❌ **404** | M1 新增路由**尚未加载** |
| **`/geo/taxonomy/query?ids=…`** | ❌ **404** | M1 新增查询**尚未加载** |

**结论：M1-f 的考点树扩展需要完整重启桌面后才生效**（插件改动不随文件保存生效）。重启后请执行：

```powershell
cd E:\geo_edu_agent
node scripts\geo-verify.mjs --runtime     # 完整重启桌面后
```

重启后在一个 geo-teacher 会话里验证点：

1. 技能目录只含一个 `geo-question-generator` 条目；
2. `geo_taxonomy({})` 仍返回 `status` + `roots`（旧行为未回归）；
3. `geo_taxonomy({ "query": "热力环流" })` 返回 `matchKind`、`matches[]`（含 `includes`/`excludes`/`needs_review`）与 `meta.taxonomyVersions`；
4. `geo_taxonomy({ "ids": ["KU-NAT-ATM-HEAT-005"] })` 返回 `matchKind: "exact"`；
5. `GET /geo/taxonomy/meta` 返回逐文件 `sources`；
6. 故意把 `knowledgeBasePath` 指向不存在目录时，`geo_taxonomy` 返回 `status: "error"`、`matchKind: "unavailable"`，**而不是** `status: "success"` + 空树。

---

## 4. 需要你复核的三个设计决定

### 决定 1：taxonomy 解析采用"优先真实解析器 + 显式降级"

方案 §5.2 要求"选用预设自身声明的 YAML 解析依赖……不增加 Python 兜底解析器"。实施为：

- 预设包 `package.json` 已声明 `dependencies.yaml`；
- core 内 `import('yaml')` **动态加载**，成功则用真实解析器；
- 失败（未安装）时降级为**扩展后的原行解析**（非新写一套），并在接口 `parser` 字段与 `sources[].parser` 中标注 `legacy`。

**理由**：本会话无法安装依赖、无法重启验证。若做成硬依赖，未安装时 `geo_taxonomy` 会直接抛错，直接违反 M1 的另一条完成标准"旧 taxonomy 消费者正常"。
**取舍**：降级路径只覆盖当前四份真实源文件的实际形态（meta 缩进 2 / 节点 2 / 字段 4 / 列表项 6），对格式漂移不鲁棒——这正是 §3.2 建议安装 `yaml` 的原因。若你要求硬依赖，删掉降级分支即可。

### 决定 2：`getTaxonomyTree()` 保留旧的失败语义

方案 §5.2 要求"读取/解析失败与真正无匹配分开返回，不继续把异常吞成空树后返回 success"。

- **新接口 `getTaxonomy()`**：完全满足——`status` 取 `success`/`partial`/`error`，`matchKind` 取 `tree`/`exact`/`candidates`/`partial`/`none`/`unavailable`；工具与 `/meta`、`/query` 都走它。
- **旧访问器 `getTaxonomyTree()`**：保留失败返回 `[]`，因为它被 `/geo/taxonomy/tree`、静态面板与 `health` 消费，改语义会让这些既有消费者在 taxonomy 不可读时从"空树"变成 500。

即：**错误在新路径显式暴露，旧路径为兼容保持不变**。若你希望旧路由也改为显式失败，需要同时改面板与 health 的错误处理。

### 决定 3：`confirmations` 不设 `approved` 布尔字段

方案 §6.2、§7.1 G3 反复说"仅保存 `approved=true` 不足以支持恢复"。schema 的 `confirmations[]` **没有** `approved` 字段，只要求 `confirmationId`/`type`/`objectId`/`objectRevision`/`teacherUtterance`/`at`。

这不是冲突，而是**实现**了该规则：布尔批准根本无法表达，所以不存在"只有布尔"的合法记录。子代理把它报为矛盾，此处记录判定结论。

---

## 5. 顺带修正的 M0 记录缺陷

| 位置 | 原问题 | 修正 |
| :-- | :-- | :-- |
| M0 §2.1 | 引用"PRD §7.5 的来源分级要求"——**该节不存在**（PRD 第 7 节只到 §7.4） | 改为**技术设计 §7.5**（来源优先级表），并留修正注记 |
| M0 §2.2 | "不应出现 `full_text`，除非……来源站恰好提供可读 HTML **摘要**页"——摘要页对应 `abstract` 而非 `full_text`，自相矛盾 | 改为：摘要页记 `abstract`，`full_text` 仅限教师提供的全文；并明确"论文类落地页通常只能到 `metadata`/`abstract`" |

---

## 6. 未执行的验证与剩余对齐项

### 6.1 未执行

- 本记录 §3.3 已记载 2026-09-27 源码检查通过；该结果不等于重启后运行时通过。本节待验证项为下面的桌面与语义验收，本次文档整理未重新运行测试；
- 重启后 `geo_taxonomy` 新参数的端到端验证；
- **4 份 references 的语义评审**。已做的只有禁用模式静态扫描：`五段式` **零命中**；`综合题`、`正确率`、`难度系数`、`区分度`、`直读` 全部**仅以禁令形式**出现；`geo_question_validate`/`geo_literature_search` 未落成工具名。

### 6.2 文档对齐状态（2026-09-28）

- 技术设计已对齐 DSH 运行目标、现行数据源、目录包技能、单一 Node 校验边界、schema 状态与最小产物布局；外部 WorkBuddy 风格档案仍仅为可选输入。
- PRD 已区分六个顶层章节与十二项内容要求，并明确必要图表缺失时不能标为可使用。
- 执行方案已更新 `fetch: true`、M0/M1 进度和四态完成度；十二项映射统一引用 delivery-format，不复制第二份映射表。
- 这些为文档对齐，不代表桌面加载、校验器或完整题组交付已验收。

### 6.3 上游未定（references 内已标"上游未定，遇此情形须询问教师"）

- `input_normalized → concepts_proposed` 无教师确认点，与"阶段跳转由教师自然语言确认触发"冲突；
- 无图题组是否必须经过 `visuals_approved`（schema 有该 stage，而 §7.1 说无图不被 G5 永久阻塞）。
