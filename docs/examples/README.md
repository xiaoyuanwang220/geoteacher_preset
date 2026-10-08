# 出题任务包样例（开发用）

本目录存放**命题包数据契约**的样例文件，用于校验 schema、编写测试与演示交付结构。schema 为 `plugins/question/package.schema.json`（schemaVersion 2），对应方案 §6.1 字段表与 §6.3 最小文件结构中的 `package.json`。

| 文件 | 题型 | 用途 |
| :-- | :-- | :-- |
| `question-package.sample.json` | `single_choice` 材料型选择题组 | 演示 2—3 道小题、ABCD 选项、干扰项映射与投影禁用字段 |
| `question-package-comprehensive.sample.json` | `comprehensive` 材料型综合题 | 演示 1 道大题 + 3 个小问、分值、采分点与证据链、评分标准、开放答案边界、典型错答模式与书面答案模拟 |

一个题包只用一种题型（顶层 `questionType` 声明一次），不允许混排——schema 的 questionType 条件分支强制这一点。两个样例各代表一种。

## ⚠️ 这是样例，不是真实交付物

两个样例中的**现实性内容都是占位的**：

- `taxonomySources[].contentHash` 均未填写（该字段由校验器计算并回填，属 M3；模型不得手写或猜测）；
- 综合题样例的 `S4` 在 `limitations` 中标注了「【样例占位】」，`S1`／`S2` 取自工作区内的课标与教材文本 md，未标注版次与页码；
- 综合题样例的三条 `answerBoundary.notes` 都写明「尚未经独立评审」；
- `simulations[]` 全部标注 `disclaimer: "预测性认知路径"`，**不是真实学生数据**；综合题样例的书面答案是按认知路径构造的，不是任何学生的真实答卷；
- `confirmations[]` 是为演示确认记录结构而构造的；
- 两个样例的 `readiness` 都是 `draft_complete` 且带 `blocking: true` 的风险项，**都不构成「可使用」**。

**不得**把这两个文件当作可交付作品，也不得据它们引用任何现实事实。

## 唯一确定性的事实来源

两个样例里只有两类内容是从工作区真实文件读取的，其余均为占位。

**选择题样例**：`knowledge.coreNodeIds` 与 `design.taxonomyRole` 使用的 `KU-NAT-ATM-HEAT-005`（大气热力环流）取自 `E:\知识图谱\config\knowledge_taxonomy_natural_geography.yaml:609`，其 `definition`、`includes`、`excludes` 为该文件真实内容，且源中 `needs_review: false`（:629）——因此该样例的 `knowledge.needsReviewNodeIds` 为空：

- definition：由地面冷热不均引起的空气垂直与水平运动构成的闭合环流。
- includes：热力环流的形成过程（受热上升、冷却下沉、水平补偿）；海陆风、山谷风、城市热岛环流等应用。
- excludes：全球性大气环流（归入气压带和风带的形成）。

**综合题样例**：`KU-REG-ECOFRAGILE-003`（生态脆弱区的综合治理）与 `-002`（土地退化及成因）取自 `E:\知识图谱\config\knowledge_taxonomy_regional_development.yaml:333`—`:378`；课标条目取自 `课本与课标/课标.md:370`；教材依据取自 `课本与课标/选必二.md:514`—`:618`。这两个节点在源中**均为 `needs_review: true`**（:353、:377），所以该样例的 `knowledge.needsReviewNodeIds` 非空，并在 `risks` 中以 `blocking: true` 明示——这是刻意选的：它演示「用到待复核节点时不得无提示地交付」这条规则。

## 样例覆盖的状态

| 字段 | 选择题样例 | 综合题样例 |
| :-- | :-- | :-- |
| `schemaVersion` | `2` | `2` |
| `questionType` | `single_choice` | `comprehensive` |
| `stage` | `draft_ready` | `draft_ready` |
| `readiness` | `draft_complete`（题组依赖 `V1` 图且 `V1` 为 `proposed`，课标条目 `pending`） | `draft_complete`（两个源节点 `needs_review`，且综合题的两条语义条件未独立评审） |
| `mode` | `competition` | `competition` |
| `selectedConcept` | `C1`（组合=false，`CF1` 教师原话确认） | `C1`（组合=false，`CF1` 教师原话确认） |
| 难度维度 | `distractorDiscrimination` | `scoringDiscrimination` |

两者都演示同一条完成边界：**结构检查通过 ≠ 可使用**——`reviews` 中结构项通过，语义项仍 `pending`。

## 综合题样例刻意演示的六件事

写综合题时可直接照这几处的处理方式：

1. **分值三级自洽**：`totalPoints`（20）= 各小问 `points` 之和（4+8+8）；每个小问 `points` = 该问 `answerKey` 各采分点 `points` 之和。这是跨字段求和，JSON Schema 不表达，必须由校验器实现（见 delivery-format.md §8 G4）。
2. **采分点写成「要素＋证据链＋分值」**：`statement` 是可判定的要素，`evidenceChain` 必须落到材料字句，`acceptableVariants` 只放宽措辞不放宽边界。
3. **顺序类设问要给出由原因推出的理由**：`KP-7` 不是「因为这项更重要」，而是「原因未消除时，同一放牧压力会继续作用于正在恢复的草场和林带」。
4. **答案不唯一时用边界与评分标准兜底，而不是硬造唯一答案**：`Q1-3` 有两个可辩护的「最关键一项」，判据统一为「理由是否指向限制性因素」，`rubric` 与 `answerBoundary` 都写明不因选择不同而改变基础分。
5. **`excludes` 要认真用**：材料用了农牧交错带的区域特征，而节点 `excludes` 明确排除「具体地区的治理案例和数据」；样例在 `S2.limitations` 与 `design.expectedDifficulty.knowledgeBasis` 中划清了「节点给框架、材料给案例」的界线。
6. **模拟作答不写预估得分数字**：只记 `hitPointIds`／`missedPointIds`。命中的采分点 id 已足以按 `answerKey` 推导得分，而写数字容易被误读为试测数据。三档命中集合刻意互不相同（11/11、7/11、3/11），用来检验采分点是否真能区分水平。

## schemaVersion 1 → 2 迁移说明

v2 起支持综合题，因此 v1 题包**不能直接通过 v2 校验**。迁移项（选择题样例已按此迁完，见其 `reviews` 中的 `RV3`）：

| 变更 | 从 | 到 |
| :-- | :-- | :-- |
| 格式版本 | `"schemaVersion": 1` | `"schemaVersion": 2` |
| 题型声明 | 无 | 顶层新增 `"questionType": "single_choice"`（或 `"comprehensive"`） |
| 题组项判别 | `items[]` 项无判别字段 | 每项新增 `"itemType": "single_choice"`（或 `"comprehensive"`） |
| 假设的策略字段 | `learningHypotheses[].candidateDistractorStrategy` | 改名 `candidateErrorStrategy`（覆盖两种题型，选择题写干扰项策略、综合题写典型错答或漏点策略） |
| 待复核节点 | 无字段可记 | 新增可选 `knowledge.needsReviewNodeIds` |

迁移会改动文件，因此须递增 `revision`；按 workflow.md 第五节，受影响的质量评审需要重新登记，**不得把格式迁移当成无损操作**。选择题样例的处理方式是：递增 `revision` 并在 `reviews` 中新增一条 `RV3` 记录迁移项，同时说明题面、选项、答案与来源未改动，故原评审结论沿用、仅把 `targetRevision` 随之更新。

## 已知待修正

- **选择题样例的 `teacherInput` 已修正**：item-writing.md 要求 `request.learningStateRaw` 的原话逐字复制进每条 `learningHypotheses[].teacherInput`，而该样例原先把原话拆成三段片段，其中 `LH-03` 的 `"做题时容易出错"` 在原话中并不存在（原话为「做题时容易把它和大气受热过程混在一起」）。这是 v2 之前就存在的问题，本次已一并改为原话逐字复制（三条相同，与真实产物 `2026-0927-water-cycle-01` 的写法一致），并在其 `reviews` 的 `RV3` 中留痕。该缺陷由 `node .tmp-verify-question-package.mjs` 一类的引用一致性检查即可发现——这说明 M3 的校验器应当把「`teacherInput` 是否为 `learningStateRaw` 的原话」作为一条结构性检查，而不是靠人工看。
- **`outputs/出题/2026-0927-water-cycle-01/package.json` 仍是 `schemaVersion: 1`**：它是真实的出题任务产物，不是样例。本次未迁移它，因为迁移须递增 `revision`、从而使其 `reviews[].targetRevision: 3` 失效，这是教师可见的后果，需由使用者决定何时迁移。迁移项同上表。
