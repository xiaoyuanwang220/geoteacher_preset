# 出题工作流：阶段、确认、回退与跨会话恢复

## 何时读这份文件

- 一次出题任务已拿到学段/年级、主题或考点、教师学情原话，准备从输入归一推进到后续任一阶段时；
- 需要判断当前能否写下一个 `stage`、能否对教师声明某种 `readiness` 时；
- 教师要求重新提构思、改方向、改图表方案，或某道门禁未通过、要定回退范围时；
- 会话中断、被压缩或另开会话后，要接着同一 `taskId` 继续同一任务时；
- 出现并发写、找不到确认依据，或要判断一条旧批准是否仍然有效时。
- 只查术语口径时读 `docs/术语表.md`；题干、选项、小问、采分点与干扰项的具体写法由 item-writing 等支持文件负责，本文件不重复。

## 一、任务数据与唯一编辑源

- 正式落盘为 `outputs/出题/<taskId>/package.json`，它是唯一编辑源；`draft.md`、`student.json`、`teacher.json`、`validation.json` 均由该数据生成，不另维护答案、选项、采分点或来源的第二份权威内容。工作产物不写入技能源目录。
- 字段名与枚举以 `plugins/question/package.schema.json`（schemaVersion 2）为准，本文件只引用其中已有的字段。教师直接编辑 Markdown 后，需先把改动回收进任务数据并重新校验，旧渲染稿不再视为一致。
- **题型在阶段 0 由教师确定，写成顶层 `questionType`，此后不改**：`single_choice` 为材料型选择题组，`comprehensive` 为材料型综合题。一个题包只用一种题型，schema 按 `questionType` 收窄题组与模拟作答的形态，不允许混排。教师中途要换题型，等于换任务，须新建 `taskId`，不在原题包里改。
- `taskId` 是任务唯一标识，不靠可重复的标题 slug 隔离任务；`revision` 单调递增，保存前校验 revision，发生并发修改时停止覆盖并重新读取。
- 阶段推进必须落成字段：`stage`、`readiness`、`selectedConcept`、`visuals`、`confirmations`、`reviews`、`risks`。阶段跳转由教师的自然语言触发，不要求教师输入命令；任何推进都不得只存在于模型的叙述里。

## 二、stage 六个取值与推进条件

| stage | 含义与成立前提 | 允许推进到下一取值（上游已确立的条件） | 该阶段不得做 |
| --- | --- | --- | --- |
| `input_normalized` | 输入归一与依据检查已完成：`request` 含可识别的 `grade`/`topic`/`learningStateRaw`（学情原话逐字保留）；`questionType` 已确定；`taxonomySources` 已记录实际读取的文件、版本、状态、`contentHash`、`readAt`；`learningHypotheses` 有 2—3 条 `status=proposed` 的待验证认知障碍，措辞含「可能/待验证」 | 课标、考点树、热点检索、论文检索的可用性已分别检查，会实质改变结果的缺口已向教师提问或记入 `risks`/`knowledge.unresolved`；用到 `needs_review=true` 的节点时已记入 `knowledge.needsReviewNodeIds`；且 `concepts` 已形成 3 个实质不同的构思 | 在考点树不可读时声称完成了知识图谱对齐；询问教材出版社版本；把年级等同于固定教学进度；在教师未表态时替教师决定题型 |
| `concepts_proposed` | `concepts` 数组中已有 3 个实质不同的构思（不同现实问题、材料证据或认知路径，不是标题与措辞变化），每个构思带 `measurementTarget`、`context`、`learningHypothesisIds`、`itemProgression`、`visualProposalIds` | 教师以自然语言选择、组合或修改方向后：`confirmations` 记一条 `type=concept_selection`（含 `objectId`、`objectRevision`、`teacherUtterance`），并据此写 `selectedConcept`（组合时填 `conceptIds`、`composed`、`basis`），进入 `concept_selected` | 交付完整题组；用局部示例冒充已确认方向；把 3 个构思写成同一构思的三种措辞 |
| `concept_selected` | `selectedConcept` 非 null，且其 `revision` 与被确认的构思 revision 一致；组合而成的新修订有明确内容 | 按选定方向生成初稿：`questionSet`（共用材料 + 题组项齐备；选择题组为 1—3 道小题，综合题为 1 道大题含 2—4 个小问）、`design`、`simulations` 齐备，逐题六章节 Markdown 初稿形成，结构评审与语义评审分别登记进 `reviews`（各带 `targetRevision`、`checkType`、`method`、`findings`、`pendingItems`） | 把只有结构检查通过、语义项仍 `pending` 的状态说成「全部门禁通过」；综合题在采分点与答案边界未评审时就写成可用的样式 |
| `draft_ready` | 完整题组及说明已形成，允许含必要图表占位或待核验依据（`design.curriculumBasis[].verification=pending` 属正常） | 题组所需的每一张图表都先说明内容、作用、必要性并获得教师确认：`confirmations` 记 `type=visual_approval`，`objectId` 为 `visuals[].id`、`objectRevision` 为该图表 `revision`，随后进入 `visuals_approved` | 在批准前创建正式制图产物，或提前做数据下载、清洗与绘图；把含图表占位的初稿标成「可使用」 |
| `visuals_approved` | 题组所需图表提案均已获教师批准，且按 G5 逐图核对（每张图自身状态、批准版本、文件引用、关联小题／小问），不能因「存在一张获批图」放行题组内其他图 | 达到「可使用」的全部要求（必要材料与图表齐备；结构核验与语义核验完成；综合题另需采分点分值自洽与答案边界可判定两条语义条件；无影响使用的阻断项；`risks` 中无 `blocking=true`），并取得教师对收尾的自然语言确认后进入 `finalized` | 只用 URL 或日期字段合格就宣称来源真实性核验通过；把来源真实性等待评审项当作已通过；把综合题的答案边界灰区当作已判定 |
| `finalized` | 本题组在 V1 边界内完成：Markdown 六章节交付齐备，来源、评审与确认记录可追溯 | —（结束态） | 宣称符合某场比赛规则（是否符合仍按该比赛要求判断）；输出正确率、难度系数或区分度；在 V1 制作正式图表或 Word/PDF 作品包；给综合题的模拟作答写预估得分数字 |

补充认定：

- 题组不需要图表时，上游未明确规定是否仍必须经过 `visuals_approved`（G5 为 `not_applicable`，依赖未制作的图才是 `pending`）。上游未定，遇此情形须询问教师，不得模型自行跳级。
- `input_normalized → concepts_proposed` 之间没有对应的教师决策：上游既写「阶段跳转由教师的自然语言确认触发」，又未要求教师在此处表态。上游未定，遇此情形须询问教师。
- `finalized` 相对「可使用」的额外条件上游未单独定义；除上表可用条件外，不要再自行加条件或降低条件。

## 三、readiness 四态：可对教师声明什么

| readiness | 中文 | 可对教师声明什么 | 支撑声明的事实 |
| --- | --- | --- | --- |
| `concepts_pending` | 构思待选择 | 可比较、选择或修改方向；此时只提供构思、比较和局部示例 | 已形成 3 个实质不同构思，尚未获教师确认 |
| `draft_complete` | 初稿完成 | Markdown 初稿完成，并逐项列明尚缺内容 | 完整题组及说明已形成，可含必要图表占位或待核验依据 |
| `usable` | 可使用 | 题组可用于相应教学任务；是否符合具体比赛规则仍按该比赛要求判断 | 必要材料与图表齐备；结构核验与语义核验完成；无影响使用的阻断项；`risks` 中无 `blocking=true` |
| `pending` | 待补充 | 只能交付构思或初稿，不宣称最终对齐、完整成品 | 证据、确认或必要图表缺失 |

- **必须读图才能作答的题组，缺图时只能达到「初稿完成/待补充」**：不得标 `usable`，也不得以此宣称最终对齐或完整成品。依赖未制作图表的题组，G5 为 `pending`，该状态阻止「可使用」。
- 已有教师提供的适用图表，可在核实来源与使用条件后直接使用，不必重新绘制；但 `visuals[].files` 只在 `status` 为 `generated`/`verified` 时才可填写。
- 未确认构思时不得交付完整题组。上游未给出 `stage` 与 `readiness` 的强制对应表：两者都必须与任务实际进度一致，不允许用 `usable` 覆盖实际仍处于初稿或待补充的情形。
- **综合题的两条额外语义条件**（结构校验查不出，必须有评审记录）：采分点与分值三级自洽且覆盖参考答案的每一条推理；答案边界在常见作答上可判定、未由 `notes` 兜底。任一条未评审，综合题只能停在 `draft_complete`。
- **`knowledge.needsReviewNodeIds` 非空时**，无论 readiness 取哪一态，交付稿都必须明示所涉节点待复核；不得无提示地呈现为最终作品。

## 四、两个默认确认点

1. **构思确认**：从 3 个构思中选择、组合或修改。教师可选择其一、组合多个、修改局部方向或要求重新提出；组合后形成有明确内容的新修订（构思 `revision` 递增，`selectedConcept.composed=true` 并在 `basis` 写清改动了哪些方向）。确认记录指向构思 id 与对应 revision。
2. **图表确认**：确认图表内容、作用和必要性后才制作正式图。提案须说明图表名称与类型、将包含的数据/变量/单位或图像信息、在题组中的作用、为何不能用文字替代、关联哪些小题（`Q1`）或小问（`Q1-1`）、数据或原图的拟用来源、后续制作方式，以及科学性、版权、地图合规与认知负荷风险。教师确认必要且方向正确后，才进入数据获取、清洗、制图与嵌入；V1 不自动正式制图。

- 两个默认确认点之外，安全、可逆、不改变教学方向的细节由模型自行完成，不为每个小选择询问教师。
- **模型不得凭自己的「已确认」描述创造授权**。确认必须来自教师自然语言；`confirmations` 每条须写全 `confirmationId`、`type`、`objectId`、`objectRevision`、`teacherUtterance`、`at`（可得时加 `sessionRef`）。只有一个「已批准」布尔标记、或模型复述「教师已同意」，都不构成确认依据，也不足以支持恢复或后续制作。

## 五、确认失效与改动传播

| 改了什么 | 失效什么 | 必须做什么 |
| --- | --- | --- |
| 构思的测量目标、核心情境或关键证据改变（`concepts[].measurementTarget`、`concepts[].context` 及其 `sourceIds`、`coreKnowledge`） | 该构思原有方向确认失效 | 递增构思 `revision`，重新与教师确认方向，再更新 `selectedConcept` |
| 图表内容、变量、用途或必要性改变（`visuals[].content`、`itemFunction`、`necessity`、`linkedItems`、`plannedMethod`） | 该图表的旧批准失效 | 递增 `visuals[].revision`，重新走图表确认；普通文字润色不自动触发重新审批 |
| 题面、答案／采分点、关键来源或必要图表改变（`questionSet.material`／`items`、`sources`、`visuals`） | 受影响的质量评审失效（以 `reviews[].targetRevision` 判定），不得沿用旧评审结论 | 只重做受影响部分并重新登记评审，不重做无关部分 |
| **综合题的小问分值或采分点改变**（`subQuestions[].points`、`answerKey`） | 该问的评分标准与答案边界评审、以及引用该问 `pointId` 的模拟作答结论一并失效 | 重算该问分值之和与 `totalPoints`，重做该问的模拟与边界评审，不动其他小问 |
| **题型改变**（`questionType`） | 整个题包的题组形态、模拟作答形态与全部评审 | 不在原题包改；新建 `taskId` |
| 教师拒绝全部构思、拒绝图表方案 | 被拒绝对象作废，方向确认或图表批准随之失效 | 局部更换情境、材料或设问后重新提案；不重做整个题组 |
| 任务被取消 | 不产生完成声明 | 保留任务记录与状态，不把未确认产物呈现为完成品 |

## 六、回退规则

- 任一门（G0—G6）未通过时，只回退到受影响阶段，不重做已确认且未受影响的部分。
- 落地判定顺序：先按 `reviews[].targetRevision` 与 `confirmations[].objectRevision` 列出受影响对象（构思、图表、小题、小问、来源），再定回退目标 `stage`，然后只重走该阶段之后的检查；回退原因记入 `risks` 或 `reviews[].findings`，并同步 `readiness`。
- 语义评审退回时，独立核验先只拿 `student.json` 投影作答，再对照教师内容；发现多解、无解、漏点或证据不足即退回局部修改。综合题的核验还要专门检查边界外作答是否被误判为正确。本会话内已知答案，再次作答不算独立解题。

## 七、跨会话恢复

1. 先读 `outputs/出题/<taskId>/package.json`，它是恢复的唯一依据；不凭上一会话的摘要、记忆或已进入会话的旧文本恢复（旧文本不会自动被磁盘新内容替换）。
2. 核对确认对象版本：`confirmations[].objectId`/`objectRevision` 是否仍等于当前 `concepts`/`selectedConcept`/`visuals` 的 revision；`selectedConcept`、`stage`、`readiness` 是否自洽；`risks` 中是否仍有 `blocking=true`；`reviews[].targetRevision` 是否仍是当前题面 revision。综合题另核对分值与采分点三级是否仍相加一致。
3. 列出待办：`knowledge.unresolved`、`knowledge.needsReviewNodeIds`、`concepts[].risks`、`reviews[].pendingItems`、`risks[].mitigation`，把缺失决策合并成一次补问，不逐条追问。
4. **无法定位确认依据时，只补问缺失决策，不凭摘要补造确认**；版本对不上的旧批准一律视为失效，需教师重新确认。
5. `taskId` 唯一，按 taskId 定位任务，不按标题 slug 或相似主题猜任务；`revision` 发生并发冲突时停止覆盖并重新读取。
6. 恢复后不要重跑已确认且未受影响的阶段，也不要在未重新读取题包的情况下推进 `stage`。
7. 读到 `schemaVersion: 1` 的旧题包时，先按迁移说明补齐 `questionType` 与题组项 `itemType`、并把 `candidateDistractorStrategy` 改名为 `candidateErrorStrategy`；补齐属数据格式迁移，须递增 `revision`，因此按第五节该题包全部评审失效，需重新登记——不得把迁移当成无损操作。

## 八、取题与工具纪律

- 取题一律走工具：真题检索用 `geo_search_questions`，真题详情用 `geo_question_detail`，风格档案用 `geo_style_profile`，考点树用 `geo_taxonomy`；命题研究用 `geo_analyze`，需要导出时用 `geo_export_analysis`。
- 严禁用 read/glob/pwsh 直接读真题库 md 文件：已配置的真题库目录下所有 md 均含答案与解析，直读等同读取答案，属流程违规。生效路径见 `/geo/core/health`。
- 生成的题包 ID（`taskId`/`questionSetId`/`itemId`/`subQuestionId`/`pointId`）不是现成题库 qid，不能直接传给 `geo_solve`、`geo_judge`、`geo_explain`；这三个入口面向题库 qid。
- 「出题上下文已知答案」这一事实必须如实说明：答案核验采用教师审题，或另开只收到学生题面投影的独立验证会话。

## 九、V1 边界（不得承诺）

- 题型只做**材料型选择题组**与**材料型综合题**两种，一个题包只用一种；不做整卷组卷、分值结构设计与混排题型。
- 不做正式制图；不做 Word/PDF 作品包（属 V1.x）。
- 无真实试测数据时只输出「预计难度等级 + 判断依据」，不输出正确率、难度系数或区分度；综合题的模拟作答不写预估得分数字。
- 不修改考点库与真题库，不把生成题自动写回知识图谱。
- 上游未定或本文件未覆盖的情形：不得自行补规则，须询问教师。
