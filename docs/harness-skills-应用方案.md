# DSH 仓库 Skills 应用方案（deepseek-harness-skills-master）

> 版本：v4.0　日期：2026-08-19　状态：方法论当前有效；验证入口与部署说明已对齐预设包形态，具体检查项以脚本和开发检查技能为准
> 更新说明（2026-09-27，M0）：`geo-verify.mjs` 现按声明行形态（`.agent-presets/geo-teacher/cordis.patch.yml`）校验，**不再读 `agent.cordis.yml`，不再要求 C: 运行时副本**；检查项由"双副本一致性 / YAML 结构(agent.cordis.yml)"改为"预设包导出 / bundle patch 声明 / 声明行完整性 / 插件行 name / isolate / 路由 / 技能入口唯一性 / 讲题回归"。详见 `docs/geography-question-generation-m0-baseline.md`
> 说明：dsh-code-review 已独立适配为 `.agents/skills/geo-code-review/SKILL.md`（语义代码审查）。开发维护 Skill 现为三个，职责分离、互不替代：`geo-dev-checklist`（确定性验证）、`geo-code-review`（语义审查）、`geo-doc-writing`（写作规范）。
> 来源：`E:\geo_edu_agent\deepseek-harness-skills-master`（从 deepseek-harness GitHub 仓库 `.agents/skills` 下载，共 11 个 skill 包）
> 配套：`README.md`、`使用指南.md`、`讲题功能设计.md`、`讲题评测方案.md`、`讲题工作流修复方案.md`

## 〇、来源与合规信息

| 项 | 值 |
| :-- | :-- |
| 上游仓库 | https://github.com/deepseek-ai/deepseek-harness （`.agents/skills` 目录） |
| 参考上游 commit SHA | `47f943859bef60e4160492346772ded9b24f765a`（下载时检索到的 master 参考 commit；本地 zip 不含 .git，无法本地确证，实施前可重新核对上游 HEAD） |
| 下载包聚合 SHA-256 | `b1c7d5a68e92380a57d6c94e72303f3aea9f1da7bf81fe5e6e1d76880f66706f`（按"相对路径\|逐文件SHA-256"排序拼接后计算；21 个文件；逐文件哈希见本方案附录） |
| 许可证 | MIT License（Copyright (c) 2026 DeepSeek；与 dsh 包 LICENSE 一致）。本项目对 skill 仅做"提炼方法论 → 重写适配版"，重写内容归本项目；引用上游方法论时保留署名与 MIT 许可说明 |
| 使用边界 | 不直接拷贝任何原 SKILL.md 进项目（引用不存在路径/脚本会导致 Agent 幻觉）；只提炼方法论并重写 |

## 一、总体结论

这 11 个 skill **全部是 DSH 仓库自身的"开发维护"技能（dogfooding），没有一个是地理业务技能**；它们的方法论与部分流程对本项目有真实借鉴价值。

**关键原则**：
1. **能程序化的检查一律程序化**（确定性检查程序），不依赖 Agent 阅读清单后手工执行。
2. **开发维护类 Skill 放 `.agents/skills/<skill-name>/SKILL.md`**（项目根目录，与 DSH 仓库结构一致），**不进** geo-teacher 教师预设、**不写成**普通 `skills/*.md`。
3. **教师端规范嵌入教师技能本身**，不另设教师写作规范技能；术语以 `docs/术语表.md` 为唯一权威。
4. **不是每个工具都要技能化**：只有需要**稳定多步骤工作流**的工具才配套 Skill；单步工具（如 `geo_taxonomy`、`geo_search_questions`）不配技能。

## 二、11 个 Skill 总览与四类归类

| Skill | 用途（一句话） | 归类 | 本项目去向 |
| :-- | :-- | :-- | :-- |
| `dsh-pre-push-checks` | 推送前选最小验证集 | 确定性检查程序（思想） | **做 `scripts/geo-verify.mjs` 检查程序** |
| `dsh-code-review` | 审查仓库改动（生命周期/所有权/模型可见输出） | 项目开发维护 | **独立适配为 `.agents/skills/geo-code-review/SKILL.md`（语义代码审查）** |
| `dsh-find-simplifications` | 找死代码/重复/过度设计 | 项目开发维护 | 一次性简化审计 |
| `dsh-archive-agent-notes` | 决策记录生命周期管理 | 项目开发维护（轻量借鉴） | **轻量决策记录**（单文件，见 §六） |
| `dsh-prose-standard` | 散文写作标准（契约完整、删废话） | 规范与术语 | **开发写作规范**（供开发 Agent）+ 命题完整性思想 |
| `dsh-trim-cot-leakage` | 修剪"过程性元话语/作者痕迹"散文 | 规范与术语 | 并入开发写作规范 + 讲题稿评测检测 |
| `dsh-translate-docs` | 双语文档翻译（术语表） | 规范与术语 | **只借鉴术语表 → 共享术语表** |
| `dsh-doc-standards` | 文档层级/预算/slop 清理 | 规范与术语 | 开发写作规范（思想） |
| `record-browser-gif` | 录制 Web UI 演示 GIF | — | **人工录制**（不建自动录制 Skill，不在本方案实施范围） |
| `dsh-doc-site-sync` | 同步 VitePress 文档网站 | — | 不用 |
| `dsh-merging-stacked-prs` | GitHub stacked-PR 合并 | — | 不用 |

## 三、四类落地框架

### A. 项目开发维护（开发 Skill，放 `.agents/skills/`）

面向"开发/维护本项目"的 Agent，**不进 geo-teacher 教师预设**；目录结构对齐 DSH 仓库：

```
E:\geo_edu_agent\.agents\skills\
  geo-dev-checklist\SKILL.md          # 确定性验证（verify:geo + 提交前/重启后检查）
  geo-code-review\SKILL.md            # 语义代码审查（判断代码与设计是否正确）
  geo-doc-writing\SKILL.md            # 开发写作规范（含过程性元话语/作者痕迹检测）
```

| Skill | 内容 |
| :-- | :-- |
| `geo-dev-checklist` | ① 何时运行 `npm run verify:geo`（含各参数模式）；② 程序无法覆盖的人工判断项（简化候选核验、重启沟通、重启后冒烟）；③ 语义代码审查指向 `geo-code-review`（不重复审查条目） |
| `geo-code-review` | 语义代码审查：判断代码与设计是否正确（DSH 生命周期与服务边界 / 工具与模型可见契约 / 讲题流水线纪律 / 数据缓存新鲜度 / 安全文件边界 / 测试真实入口 / 文档一致性），findings-first 报告，默认不改代码 |
| `geo-doc-writing` | 供**开发 Agent** 使用的写作规范：契约完整（proposition-preservation）、删废话、无过程性元话语/作者痕迹、术语引用 `docs/术语表.md`；**教师端不引用本 Skill** |

### B. 教师业务运行（教师运行 Skill）

面向教师的业务技能。**教师端所需的术语与写作规则分别嵌入各教师技能本身**（不设教师写作规范技能），共同以 `docs/术语表.md` 为权威来源：

| 教师技能 | 内嵌的规范 |
| :-- | :-- |
| `geo-question-generator` | 出题术语/六大章节/四态完成度/自检（嵌"命题完整性"项） |
| `geo-solver` | 解题术语/轨迹书写规范 |
| `geo-question-explainer` | 讲题稿规范（含"过程性元话语与作者痕迹检测"项） |
| `cn-high-school-geography-lesson-planning` | 课程方案术语/写作规范 |
| 未来工具（`geo_judge` 等） | 仅在需要稳定多步骤工作流时才配套 Skill |

**工具 ≠ 技能**：单步工具（`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_style_profile` 等）**不配 Skill**；只有需要稳定多步骤工作流的工具（出题、解题、讲题、课程方案）才配套。

### C. 确定性检查程序（脚本，非技能）

**原则：语法、哈希、导入、服务注册等确定性检查做成可执行脚本一键运行，不依赖 Agent 手工。**

**`scripts/geo-verify.mjs`（已实现）**：

```
项目根 package.json:
  "scripts": { "verify:geo": "node scripts/geo-verify.mjs" }
  "dependencies": { "yaml": "^2.x" }   # 固定 YAML 解析依赖
```

**现行验证入口**：`scripts/geo-verify.mjs`；使用方式见 [开发检查技能](../.agents/skills/geo-dev-checklist/SKILL.md)。具体检查项和退出语义以脚本为准，不在此维护第二份清单。

当前检查覆盖预设包导出、`cordis.patch.yml` 声明行、插件语法与加载、服务隔离、路由、技能入口、讲题纪律和原生图片交付。本机采用 profile 依赖 + link，不做双副本哈希同步；运行时验收须在插件或组合修改并完整重启后执行。静态检查不能证明运行进程已加载新代码。

### D. 规范与术语（共享规范）

| 项 | 内容 | 形态 |
| :-- | :-- | :-- |
| **共享术语表** | 统一"考点/知识点""素养/素养立意""设问/题干"等术语；**权威来源**，所有教师技能、开发技能、面板文案、文档、工具 description 一律引用，不各自定义 | `docs/术语表.md`（唯一权威） |
| **教师端写作规则** | 直接**嵌入各教师 Skill**（§三-B），不另设教师写作规范技能 | 各教师 SKILL.md 内节 |
| **开发写作规范** | 契约完整、删废话、无过程性元话语/作者痕迹 | `.agents/skills/geo-doc-writing/SKILL.md` |

## 四、开发侧要点

### 确定性检查程序化
`geo-verify.mjs` 覆盖可确定检查的加载、隔离、路由、题面解析与讲题纪律；运行时冒烟和教师内容评测仍须分别执行，不能以静态通过代替。

### 人工判断保留在开发 Skill
- 代码简化审计（消费者证据：先证明无生产调用者再删）→ `geo-dev-checklist` 或一次性审计 TODO。
- code-review 维度（生命周期/所有权/真实入口/模型可见输出/流水线纪律）→ 独立语义审查 Skill `geo-code-review`（不并入 checklist）。
- 重启沟通：脚本提示 + 开发 Skill 说明。

### 轻量决策记录（见 §六）

## 五、评测侧要点

### 讲题稿评测：改名"过程性元话语与作者痕迹检测"
**不再使用"CoT 泄漏"称谓**（避免误伤可教学推理）。规则：
- **保留**：审题（设问拆解）、证据（材料引用）、原理（知识选择）、因果链（推理步骤）、干扰项排除（为什么不是另一个答案）等**可教学推理**——这些是讲题稿的核心价值。
- **删除**：模型自述（"我这样想""我推测"）、版本痕迹（"v2 修订""之前"）、评审痕迹（"评审指出""reviewer 确认"）、以及对解析的机械复述（照抄解析原文）。
- 检测项融入 P4 评测"推理层"指标：讲题稿出现上述删除类内容 → 判定不合格。

### proposition-preservation 的边界（必须写明）
proposition-preservation（来自 prose-standard）**只能检查"编辑时是否遗漏了原关键命题"**，用于**编辑/改写**场景（如修订讲题稿、压缩文档时不得丢事实）。它**不能证明**：
- 答案是否正确；
- 答案与解析是否一致；
- 地理事实是否准确。
以上三项仍需**领域 Rubric**（出题/解题/讲题的学科标准）人工验证。评测时二者分开：形式完整性用 proposition-preservation，正确性用领域 Rubric。

## 六、轻量决策记录

**不做** dsh-archive-agent-notes 的完整生命周期（proposed/implemented/rejected + 归档目录 + 校验脚本），改为**单文件轻量记录**：

- 位置：`docs/决策记录.md`
- 格式：表格（日期 / 决策 / 原因与证据 / 关联文件 / 状态）
- 规则：每次形成重要结论追加一行；状态只有 `有效 / 已废弃`；不设归档、不设校验。
- 目的：避免重复踩坑、便于接手；够用即可。

## 七、面板演示（人工录制，不在本方案范围）

- **不建设自动录制 Skill**（record-browser-gif 不实施）。
- 面板演示（如使用指南配图/动图）由**开发者人工录制**（系统自带录屏/浏览器工具），产出物放 `outputs/demos/`。
- **明确：面板演示不属于本方案实施范围**，仅作为项目未来可选交付物。

## 八、落地方案（实施优先级）

| 优先级 | 做什么 | 形态 |
| :-- | :-- | :-- |
| **P0** | `scripts/geo-verify.mjs` + 项目根 `package.json`（yaml 依赖、`npm run verify:geo`、参数/退出码） | 脚本 + package.json |
| **P0** | `docs/术语表.md` 共享术语表（权威 + 教师技能引用） | 文档 + 各技能引用 |
| **P1** | `.agents/skills/geo-dev-checklist/SKILL.md`（确定性验证：verify:geo + 提交前/重启后检查） | 开发 Skill |
| **P1** | `.agents/skills/geo-code-review/SKILL.md`（语义代码审查，独立适配 dsh-code-review） | 开发 Skill |
| **P1** | `.agents/skills/geo-doc-writing/SKILL.md`（开发写作规范） | 开发 Skill |
| **P1** | 教师技能内嵌规范：出题/解题/讲题/课程方案各自嵌术语 + 写作规则；讲题稿评测改名并入 `docs/讲题评测方案.md` | 各教师 SKILL.md + 评测文档 |
| **P2** | 代码简化审计（sendJson/parseQuery 重复等）→ TODO 清单 | 一次性审计 |
| **P2** | `docs/决策记录.md` 轻量决策记录 | 单文件 |
| **不做** | 自动录制 GIF Skill、dsh-doc-site-sync、dsh-merging-stacked-prs | — |

## 九、验收标准

1. `npm run verify:geo -- --source` 全绿退出码 0；`--json` 输出合法 JSON；`--runtime` 在重启 DSH 后核心端点（`/geo/core/health`、`/geo-teacher`）与 geo_* 工具冒烟通过。
2. 运行时路径由环境计算（`DSH_HOME`/`DSH_WEB_URL`），源码不含写死的用户名。
3. `.agents/skills/geo-dev-checklist/`、`.agents/skills/geo-code-review/`、`.agents/skills/geo-doc-writing/` 存在且 frontmatter 齐全；**不在** geo-teacher 教师预设内、**不在** 普通 `skills/*.md`。
4. `geo-code-review` 触发边界明确：description 能准确触发 "review / 代码审查 / 审查改动 / 检查 diff / 找回归风险" 类请求，且不抢占普通实现任务；与 `geo-dev-checklist`（确定性验证）、`geo-doc-writing`（写作规范）职责分工清晰，`npm run verify:geo` 全绿不替代语义审查。
5. `docs/术语表.md` 建立，且出题/解题/讲题/课程方案四个教师 SKILL.md 均引用它；各教师技能内已嵌入对应术语与写作规则。
6. 讲题稿评测项以"过程性元话语与作者痕迹检测"命名，保留可教学推理清单、删除类清单明确；评测方案同时声明 proposition-preservation 边界（不能证明正确性，需领域 Rubric）。
7. `docs/决策记录.md` 存在并记录 ≥1 条既有决策（如双副本、isolate 白名单、standing 换代）。
8. 方案文档（本文件）与 README 登记一致。

## 十、明确不做

- 不直接拷贝任何原 SKILL.md 进项目（引用不存在路径/脚本导致幻觉）。
- 不做文档网站（VitePress）、不做 stacked-PR 流程、不做中英双语配对（仅保留术语表思想）。
- 不建设自动录制 GIF Skill（面板演示由人工录制，不在本方案范围）。
- 不为单步工具配 Skill（仅稳定多步骤工作流配）。

## 附录：下载包逐文件 SHA-256

（21 个文件；聚合 SHA-256 `b1c7d5a68e92380a57d6c94e72303f3aea9f1da7bf81fe5e6e1d76880f66706f`）

| 相对路径 | SHA-256 |
| :-- | :-- |
| dsh-archive-agent-notes\agents\openai.yaml | 6EE8722EA1BA67AA95094C60D4F880B9FB6B517642DF336FEECF3B1B7541A171 |
| dsh-archive-agent-notes\SKILL.md | 5500E960A645BE6F842FC8506817C3EF4132182EDD79804FC5595F68FDDBA314 |
| dsh-code-review\SKILL.md | 59DF05CE442F5F57B46C8CDD5F038E53C28F0AE0DAA5A915233646F357F83EF4 |
| dsh-doc-site-sync\agents\openai.yaml | 48B93DC9E9D55441DB63D8D7BC3AE6181CCCD532FC62A52A0BEB591D105821A8 |
| dsh-doc-site-sync\SKILL.md | D2FA857EFA06D9CFE1F158461523D92CD0318FA3E0B04780B492983C3CE4BB94 |
| dsh-doc-standards\SKILL.md | 8A648B26F28A8FB2B37F9692F36049E71C8407F9480DCBE0EF23D279C9E7827B |
| dsh-find-simplifications\SKILL.md | C6F0165F6AA36AF51EF46B3E0111C6C936D7498452CFFCFD805CC81CC336FB4B |
| dsh-merging-stacked-prs\SKILL.md | 1C3164317782BCA7C9BFDEB85C6212F75EB185A209DE4BBFE03DC53284457164 |
| dsh-pre-push-checks\agents\openai.yaml | D5AEB533BF2F620C08FF45BCBC501C18FE3083153CAA03043D6AB5A2EB955182 |
| dsh-pre-push-checks\SKILL.md | 8D2120972D88BA814B5F7CE2B30C71F0F99A8A22D64D58E8188A1DE72B7357BE |
| dsh-prose-standard\agents\openai.yaml | 2B138EE159D955A8D4372DABF00EC2B98364E52466F24585354F7991DE963A40 |
| dsh-prose-standard\references\examples.md | 7A83C6AC39FB2F6D38811584AA854159EB1A6CECE14AFBEBE729D128772F6BE0 |
| dsh-prose-standard\SKILL.md | 60FB954529BF5388D8ACF0DE99036C9C3299EB659221B355FD07988F6313915C |
| dsh-translate-docs\agents\openai.yaml | 010D3F9E9377FED59A618ACE739FCC38EE2CFDF2B648FA029AC36C236BB76DAB |
| dsh-translate-docs\SKILL.md | B282A210569D50BAD95D4637062BC9EE11AA27802D54594EA8454C726DB2660B |
| dsh-trim-cot-leakage\references\examples.md | 1ABB8155EC1EF7728A885A6C6422BC5C449DF7F66D6D08399ADE106301CE99CF |
| dsh-trim-cot-leakage\references\recall-batteries.md | 05F955A01C8D44E6EA5645E700B17DBB11DA30B6B1F4D406E070C7E1C383395F |
| dsh-trim-cot-leakage\SKILL.md | E46F456241D918649AB724E622DC256D9990732D17B765FE92C448C414604FC8 |
| record-browser-gif\agents\openai.yaml | F9777DAF2D6354766951776E011751FFBBB168BA4E8E7E4E33342055B8CDB3BC |
| record-browser-gif\scripts\encode_gif.py | 53F618548F4BF694EC8154331D0D60EAC5AC83EC376035574580F2F782C1A8E4 |
| record-browser-gif\SKILL.md | D0FD6FCA1EF8C4F9A0045D7A90517354C6A3879CCCF4542E49BDF9EACBB9C674 |
