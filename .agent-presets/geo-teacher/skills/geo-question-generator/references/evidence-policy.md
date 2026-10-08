# 来源与证据策略（课标/教材、热点/论文、来源范围与降级）

> **何时读这份文件**：进入阶段 0「输入归一与依据检查」时；填写或复核 `package.json` 的 `sources[]`、`design.curriculumBasis[]`、`design.textbookBasis[]` 时；判断热点是否符合时间规则、论文 `accessScope` 该填哪一级时；以及在证据缺失、渠道不可用时决定降级口径与交付声明时。纯题面润色不必读本文件。
>
> **事实来源**：`docs/geography-question-generation-m0-baseline.md` §2.1—§2.5 的**实测记录**，字段以 `plugins/question/package.schema.json`（schemaVersion 2）为准，术语以 `docs/术语表.md` 为准。本文件不把"通道存在"写成"内容已读到"，不把失败美化为成功。

## 1. 来源不等于证据

- `sources[]` 每条必填 `usedClaims`（≥1 条），写的是**该来源实际支持的事实、数据或设计判断**，不是来源简介或检索理由。
- 只填一个 `urlOrPath`，再补 `title`、日期，**不构成证据支持**。G2 检查 `sourceId` 可解析、日期格式、`accessScope`、使用关系与已引用本地附件是否存在——**这些是结构检查**；"该来源是否真支持这个事实"属语义核验，只能由内容评审给出，结构通过不得代替它。
- `sourceId`（`S1`、`S2`…）是引用来源的唯一方式：小问、材料、构思情境（`concepts[].context.sourceIds`）、图表提案（`visuals[].candidateSourceIds`）都通过它关联。无人引用的来源直接删除，不堆放。
- `type` 取实际形态：`curriculum`、`textbook`、`policy`、`news`、`dataset`、`paper`、`map`、`question_style`、`teacher_material`、`other`。
- `type: "question_style"` 的来源一律经工具取得：风格档案用 `geo_style_profile`，真题样本用 `geo_search_questions` 与 `geo_question_detail`。真题只用于风格与质量参照，不得改写真题冒充原创。

### `authorityLevel` 三档与可用位置

| 档位 | 定义（按本机实际可获得性） | 可用在哪 | 不得用在哪 |
| --- | --- | --- | --- |
| `primary` | 一手发布：官方政策/公告原文、官方数据集、课标与教材本身、教师提供的原始材料 | 题面事实与数据、课标条目、教材共同知识依据、热点内容与时间 | 不得因"官方"省略 `usedClaims` 与实际读取范围 |
| `authoritative_secondary` | 权威二手：机构/期刊/高校正式出版物、可核验的学术元数据与摘要 | 背景、机制表述、情境佐证、论文依据（限其 `accessScope` 允许的范围） | 不得替代一手数据的原始出处；不得用于引述课标原文 |
| `lead_only` | 线索级：只见链接或题录，未读到正文 | 提出检索方向、定位待核验来源、写入 `risks[]` 与待办 | **不得**作为题面事实、数据、机制或课标依据；不得据此把 G2 判为 `pass` |

## 2. `accessScope` 只按实际取得的内容填写

枚举仅五个值：`metadata` / `abstract` / `excerpt` / `full_text` / `dataset`。

| 值 | 何时可填 | 何时不可填 |
| --- | --- | --- |
| `metadata` | 只有题录信息：DOI、标题、年份、期刊、机构、链接 | 已读到正文段落时不要只写它（应写实际层级） |
| `abstract` | 读到摘要文本，含结构化 API 还原的摘要 | 只有标题与关键词 |
| `excerpt` | 读到正文片段或片段式引用 | 只有搜索摘要（那是线索，记 `lead_only`） |
| `full_text` | 读到完整正文并据其核对内容；教师提供的正文文本按此记 | 空响应体、PDF 未解码、被 403 拦截时**一律不得填** |
| `dataset` | 取得结构化数据集本体或可追溯下载文件 | 只看到数据集介绍页（记 `metadata`） |

- 未读到的来源不得用 `accessScope` 表达"正在争取"：在 G2 该项记 **`pending`**，并在 `limitations` 写明原因（如"HTTP 200 但响应体为空"）。
- `publishedAt` / `eventTime` / `accessedAt` 未知时显式记 `null` 并在 `limitations` 说明，**不伪造日期**。

## 3. 本机实测边界（2026-09-27 实测；出题时据此判断）

- **`web_search` 只返回来源链接，不返回正文**：实测一次返回 8 条 URL 列表，无摘要答案、无正文；来源混合官方 `.gov.cn`/考试院 PDF 与聚合站、公众号。→ 其结果**一律记 `lead_only`**，搜索排名不作为权威性判据。
- **`web_fetch` 能读 HTML 正文**：实测教育部《中国高考评价体系》发布页 https 地址失败（`cross-origin redirect to http://… is not followed automatically`），改用重定向后的 http 地址成功（HTTP 200，读到"四翼"原句）→ 该来源可记 `full_text`。
- **PDF 端点返回空**：AMS 期刊 PDF 端点 HTTP 202、响应体为空；地球科学期刊 PDF 端点 HTTP 200、响应体为空（二进制未解码为文本）。→ 均判"未读到"。
- **出版社站点常 403**：MDPI 论文落地页 HTTP 403 Access Denied（边缘防护拦截非浏览器客户端）。→ 判"未读到"。
- **跨域重定向不自动跟随**：遇到该错误必须改用重定向后的 URL 重试；重试仍失败按降级处理，**不得据原始 URL 声称已核实**。

三条必须执行的硬规则：

1. **HTTP 2xx ≠ 已读取**：202/200 但响应体为空，必须判为"未读到"，G2 记 `pending`，**不得**记成 `full_text`。
2. PDF 经此通道返回空；论文全文若只有 PDF，实际只能达到 `metadata`（靠题录信息），不能声称读过全文、引用其图或方法。
3. 因此**联网渠道下论文的 `accessScope` 不应出现 `full_text`**（实际可达层级为 `metadata` / `abstract` / `excerpt`）；只有教师自行提供的全文才可记 `full_text`（见 §4）。

另注：geo-teacher 预设已把 `tool-web` 的 `fetch` 由 `false` 改为 `true`，但"已注册"以完整重启后的预设会话工具表为准（M0 记录该项为待人工确认）。确认前按"无网页读取"降级。

## 4. 教师提供材料是正常输入路径，不是降级

| 教师提供的形态 | 可读性 | 记录与用法 |
| --- | --- | --- |
| 正文或摘要**文本**（粘贴/上传） | 可读 | 按实际形态记 `accessScope` 为 `full_text` 或 `abstract`；`urlOrPath` 记教师给的文件或标识，`limitations` 注明"教师提供" |
| 论文**图片**（图、表、截图） | 可读 | 仅用于**理解后教学化改绘**（`visuals[].plannedMethod = "paper_redraw"`），图注注明"据××研究改绘"；**不得直接使用论文图** |
| **PDF 文件** | 读不到 | 随发行版 Python 的 site-packages 无任何 PDF 库，不得当可读全文，不得据 PDF 声称已核对方法、数值或图示关系；应请教师另给文本或图片形态 |

## 5. 文献通道当前未建

- M0 实测（2026-09-27）：Google Scholar 两次 `TypeError: fetch failed`（不可用）；OpenAlex、Crossref 均 HTTP 200，可达 `metadata` + `abstract`；Semantic Scholar 429（未带 key 被限流）；CNKI/万方/维普无公开 API 且拦非浏览器客户端。**已确认决策：文献检索通道本期不动，只记录在案。**
- 在确定性文献入口（如 `geo_literature_search`）建成前，出题按"**无文献通道**"运行：
  - 论文依据只能来自教师提供的材料；教师未提供时不得声称已检索并核对了论文。
  - `sources[]` 不得出现声称经联网核实的论文条目，也不得用 `lead_only` 条目充作论文依据。
  - G2 的论文项与 PRD R6 只能判 `pending`，**不能判 `pass`**。
  - 交付物须明示"论文依据待补"：写入 `draft.md` 第五、六部分与 `risks[]`（缺失影响作答时 `blocking: true`）。

## 6. 热点时间规则

- `type: "policy"` / `"news"` 优先使用**命题时点之前 12 个月内**的材料；采用理由写进 `usedClaims`。
- 国家战略不受一年限制，但必须附**最新进展**与**当下命题价值**：`publishedAt`（发布）与 `eventTime`（事件发生）分列，不得混为一谈。
- 每条热点必须记：来源（`urlOrPath` + `publisherOrInstitution`）、发布日期、事件时间、采用理由四项，缺项记 `null` 并说明。
- **删除检验**：删掉热点后题目仍原样成立 → 热点是装饰，须重新设计情境或更换热点，不得只在设计说明里补一句"体现时代性"。
- 承担题面信息的热点必须是 `concepts[].context.sourceIds` 指向的那条来源，而不是另找一条政策文件装饰引用。

## 7. 论文教学化转化链

固定六步，必须留痕：`研究问题/发现 → 提取地理机制 → 判断与考点关系 → 降低专业表达难度 → 转化为高中生可处理的材料 → 设计设问`。

- 记录**实际读取范围**：`accessScope` + `limitations`；语义评审的发现写入 `reviews[]`（`checkType: "semantic"`）。
- **只读摘要时不得声称已核对全文**：不得复刻论文题图，不得引用具体方法、参数、数值或模型；只能使用摘要中明确写出的结论与机制。
- 论文提供的机制进入题面后必须能由高中地理共同知识推导（§8）；不得用论文结论替代学生应完成的推理。
- 需要命题研究时走 `geo_analyze`，需要导出时走 `geo_export_analysis`；不得绕过工具直接读取题库文件。

## 8. 课标与教材

- `design.curriculumBasis[]` 每条记 `statement`（课标内容要求与行为动词）、`behaviorVerb`、`evidenceInItem`（题面中实际承载该要求的证据）、`sourceId`、`verification`。行为动词须与设问、任务对应；`evidenceInItem` 要指向材料或题干中的具体信息，不写"本题考查了……"式口号。**综合题须逐小问指出承载处**，不得只写"整道大题体现"。
- **无法核验课标原文时填 `verification: "pending"`**：可作一般性表述，**不得加引号伪造课标原句**，不得声称完成课标对齐，不得用二手解读替代条目原文。
- `design.textbookBasis[]` 每条记 `prerequisite`（作为答案必要前提的知识）与 `basis`（其属高中地理共同知识的书目/资料定位与适用范围）。
- **答案必要前提知识必须能在高中地理教材共同知识中找到依据**：允许情境超纲，禁止必备知识暗中超纲。材料外术语如影响作答必须在题面解释，不要求学生预先掌握大学地理知识。
- 不询问教材出版社版本，不为特定出版社建立独立知识体系；不得用论文结论代替教材边界证明。
- 考点对齐走 `geo_taxonomy`；课标与教材依据当前无专用工具，只能来自教师提供材料或已读到正文的来源，且必须记录来源与范围。

## 9. 降级表

| 情形 | 判定依据 | 降级动作（落到字段/状态） |
| --- | --- | --- |
| 考点树不可读或解析失败 | `geo_taxonomy` 报读取/解析失败（区别于"无匹配"） | 明示无法对齐；用 `knowledge.taxonomyGap` 或 `unresolved` 记明；经教师选择可形成**非最终**构思；`readiness` 不得 `usable`；不自行生成考点 ID |
| 课标不可核验 | 无原文来源，或 `sourceId` 指向 `lead_only` | `curriculumBasis[].verification = "pending"`，对应门状态 `pending`；交付物写明"课标依据待核验"；不加引号伪造原文 |
| 无近 12 个月热点 | 检索只返回旧材料，或 `web_search` 仅给线索 | 改用教师提供素材，或经教师确认使用非热点真实情境；在 `limitations`/`risks[]` 保留降级说明；不编造近期事件，不把旧闻包装成新热点 |
| 只有摘要 | `accessScope = "abstract"` | 只用摘要明确写出的结论；不使用全文细节、论文图、具体方法或数值；`limitations` 写明"仅摘要"；不声称核对全文 |
| 权威数据不可得 | 只有二手转述、媒体图或无法追溯来源 | 不编造数值；改可追溯来源，或把图表留在 `visuals` 的 `proposed` 提案并说明数据缺口；不得把"教学模拟"数据写成真实机构数据；缺数据时 `readiness` 不得 `usable` |
| 无官方地图或审图号 | 无官方地图/行政区划数据，或拿不到审图号与适用范围 | **只提供配图需求说明，不生成正式地图**；`visuals[].type = "map"` 时 `status` 保持 `proposed`、`files` 为空、`risks.mapCompliance` 写明缺口；不使用 AI 生成的行政区划轮廓；必须读图才能作答时 `readiness` 至多 `draft_complete`/`pending` |

- 降级必须写进题包（`limitations`、`risks[]`、`verification`、门状态），`package.json` 是唯一编辑源：只在对话里口头说明、不落字段，视为未降级。
- 本文件不承诺 V1 之外的交付形式：**正式制图与 Word/PDF 不在 V1 范围**，涉及时只能给出提案与缺口说明。
- V1 的题型为材料型选择题组与材料型综合题两种。综合题的评分体系同样受本文件的来源规则约束：**采分点的 `evidenceChain` 必须落到已读到的来源或材料字句，且 `authorityLevel` 不为 `lead_only`**；不得依据只有链接的来源给分，也不得把 `notes` 里的待裁定灰区当作已核验证据。
