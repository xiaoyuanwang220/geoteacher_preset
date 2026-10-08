# 交付格式：六大章节、模拟作答、设计依据及题包字段

> **何时读这份文件**：①确定 `draft.md`、`student.json`、`teacher.json`、`validation.json` 的落盘结构时；②判断一条内容应归入哪个固定章节时；③撰写或审查图表提案 `visuals[]` 时；④声明完成状态 `readiness`、或向教师解释 G0—G6 某门为何是 `pending`/`not_applicable` 时。字段名与枚举以 `plugins/question/package.schema.json`（schemaVersion 2）为准；术语以 `docs/术语表.md` 为唯一权威，正文不另造定义。
>
> **题型**：`questionType` 在题包顶层声明一次，取 `single_choice`（材料型选择题组）或 `comprehensive`（材料型综合题）。一个题包只用一种，由 schema 的 questionType 条件分支强制，不允许混排。本文件凡按题型分叉之处均明确标注。

## 1. 唯一编辑源与最小文件结构

- 唯一编辑源是 `outputs/出题/<taskId>/package.json`。这里的 package.json 是**任务数据，不是 npm 包**；Markdown、学生投影、教师投影均由它生成，不分别维护答案、选项或来源的第二份权威内容。
- 教师直接编辑 `draft.md` 后，必须先把改动**回收**到任务数据、递增 `revision` 并重新校验；未回收前，旧渲染稿不得视为与数据一致，也不得据此声明完成。
- 工作产物不写入技能源目录（`skills/geo-question-generator/` 只放 `SKILL.md` 与 `references/`）。
- 不同时维护 `state.yaml` 与 `sources.yaml` 的重复状态。来源记录嵌在任务数据 `sources[]` 中；必要时可导出 `sources.json`，但导出文件不是另一份编辑源。
- `taskId` 用唯一标识（`^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`），不靠可重复的标题 slug 隔离任务；发生并发修改时停止覆盖并重新读取。

```text
outputs/出题/<taskId>/
├── package.json          # 唯一编辑源
├── draft.md              # 六章节教师交付稿，包含版本标识
├── student.json          # 不含答案、解析与采分点的题面投影
├── teacher.json          # 教师内容投影
├── validation.json       # 结构与评审状态报告，绑定 revision
└── visuals/              # 提案对应的已有附件；V1 不自动正式制图
```

| 文件 | 用途 | 版本绑定 |
| --- | --- | --- |
| `package.json` | 任务数据：`request`、`knowledge`、`concepts`、`selectedConcept`、`questionSet`、`design`、`simulations`、`sources`、`visuals`、`confirmations`、`reviews`、`risks` | 自身 `revision` 单调递增 |
| `draft.md` | 交付给教师读的六章节稿；由任务数据渲染，须写出 `taskId` 与 `revision` | 渲染来源 `revision` |
| `student.json` | 学生题面投影，供独立核验或后续讲题适配器读取 | 记录 `sourceRevision` 与内容指纹 |
| `teacher.json` | 教师内容投影（答案／采分点、解析、映射、设计说明、评审结果） | 与 `student.json` 同一 revision，共享题组 ID 与题内 ID |
| `validation.json` | 校验器输出：`structureOk`、`packageRevision`、`gates`、`findings`、`readiness` | 所针对 `packageRevision` |
| `visuals/` | 已获批准且已制作附件的存放位置；`visuals[].files` 在 `status != generated/verified` 时必须为空 | `visuals[].revision` |

题内 ID 约定：选择题小题 `Q1`、`Q2`…；综合题大题 `Q1`，其小问 `Q1-1`、`Q1-2`…；采分点 `KP-1`、`KP-2`…。`visuals[].linkedItems` 与 `simulations[].responses[]` 引用同一套 ID。

## 2. 六大章节（固定）

章节顺序与名称固定，不增删顶级章节：一、学生用试题；二、答案与解析；三、命题设计说明；四、典型学生模拟作答；五、来源与证据；六、风险与待确认事项。

- 第一部分含材料、拟用图表说明／正式图表、各题题干与作答结构。**选择题组**给出 2—3 道小题的题干与 A/B/C/D 选项；**综合题**给出大题引导语、2—4 个小问的题干与各问分值，不出现选项。
- 第二部分：**选择题组**含答案、逐题解析与干扰项分析（正确项不出现在 `distractorMap` 中）；**综合题**含参考答案（分档）、采分点与证据链、评分标准与开放答案边界，并列出典型错答模式。
- **专项训练模式可压缩第三、第五部分**，但不得省略知识依据、答案／采分点、错因对应（选择题为干扰项、综合题为典型错答与答案边界）和学情诊断。
- PRD §6.3 的十二项内容要求**不是十二个顶级章节**，按下表落入六大章节：

| PRD §6.3 十二项 | 归属章节 | 题包字段（选择题组） | 题包字段（综合题） |
| --- | --- | --- | --- |
| 1 题组材料 | 一 | `questionSet.material.text` | 同左 |
| 2 拟用图表占位及设计说明 | 一（提案明细见提案区） | `material.visualRefs`、`visuals[]` | 同左 |
| 3 题量与设问 | 一 | `items[]`（2—3 道单项选择） | `items[0].stem`、`items[0].subQuestions[]`（2—4 个小问与分值） |
| 4 答案 | 二 | `items[].answer`（A/B/C/D 之一，答案唯一） | `subQuestions[].answerKey[]`（采分要素＋证据链＋分值） |
| 5 逐题解析与作答分析 | 二 | `items[].analysis`、`items[].distractorMap` | `subQuestions[].rubric[]`、`answerBoundary`、`misconceptionPatterns[]` |
| 6 命题设计说明 | 三 | `design.*`、`concepts[].innovation`、`design.innovationBoundary` | 同左 |
| 7 课标、知识图谱与教材共同知识依据 | 三 | `design.curriculumBasis`、`design.textbookBasis`、`design.taxonomyRole`、`knowledge`、`taxonomySources` | 同左（另见 `knowledge.needsReviewNodeIds`） |
| 8 核心素养与"四翼"分析 | 三 | `items[].fourWings`、`design.fourWings` | `items[0].fourWings`、`subQuestions[].fourWings`、`design.fourWings` |
| 9 难度分析 | 三 | `design.expectedDifficulty` | 同左，第四个维度用 `scoringDiscrimination` |
| 10 3 名典型学生模拟作答 | 四 | `simulations[].responses[]`（记选项） | `simulations[].responses[]`（记书面答案与命中采分点） |
| 11 热点、数据、论文与图片来源 | 五 | `sources[]` | 同左 |
| 12 风险与待确认事项 | 六 | `risks[]`、`confirmations[]`、`reviews[].pendingItems` | 同左 |

## 3. 第三部分的必要证据（设计说明）

命题设计说明必须能逐条落到字段，否则只是措辞：

- 课标条目与行为动词 → `design.curriculumBasis[].statement`、`behaviorVerb`；无法核验时 `verification: pending`，不杜撰引文、不声称完成对齐。
- 题目中承载该要求的证据 → `curriculumBasis[].evidenceInItem`，写明题面哪一处任务实际承载该项要求。综合题须逐小问指出，不得只写"整道大题体现"。
- 核心素养 → 指出主要考查的区域认知／综合思维／人地协调观／地理实践力（须指明具体哪一项，不单说"素养"）。
- 学生如何处理材料 → `materialClues` 与材料线索的对应关系（综合题写在小问级）。
- 四翼主次与题面证据 → `fourWings.primary`、`fourWings.secondary`、`fourWings.evidence`；四翼是"怎么考"的要求，不是四个难度等级，不强凑四项，无题面承载的不标。
- 考点复核状态 → `knowledge.needsReviewNodeIds` 非空时，第三部分与第六部分都必须明示该节点待复核，不得只在字段里记一下。

## 4. 第四部分：模拟作答

- 默认 `simulations[]` 三名：水平 A 准确提取信息并完成分析与迁移；水平 B 掌握基本概念但证据整合或推断不完整；水平 C 存在核心概念误解、依赖表面词语或记忆结论。
- 每人给出各题作答、简短自然的作答思路、正确理解的部分、出错环节、对应认知障碍与教师可据此进行的判断和干预。
- `disclaimer` 固定为"预测性认知路径"：模拟用于解释预期认知路径，**不是试测**，也不能证明答案唯一。
- **选择题**：记 `selected`（A/B/C/D）；`misconceptionId` 必须与所选干扰项的 `misconceptionId` 一致。
- **综合题**：记 `subQuestionId`、`writtenAnswer`、`hitPointIds`、`missedPointIds`。`writtenAnswer` 要像学生真的会写出来的样子，不能写成标准答案；**不写预估得分数字**，命中的采分点 id 已足以按 `answerKey` 推导得分。三档必须在 `hitPointIds` 上真正分开——三档命中完全相同时，问题在采分点而非模拟文字。
- 无真实试测数据时只输出预计难度等级与判断依据，**不得输出正确率、难度系数、区分度或选项分布**；教师提供真实试做记录时优先分析真实数据，不再以模拟代替。

## 5. 两类投影的字段边界

**选择题组**的学生投影只含：`questionSetId`、`itemId`、共用材料、小题题干、A/B/C/D 选项、必要图片引用（`material.visualRefs`），并记录 `sourceRevision` 与内容指纹。

**综合题**的学生投影只含：`questionSetId`、大题 `itemId` 与引导语、共用材料、各小问的 `subQuestionId`、题干与分值、必要图片引用，并记录 `sourceRevision` 与内容指纹。

两类题型都必须排除：`answer`（选择题）、`analysis`、`distractorMap`；综合题另须排除 `answerKey`（含采分要素、证据链与分值）、`rubric`、`answerBoundary`、`misconceptionPatterns`。同时排除 `simulations`、`design`，以及透露答案的证据标签——`coreExamPoint`、`supportingKnowledge`、`materialClues`、`sources[].usedClaims`、`design.curriculumBasis[].evidenceInItem` 等。

- 学生投影不仅要检查禁用字段：还要检查**材料、选项、小问题干、文件名和图片说明是否夹带答案提示**（例如图注或附件名出现"正确""错误""答案""关键"，或综合题小问分值分布暗示了采分点数量）。结构筛查不能替代这项内容检查。
- 教师投影含：答案或采分点、逐题解析、错因映射、考点映射、命题设计说明、评审结果。
- 两类投影共享题组 ID 与题内 ID，并绑定同一 revision。题面、答案／采分点、关键来源或必要图表改变时，受影响的质量评审失效（由 `reviews[].targetRevision` 判定），不重做无关部分。
- 出题上下文已知答案，不能把同上下文再次作答称为"独立解题"；独立核验应只收到学生投影，再对照教师内容。综合题的独立核验须按参考答案与采分点逐问比对，并专门检查**答案边界外的作答是否被误判为正确**。
- 取题一律走工具：`geo_search_questions`、`geo_question_detail`、`geo_style_profile`、`geo_taxonomy`；需要命题研究用 `geo_analyze`、`geo_export_analysis`（导出件仍不是编辑源）。不得用 read/glob 直读题库 md，真题只作风格与质量参照，不得改写真题或论文题图冒充原创。

## 6. 图表提案格式与检查点（`visuals[]`）

提案在批准前只完成来源定位与可用性检查，**不产正式图、不提前做数据下载／清洗／绘图**（`files` 必须为空）。每份提案写全：

名称与类型（`title`、`type`）｜包含什么数据、变量、单位或图像信息（`content`）｜在题组中的作用（`itemFunction`）｜为何不能用文字替代（`necessity`）｜对应哪些题与认知活动（`linkedItems`：选择题写小题 id `Q1`，综合题写小问 id `Q1-1`）｜拟用来源（`candidateSourceIds`，解析到 `sources[]`）｜后续制作方式（`plannedMethod`）｜风险（`risks.scientific`／`copyright`／`mapCompliance`／`cognitiveLoad`）。

- 内容、变量、用途或必要性改变时递增 `visuals[].revision`，旧 `visual_approval` 确认随之失效；普通文字润色不触发重新审批。
- 地图必须使用官方来源并记录审图号、下载时间与适用范围（`sources[]` 中 `type: map`）；**禁止 AI 生成行政区划轮廓**；不擅自变形、裁切或遗漏必要疆界要素；无合规底图时只出配图需求说明，不生成正式地图。
- 论文图不得直接使用，只能理解后教学化改绘并注明"据××研究改绘"；PDF 经当前渠道读不到，不得据 PDF 声称已核对方法、数值或图示关系。教师提供的适用图表在核实来源与使用条件后可直接使用，不必重绘。
- 必须读图才能作答的题组缺图时，只能到"初稿完成／待补充"。

## 7. `readiness` 四态与声明口径

| `readiness` | 含义 | 可对教师作出的声明 |
| --- | --- | --- |
| `concepts_pending` 构思待选择 | 已形成三个构思，尚未获教师确认 | 可比较、选择或修改方向 |
| `draft_complete` 初稿完成 | 完整题组及说明已形成，可以包含必要图表占位或待核验依据 | Markdown 初稿完成，列明尚缺内容 |
| `usable` 可使用 | 必要材料与图表齐备，结构和语义核验完成，无影响使用的阻断项 | 题组可用于相应教学任务；是否符合具体比赛规则仍按该比赛要求判断 |
| `pending` 待补充 | 证据、确认或必要图表缺失 | 只能交付构思或初稿，不宣称最终对齐、完整成品 |

`readiness: usable` 要求不存在 `blocking: true` 的风险项。两类题型都要求结构与语义核验完成；**综合题另加两条语义条件**：

1. 采分点与分值自洽，且覆盖参考答案的每一条推理（无空采分点、无未给分的参考答案要点、各问分值与总分三级相加一致）；
2. 答案边界在常见作答上可判定（`answerBoundary` 不只是措辞，`notes` 未充当边界）。

这两条结构校验查不出，未评审前综合题不得标 `usable`。V1 不承诺正式制图与 Word/PDF 作品包；纯文字题组可以达到"可使用"。

## 8. 校验器返回状态与门禁口径

校验器返回 `structureOk`、`packageRevision`、`gates`、`findings` 与 `readiness`。每项结果用 `pass`／`fail`／`pending`／`not_applicable`，并记录 `checkType=structural|semantic`、检查依据及所针对的 revision。

- 只有结构检查完成时，语义项仍保持 `pending`，**不能返回"全部门禁通过"**。
- G5（图表）：无图且题目不需要图时为 `not_applicable`；依赖未制作的图时为 `pending` 并阻止"可使用"；不能因"存在一张获批图"就放行题组内其他图。
- G2（证据）：仅有 URL 或日期字段合格**不能**把真实性核验标为 `pass`；只填一个 URL 不算证据支持，`accessScope` 按实际取得的内容填写（`metadata`／`abstract`／`excerpt`／`full_text`／`dataset`），HTTP 2xx 但空响应必须判为未读到。
- G4（题组质量）——**选择题**：答案为 A/B/C/D 之一、选项齐全、干扰项映射与关联 ID 完整。**综合题**：各问 `points` 之和等于该问 `answerKey` 各点 `points` 之和；各问 `points` 之和等于 `totalPoints`；`rubric` 至少 2 档；`answerBoundary` 的 `acceptable`／`unacceptable` 均非空；`misconceptionId` 能在 `learningHypotheses` 中解析；`hitPointIds`／`missedPointIds` 能在 `answerKey` 中解析。**分值与采分点的三级求和是跨字段约束，JSON Schema 不表达，必须由校验器实现。**
- G6（交付说明）：核对六章节内容字段、三水平模拟结构，以及模拟与错因映射引用一致。
- 校验器只能检验所提供的评审记录及版本一致性，不能独立证明记录中的评审已真实发生；结构与语义结论分开记录，不把结构通过当质量通过。
