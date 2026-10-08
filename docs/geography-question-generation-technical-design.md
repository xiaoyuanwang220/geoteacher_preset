# 高中地理出题功能技术设计文档

> 状态：DSH 技术基线；M1 数据与技能已落地，后续实现和验收按执行方案推进。  
> 更新日期：2026-10-08  
> 范围（2026-10-04 决策）：出题范围含两种题型——材料型选择题组（`single_choice`）与材料型综合题（`comprehensive`），一个题包只用一种题型，不支持混排；命题包数据格式升 `schemaVersion: 2`。依据 [决策记录](决策记录.md) 2026-10-04 行。**出题自 2026-10-08 起正在开发**（2026-10-04 之前的暂缓令已解除），本文档的实现与验收按执行方案推进。  
> 进度（如实区分）：**已落地（源码）**——技能目录包、命题包 schema v2、双样例、术语表；**未实现**——命题包校验与渲染实现、学生与教师投影、`geo_question_validate` 工具（`plugins/question/` 下只有 schema，全仓无任何程序读取它）；**未验收**——M1 桌面重启验收（`/geo/taxonomy/meta`、`/geo/taxonomy/query` 与 `geo_taxonomy` 的 `query`/`ids` 参数当时探测为 404，需完整重启桌面）与 4 份 references 的语义评审（只做过禁用词静态扫描）；**未跑通**——M2 端到端闭环。  
> 对应产品文档：[产品需求](geography-question-generation-product-requirements.md)  
> 实施目标：在 DSH Desktop 中运行的两阶段高中地理命题 Skill

## 1. 技术目标

在不建设独立数据库、知识图谱服务或复杂状态机的前提下，把现有 `geo-question-generator` 改造成可读取外部活数据、可追溯证据、可分阶段获得教师确认的命题 Skill。

技术设计必须支持：

- 读取 `E:\知识图谱` 中当前 taxonomy 和已映射真题；
- 消费 WorkBuddy 后续生成的省份风格档案；
- 核验课程标准和高中地理共同知识边界；
- 联网检索近 12 个月新闻、国家战略最新进展、权威数据和专业论文；
- 先生成 3 个构思，再生成 Markdown 题组；
- 图表先输出设计说明，教师确认后再制作；
- 保存来源、时间、taxonomy 版本和处理边界；
- 在不可用或证据不足时明确降级，不伪造来源和数据。

## 2. Agent 能力演进下的 Skill 设计原则

本 Skill 面向能够自主理解目标、选择工具、读取文件、检索证据和检查结果的新一代 Agent。设计时不把模型当作只能逐步执行提示词的旧式流程引擎，也不通过不断追加规则来修补每一次个案失败。

OpenAI 开发者文章指出，随着 Agent 能力提高，过去用于“手把手引导”的大量脚手架可能开始妨碍结果；过长、重叠的 Skill 描述会降低技能选择质量，而渐进式披露、简短的根文档和按任务需要读取资料更适合新的 Agent。官方 Skills 文档同样将 Skill 定义为包含 `SKILL.md` 和支持文件的模块化指令目录，并建议按用途组织 references、scripts 和 assets。

官方依据：

- OpenAI Developer Blog, *Rethinking skills and prompts for GPT-6 Astra*: <https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra>
- OpenAI API Docs, *Skills*: <https://developers.openai.com/api/docs/guides/tools-skills>

### 2.1 假设 Agent 已具备通用能力

Skill 不重复教授通用的检索、阅读、归纳、写作、工具调用、自检和文件操作方法。只有下列信息值得进入运行时指令：

- 会改变命题判断的学科规则；
- 当前项目特有的数据位置、数据语义和所有权边界；
- 课标、taxonomy、热点、论文、图表和地图之间的非显然关系；
- 必须保留的教师决策点；
- 版权、地图、数据真实性、答案唯一性（选择题）与采分点／开放答案边界可判定（综合题）等高风险约束；
- 可观察、可验证的交付标准和失败降级方式。

如果一条指令只是要求 Agent “认真分析”“仔细检查”或“按步骤思考”，且没有提供本项目独有的判断标准，应删除而不是保留。

### 2.2 根 `SKILL.md` 是最小路由器

根文件只保留：

- Skill 的任务边界与触发范围；
- 参赛模式和专项训练模式的路由；
- 两阶段交互及教师确认点；
- 知识图谱真源、外部证据和写入权限；
- 必须始终成立的少量硬约束；
- 何时读取哪一份 reference、何时运行哪一个 script；
- 完成条件与不可降级红线。

不得把产品文档、全部命题规范、所有来源政策、图表流程、学生模拟模板和异常案例全部塞入根文件。根文件的作用是让 Agent 知道“当前任务需要读什么”，而不是预先装载全部知识。

### 2.3 采用三层渐进式披露

| 层级 | 默认可见内容 | 本项目中的内容 |
| --- | --- | --- |
| 发现层 | Skill 名称和简短 description | 做什么、何时使用、不要用于什么 |
| 路由层 | 根 `SKILL.md` | 模式、阶段、真源、教师确认点、references/scripts 路由 |
| 执行层 | 当前任务需要的支持文件 | 构思卡、证据政策、四翼分析、学生模拟、视觉提案或交付格式 |

执行层按情境加载：

- 只做阶段 1 构思时，不读取正式交付格式和绘图实现细节；
- 教师尚未批准图表时，只读取视觉提案规则，不读取或执行绘图脚本；
- 不涉及地图时，不加载地图合规细则；
- 专项训练模式不加载比赛版完整设计说明模板；
- taxonomy 匹配明确时，不读取异常映射案例集；
- 只有进入最终 Markdown 交付时才读取完整交付结构。

### 2.4 写结果与边界，不写僵硬行程表

对于构思、素材选择、论文转化、题目编写和解析表达，Skill 应说明期望结果、决策依据、必须满足的约束和停止条件，给 Agent 保留专业判断空间。除非顺序影响正确性或教师授权，不规定机械的内部思考步骤。

需要固定顺序的只有少数关键依赖：

1. 未定位知识点和学情假设，不生成命题构思；
2. 未经教师选择构思，不生成完整题组；
3. 未说明图表内容、作用和必要性并获得确认，不制作正式图表；
4. 未核验答案唯一性（选择题）或采分点与开放答案边界可判定（综合题），以及来源证据，不交付最终参赛稿；

这些顺序是产品决策和风险边界，不是为了约束 Agent 的所有内部工作方式。

### 2.5 教师确认点必须少而有意义

更强的 Agent 应自行完成安全、可逆、不会改变教学方向的细节工作，不为每个小选择询问教师。V1 保留两个默认确认点：

- 从 3 个命题构思中选择、组合或修正方向；
- 确认图表内容、作用和必要性后再制作正式图表。

只有知识点缺失或待复核、来源不足、地图不合规、比赛要求冲突等会实质改变结果的情况，才增加询问。措辞、局部版式、普通检索词和可自行核验的细节由 Agent 自主处理。

### 2.6 活数据留在真源，Skill 只保留路由

taxonomy、真题映射、统计、课标、教材、热点、论文和省份风格档案都会更新。Skill 不复制这些内容，只记录：

- 真源如何发现；
- 如何选择本次相关片段；
- 如何记录版本和读取范围；
- 不可用时如何降级。

这样可以避免 Skill 因嵌入旧知识而快速腐化，也避免上下文被大量与当前题目无关的资料占用。

### 2.7 判断交给 Agent，确定性工作交给代码

Agent 负责需要语义理解和专业判断的工作，包括学情转译、构思比较、论文教学化转化、设问设计、科学性解释，以及按题型分叉的错因与评分判断：**选择题**的干扰项诊断，**综合题**的采分点与证据链设计、评分标准与开放答案边界判定。

脚本只用于适合确定性执行的任务：

- 解析和索引 taxonomy；
- 检查 ID、版本、必填字段和来源记录；
- 清洗已批准的数据并绘图；
- 校验 Markdown 命题包结构；
- 检查图表文件、单位、尺寸和附件完整性。

不把开放的命题判断编码成庞大的规则引擎，也不为能够由 Agent 可靠完成的一次性操作增加脚本。

### 2.8 验证真实行为，不锁死输出措辞

测试聚焦可观察行为和不变量，例如是否先给构思、是否读取当前 taxonomy、是否在图表确认前停止制图、答案是否唯一（综合题则为采分点与开放答案边界是否可判定）、来源是否可追溯。不要用正则匹配固定标题、固定句式或长模板来证明质量。

失败样例只有在跨主题复现并能归纳出稳定机制后，才进入 Skill 规则。个别题目的特殊修订保留在测试记录中，避免 Skill 逐渐膨胀成历史补丁集合。

### 2.9 面向多模型并定期减法审计

DSH 会话可能使用不同能力层级的模型。Skill 应保存真正的领域不变量和风险边界，不围绕某个模型的偶发行为堆积提示。每次主要模型升级或完成一轮前向测试后，检查：

- 哪些指令模型已经能够稳定自行处理；
- 哪些 references 从未被路由使用；
- 哪些规则重叠、冲突或已由工具验证替代；
- 哪些确认点已经没有决策价值；
- 哪些脚本和模板增加的复杂度大于收益。

优先删除、合并和缩短，再考虑增加规则。

### 2.10 对本技术方案的直接影响

- `SKILL.md` 不直接承载本技术文档中的所有组件说明；
- 下文组件是能力边界和数据契约，不等于必须建立同名模块或脚本；
- references 只有在对应阶段或风险出现时才读取；
- 会话状态是轻量工作记录，不建设工作流引擎；
- 两阶段与图表审批门属于用户已确认的产品交互，保留；
- 工具、脚本和多 Agent 只在能带来可验证收益时引入；
- 实施时先做最小 Skill，再通过真实题组测试决定哪些支持文件值得保留。

## 3. 架构边界

### 3.1 采用

- DSH 的 geo-question-generator 目录包技能作为编排入口；
- 本地文件作为课标、教材、taxonomy、风格档案和真题映射的主要结构化来源；
- 联网搜索作为热点、政策、论文和数据的实时来源；
- Markdown 作为首要中间产物和第一版交付格式；
- Python 脚本作为确认后的数据清洗和科研级制图工具；
- 轻量会话状态记录阶段、选定构思和来源清单。

### 3.2 不采用

- 不恢复已移除的数据 MCP 或知识图谱服务；
- 不建立新的数据库；
- 不把外部 taxonomy 复制到 Skill references；
- 不建立自动写回 `E:\知识图谱` 的通道；
- 不把完整论文、真题库或热点资料打包进发布 Skill；
- 不在 V1 建设整卷组卷器或自动难度标定系统。

## 4. 数据源与所有权

| 数据源 | 默认位置或渠道 | 用途 | 写入权限 |
| --- | --- | --- | --- |
| 当前 taxonomy | 由 `knowledgeBasePath` 指定的 `knowledge_taxonomy_*.yaml` | 知识点定位、边界、ID、版本 | 只读 |
| 已映射真题 | 由 `questionBankPath` 指定的目录（由现有 geo 工具读取） | 风格例证、知识组合、选项与题组结构参考 | 只读 |
| 真题统计与索引 | 现有 geo 工具与 core 维护的索引；不假定外部 processed 目录存在 | 描述当前样本与候选知识共现 | 只读 |
| 课程标准与教材文本 | `E:\geo_edu_agent\课本与课标\`；教师补充资料另记来源 | 课标原文与共同知识核验 | 只读 |
| 省份风格档案 | 待 WorkBuddy 产出后指定 | 风格技法输入 | 只读 |
| 新闻、政策与数据 | 官方网站、权威机构 | 现实情境和数据 | 外部只读 |
| 学术论文 | 正式论文页面、摘要、全文或教师上传 | 地理机制和图示依据 | 外部只读 |
| 命题输出 | 当前任务输出目录 | Markdown、图表、脚本、来源清单 | 可写 |

知识图谱项目自身标明 taxonomy 当前为 `v0.2-draft`。系统必须记录实际版本，不把“结构检查通过”表述为“正式定稿”。已映射真题的统计受样本范围限制，不得夸大为稳定命题趋势。

## 5. 目录与实现边界

当前技能根是 `.agent-presets/geo-teacher/skills/geo-question-generator/`，包含 `SKILL.md` 和四份 references：workflow、evidence-policy、item-writing、delivery-format。根入口按阶段、任务与风险路由，不要求每次全文加载。

命题包结构以 [package.schema.json](../.agent-presets/geo-teacher/plugins/question/package.schema.json) 为准，该 schema 现为 **`schemaVersion: 2`**（2026-10-04 决策）：题型在题包顶层由 `questionType` 声明一次，取 `single_choice`（材料型选择题组）或 `comprehensive`（材料型综合题），一个题包只用一种题型，不支持混排，题组项与模拟作答的形态由 schema 的 `questionType` 条件分支收窄。综合题没有干扰项，其错因与判定由典型错答模式（`misconceptionPatterns`）与开放答案边界（`answerBoundary`）承载。taxonomy 解析集中在 core，通过 `geo_taxonomy` 获取；命题包校验与渲染按执行方案采用单一 Node 实现，CLI 与可选工具复用同一实现，不增加独立 Python 校验器。Python 仅留给后续经确认的数据处理与制图；V1 不承诺正式制图。

**校验与渲染实现当前并不存在**：`plugins/question/` 下只有 `package.schema.json` 这一个文件，全仓没有任何程序读取它；学生与教师投影、`geo_question_validate` 工具（原 M3 交付物）同样未实现。因此“命题包满足 schema”目前只能由人工或临时脚本核对，须待校验器实现后另行验收。

只有规则稳定且能降低重复上下文或提高确定性时才拆分支持文件；每份 reference 必须有明确读取条件。

## 6. 运行状态

命题包是唯一编辑源，字段、枚举与约束由 [schema](../.agent-presets/geo-teacher/plugins/question/package.schema.json)（`schemaVersion: 2`）定义。完整数据示例有两份，各代表一种题型：[选择题组样例](examples/question-package.sample.json) 与 [综合题样例](examples/question-package-comprehensive.sample.json)；两个样例的覆盖状态与 `schemaVersion: 1 → 2` 迁移说明见 [样例说明](examples/README.md)。**`schemaVersion: 1` 的题包不能直接通过 v2 校验**，须按该迁移表升级（补顶层 `questionType`、补题组项 `itemType`、把 `learningHypotheses[].candidateDistractorStrategy` 改名为 `candidateErrorStrategy`）；迁移会改动文件，须递增 `revision` 并使受影响评审失效，不是无损操作。不另维护与 schema 不一致的 YAML/frontmatter 状态模型。

- `request` 保留教师输入与原始学情；`taxonomySources` 记录各源版本和指纹，`knowledge` 保存考点映射、未解决项，以及本次实际使用且源中 `needs_review=true` 的节点（`knowledge.needsReviewNodeIds`；非空时不得无提示地交付为最终作品，须在 `risks` 中明示）。
- `questionType` 在阶段 0 由教师确定、写入题包顶层后不改（中途换题型等于换任务，须新建 `taskId`）；`concepts[].itemProgression`、`questionSet` 与 `simulations` 的形态都由它决定。`design.expectedDifficulty` 的第四个维度按题型取一个且不得互换：选择题用 `distractorDiscrimination`，综合题用 `scoringDiscrimination`。
- `learningHypotheses`、`concepts`、`selectedConcept`、`visuals` 分别保存学情假设、候选构思、选定构思与图表状态；具体合法状态以 schema 为准。
- `stage` 表示流程阶段；`readiness` 为构思待选择、初稿完成、可使用、待补充四态，不能把阶段推进等同质量通过。
- 教师通过自然语言选择构思、审批图表，确认记录绑定对象 revision；关键变更使相关确认或评审失效。跨会话恢复读取题包，不要求教师维护状态文件。

确认边界见 [执行方案 §6.2](geography-question-generation-execution-plan.md#62-确认及修改失效)。无图任务如何编码 `visuals_approved` 仍是待确认的阶段表示问题，不擅自修改 schema 或技能。

## 7. 核心组件

### 7.1 输入归一器

职责：

- 提取年级、主题、学情、目标难度、模式和指定材料；
- 保留教师的原始学情描述；
- 识别缺失但会改变任务边界的信息；
- 不询问教材出版社；
- 不把“高一”自动等同于固定教学进度。

最小可继续条件：年级或学段、主题或知识点、学情描述均可识别。

### 7.2 Taxonomy 解析与知识定位器

每次会话现场读取 `E:\知识图谱\config\knowledge_taxonomy_*.yaml`：

1. 读取 meta.version、status 和构建时间；
2. 解析 `domain → theme → knowledge_unit`；
3. 为节点建立 `id/name/aliases/definition/includes/excludes/source_refs/status/confidence/needs_review` 索引；
4. 以名称、别名和定义匹配教师主题；
5. 输出精确匹配、近似候选或未收录；
6. 记录本次使用的文件、版本和节点，以及源中 `needs_review=true` 且本次实际使用的节点（写入 `knowledge.needsReviewNodeIds`）；
7. 不生成或写回新 ID。

异常策略：

| 情形 | 行为 |
| --- | --- |
| 精确匹配且无需复核 | 正常进入构思 |
| 多个近似匹配 | 展示候选节点及差异，等待教师选择 |
| 节点 `needs_review=true` | 允许构思；记入 `knowledge.needsReviewNodeIds`，最终参赛稿前必须显著提示并确认，不得无提示地交付 |
| 未收录 | 标记 taxonomy gap，教师决定换点或待确认继续 |
| taxonomy 不可读 | 停止声称知识图谱对齐；可在教师授权后生成非最终草案 |

### 7.3 课标与教材共同知识核验器

职责不是指定教材版本，而是验证“答案所需知识是否属于高中地理共同知识”。

核验输出：

- 课标内容要求及行为动词；
- 主要核心素养；
- taxonomy 节点与课标的关系；
- 答案所需的必备知识陈述；
- 教材共同知识依据；
- 可能因版本深度差异而产生的风险。

如无法读取可核验的课标或教材依据，不得使用引号伪造原文。可标记“待核验”，但最终参赛稿应在教师授权或补充材料后才能宣称完成对齐。

### 7.4 学情假设生成器

输入教师的模糊学情和知识节点，输出 2—3 个待验证认知障碍。每个障碍包含：

```yaml
id: LH-01
teacher_input: 学生对热力环流概念不理解
hypothesis: 无法建立冷热差异、垂直运动、气压差异和水平气流的因果链
observable_error:
  - 把气温高直接判断为近地面高压
  - 只判断垂直运动，不判断水平气流
candidate_error_strategy: 因果倒置或局部链条选项   # v2 由 candidate_distractor_strategy 改名；选择题写干扰项策略，综合题写典型错答或漏点策略
status: proposed
```

系统必须使用“可能”“待验证”等表述。教师选择后，选中的障碍才进入题组测量目标。**按题型分叉**：选择题的 `observable_error` 写选项层面的错误表现、`candidate_error_strategy` 写将来对应哪类错因的干扰项；综合题写答卷层面的漏点或错答表现，以及典型错答或漏点策略。

### 7.5 现实证据检索器

按以下类别并行检索，但在形成构思前完成来源核验：

- 近 12 个月新闻事件；
- 国家战略及其最新进展；
- 政府、国际组织或科研机构数据；
- 地理方向专业论文；
- 如涉及地图，官方地图或行政区划数据。

来源优先级：

1. 政府部门、教育考试机构、统计与自然资源主管部门；
2. 国际组织、国家级科研机构和大学正式研究页面；
3. 论文出版社页面、DOI、正式数据库或作者公开全文；
4. 权威新闻机构；
5. 其他来源只作线索，不直接作为关键事实依据。

每条来源记录：

```yaml
source_id: S01
type: policy | news | dataset | paper | map | curriculum | textbook | question_style
title: "..."
publisher_or_institution: "..."
published_at: "YYYY-MM-DD"
event_time: "YYYY-MM-DD or range"
accessed_at: "YYYY-MM-DD"
url_or_path: "..."
access_scope: full_text | abstract | metadata | excerpt | dataset
used_claims:
  - "..."
authority_level: primary | authoritative_secondary | lead_only
limitations: "..."
```

新闻超过 12 个月时默认不作为“当年热点”，除非它属于持续事件且有近 12 个月的新进展。国家战略允许长期存在，但必须附最新进展来源和当前命题价值。

### 7.6 论文教学化转化器

不直接把论文内容交给题目生成器。先形成研究转化卡：

```yaml
paper_source_id: P01
research_question: "..."
usable_geographic_mechanism: "..."
relation_to_taxonomy:
  - KU-...
student_prerequisite: "..."
new_information_to_define_in_material: "..."
removed_professional_details:
  - "..."
possible_item_use: "..."
distortion_risk: low | medium | high
```

仅获取摘要时，`access_scope` 必须为 `abstract`，不得提取需要全文支持的具体方法、数值或图示关系。

### 7.7 省份风格适配器

风格档案由 WorkBuddy 在独立流程中生成，本 Skill 只消费。建议档案至少包含：

- 地区、年份范围和样本数；
- 材料类型与平均结构；
- 题组题量；
- 常见设问认知层级；
- 选项构造特征（选择题组）与小问分层、分值结构特征（综合题）；
- 图表类型；
- 知识组合方式；
- 明确的证据题例；
- 适用边界和样本限制；
- 档案版本及更新时间。

未提供风格档案时，使用成熟高考题的一般规范，不凭模型记忆声称模仿具体省份。风格档案与比赛设计说明相互独立：前者约束题目写法，后者解释作品依据。

### 7.8 构思生成器

综合知识节点、学情假设、课标、现实证据、论文转化卡和风格档案，生成 3 个实质不同的概念卡。

概念卡建议结构：

```yaml
concept_id: C1
title: "..."
core_knowledge:
  - taxonomy_id: KU-...
    role: core_exam_point
learning_hypotheses:
  - LH-01
context:
  issue: "..."
  source_ids: [S01, P01]
paper_transformation: "..."
item_progression:
  - item: 1
    cognitive_level: 理解与解释
  - item: 2
    cognitive_level: 分析与推断
  - item: 3
    cognitive_level: 迁移与应用
four_wings:
  primary: [应用性, 综合性]
  secondary: [基础性, 创新性]
visual_proposals:
  - V1
innovation: "..."
expected_difficulty: 中等
risks:
  - "..."
```

三个构思的差异检查至少比较情境、主要证据、认知推进和创新方式。只有措辞不同视为失败，需重新生成。

### 7.9 题组生成器

教师选择或组合构思后生成题组。题型在阶段 0 由教师确定并写入题包顶层 `questionType`，此后不改；一个题包只用一种题型（`single_choice` 或 `comprehensive`），不支持混排。生成顺序建议按题型分叉：

**选择题组（`single_choice`）**

1. 固定测量目标和认知障碍；
2. 固定每题核心考点、认知水平和“四翼”主次；
3. 确定材料中的必要证据；
4. 编写题干；
5. 先写正确答案及成立条件；
6. 根据认知障碍构造干扰项（`distractorMap`，正确项不得出现在其中，每个干扰项映射一种可解释的认知错误）；
7. 回查材料是否足以支持唯一答案；
8. 检查题间独立性和递进；
9. 生成解析、逐题选项分析（含错因类型与 `misconceptionId`）和设计说明。

**材料型综合题（`comprehensive`）**

1. 固定测量目标和认知障碍；
2. 先定各小问的设问层级与分值分配，再写题干；
3. 逐小问列采分点：先写采分要素（`statement`），再写它依据的材料字句（`evidenceChain`），最后分配分值（`points`）——顺序反过来会出现“有分无据”的采分点；
4. 写参考答案（分档），据此写评分标准（`rubric`，至少 2 档，每档须能依据采分点判定）；
5. 写开放答案边界（`answerBoundary` 的 `acceptable`／`unacceptable`，灰区只能进 `notes`）与典型错答模式（`misconceptionPatterns`，每条指明落在哪个采分点或哪条边界上失分）；
6. 回查三级求和与独立性：各问 `answerKey` 各点 `points` 之和 = 该问 `points`；各小问 `points` 之和 = `totalPoints`；采分点之间不重复给分，小问之间不串答案。

综合题没有干扰项，测量目标的独立性靠**采分点互不重叠**保证。上述分值与采分点的三级求和是跨字段约束，JSON Schema 不表达，必须由校验器实现（该校验器尚未实现，见 §5）。

题组内每题建议维护结构化记录：

```yaml
# 选择题：记选项与干扰项映射
item_id: Q1
stem: "..."
options:
  A: "..."
  B: "..."
  C: "..."
  D: "..."
answer: B
core_exam_point: KU-...
supporting_knowledge: []
material_clues: []
cognitive_level: 分析与推断
four_wings:
  primary: 应用性
  secondary: [基础性, 综合性]
distractors:
  A:
    misconception_id: LH-01
    error_type: 因果倒置
  C:
    misconception_id: LH-02
    error_type: 证据遗漏
```

综合题项没有选项与干扰项，其结构化记录是「1 道大题 + 2—4 个小问」形态，小问承载分值、采分点、评分标准与答案边界（层级示意如下，字段名与枚举以 schema v2 为准）：

```yaml
item_type: comprehensive
item_id: Q1
stem: "大题引导语；无引导语时写空串"
total_points: 20
sub_questions:
  - sub_question_id: Q1-1
    stem: "..."
    points: 4
    answer_key:
      - point_id: KP-1
        statement: "采分要素"
        evidence_chain: "该要素成立所依据的材料具体字句与推理结论"
        points: 2
    rubric:            # 至少 2 档，档位描述须能依据采分点判定
      - level: 满分
        score_range: "4 分"
        description: "..."
    answer_boundary:
      acceptable: ["..."]
      unacceptable: ["..."]
      notes: null      # 灰区记录；不得用本字段代替边界
    misconception_patterns:
      - misconception_id: LH-01
        pattern: "可观察的错答或漏点样子"
        how_it_loses_points: "落在哪个采分点或哪条边界上失分"
```

### 7.10 难度与“四翼”分析器

难度分析使用四个维度：

- 考查知识与教材依据；
- 信息加工负荷；
- 认知水平；
- 第四个维度按题型取一个，两者不得互换：选择题用干扰项区分度（`distractorDiscrimination`：每个干扰项指向的认知障碍，以及排除它需要达到何种理解水平）；综合题用采分点区分度（`scoringDiscrimination`：采分点能否把不同水平的学生区分开，答案边界是否在常见作答上可判定），**综合题不得把这一维度写成干扰项分析**。

不得把推理步骤数量作为单独难度指标，不把材料长度等同于难度，不把“四翼”相加形成难度分数。

“四翼”分析为每题指定主要求、次要求和题面证据。题组不强制凑齐四翼，单题也不强制平均承担；没有真实题面承载的要求不得标注。

### 7.11 学生模拟器

默认生成 A、B、C 三名典型学生。模拟器输入为学情假设、题目与答案，以及**按题型**的错因与评分材料——选择题为干扰项映射，综合题为采分点（`answerKey`）与开放答案边界（`answerBoundary`）；不是随机编写三段答案。

每名学生记录：

```yaml
# 选择题：记选项
profile: A | B | C
cognitive_description: "..."
responses:
  Q1:
    selected: B
    reasoning: "..."
    correct_understanding: "..."
    error_step: null
    misconception_id: null
teacher_interpretation: "..."
intervention: "..."
```

```yaml
# 综合题：记书面答案与命中的采分点，不写预估得分数字
profile: A | B | C
cognitive_description: "..."
responses:
  - item_id: Q1
    sub_question_id: Q1-1
    written_answer: "该水平的书面答案"
    hit_point_ids: [KP-1, KP-2]
    missed_point_ids: [KP-3]
    reasoning: "..."
    correct_understanding: "..."
    error_step: "..."
    misconception_id: LH-01
teacher_interpretation: "..."
intervention: "..."
```

模拟必须内部一致：如果水平 C 被设定为存在 LH-01，其错误选项应确实对应 LH-01。综合题的同一条纪律是：该水平的书面答案所命中的采分点（`hitPointIds`）与漏掉的采分点（`missedPointIds`）必须与它被设定的认知障碍一致，并落在该问的 `misconceptionPatterns` 或 `answerBoundary.unacceptable` 上；三档必须在命中采分点上真正分开。综合题的模拟作答**不写预估得分数字**——命中的采分点 id 已足以按 `answerKey` 推导得分，写数字容易被误读为试测数据。不得生成比例或统计指标。

## 8. 图表工作流

### 8.1 先提案，后生成

题组初稿中的图表只生成视觉提案：

```yaml
visual_id: V1
title: "..."
type: line_chart | bar_chart | scatter | process_diagram | map | remote_sensing | other
content: "图中包含的数据、变量、单位或图像信息"
item_function: "图在测量中的作用"
necessity: "为什么不能用文字替代"
linked_items: [Q1, Q2]   # 选择题写小题 id（Q1）；综合题写小问 id（Q1-1）
candidate_sources: [S03]
planned_method: python_plot | paper_redraw | official_map_overlay
risks:
  scientific: "..."
  copyright: "..."
  map_compliance: "..."
  cognitive_load: "..."
status: proposed
```

教师批准后将 `status` 改为 `approved`，此时才允许下载数据、创建清洗文件、绘制或改绘正式图。

### 8.2 数据图表流水线

1. 下载或读取权威原始数据；
2. 保存来源元数据；
3. 仅保留题目需要的变量；
4. 记录缺失值、筛选、聚合、单位换算和派生变量；
5. 使用 Python 绘图；
6. 导出 PNG 供 Markdown 使用，同时保留 SVG/PDF 等高质量格式（工具支持时）；
7. 检查坐标轴、单位、图例、时间范围、数值和视觉可辨性；
8. 用图中信息重新独立作答，确认图题一致；
9. 保存脚本、清洗数据和图表证据卡。

### 8.3 论文示意图改绘

1. 确认实际读取到论文原图和图注；
2. 识别变量、方向、过程和因果关系；
3. 标记保留、删除和重新表达的元素；
4. 判断删除细节是否改变科学含义；
5. 改绘而非截图；
6. 图注注明“据××研究改绘”；
7. 进行科学性、认知适配和版权检查。

### 8.4 地图

1. 使用官方标准地图或官方行政区划数据；
2. 记录来源、审图号、版本和下载时间；
3. 禁止 AI 生成行政区划轮廓；
4. 叠加专题数据时不改变底图疆界表达；
5. 生成后检查地图范围、方向、比例、图例、标注和审图信息；
6. 无合规来源时不生成正式地图。

## 9. 证据与可追溯性

### 9.1 来源不等于证据

每个来源必须记录它实际支持哪项事实或设计决策。只列参考文献但没有使用关系，不能通过证据检查。

### 9.2 事实类型

命题包中的事实分为：

- 课标事实；
- taxonomy 事实；
- 教材共同知识；
- 新闻或政策事实；
- 数据事实；
- 论文研究事实；
- 设计者判断；
- 模拟学生表现。

不同类型必须使用不同标签，不能把设计者判断写成外部事实，也不能把模拟作答写成真实试测。

### 9.3 版权和原创性

- 真题仅用于风格参照和质量检查；
- 题干、材料组织和选项（选择题组）或小问（综合题）不得从真题改写；
- 论文图片采用教学化改绘并引用；
- 不大量复制论文、新闻或教材原文；
- 第三方题目和论文保留原版权状态；
- 作品中只放完成说明所需的短引用和准确来源。

## 10. 校验门

### G0：输入可用

- 年级或学段、知识点和学情可识别；
- 模式和默认参数明确。

### G1：知识边界

- 核心考点映射到当前 taxonomy；
- taxonomy 版本已记录；
- 未收录、近似匹配和 `needs_review` 已处理；本次实际使用且源中 `needs_review=true` 的节点已记入 `knowledge.needsReviewNodeIds`，非空时不得无提示地交付为最终作品；
- 答案所需知识属于高中地理共同知识。

### G2：证据可用

- 课标依据可核验；
- 热点满足时间规则；
- 国家战略有最新进展；
- 论文读取范围如实记录；
- 数据来源权威且单位、年份明确。

### G3：构思确认

- 有 3 个实质不同的构思；
- 教师已选择、组合或修改；
- 未经确认不进入完整成题。

### G4：题目质量

按题型分列。两类题型共同要求：

- 材料证据充分；
- 题间递进自然且不泄露答案；
- 无科学错误、歧义、偏题和暗中超纲；
- 热点与论文不是装饰。

**选择题组**：

- 每题答案唯一（A/B/C/D 之一）、选项齐全；
- 每个干扰项对应一种可解释的认知错误，且能解析到 `learningHypotheses[].id`（`misconceptionId`）。

**材料型综合题**（综合题没有干扰项，对应物是典型错答模式与开放答案边界）：

- 各小问 `points` 之和 = 该问 `answerKey` 各点 `points` 之和；
- 各小问 `points` 之和 = `totalPoints`；
- `rubric` 至少 2 档；
- `answerBoundary` 的 `acceptable`／`unacceptable` 均非空；
- `misconceptionId` 能在 `learningHypotheses` 中解析；
- `hitPointIds`／`missedPointIds` 能在 `answerKey` 中解析。

**分值与采分点的三级求和是跨字段约束，JSON Schema 不表达，必须由校验器实现；该校验器（原 M3 交付物 `geo_question_validate`）尚未实现。**

### G5：图表审批

- 正式绘图前已说明内容、作用和必要性；
- 教师已批准；
- 数据、论文图或地图来源合规；
- 图题一致且通过视觉检查。

### G6：参赛说明

- 设计理念、课标、taxonomy、核心素养、四翼、难度和创新点均有题面证据；
- 3 名模拟学生的认知路径与错因材料一致：选择题与所选干扰项的 `misconceptionId` 一致，综合题与命中采分点及典型错答模式（`misconceptionPatterns`／答案边界）一致；
- 来源与限制完整；
- 未伪造真实试测或统计结果。

任一门未通过时只回退到受影响阶段，不重做已确认且未受影响的部分。

## 11. 降级与失败处理

| 失败 | 降级行为 |
| --- | --- |
| taxonomy 不可读 | 告知无法完成知识图谱对齐；经授权只生成非最终构思草案 |
| 课标或教材依据不可核验 | 标记待核验，不声称最终对齐 |
| 无近 12 个月合适热点 | 改用有最新进展的长期国家战略，或请求教师接受非热点真实情境 |
| 论文只能读摘要 | 只使用摘要明确支持的结论，不复刻图、不使用全文细节 |
| 权威数据不可获得 | 更换构思或将图表方案保留为待补，不编造数据 |
| 无官方地图或审图信息 | 不生成地图，输出配图需求说明 |
| 教师拒绝图表方案 | 局部更换材料或设问，不重做整个题组 |
| 无真实试测数据 | 只做预测性认知路径和定性难度分析 |

## 12. 输出与文件建议

任务目录为 `outputs/出题/<taskId>/`。`package.json` 是任务数据和唯一编辑源；`draft.md` 为六章节稿，`student.json` 为不含答案的题面投影，`teacher.json` 为教师投影，`validation.json` 保存绑定 revision 的校验与评审状态，`visuals/` 保存提案对应的已有附件。

布局与写入规则见 [执行方案 §6.3](geography-question-generation-execution-plan.md#63-最小文件结构)。Markdown 和投影不得分别成为第二份答案或来源权威。来源保存在题包 `sources` 中；后续经授权制图所需的原始数据、处理数据和脚本可以另存支持目录，并记录许可与来源。工作产物不得写入 Skill 源目录。

## 13. 验证方案

### 13.1 结构验证

- 用现有 `npm run verify:geo -- --source` 检查技能入口、frontmatter 与预设结构；
- `geo_taxonomy` 能读取实际 YAML 并输出版本与指定节点，旧消费者仍能取得树结构；
- Markdown 输出包含约定章节；
- 命题包满足 schema，来源记录可解析；后续 Node 校验器必须区分结构检查与语义评审，不把结构通过当作可使用。**该校验器尚未实现**：当前 `plugins/question/` 下只有 `package.schema.json`，全仓没有任何程序读取它；schema v2 的分值与采分点三级求和属跨字段约束，JSON Schema 不表达，须由该校验器实现；综合题的两条语义条件（采分点与分值三级自洽并覆盖参考答案的每一条推理；答案边界在常见作答上可判定、未由 `notes` 兜底）同样只能由评审给出；
- 图表未批准时不存在正式制图副作用。

### 13.2 行为场景

至少覆盖：

1. “热力环流＋概念不理解＋中等难度”的标准参赛流程；
2. 模糊学情能够生成可选择的认知障碍；
3. 知识点精确匹配当前 taxonomy；
4. 知识点未收录时不自动造 ID；
5. `needs_review` 节点能够阻止无提示的最终交付；
6. 新闻超过 12 个月但国家战略仍有最新进展；
7. 论文只有摘要时不使用论文图和具体数据；
8. 图表提案未确认时不绘图；
9. 地图无审图号时降级；
10. 三名模拟学生与三个干扰路径一致（选择题为干扰项映射，综合题为采分点命中与典型错答模式一致）；
11. 专项训练模式压缩说明但保留诊断链；
12. 省份风格档案缺失时不伪称特定省份风格；
13. 材料型综合题题包：分值与采分点三级求和自洽（各问 `points` 之和 = 该问 `answerKey` 各点 `points` 之和，且各小问 `points` 之和 = `totalPoints`）、`rubric` 至少 2 档、答案边界在常见作答上可判定，且模拟作答不写预估得分数字。

### 13.3 内容验证

用 12—15 个候选题组进行真实前向测试，覆盖自然地理、人文地理、区域发展和资源环境安全。每轮只记录可观察问题：

- 知识映射错误；
- 课标或教材边界错误；
- 科学事实错误；
- 材料不足以支持答案；
- 干扰项无效（选择题组）；
- 采分点无证据链、评分标准少于 2 档、分值三级不等或答案边界不可判定（综合题）；
- 图表与题目脱节；
- 热点牵强；
- 论文转化失真；
- 模拟学生路径不一致；
- 来源或地图合规缺失。

未经跨主题验证的个别经验先保留为研究记录，不立即上升为 Skill 硬规则。

## 14. 实施顺序

1. 以本产品文档和技术文档评审需求；
2. 明确 WorkBuddy 省份风格档案格式；
3. 重构 `geo-question-generator/SKILL.md`，先实现二阶段流程和知识图谱只读接入；
4. 增加证据、构思卡、难度/四翼、学生模拟和视觉提案 references；
5. 增加 taxonomy 检查和命题包校验脚本（须覆盖 schema v2 的两种题型分支、分值与采分点的三级求和；**尚未实现**，“命题包满足 schema”目前无法自动校验）；
6. 用“热力环流”完成第一个端到端行为测试；
7. 扩展到 12—15 个题组并回写稳定规则；
8. V1 稳定后再建设正式制图和 Word/PDF 作品包；
9. V2 的具体范围待 V1 稳定后另行定义——原 V2 的「材料型综合题」已按 2026-10-04 决策并入 V1，不再单列步骤。

## 15. 尚待技术确认

- DSH 预设的数据源路径如何在其他安装中配置；本机路径不作为所有安装的固定要求；
- 省份风格档案的 schema 与更新机制；
- 论文检索渠道及全文权限边界；
- 外部数据下载是否需要统一缓存和许可记录；
- 图表批准的会话状态如何在跨会话任务中持久化；
- Word/PDF 模板与比赛格式的适配边界；
- 真实试测数据未来采用 CSV、Excel 还是手工粘贴。
