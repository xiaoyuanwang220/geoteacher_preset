# 高中地理出题功能 DSH 桌面端执行方案

> 状态：M0 已记录；M1 数据契约（`plugins/question/package.schema.json`，schemaVersion 2）、目录包技能和考点树扩展已落地（源码），桌面验收待补齐；M2 端到端闭环**未跑通**；M3 的命题包校验/渲染、学生与教师投影、`geo_question_validate` **未实现**，且全仓没有任何程序读取 `package.schema.json`。见 [M1 实施记录](geography-question-generation-m1-record.md)。  
> 更新（2026-10-08）：**出题已转入开发**——2026-10-04 的两项前置（① 材料型综合题已纳入 V1 范围；② 命题包数据格式已升为 `schemaVersion: 2`，支持 `single_choice` 与 `comprehensive` 两种题型、一个题包只用一种题型）已定案，**2026-10-04 之前的暂缓令解除**，本方案的阶段划分与验收要求继续有效并按 M 阶段推进。进度口径：已落地（源码）的是技能目录包（`SKILL.md` + 4 份 references）、命题包 schema v2、选择题与综合题双样例、术语表口径；**未验收**的是 M1 的桌面重启验收（`/geo/taxonomy/meta`、`/geo/taxonomy/query` 与 `geo_taxonomy` 的 `query`/`ids` 参数当时探测为 404，需完整重启桌面）与 4 份 references 的语义评审（只做过禁用词静态扫描）；**未跑通**的是 M2 端到端闭环；**未实现**的是命题包校验/渲染、学生与教师投影、`geo_question_validate` 工具（原 M3 交付物，全仓没有任何程序读取 `package.schema.json`）。详见 [决策记录](决策记录.md) 2026-10-08 行与 2026-10-04 行、[使用指南](使用指南.md) §一.3。  
> 目标环境：官方 DSH Desktop `0.1.7-rc.2`，Windows，`desktop` profile  
> 源码基线：`deepseek-ai/deepseek-harness`，标签 `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`  
> 核对日期：2026-09-27  
> 需求依据：[产品需求](geography-question-generation-product-requirements.md)、[技术设计](geography-question-generation-technical-design.md)  
> 范围：独立实现出题流程，保留与讲题衔接的数据边界；不实施 WorkBuddy 适配。

## 1. 目标与完成边界

在现有 `@geo-edu/dsh-geo-teacher-preset` 中，将出题技能改为“学情与依据检查 → 三个构思 → 教师选择 → Markdown 命题初稿”的两阶段流程。出题独立完成，不以讲题功能改造、题库入库或新增桌面面板为前置条件。

V1 支持两种题型，**一个题包只用一种题型**，由题包顶层 `questionType` 声明一次，**不支持混排**：

- 材料型选择题组（`single_choice`）：默认一则共用材料与 2—3 道单项选择题（`items[]` 的小题）；专项训练允许只出 1 道。小题记 A/B/C/D 选项、唯一答案与干扰项映射。
- 材料型综合题（`comprehensive`）：一则共用材料与 1 道大题，内含 2—4 个小问；每个小问带分值、采分点（要素 ＋ 证据链 ＋ 分值）、至少 2 档的评分标准、开放答案边界与典型错答模式。综合题**没有干扰项**。

术语上，选择题内的独立设问称「小题」（id 形如 `Q1`），综合题内的称「小问」（id 形如 `Q1-1`），综合题的评分单元称「采分点」（id 形如 `KP-1`）；以 [术语表](术语表.md) 为唯一权威。题型在阶段 0 由教师确定，中途换题型等于换任务，须新建 `taskId`。支持参赛、专项训练两种用途，省份风格是可选约束，不是第三种用途。

完成状态必须区分：

| 状态 | 含义 | 可对教师作出的声明 |
| --- | --- | --- |
| 构思待选择 | 已形成三个构思，尚未获教师确认 | 可比较、选择或修改方向 |
| 初稿完成 | 完整题组及说明已形成，可以包含必要图表占位或待核验依据 | Markdown 初稿完成，列明尚缺内容 |
| 可使用 | 必要材料与图表齐备，结构和语义核验完成，无影响使用的阻断项 | 题组可用于相应教学任务；是否符合具体比赛规则仍按该比赛要求判断 |
| 待补充 | 证据、确认或必要图表缺失 | 只能交付构思或初稿，不宣称最终对齐、完整成品 |

正式制图和 Word/PDF 作品包在 V1.x 实现。V1 的纯文字题组可以达到“可使用”；必须读图才能作答的题组，缺图时只能达到“初稿完成/待补充”。已有教师提供的适用图表可在核实来源与使用条件后使用，不必重新绘制。

综合题标“可使用”另加两条**语义**条件（结构校验查不出，必须有评审记录）：① 采分点与分值三级自洽且覆盖参考答案的每一条推理；② 答案边界在常见作答上可判定、未由 `notes` 兜底。任一条未评审，综合题只能停在“初稿完成”。详见 §7.1。

不建立数据库、通用工作流引擎或自动知识图谱写回通道。命题的专业判断交给模型与内容评审；确定性的字段、引用、版本、文件及一致性检查交给代码。

## 2. rc.2 桌面端源码事实与落地约束

下表的 S 编号对应附录 A 的固定 commit 源码链接。源码机制、本机配置与运行验证分别记录，不能互相替代。

### 2.1 桌面宿主与预设加载

| 已核对事项 | 源码或本机证据 | 实施约束 |
| --- | --- | --- |
| Electron 启动独立 Desktop Host，Host 使用共享 `runProfile` 启动 Web 应用 | S1、S2 | 业务能力扩展现有预设及宿主插件，不修改 Electron 主进程、preload 或安装包 |
| 桌面 profile 路径为 `$DSH_HOME/profiles/desktop`；Host 默认端口参数为 19387 | S2、S3 | 验收针对 desktop profile 和实际运行地址，不能把 CLI/Web 另一 profile 的成功当作桌面成功 |
| 桌面初始化外部插件 profile，并与内置运行时安装目录分离 | S4、S5 | 在预设包声明依赖和导出；不向内置运行时或 app.asar 写文件 |
| profile 按 bundle 列表装配各包 patch，再应用 profile 等覆盖层 | S5 | 生效配置要核对最终组合，不能只看预设文件 |
| 本机 desktop manifest 的依赖为 `link:E:/geo_edu_agent/.agent-presets/geo-teacher`，bundle 列表包含该包 | 本机 `C:/Users/xxx/.dsh/profiles/desktop/package.json` | 当前无需 E:→C: 双副本同步；此结论属于本机开发部署方式，不是所有 DSH 安装的通用规则 |
| 预设注册时用声明上下文的 `baseUrl` 挂载其插件 | S6；本仓库 `cordis.patch.yml` | 本地插件继续使用包子路径导出，技能根继续从包位置解析，不使用依赖 profile 工作目录的相对插件名 |

源码核对确认 Desktop 包版本为 `0.1.7-rc.2`。实施前仍需从本机“关于”或安装元数据记录实际版本；升级后重新核对关键行为，不沿用 rc.2 结论。

### 2.2 修改何时生效

rc.2 的 `dsh-base` 虽装载 HMR，但明确配置 `root: []`：默认启用 profile 配置监听，未启用通用模块目录监听。HMR 源码监听 profile manifest、profile patch 和 home patch；不能据此推断链接包内任意文件都被监听。[S7、S8]

| 修改 | 本方案采用的生效与验证方法 |
| --- | --- |
| 技能目录中的 `SKILL.md`、平铺技能文件 | 技能发现器默认监听技能入口；改后重新调用技能，确认实际内容和唯一名称，不需要为纯技能文档修改例行重启 |
| `references/` 与其他支持文件 | 不触发技能目录刷新；下次显式读取该文件取得新内容。已进入会话的旧文本不会自动被替换 |
| 插件 JS、预设包内 `cordis.patch.yml`、包导出或依赖 | 本项目默认用完整重启 Desktop Host 后验收；只有单独验证过监听根和重载结果，才可改用 HMR |
| profile 自身配置 | 源码支持配置热刷新，仍须检查刷新结果及预设诊断，不以文件保存成功判断挂载成功 |

rc.2 预设注册器会将旧 generation 标为 retired，并在使用者归零后回收；“旧代永不 dispose”不能作为本版本通用事实。现有会话可能仍持有旧代，因此结构变更验收使用重启后的新测试会话。[S6]

桌面关闭主窗口可能仅隐藏到后台，不能把点击 × 当成重启。验收时确认应用及其 Host 已退出，再启动并检查目标预设。桌面原生退出行为依据见 S16。

### 2.3 技能发现、加载和上下文预算

| 机制 | rc.2 源码结论 | 本项目约定 |
| --- | --- | --- |
| 发现形态 | 根目录下一层 `<name>.md` 或 `<name>/SKILL.md`；支持自定义技能根 | 迁为目录包，删除同名平铺入口，避免重名候选 |
| 支持资源 | 目录包返回 `resourceBase`，渲染结果说明相对资源的基目录 | references 按阶段读取，不假设 DSH 自动加载它们 |
| 目录说明 | `catalogDescriptionMaxLength` 默认 500，按字符串长度裁剪；目录使用 name/description | 触发范围放 description 前部，长度不超过 500；不依赖 whenToUse 路由 |
| 技能正文 | `skill` 工具返回完整正文，并增加资源说明及包装文本 | 正文保持简短；根文件只保留边界、确认点、完成条件和资源路由 |
| 8192 阈值 | 工具结果修剪器按 Unicode 码点计数；`compaction-basic` 在满足上下文压力条件或溢出恢复时调用它 | 8192 不是技能解析或首次加载的硬上限；长工具结果在压缩时有被删去中段的风险 |
| 技能目录监视 | 默认 watch=true，相关事件限于技能入口；支持文件不属于入口事件 | 文件改动后按真实读取验证，不声称 references 会自动刷新目录 |

依据：S9—S13。工程预算采用根正文不超过 6000 Unicode 码点、description 不超过 500 个 JS 字符，并测量实际渲染后的工具文本，为包装信息留余量。该预算是本项目维护约定，不冒充 DSH 格式限制。reference 同样按需读取并控制单次结果长度；关键确认与完成条件不能只出现在容易被裁剪的长文中段。

### 2.4 搜索与网页读取

`tool-web` 分别注册 `web_search` 和 `web_fetch`，search/fetch 默认各自为 true。本机预设现设置 `fetch: true`，配置允许注册网页读取；M0 可用性记录与当前 `cordis.patch.yml` 为本机依据，运行时是否加载仍须在预设会话验证。[S14]

rc.2 base 提供 web 服务、DeepSeek 搜索提供方和 HTTP 抓取提供方；是否能成功执行仍取决于有效配置、凭证、网络及提供方可用性。web 服务会区分未注册、不可用、多提供方歧义等错误。[S7、S15]

实施时分别检查：
1. 目标预设会话是否实际拥有搜索工具，能否返回可追溯的官方来源。
2. 是否拥有网页读取工具，能否读到所引用段落，而不只是搜索摘要。
3. 论文访问实际达到 metadata、abstract、excerpt 或 full_text 中哪一级。
4. 如启用 fetch，只修改需要的预设配置并验证宿主提供方；不重复注册整套 web 服务。
5. 无凭证或网络不可达时记录明确降级；改用教师提供材料不能被写成“联网验证通过”。

### 2.5 本地运行时与依赖

桌面提供 `load_workspace_dependencies`，返回独立 Node/Python 等运行时路径。它不是把解释器永久加入 PATH 的机制。实际运行时按工具返回值定位，不硬编码 Codex 或其他产品的依赖目录。[S16]

V1 的命题包使用 JSON，校验与渲染采用单一 Node 实现，不额外维护 Python 校验器。Python 留给后续制图。taxonomy YAML 的解析需正确支持真实源文件，不能因未预装 PyYAML 就再实现一套不完整 YAML 解析器。

新增依赖必须声明在实际运行的预设包中；仓库根 package.json 中已有 `yaml` 不等于发布或其他安装中的预设自动具备该依赖。不得根据某次沙箱 EPERM 推导“桌面插件不能使用管道”；只有需要子进程时才在目标环境验证，本期校验不需要 Python 子进程。

## 3. 需求与交付契约

| 编号 | 要求 | 实施及验收 |
| --- | --- | --- |
| R1 | 先提出三个实质不同构思，教师选择、组合或修改后才成题 | 对话记录与确认记录对应；不能仅检查有无 draft 文件 |
| R2 | 模糊学情转为 2—3 个待验证的认知障碍 | 保留教师原话，假设明确使用“可能/待验证”；所选障碍进入测量目标 |
| R3 | 当前考点树只读、记录版本、不造 ID | 记录实际源文件、版本、状态与读取指纹；近似、未收录、needs_review 有明确处理 |
| R4 | 答案必要前提属于高中共同知识 | 有课标和教材依据；情境可以陌生，必要术语必须在材料中解释 |
| R5 | 热点与考点实质相关 | 优先近 12 个月；长期战略有新进展；删除后仍可原样成立时重新检查情境必要性 |
| R6 | 论文经教学化转化，读取范围诚实 | 有来源与转化记录；摘要不支持全文细节、原图或具体方法时不得使用 |
| R7 | 正式制图前确认图表内容、作用和必要性 | V1 提案记录；后续制作入口校验对应版本的批准状态 |
| R8 | 不伪造试测统计 | 无真实数据时仅定性预计难度与依据，不输出虚构正确率、难度系数或区分度 |
| R9 | 三水平学生模拟 | 明示“预测性认知路径”，错误路径与障碍一致：选择题与干扰项映射一致（模拟作答记所选 A/B/C/D），综合题与典型错答／漏点一致（模拟作答记书面答案与命中采分点，不写预估得分数字）；教师提供真实记录时优先分析真实数据 |
| R10 | 选择题答案唯一、材料充分、干扰项有错因；综合题采分点与答案边界可判定、材料证据充分 | 结构校验与独立内容核验分开，题间不泄露答案 |
| R11 | 四翼分析有主次和题面证据 | 不强凑四项，不把四翼当作难度等级 |
| R12 | 六大 Markdown 章节覆盖十二项内容要求 | 依据 PRD §12；PRD §6.3 的十二项不是十二个顶级章节 |
| R13 | 两种用途、可选省份风格 | 缺风格档案时用一般高考命题规范，不伪称某省风格 |
| R14 | 原创与追溯 | 真题仅用于风格与质量参照，不改写真题或论文题图冒充原创 |

六大章节固定为：学生用试题、答案与解析、命题设计说明、典型学生模拟作答、来源与证据、风险与待确认事项。专项训练可压缩第三、第五部分，但保留知识依据、答案解析、干扰项对应（综合题为采分点、评分标准与答案边界）和学情诊断。

“认知障碍”“四翼”等本方案沿用的 PRD 用语，须在实施阶段与术语表核定并补齐定义；未核定前不在运行技能中另造相互冲突的定义。“五段式”与新交付结构的适用范围也在该步骤厘清，不继续把旧技能格式作为 V1 验收标准。

## 4. 与讲题的边界

### 4.1 本期复用与独立范围

复用 `geo_taxonomy`、`geo_style_profile`、`geo_search_questions`、`geo_question_detail`；需要命题研究时按现有接口消费 `geo_analyze`。跨插件通过 `geoKernel` 等正式服务交互，不 import 其他插件实现，也不以读取其他插件私有文件充当接口。

本期不修改 `geo_solve / geo_judge / geo_explain` 和两个讲题技能，不把生成题自动写入 `E:/知识图谱`。现有讲题工具的入口是题库 qid，底层查现有题库；生成题包的 ID 不能直接当作现成题库 qid 使用。

### 4.2 预留数据衔接

出题产物保留稳定 taskId、questionSetId、itemId 与 revision（综合题另有 subQuestionId、采分点 pointId）。学生题面和教师内容分别形成可读取的投影，字段列表按题型分列：

- 学生题面：共用材料、题干与必要图片引用。选择题为各小题题干与 A/B/C/D 选项；综合题为大题引导语与各小问题干，并给出各小问分值（`points`）。不得包含答案、解析、干扰项错因、模拟作答或透露答案的证据标签。
- 教师内容：答案、逐题解析、考点映射、命题设计说明和评审结果。选择题另有干扰项映射（`distractorMap`）；综合题为各小问的采分点（`answerKey`：要素 ＋ 证据链 ＋ 分值）、评分标准（`rubric`）、开放答案边界（`answerBoundary`）与典型错答模式（`misconceptionPatterns`）。
- 综合题的学生投影须排除 `answerKey`／`rubric`／`answerBoundary`／`misconceptionPatterns`：四者都是答案侧内容，投影检查须逐项确认缺失，不能只看通用禁用词。
- 两类内容共享题组及设问 ID（选择题为小题 ID，综合题为小问 ID），并绑定同一 revision；题面变化使旧评审失效。

后续讲题适配器可以从题包读取这两种投影，再接入 solve → judge → explain。V1 只定义并验证投影，不实现适配器、不扩展现有 qid 语义。

出题上下文已知答案，不能把同一上下文中的再次作答称为“独立解题”。三水平模拟用于解释预期认知路径，不能证明答案唯一。答案核验采用教师审题或只收到学生题面的独立验证会话；本期不为此强制新增多 Agent 编排。

## 5. 首个闭环与证据接入

先用“高一、热力环流、概念不理解、中等难度”完成一个真实闭环，再扩充技能支持文件。输入至少含学段/年级、考点或主题、教师提供的学情；不把年级等同于固定教学进度，不询问教材出版社版本。

### 5.1 数据可用性清单

| 能力 | 首轮要确认的输入/输出 | 不可用时 |
| --- | --- | --- |
| 考点树 | 从配置路径读取 `knowledge_taxonomy_*.yaml`；返回匹配节点、定义、包含/排除项（源中存在时）、needs_review、文件版本与状态 | 明示无法对齐；经教师选择可形成非最终构思，不自行生成 ID |
| 课标 | 可读取的版本、条目与位置，实际支持哪些考查要求 | 标记待核验，不杜撰引文或声称完成对齐 |
| 教材共同知识依据 | 书目/资料定位、适用范围、支撑的答案前提 | 请求必要材料或调整方案；不能用论文结论代替教材边界证明 |
| 热点/政策 | 搜索结果、正文可读范围、发布日期、事件时间、最新进展 | 教师提供素材或确认非热点真实情境；保留降级说明 |
| 论文 | 标识符或链接、实际读取范围、可用结论、转化卡 | 仅使用已读范围支持的内容，不伪称全文核实 |
| 数据与图表 | 机构、年份、单位、授权/使用限制及拟用来源 | 不编造数值；图表保留提案或更换情境 |
| 风格 | 实际样本、地区、年份、来源及适用边界 | 使用一般规范，不声称特定省份风格 |

在提出构思前核查关键证据是否存在。图表批准前只完成来源定位和可用性检查，不提前创建正式制图所需的数据下载、清洗和绘图产物。若无法在这个边界内确认数据足够支持构思，明示风险，不承诺图表必能实现。

### 5.2 考点树接口的最小扩展

保持旧调用 `geo_taxonomy({})` 的 `status/roots` 兼容，新增可选 query/ids 以返回本次相关节点，避免整树大量输出和现有 render 截断。版本信息放在简短元数据中，不埋在大树末尾。

增加 `sources: [{file, version, status, contentHash, readAt}]`，保留每份文件各自版本，不假设四份文件永远同版。needs_review 归一化为布尔值；读取/解析失败与真正无匹配分开返回。不继续把异常吞成空树后返回 success。

现有 core 的简化解析未覆盖完整 YAML 与所有边界字段。实施时选用预设自身声明的 YAML 解析依赖，并用实际源文件验证；解析集中在 core，现有树消费者继续取得原数组结构，新元数据通过兼容接口暴露。不增加 Python 兜底解析器。

## 6. 命题包与确认记录

### 6.1 唯一编辑源

正式落盘采用 `outputs/出题/<taskId>/package.json` 作为唯一编辑源；这里的 package.json 是任务数据，不是 npm 包。Markdown、学生题面与教师内容均由该数据生成，不分别维护答案、选项或来源的第二份权威内容。教师直接编辑 Markdown 后，需要先回收改动到任务数据并重新校验；旧渲染稿不能继续视为一致。

工作产物不写入 Skill 源目录。来源记录嵌在任务数据中，必要时可导出 sources.json，但导出文件不是另一份编辑源。不同时维护 state.yaml 与 sources.yaml 的重复状态。

| 字段 | 最小内容 |
| --- | --- |
| schemaVersion / taskId / revision | 数据格式版本、任务唯一标识、单调递增修订号 |
| mode / stage / readiness | competition 或 targeted_practice；当前工作阶段；构思待选择、初稿完成、可使用或待补充四态 |
| questionType | 题型，顶层声明一次：`single_choice` 材料型选择题组或 `comprehensive` 材料型综合题；一个题包只用一种，不支持混排。放顶层而非 `questionSet` 内，因为题型在阶段 0 就由教师确定，`simulations` 与 `concepts[].itemProgression` 的形态也由它决定 |
| request | 年级、主题、教师学情原话、难度、已教范围及其他实际提供约束 |
| taxonomySources / knowledge | 文件、版本、状态、内容指纹；选定节点及未解决映射 |
| knowledge.needsReviewNodeIds | 本次实际使用、且源中 `needs_review=true` 的考点节点。非空时不得无提示地交付为最终作品，须在交付稿与 `risks` 中明示 |
| learningHypotheses | 稳定 id、假设、可观察错误、`candidateErrorStrategy`、proposed/selected/rejected 状态 |
| concepts | id、revision、情境、来源 ID、测量目标、递进、图表提案及风险；构思差异的比较依据 |
| selectedConcept | 选定/组合构思与 revision；组合后形成有明确内容的新修订 |
| questionSet | 题组 ID、共用材料、题组项数组。选择题为 1—3 道小题，每小题含 ID、题干、A/B/C/D、答案、解析、干扰项及障碍映射；综合题为恰好 1 道大题，其内 `subQuestions[]` 含 2—4 个小问，各问含 ID、题干、分值、采分点（要素 ＋ 证据链 ＋ 分值）、评分标准、答案边界与典型错答模式 |
| design | 课标与教材依据、核心考点/支撑知识/材料线索、四翼、预计难度、创新边界 |
| design.expectedDifficulty.scoringDiscrimination | 综合题的难度第四维度：采分点能否把不同水平的学生区分开、答案边界是否可判定。选择题仍用 `distractorDiscrimination`（每个干扰项指向的认知障碍）；两者不得互换，综合题不得把该维度写成干扰项分析 |
| simulations | A/B/C 三水平、简短认知路径、错误环节、障碍 ID、教学干预，注明模拟。选择题记各小题所选 A/B/C/D；综合题记各小问的 `subQuestionId`、`writtenAnswer` 与命中/未命中采分点 id，**不写预估得分数字** |
| sources | sourceId、类型、标题、机构、日期、urlOrPath、accessScope、usedClaims、限制；未知日期显式记录，不伪造 |
| visuals | id、revision、内容/作用/必要性、关联小题（综合题为小问）、来源、风险、状态与已有文件引用 |
| confirmations | 确认类型、对象 ID、对象 revision、教师原话、时间、可获得的会话/消息引用 |
| reviews / risks | 评审所针对的题面 revision、方法、发现、待补事项；结构与语义结论分开。综合题标 `usable` 所需的两条语义条件（采分点与分值三级自洽并覆盖参考答案的每一条推理；答案边界在常见作答上可判定）也在此留痕 |

本表字段名以 `.agent-presets/geo-teacher/plugins/question/package.schema.json`（schemaVersion 2）与 [术语表](术语表.md) 为准。`schemaVersion: 1` 的题包**不能直接通过 v2 校验**，须按 [样例说明](examples/README.md) 的 v1→v2 迁移表升级（补顶层 `questionType`、补题组项 `itemType`、把 `learningHypotheses[].candidateDistractorStrategy` 改名为 `candidateErrorStrategy`、补可选的 `knowledge.needsReviewNodeIds`）；迁移会改动文件，须递增 `revision` 并按 §6.2 使受影响评审失效，**不是无损操作**。

sources 的 accessScope 采用 metadata/abstract/excerpt/full_text/dataset。题目对象（选择题的小题、综合题的小问）、材料、设计判断和图表通过 sourceId 关联实际使用的来源；只填一个 URL 不算证据支持。现实事实、设计判断、模拟表现要明确区分。

### 6.2 确认及修改失效

教师自然语言决定选定构思与图表审批；模型不得凭自己的“已确认”描述创造授权。确认记录引用对应对象的具体 revision；仅保存 approved=true 不足以支持恢复或后续制作。

- 未确认构思：可以提供构思、比较和局部示例，不交付完整题组。
- 构思的测量目标、核心情境或关键证据改变：更新构思 revision，重新获得方向确认。
- 图表内容、变量、用途或必要性改变：旧批准失效；普通文字润色不自动触发重新审批。
- 题面、答案、关键来源或必要图表改变：使受影响的质量评审失效；不重做无关部分。
- 综合题的小问分值或采分点改变：该小问的评分标准与答案边界评审失效，引用该问 `pointId` 的模拟结论同时失效。
- 题型改变：不在原题包上直接改，新建 `taskId`。题型在阶段 0 由教师确定，且 `simulations` 与 `concepts[].itemProgression` 的形态由它决定，中途换题型等于换任务。
- 取消后保留任务记录与状态，不把未确认产物呈现为完成品。
- 跨会话恢复必须读取题包，核对确认对象版本与待办。无法定位确认依据时只补问缺失决策，不凭摘要补造确认。
- taskId 使用唯一标识，不靠可重复的标题 slug 隔离任务；保存校验 revision，发生并发修改时停止覆盖并重新读取。

V1 的确认记录用于可追溯和行为校验，仍由模型可写文件承载，并非防篡改授权系统。若未来要求硬性阻止未批准的制作/发布，必须让相应执行入口验证可信的确认来源；只运行一个只读 validator 无法阻止模型在对话中提前成题。

十二项内容到六章节的对应关系统一见 [交付格式映射表](../.agent-presets/geo-teacher/skills/geo-question-generator/references/delivery-format.md)，不另维护一份映射。

### 6.3 最小文件结构

```text
outputs/出题/<taskId>/
├── package.json          # 唯一编辑源（任务数据，不是 npm 包；两种题型同一位置）
├── draft.md              # 六章节教师交付稿，包含版本标识
├── student.json          # 不含答案与解析的题面投影
├── teacher.json          # 教师内容投影
├── validation.json       # 结构与评审状态报告，绑定 revision
└── visuals/              # 提案对应的已有附件；V1 不自动正式制图
```

投影由同一渲染实现产生，记录 sourceRevision 与内容指纹。学生投影不仅检查禁用字段（综合题须确认 `answerKey`／`rubric`／`answerBoundary`／`misconceptionPatterns` 均未出现），还检查材料、选项、文件名和图片说明是否夹带答案提示。结构筛查不能替代这项内容检查。

## 7. 校验与质量门

### 7.1 返回状态

校验器返回 `structureOk`、`packageRevision`、`gates`、`findings` 和 `readiness`。每项结果使用 pass/fail/pending/not_applicable，并记录 checkType=structural/semantic、检查依据及所针对 revision。只有结构检查完成时，语义项仍保持 pending，不能返回“全部门禁通过”。

| 门 | 可确定性检查 | 必须另做的语义/行为核验 |
| --- | --- | --- |
| G0 输入 | 必填字段、模式、格式 | 学情和测量目标是否可解释 |
| G1 知识边界 | ID 存在、源版本/指纹、未解决项及确认记录 | 必要知识是否属于高中共同知识、近似映射是否合适 |
| G2 证据 | sourceId 可解析、日期格式、访问范围、使用关系、已引用本地附件是否存在 | 来源是否真实支持该事实，热点是否相关，论文转化是否失真 |
| G3 构思确认 | 构思数量、选定对象、确认 revision、状态一致性 | 三构思实质不同；确认来自教师；对话是否提前完整成题 |
| G4 题组质量（按题型分列） | **选择题**：答案为 A/B/C/D 之一、选项齐全、干扰项映射与关联 ID 完整。**综合题**：各小问 `points` 之和等于该问 `answerKey` 各采分点 `points` 之和；各小问 `points` 之和等于 `totalPoints`；`rubric` 至少 2 档；`answerBoundary` 的 `acceptable`／`unacceptable` 均非空；`misconceptionId` 能在 `learningHypotheses` 中解析；`hitPointIds`／`missedPointIds` 能在 `answerKey` 中解析 | **选择题**：答案唯一、材料充分、科学性、题间独立、无歧义或暗中超纲。**综合题**：采分点与分值三级自洽且覆盖参考答案的每一条推理；答案边界在常见作答上可判定、未由 `notes` 兜底；评分标准能依据采分点判定；设问不退化为照抄材料 |
| G5 图表 | 每张图自身状态、批准版本、文件引用、关联对象（选择题为小题 id、综合题为小问 id） | 图表必要性、图题一致、来源及视觉可读性 |
| G6 交付说明（按题型分列） | 六章节内容字段、三水平模拟结构，模拟与该题型的判分对象引用一致：选择题为干扰项，综合题为采分点与答案边界 | 四翼和难度依据成立；模拟路径合理；未伪造试测统计。综合题另须核对难度第四维度是 `scoringDiscrimination` 而非 `distractorDiscrimination` |

**分值与采分点的三级求和是跨字段约束，JSON Schema 不表达，必须由校验器实现**（见 `plugins/question/package.schema.json` 中 `comprehensiveItem`／`subQuestion` 的说明）。综合题标 `usable` 另加两条**语义**条件，结构校验查不出，必须有评审记录：① 采分点与分值三级自洽且覆盖参考答案的每一条推理；② 答案边界在常见作答上可判定、未由 `notes` 兜底。任一条未评审，综合题只能停在 `draft_complete`。`knowledge.needsReviewNodeIds` 非空时须在交付稿与 `risks` 中明示，不得无提示地交付为最终作品。

G5 无图且题目不需要图时为 not_applicable；依赖未制作的图时为 pending 并阻止“可使用”；不能因“存在一张获批图”就放行所有图。仅有 URL 或日期字段合格不能把 G2 的真实性核验标为 pass。

独立核验先使用 student 投影作答，再对照教师内容（综合题按小问对照采分点与答案边界）；发现多解、无解或证据不足则退回局部修改。参赛说明质量和地理科学性依据领域评审标准评估，不用固定标题或“认真分析”等措辞是否出现证明质量。

### 7.2 单一实现与工具接入

先实现一个预设包内的 Node 校验/渲染模块，再由 CLI 和可选模型工具薄封装调用同一实现。没有第二套 Python 校验逻辑，不要求一开始就创建空插件占位。

建议模块归属：
- `plugins/question/package.js`：纯数据校验、学生/教师投影和 Markdown 渲染，无 DSH 生命周期副作用。
- `skills/geo-question-generator/scripts/check-package.mjs`：CLI 包装；只读校验默认不写文件，显式 render 子命令生成投影。
- `plugins/question/index.js`：核心闭环稳定后注册 `geo_question_validate`；读取文件经 DSH fs 服务与明确策略，不绕过宿主文件权限。

工具输入使用 `{ taskId, target: "concepts" | "draft" | "usable" }`，不接受任意 packageDir。taskId 限定格式，解析后的真实路径必须位于配置的输出根；拒绝路径穿越、越界链接与未知 schemaVersion。对 `schemaVersion: 1` 的旧题包不按 v2 放行，报出待迁移项（迁移表见 [样例说明](examples/README.md)）。CLI 同样约束输出根，使用桌面返回的 Node 或已确认可用的本地 Node。

V1 的工具只校验，不下载来源、不生成图、不自动修稿；报告中列出来源真实性等尚待评审项。校验器只能检验所提供的评审记录及版本一致性，不能独立证明记录中的评审已经真实发生。

## 8. 技能与插件变更范围

### 8.1 技能

将 `skills/geo-question-generator.md` 迁入 `skills/geo-question-generator/SKILL.md`，迁移时保证同名入口只剩一个。根文件保留任务边界、两种用途、两个默认确认点、读写边界、质量红线、完成条件与资源路由。

支持文件按首个题组需要拆分，建议先有：
- workflow.md：阶段、确认、回退、跨会话恢复；
- evidence-policy.md：课标/教材、热点/论文、来源范围与降级；
- item-writing.md：构思比较、题组、选择题的题干与干扰项、综合题的小问／分值／采分点／评分标准／答案边界、四翼与难度、学生模拟与学情的对应；
- delivery-format.md：六章节、模拟作答、设计依据及题包字段。

跨主题测试证明有必要后，再拆出 concept-card、curriculum-and-taxonomy、difficulty-and-four-wings、student-simulation、visual-proposal。文件数量不是验收条件，不能强制每轮加载全部文件。

旧技能允许直接 read/glob 抽取题库的路径与当前 persona 取题纪律不一致，迁移时统一为工具访问真题；需要解析派生信息时使用命题研究工具，不让题库文件直读成为讲题答案隔离的旁路。重写 description：2026-10-04 起综合题属 V1，description 须保留两种题型（材料型选择题组与材料型综合题）的触发与边界表述，只去掉旧五段式承诺。

### 8.2 插件与组合

| 文件/模块 | 计划变更 |
| --- | --- |
| core | 考点树可靠解析、相关节点查询、源元数据及显式失败；保持旧树接口兼容 |
| taxonomy | 兼容扩展查询参数与简短元数据输出，避免整树截断 |
| generator | 继续消费现有风格能力，不另建风格数据库 |
| question | 一个校验/渲染实现；需要工具入口时新增薄插件 |
| preset package.json | 声明实际运行依赖；新增工具插件时添加 `./plugins/question` 导出 |
| cordis.patch.yml | 工具插件完成后加入 geo group；按证据需求启用 fetch；补齐出题路由 |
| scripts/geo-verify.mjs | 改成针对有效 bundle/profile 的验证，保留讲题回归断言 |
| 开发说明与术语表 | 更新部署机制、有效配置路径、交付结构适用范围与新增术语 |

question 插件按实际使用注入 tools/fs/geoKernel；若实现 HTTP 才注入 webServer。无新增服务时不增加 isolate 项；新增正式服务时同步 isolate 白名单。包内辅助模块可以相对 import，跨插件实现不得直接 import。

`geo_question_validate` 的新增行使用 `@geo-edu/dsh-geo-teacher-preset/plugins/question`，不使用 `./plugins/question/index.js`。组合/导出/依赖改动完整重启后检查预设诊断与实际工具调用。

### 8.3 面板

V1 以桌面对话作为主入口；暂不新增 `/geo/question/status?dir=` 或原生抽屉。核心流程稳定后，面板确有需要时再增加按 taskId 读取的状态接口，明确任务选择和访问边界。不得使用一个全局“当前任务”变量代表多个会话。

若后续采用原生工作台扩展，单独按 rc.2 客户端扩展契约设计；现有静态 `/geo-teacher` 页不能自动等同于桌面原生面板。

## 9. 实施顺序

阶段编号 M0—M5 表示先后关系，不与问题严重级别混用。

| 阶段 | 交付物 | 完成标准 |
| --- | --- | --- |
| M0 基线与可用性 | 记录桌面版本/profile/预设解析路径；修正 geo-verify 对旧形态的依赖；证据渠道检查记录 | source 检查不依赖旧副本；真正的 desktop 预设可加载；知道每个证据渠道可用到哪一层 |
| M1 数据与最小技能 | 命题包 schema（schemaVersion 2，含两种题型）、学生/教师边界、确认失效规则；技能迁目录包；必要 references；考点树接口兼容扩展 | 数据样例可表达两种题型的完整初稿（选择题与综合题各一份样例）；旧 taxonomy 消费者正常；只出现一个技能入口。**截至 2026-10-08 的进度**：交付物已落地（源码），但桌面重启验收与 4 份 references 的语义评审未完成 |
| M2 首个完整题组 | 输入、依据、三构思、教师选择、初稿、来源与风险记录 | 正常场景跑通；拒绝或修改构思也能继续；缺必要图表时不会宣称可使用。**截至 2026-10-08 的进度**：未跑通 |
| M3 确定性检查与桌面工具 | 单一 Node 校验/渲染实现、正反样例；需要时封装 geo_question_validate 并接线 | 错引用、旧确认、投影不同版等能被检出；桌面工具实际调用成功；不会把结构通过当质量通过。综合题另需检出：分值三级求和（各小问 `points` 之和 = 该问采分点 `points` 之和 = `totalPoints`）、`rubric` 少于 2 档、`answerBoundary` 的 `acceptable`／`unacceptable` 为空、`subQuestionId`／`pointId` 引用无法解析。**截至 2026-10-08 的进度**：未实现，全仓没有任何程序读取 `package.schema.json` |
| M4 跨主题与恢复验证 | 原十二类场景及新增异常场景；12—15 个候选题组的前向测试记录 | 覆盖四个领域；无未解决红线；稳定问题才进入技能规则 |
| M5 可选体验完善 | 任务状态面板或原生工作台接入 | 有真实使用需求，任务隔离明确；不影响对话核心流程 |
| V1.x / V2 | V1.x：正式图表制作与 Word/PDF 作品包导出（不变）。V2：待 V1 稳定后另行定义 | 各自单独定义输入、审批、副作用和验收。**不要把 V2 预设成新的具体范围**：原 V2 的「材料型综合题」已按 2026-10-04 决策并入 V1，不再属于 V2 |

M0 不挂空插件，不把九份 references 全部写完作为首个题组的前提。旧 `agent.cordis.yml/preset.yml` 先标明退役、查清脚本引用，确认无消费者后再移入归档或删除，避免修校验时掩盖真实断言。

## 10. 验证与验收

### 10.1 源码检查与桌面验收分开

`npm run verify:geo -- --source` 应不依赖用户电脑必须使用 link，也不依赖存在旧 C: 副本。它验证预设包导出、有效 patch、服务隔离、插件语法、技能唯一性及保留的讲题回归检查。带 `!!js` 的 patch 不能当普通 YAML 随意执行；使用兼容解析或真实 Loader 验证，明确静态检查边界。

本机部署检查另行核对 desktop manifest 与包实际解析路径；本机预期为仓库 link，其他安装可为正常包安装，不能因此把源码判为失败。

修改插件或组合后，完整重启桌面，再进行 runtime 检查：
- 预设可选且无挂载错误，新会话中实际工具与技能可用；
- 在桌面会话中调用目标工具，验证数据、来源元信息与失败返回；
- 旧讲题工具仍在册，选取原有题库题验证题面/图片及核验接口未回归；
- 健康端点和静态页面仅作冒烟，不代替模型侧工具、权限和技能加载验证；
- HTTP 检查采用实际地址与支持的认证方式，不关闭认证以凑通冒烟。

只修改本方案时不要求重启、不宣称功能已实现。涉及插件/技能实施后按项目开发检查清单执行适用项；旧清单里的双副本和生命周期描述也须按 rc.2 更新。

### 10.2 必须覆盖的行为

保留原十二类场景：
1. 热力环流标准流程：先构思，经选择后成题。
2. 模糊学情生成可选择的待验证障碍。
3. 精确匹配当前考点树并记录实际版本。
4. 未收录不造 ID，允许教师决定换点或待确认继续。
5. needs_review 节点不无提示地进入最终交付。
6. 超过 12 个月的长期战略情境附有近期进展，并解释当下价值。
7. 只读摘要时不使用全文细节、论文图或无依据数据。
8. 图表未确认不发生正式制图及其数据处理副作用。
9. 无合适官方地图来源或所需审图信息时降级为配图需求。
10. 三水平模拟与学情一致且明确不是试测：选择题的错误路径与所选干扰项的心理误区一致；综合题的错误路径与典型错答／漏点一致，作答记书面答案与命中采分点、不写预估得分数字。
11. 专项训练压缩说明，保留诊断链及必要证据。
12. 风格档案缺失不伪称某省风格。

新增边界场景：
13. 拒绝全部构思、组合构思或修改方向后，确认对象和版本正确。
14. 已确认后修改关键材料/图表用途，受影响确认与评审失效。
15. 重启或跨会话恢复，不凭记忆重建审批，不串任务。
16. 搜索可用但 fetch 关闭；搜索或抓取失败；只有摘要——分别正确降级。
17. 含必要图表占位的初稿不标“可使用”；无图题组不被 G5 永久阻塞。
18. sourceId、障碍 ID、小题 ID（综合题为小问 `subQuestionId`、采分点 `pointId`）失配，分值三级不等，投影旧版，缺字段，未知 schemaVersion，`schemaVersion: 1` 的旧题包，均在检出之列。
19. 学生投影无答案及解析派生提示；综合题投影不含 `answerKey`／`rubric`／`answerBoundary`／`misconceptionPatterns`；独立核验只收到该投影。
20. 路径穿越、越界链接、并发 revision 冲突不造成越界访问或覆盖。
21. 连续任务中考点源改变，能记录新版本/指纹并使相关旧核验待复核。
22. 长会话压缩后读取任务文件继续，不因关键指令只留在被裁剪文本中而跳过确认。
23. 只改 references 后重新读取即可取得新内容；插件改动以真实重载/重启结果为准。
24. 综合题的分值三级求和不符（各小问 `points` 之和 ≠ `totalPoints`，或某问 `points` ≠ 该问采分点 `points` 之和）时，校验器能检出并停在 `draft_complete`，不因结构其余部分合格而放行。
25. 综合题的答案边界外作答（`unacceptable` 或 `notes` 兜底的灰区）被误判为正确时，能在语义评审中被发现并要求修订，不得以结构通过代替该评审。
26. 综合题标 `usable` 时两条语义条件（采分点与分值三级自洽并覆盖参考答案的每一条推理、答案边界可判定）任一未评审，只能停在 `draft_complete`；难度第四维度被写成干扰项分析（`distractorDiscrimination`）而非 `scoringDiscrimination` 时能被发现。

### 10.3 内容前向测试

使用 12—15 个候选题组，覆盖自然地理、人文地理、区域发展、资源环境安全。记录输入、实际模型与运行日期、源版本、确认过程、题包 revision、发现的问题和修订结果。多模型验证选取实际计划支持的模型，不要求所有模型产出相同措辞。

逐项检查 PRD §13 的十七项标准，并按题型补齐对应物：两种题型都须覆盖材料充分、科学性、课标/教材边界、四翼证据、难度依据、原创性、热点必要性、论文转化、模拟路径与来源；选择题另看答案唯一与干扰项有效（难度第四维度记干扰项区分度）；综合题另看采分点与分值三级自洽、采分点证据链是否落到材料字句、评分标准能否依据采分点判定、答案边界能否覆盖常见作答、典型错答模式是否映射到学情障碍、设问是否要求判断／解释／评价而非照抄材料。任何多解、伪造数据/来源、未经确认完整成题或必要材料缺失仍被标成可使用，均阻断验收。

个别题组的问题先修题组；跨主题反复出现的机制性问题才回写 references，避免技能累积个案补丁。

## 11. 依赖文档的对齐清单

本执行方案采用 DSH 桌面端作为实施目标。实施阶段同步修订关联文档中的冲突，不删除原产品要求：

| 文档 | 要对齐的内容 |
| --- | --- |
| 技术设计 | WorkBuddy 运行目标改为 DSH；修正 docs/plans 引用；保留外部风格档案作为可选输入 |
| 技术设计数据源表 | 用现场可读路径替换不存在的 processed/indexes 等路径；不保证固定题库数量 |
| 技术设计脚本建议 | Python 校验建议替换为单一 Node 校验实现；Python 用于后续制图 |
| 技术设计状态示例 | 与本方案确认版本、完成边界及任务数据保持一致 |
| PRD | 保留六章节与十二项内容要求的区分；明确必要图表缺失时只交付初稿；特殊降级不冒充十七项全部通过。按 2026-10-04 决策把题型范围与命题包数据格式对齐到「综合题纳入 V1、schemaVersion 2、一包一题型」，修正「综合题暂不包含／留待 V2」的旧口径；具体措辞由 PRD 维护者定 |
| README、术语表、开发检查技能 | 更新本机 link 部署事实、有效 patch 路径、rc.2 generation 生命周期；不继续使用旧副本校验 |
| 运行时技能 | 统一考点术语与交付格式；移除题库直读旁路，并按 2026-10-04 决策把综合题纳入 V1 交付格式（`SKILL.md` 与 4 份 references 的口径以 schema v2 与 [术语表](术语表.md) 为准） |

2026-10-04 决策的范围与数据格式口径，本次已对齐本文档（执行方案）自身。上表的对应修订中，**PRD、技术设计与运行时技能已于同日按同一决策对齐**（见 [决策记录](决策记录.md) 2026-10-04 行），README 与术语表同步更新；本表继续作为对齐范围清单使用，不再逐条标注完成时点。仍未完成的是**实现项而非文档项**——命题包校验器，见 §9 的 M3 行与附录 B。

## 附录 A：官方 rc.2 源码依据

所有链接固定到 commit `477b4f420553e8a52c2fbccc464d7561b239c443`，避免 master 漂移。标签见 [官方 rc.2 发布页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2)。

| 编号 | 源码 | 核对位置 |
| --- | --- | --- |
| S1 | [Desktop Host 进程](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/host-process.ts#L186) | start：启动 dsh-desktop-host，传运行时/profile 路径，IPC 生命周期 |
| S2 | [Desktop Host 启动入口](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop-host/src/index.ts#L23) | loadProfileDirectory、runProfile、desktop、19387 |
| S3 | [桌面路径](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/paths.ts#L17) | resolveDesktopPaths |
| S4 | [桌面 profile 管理](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/src/project-manager.ts#L81) | prepare、createPluginProfile |
| S5 | [共享 profile 装配](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts#L1) | bundle patch 层次、manifest、解析锚点 |
| S6 | [预设注册器](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/src/index.ts#L80) | register、activate、collect、bind |
| S7 | [base 组合](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/bundle/base/cordis.patch.yml#L27) | HMR root: []；第 460 行起 web 服务与提供方 |
| S8 | [HMR](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/hmr/src/index.ts#L206) | profile 配置监听与模块 root 监听分离 |
| S9 | [文件系统技能提供方](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill-filesystem/src/index.ts#L662) | isRelevantWatchEvent、discoverRoot；get 返回 resourceBase |
| S10 | [技能工具](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/tool-skill/src/index.ts#L27) | 500 默认值、execute 全文、catalogDescription |
| S11 | [技能内容渲染](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/skill/skill/src/index.ts#L170) | renderSkillContent、renderResourceHint |
| S12 | [压缩调用时机](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/index.ts#L269) | compactIfNeeded：pressure/overflow 与 pruneSession |
| S13 | [工具结果修剪器](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-tool-result-pruner/src/index.ts#L83) / [计数与默认配置](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-tool-result-pruner/src/config.ts#L10) | 文本块码点计数、8192 默认阈值、头尾保留 |
| S14 | [web 工具配置](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/tool-web/src/index.ts#L83) | search/fetch 分别注册 |
| S15 | [web 服务](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/web/web/src/index.ts#L50) | 搜索/抓取提供方选择和可用性错误 |
| S16 | [官方 Desktop 说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/README.md) / [Desktop 包版本](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/desktop/package.json#L4) | 关闭与退出、内置依赖、安装边界、rc.2 版本 |

## 附录 B：验证状态与剩余范围

已完成：官方 rc.2 源码只读核对；本机 desktop manifest、预设 patch/导出、考点树与讲题工具源码、旧校验脚本引用核对。

截至 2026-10-04 的进度口径（与头部状态行一致，不夸大也不缩小）：

- **已落地（源码）**：技能目录包（`SKILL.md` + 4 份 references）、命题包 schema v2、选择题与综合题双样例（`docs/examples/`）、术语表口径。
- **未验收**：M1 的桌面重启验收（`/geo/taxonomy/meta`、`/geo/taxonomy/query` 与 `geo_taxonomy` 的 `query`/`ids` 参数当时探测为 404，需完整重启桌面）；4 份 references 的语义评审（只做过禁用词静态扫描）。两项截止本次文档改动仍未重跑。
- **未实现**：命题包校验/渲染实现、学生与教师投影、`geo_question_validate` 工具（原 M3 交付物）。全仓没有任何程序读取 `package.schema.json`。
- **未跑通**：M2 端到端闭环。

尚未完成：桌面运行时重启验收、联网提供方可用性测试、技能目录刷新与长会话裁剪实验、真实题组前向测试。上述项目是实施验收任务，不以文档或源码推导代替实际通过记录。

**出题已自 2026-10-08 转入开发**（2026-10-04 之前的暂缓令已解除），按 M 阶段推进；上表四条进度口径是**当时快照**，不代表 M1 已验收或 M2／M3 已完成。本次改动只对齐范围、数据格式与状态的文档口径。

本方案不包含：WorkBuddy 适配、自动知识图谱写回、题库入库、讲题接口改造、通用规则引擎、整卷组卷与分值结构设计、正式制图、Word/PDF 作品包、无真实试测数据时输出正确率／难度系数／区分度，以及把论文或真题改写后冒充原创。

