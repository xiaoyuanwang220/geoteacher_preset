# 中国高中地理课程设计 Harness 构建方案

> 版本：v0.3（方案稿）  
> 日期：2026-08-05  
> 定位：把现有「静态规则技能包」升级为「内容驱动的课程生成执行框架」，让课标、教材、真题、课例成为每次课程设计的强制输入，而不是模型的记忆。

> **修订说明**：
>
> - **v0.1 → v0.2**：根据用户实测反馈修正设计假设——ima 检索能力可靠，未出现检索错误。删除所有为「规避检索失败 / 命中率低」而设计的防御机制（教材章节索引、防御性缓存、命中率兜底等），仅保留：①正确性边界（切片归属核验、课标原文核验）；②性能优化（缓存省 token）；③内容建设（真题蒸馏与标签化）。
> - **v0.2 → v0.3**：①明确 ima-mcp 的调用主体是 **WorkBuddy**（检索由 WorkBuddy 会话中的 Agent 经已注册的 MCP 连接器执行，harness 脚本只做确定性计算，不直连 ima）；②新增**运行状态机与统一执行入口**（`harness/run.py` + `harness/state/`，支持断点续跑与阶段重放）；③为 `lesson.json` 增加**证据引用**（`from_evidence` 块）与**硬 Schema**（`lesson.schema.json` + 渲染前强制校验）；④闭环沉淀改为**教师批准后写入独立派生库**，原始库永不自动写入。

---

## 0. 摘要

当前技能包的迭代方式是在 `SKILL.md` 与 `references/` 中堆叠规则。这部分工作的边际收益已经很低：规则的极限是"要求模型写得严谨"，但模型写不严谨的根本原因是**内容输入缺失**——课标原文靠记忆、教材结构靠猜测、真题情境靠编造、课例参考靠印象。规则再好，也无法凭空生成真实内容。

Harness 的核心思路是**把"内容获取"从模型的临场发挥，变成流程中的强制环节**：

1. 内容资产（课标、教材、真题、课例）统一托管在 ima 知识库中，通过 MCP 实时检索；
2. 每次课程设计前，先执行确定性的**四通道检索**（课标 / 教材 / 真题 / 课例），把结果组装成结构化的**课程证据包**；
3. 设计阶段只允许基于证据包 + 学科规则工作，生成后执行**溯源门禁**，最后把课程决策**回写沉淀**到知识库，形成闭环。

一句话：**Skill 回答"怎么设计"，Harness 回答"用什么内容、拿什么证据、过什么门禁"。**

---

## 1. 现状诊断

### 1.1 当前 skill 的架构

| 层   | 载体                                    | 现状                       |
| --- | ------------------------------------- | ------------------------ |
| 指令层 | `SKILL.md`（步骤0–5）                     | 工作流规则，质量高，但已充分打磨         |
| 规则层 | `references/*.md`（8 个文件）              | 学科写法、课标路由、来源政策、地图规范      |
| 数据层 | `config/china_geography_kg.json`      | 知识图谱结构存在，**数据为空**        |
| 工具层 | `scripts/*_mcp_server.py`             | 官方数据连接器（NBS/CMA）、KG 查询服务 |
| 渲染层 | `lesson.json` → `render_documents.py` | 三件套 docx/html 渲染，稳定成熟    |

### 1.2 质量瓶颈：内容输入，而非规则

逐项对照课程生成中的关键事实性输入，看当前系统从何而来：

| 生成环节  | 需要的真实内容          | 当前来源               | 风险         |
| ----- | ---------------- | ------------------ | ---------- |
| 课标对齐  | 课标条目原文、行为动词      | 模型记忆 / 手动查 ima     | 凭记忆引用=伪造风险 |
| 教材分析  | 章节结构、小标题、栏目、核心概念 | 模型记忆（skill 明令禁止猜测） | 教材分析薄弱或出错  |
| 学情与困难 | 该主题的常见学生困难       | 模型通识               | 泛化、不贴课标    |
| 课堂检测  | 真题情境、认知要求对标      | 模型自编               | 与高考考查方式脱节  |
| 活动设计  | 成熟课例的模式与可取处      | 模型记忆               | 缺少教学法参照系   |

结论：**规则层已经做到"不犯错"的上限，内容层是唯一还能带来数量级提升的地方。**

### 1.3 已有资产盘点（好消息：一半已经就绪）

| 资产                              | 位置                              | 状态        |
| ------------------------------- | ------------------------------- | --------- |
| 课标+教材 PDF（人教全套 6 本）             | ima「课程方案skill资源」/「课标和教材」        | ✅ 已入库     |
| 真题原始材料（15 个文件）                  | ima「真题库」/ raw_data              | ✅ 已入库，待蒸馏 |
| 真题蒸馏契约（题组原始页制作契约）               | ima「真题库」/ 要求.md                 | ✅ 已有流程    |
| 课例库（自然 2 / 人文 6 / 区域 37 / 复习 5） | ima「微信公众号课例」                    | ✅ 已分类     |
| 课例蒸馏成果（51 条）                    | ima「微信公众号课例」/ 06_蒸馏成果           | ✅ 已产出     |
| 课例蒸馏方案（分类+标签+模板体系）              | ima「微信公众号课例」/ 蒸馏方案.md           | ✅ 已有设计    |
| 官方数据连接器                         | `china-geography-data`（NBS/CMA） | ✅ 可用      |
| 渲染管线                            | `scripts/render_documents.py`   | ✅ 稳定      |

缺失的是：**把「制作端」的蒸馏体系接到「消费端」的课程生成流程上的那一层——这就是 Harness。**

---

## 2. Harness 总体架构

### 2.1 定义

本方案中的 Harness = 围绕大模型的**内容感知执行框架**，负责四件确定性的事：

1. **检索编排**：把"本次要查什么"固化成检索计划，按协议执行；
2. **证据组装**：把检索结果整理成结构化的课程证据包（Evidence Pack），全部带溯源；
3. **门禁控制**：生成前校验"该有的证据是否都到位"，杜绝凭记忆填充；
4. **闭环沉淀**：课程完成后，经教师批准把决策资产写入独立派生库。

**调用主体（重要）**：ima 的一切检索动作由 **WorkBuddy** 执行——具体是 WorkBuddy 会话中的 Agent 调用其已注册的 MCP 连接器（`mcp__ima-mcp__search_knowledge` / `mcp__ima-mcp__fetch_media_content` 等）。模型本身不直连 ima；harness 脚本（Python）只做确定性计算（检索计划构造、证据包组装、Schema 校验、门禁、渲染），**不直接发起 ima 检索**。因此"检索能力"= WorkBuddy 的 MCP 连接能力 + ima 的检索质量，两者都是已实测可用的部分。

### 2.2 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  L5 治理与沉淀   溯源标注 · 门禁检查 · 候选沉淀包（教师批准   │
│                  后入独立派生库）· 缓存复用                   │
├─────────────────────────────────────────────────────────────┤
│  L4 生成层       lesson.json（shared+documents+evidence_refs）│
│                  └─ validate → assemble → render → docx+html │
├─────────────────────────────────────────────────────────────┤
│  L3 设计层       references/ 学科规则（瘦身后）               │
│                  + 证据引用规则（from_evidence 必溯源）        │
├─────────────────────────────────────────────────────────────┤
│  L2 证据层       ★ 课程证据包 Evidence Pack（JSON，贯穿全程）  │
├─────────────────────────────────────────────────────────────┤
│  L1 检索层       ★ 检索计划 → 四通道检索 → 结果治理 → 溯源     │
│                  （执行主体：WorkBuddy Agent 经 ima-mcp）      │
├─────────────────────────────────────────────────────────────┤
│  L0 内容层       ima 知识库（3 个原始库 + 1 个独立派生库）      │
│                  + china-geography-data 官方数据连接器        │
└─────────────────────────────────────────────────────────────┘
```

> 所有阶段由统一执行入口 `harness/run.py` 驱动，运行状态记录于 `harness/state/<lesson_id>.json`（见 §6.4）。

### 2.3 与既有组件的关系

| 组件                                                    | 职责             | 变化                                         |
| ----------------------------------------------------- | -------------- | ------------------------------------------ |
| `SKILL.md`                                            | 入口与工作流描述       | **变薄**：删课标路由细节，改为描述 harness 工作流与检索协议入口     |
| `references/*.md`                                     | 学科写法、来源政策、地图规范 | **保留瘦身**：只留"判断框架"，删"内容提示"（如模块路由表）          |
| `references/china-geography-kg.md`                    | 本地 KG 调用       | **保留**，但课标/课例来源优先级改为 ima 实时检索              |
| `config/china_geography_kg.json`                      | 空 KG           | **废弃或冻结**，不再手工填充，由 ima 检索取代                |
| `scripts/` 渲染管线                                       | 文档生成           | 不动                                         |
| ima-mcp（`search_knowledge` / `fetch_media_content` 等） | 内容检索           | harness 的主数据通道；**由 WorkBuddy 注册并调用**，脚本不直连 |
| 蒸馏体系（真题契约 / 课例蒸馏）                                     | 内容生产           | 为 harness 供料；harness 反向提出生产需求              |

---

## 3. 内容资产规划（ima 知识库组织）

### 3.1 四库定位与检索口径

| 库           | 知识库 ID                 | 用途             | 检索入口                |
| ----------- | ---------------------- | -------------- | ------------------- |
| 课程方案skill资源 | `7483884472126341`     | 课标 + 教材（唯一事实源） | 库 + 文件夹「课标和教材」      |
| 真题库         | `7487519297918334`     | 真题题组（含蒸馏题组页）   | 库 + raw_data / 蒸馏产物 |
| 微信公众号课例     | `7490066523902822`     | 课例与蒸馏成果        | 库 + 01–07 分类文件夹     |
| （可选）官方数据    | `china-geography-data` | NBS/CMA 现实数据   | 数据连接器，独立通道          |

### 3.2 命名与标签规范（衔接既有蒸馏方案）

你的蒸馏方案已定义标签体系（`#必修一`、`#问题链驱动`、`#优质课例` 等）。Harness 检索协议将其升级为**第一检索入口**：

- **课标教材**：文件命名含 模块＋册次（如 `人教版地理必修第二册.pdf`）即可。ima 检索实测可直接命中教材切片，**无需额外章节索引**；仅当实际使用中出现特定章节定位不准时，再按需补索引 markdown。
- **真题**：蒸馏后的题组页按「题组原始页」契约命名（`来源试卷｜第X题`），**建议追加标签**：`课标条目编号`（如 `2.4`）、`模块`、`主题`、`行为动词`。标签用于**精准筛选与按条目检索**，提升效率，而非解决命中问题。
- **课例**：蒸馏成果建议统一挂 `#课例编号`、`#教学模式`、`#课标条目` 三组标签，与蒸馏方案中「蒸馏成果文档格式」对齐。

### 3.3 缺口清单（按优先级）

> 修正说明：ima 检索能力实测可靠，本节只保留内容建设本身，不含任何「规避检索失败」的设计。

1. **真题蒸馏推进**——raw_data 是整卷 word，蒸馏为结构化题组页（现有契约）后，检索与定位更精确，可分批推进；
2. **真题与课例标签化**——追加课标条目/模块/主题标签，用于精准筛选；
3. **课标条目→真题映射**——中长期资产，作为沉淀层输出（见 §7）；
4. （可选）**教材章节索引**——仅当实际定位不准时再补，非默认动作。

---

## 4. 检索协议（Harness 核心）

### 4.1 检索计划（Retrieval Plan）

Harness 的第一步是生成结构化检索计划，**而不是直接让模型"去查一下"**。检索计划在步骤2前产出，作为证据检索的执行清单：

```json
{
  "lesson": {"topic": "人口迁移", "module_hint": "必修二", "grade": null},
  "channels": {
    "standard": {
      "search_terms": ["人口迁移", "人口分布、迁移", "说明"],
      "kb_id": "7483884472126341",
      "folder_id": "folder_7484906741449732",
      "required": true
    },
    "textbook": {
      "search_terms": ["必修二 第一章 第二节 人口迁移"],
      "kb_id": "7483884472126341",
      "required": "when_version_confirmed",
      "fallback": "use_standard_only"
    },
    "past_papers": {
      "search_terms": ["人口迁移"],
      "kb_id": "7487519297918334",
      "tags_hint": ["必修二", "2.1"],
      "required": "when_detection_needed"
    },
    "lesson_cases": {
      "search_terms": ["人口迁移"],
      "kb_id": "7490066523902822",
      "folder_hint": "02_人文地理课例",
      "tags_hint": ["问题链驱动"],
      "required": false
    }
  }
}
```

要点：

- 每个通道独立声明 `required`（必须命中 / 条件命中 / 可选），供门禁使用；
- 检索词由「主题词 + 模块词 + 行为动词」三元组构造，行为动词取自课标风格（描述/说明/分析/比较/评价），与现有行为动词核对表一致；
- 教材版本未确认时，`textbook` 通道降级为可选；版本确认后强制。

### 4.2 四通道检索设计

统一执行顺序（**检索动作由 WorkBuddy Agent 调用 ima-mcp 完成**）：`search_knowledge(kb_id, folder_id?, query, tags_filter?)` → 按相关性取 top N → `fetch_media_content(media_id)` 取原文 → 按通道规则提取 → 写入证据包。Agent 在每一步把检索结果交给 `assemble_evidence_pack.py` 落盘。

| 通道       | query 构造   | 提取目标                      | 门禁                                |
| -------- | ---------- | ------------------------- | --------------------------------- |
| **T 课标** | 主题词+行为动词   | 条目编号 code、模块、原文 statement | **必须命中原文**，否则草案标注"课标原文待核对"并停止声称对齐 |
| **B 教材** | 册次+章节+小标题  | 章节结构、小标题列表、栏目名、核心概念词      | 版本已确认时对应得上；不得出现版本确认外的栏目           |
| **P 真题** | 主题词（+标签筛选） | 题组情境、设问角度、考查的课标行为、答案认知层级  | 用于检测/迁移情境时必须有原文支撑                 |
| **C 课例** | 主题词+模式标签   | 教学环节骨架、问题链、活动设计、可取处、适用条件  | 只做参考；取其模式不取其文案                    |

### 4.3 结果治理

> 修正说明：ima 检索实测可靠，本节治理不针对「检索出错」，只负责**正确性边界**（切片归属核验）与**复用秩序**（去重、优先级）。

- **溯源必填**：每条证据记录 `kb_id / media_id / folder / title`；写入课程时转成教师可读来源说明（"来源：《普通高中地理课程标准（2017年版2025年修订）》"），media_id 保留在证据包内供复查；
- **切片≠结论**：沿用真题契约的边界原则——ima 切片只是检索单位，题目归属、课标条目归属必须经原文确认，缺项明确标记；
- **去重与择优**：同一内容多库命中时，按"课标库 > 官方数据 > 课例库"的权威性排序取用；
- **不越权**：课例只贡献模式与判断框架，禁止把课例原文、教材正文、真题题干复制进课程文档（版权规则不变）。

### 4.4 缓存与复用

- 同课标条目、同教材章节的检索结果，在 `E:\tteacher_skill\.workbuddy\harness\cache\<code>.json` 缓存，24h 内直接复用——**目的仅为省时省 token**（大 PDF 反复 fetch 成本高），不是规避检索错误；
- 缓存文件记录检索时间与 media_id 指纹，失效即重取；
- 这一层同时是"课程资产库"的雏形（见 §7）。

---

## 5. 课程证据包（Evidence Pack）

证据包是 harness 的**工作记忆**：检索→设计→生成→门禁全程唯一的"事实来源"，模型不许越过它凭记忆补充事实。

### 5.1 结构

```json
{
  "lesson_id": "2026-08-05-rkqy",
  "meta": {"topic": "人口迁移", "module": "必修二", "version_confirmed": false},
  "evidence": {
    "standard": {
      "code": "1.6 / 2.1",
      "module": "必修二",
      "statement": "运用资料，描述人口迁移的特点及其影响因素……",
      "source": {"kb_id": "7483884472126341", "media_id": "media_xxx", "title": "普通高中地理课程标准（2017年版2025年修订）"}
    },
    "textbook": {
      "confirmed": false,
      "sections": [],
      "notes": "教师未确认教材版本，按课标与通行学科逻辑设计"
    },
    "past_papers": [
      {"source": {"media_id": "media_yyy", "title": "2025年全国乙卷｜第4题"}, "topic": "人口迁移", "情境": "……", "行为": "说明", "认知层级": "分析"}
    ],
    "lesson_cases": [
      {"source": {"media_id": "media_zzz", "title": "人口迁移 问题链课例"}, "模式": "问题链驱动", "可取处": ["用流迁数据作证据先行的情境", "……"], "适用条件": "……"}
    ],
    "data": []
  },
  "gates": {"standard_text_verified": true, "version_confirmed": false, "data_traceable": true}
}
```

### 5.2 证据包生命周期

1. **组装**（步骤2）：四通道检索结果按 5.1 结构写入；
2. **冻结**（步骤3开始）：设计阶段只读，任何新事实必须补检索并更新包（记录版本号）；
3. **随行**（步骤5）：lesson.json 通过 `evidence_refs` + `from_evidence` 块引用证据包（见 5.3），证据包本体作为内部文件保存在课程产物目录；
4. **归档**（步骤7）：经教师批准后，将候选沉淀包写入独立派生库（见 §7）。

### 5.3 lesson.json 证据引用（Evidence References）

lesson.json 中的事实性内容不再"直接写值"，而是**指向证据包**，形成「文档内容 → 证据条目 → media_id 溯源」的可追溯链：

- 顶层新增 `evidence_refs`：定义文档内使用的证据别名及其在证据包中的路径：

```json
{
  "evidence_refs": {
    "standard_text":      {"pack": "standard", "field": "statement"},
    "standard_code":      {"pack": "standard", "field": "code"},
    "paper_1_stimulus":   {"pack": "past_papers", "index": 0, "field": "情境"},
    "case_1_pattern":     {"pack": "lesson_cases", "index": 0, "field": "模式"}
  }
}
```

- 文档内引用：新增块类型 `from_evidence`（与现有 `from_shared` 平行）：

```json
{"type": "from_evidence", "key": "standard_text", "label": "课标原文"}
```

- 自由块补充标注：任意块可带可选字段 `"evidence": ["paper_1_stimulus"]`，表示该块内容源自对应证据，供门禁核验。
- **展开时机**：渲染前由 `assemble_lesson.py` 把 `from_evidence` 展开为实际内容（并自动附加教师可读来源说明），渲染管线（`render_documents.py`）**零改动**。

### 5.4 lesson.json 硬 Schema

把现有"软要求"固化为机器可校验的硬约束：

- **`harness/lesson.schema.json`**（JSON Schema draft-07）约束：
  - 顶层必填：`shared`（含学段、学科、课时、课标定位与原文或待核对标记）、`documents`（至少 3 个且 id 唯一）、`evidence_refs`（可选但推荐）；
  - `documents[].audience` ∈ {teacher, student}；块 `type` ∈ 现有块类型集合 ∪ {`from_shared`, `from_evidence`}；
  - `from_evidence.key` 必须在 `evidence_refs` 中定义；`from_shared.key` 必须在 `shared` 中存在。
- **`scripts/validate_lesson.py`**：渲染前强制运行（jsonschema 校验 + 上述引用完整性），失败即阻塞，不进入渲染；
- 流程固化：`lesson.json → validate_lesson.py → assemble_lesson.py（展开 from_shared / from_evidence）→ check_gates.py → render_documents.py`。

---

## 6. Harness 目录结构与运行循环

### 6.1 目录结构（对现有 skill 的最小侵入改造）

```
cn-high-school-geography-lesson-planning/
├── SKILL.md                          # 变薄：入口 + harness 工作流
├── harness/                          # ★ 新增：harness 定义层
│   ├── manifest.yaml                 #   知识库ID、文件夹、工具映射、门禁配置
│   ├── retrieval-protocol.md         #   四通道检索协议（§4 的落地文档）
│   ├── evidence-pack.schema.json     #   证据包结构定义
│   ├── lesson.schema.json            #   ★ 新增：lesson.json 硬 Schema（§5.4）
│   ├── gate-rules.md                 #   门禁规则：哪些内容必须溯源
│   ├── run.py                        #   ★ 新增：统一执行入口（状态机控制器，§6.4）
│   └── state/                        #   ★ 新增：运行状态 <lesson_id>.json（断点续跑）
├── references/                       # 瘦身保留：写法 / 来源政策 / 地图规范
├── scripts/
│   ├── render_documents.py           # 不动
│   ├── render_lesson_docx.py         # 不动
│   ├── render_lesson_html.py         # 不动
│   ├── build_retrieval_plan.py       # ★ 新增：课题 → 检索计划
│   ├── assemble_evidence_pack.py     # ★ 新增：检索结果 → 证据包（含缓存）
│   ├── validate_lesson.py            # ★ 新增：lesson.json 硬 Schema 校验
│   ├── assemble_lesson.py            # ★ 新增：展开 from_shared / from_evidence
│   └── check_gates.py                # ★ 新增：生成前门禁检查
├── config/
│   └── harness_config.json           # ★ 新增：kb_id → 用途映射（同步 manifest）
└── agents/openai.yaml                # 不动
```

### 6.2 运行循环（harness 工作流）

> 每个阶段由统一入口 `harness/run.py <stage> <lesson_id>` 推进（§6.4）；检索动作由 WorkBuddy Agent 经 ima-mcp 执行。

```
用户请求
   │
   ▼
S0 路由       解析课题/模块/年级 → 确定认知主线（读 geography.md）
   │
   ▼
S1 澄清       0–2 个教学问题 + 交付确认（直接生成 / 先草案）
   │
   ▼
S2 证据检索   build_retrieval_plan.py → WorkBuddy 四通道检索（ima-mcp）
              → assemble_evidence_pack.py → 证据包（含缓存命中）
   │
   ▼
S3 设计       只基于证据包 + references 规则；事实一律 from_evidence 引用
   │
   ▼
S4 草案/确认   （教师选择草案时）展示草案后等待
   │
   ▼
S5 生成       lesson.json（evidence_refs+from_evidence）
              → validate_lesson.py（硬 Schema）
              → assemble_lesson.py（展开引用）
              → check_gates.py（溯源门禁）
              → render_documents.py
   │
   ▼
S6 交付       一次性交付三件套 + 来源说明 + 修订选项 + 沉淀询问
   │
   ▼
S7 沉淀       生成候选沉淀包 → 教师批准 → 写入独立派生库（§7）
```

### 6.3 门禁检查（`check_gates.py`）

生成 docx 前逐项检查，任一失败则阻塞并返回证据包修订：

1. **课标门禁**：`standard.statement` 非空且 `standard_text_verified == true`；未核验时只允许生成"待核对"草案；
2. **溯源门禁**：所有进入课程的现实数据、地图、真题情境均有 `source`（media_id 或 URL+审图号）；
3. **证据引用门禁**：每个 `from_evidence.key` 都能在证据包中解析且已溯源；标记 `required` 的通道（如课标）至少被文档引用一次；带 `evidence` 标注的自由块与证据包内容一致；
4. **教材门禁**：版本已确认时，教材分析内容与检索到的章节结构一致；未确认时不得出现出版社/页码/版本栏目；
5. **一致性门禁**：沿用现有双向一致性检查（教学设计↔学生材料逐字一致、时间合计等）；
6. **版权门禁**：evidence 中的课例/教材/真题原文不得以复制形态进入交付文档（只允许改写与引用）。

### 6.4 运行状态机与统一执行入口

**状态机**：每次课程是一个运行单元，保存为 `harness/state/<lesson_id>.json`：

```json
{
  "lesson_id": "2026-08-05-rkqy",
  "run_status": "in_progress",
  "current_stage": "S3",
  "stages": {
    "S0": {"status": "completed", "output": "plan/route.json",  "ts": "…"},
    "S1": {"status": "completed", "output": "plan/clarify.json","ts": "…"},
    "S2": {"status": "completed", "output": "evidence/evidence_pack.json", "ts": "…"},
    "S3": {"status": "in_progress", "output": null, "ts": "…"},
    "S4": {"status": "pending", "output": null, "ts": null},
    "S5": {"status": "pending", "output": null, "ts": null},
    "S6": {"status": "pending", "output": null, "ts": null},
    "S7": {"status": "pending", "output": null, "ts": null}
  },
  "artifacts": {
    "retrieval_plan": "artifacts/retrieval_plan.json",
    "evidence_pack":  "artifacts/evidence_pack.json",
    "lesson_json":    "artifacts/lesson.json",
    "gate_report":    "artifacts/gate_report.json"
  }
}
```

- 阶段状态：`pending → in_progress → completed`；异常时为 `blocked`（门禁失败、缺证据，修订后重跑本阶段）或 `failed`（回退到前一阶段）；
- 运行状态：`created → in_progress → completed`（已交付）/ `archived`（已沉淀）/ `aborted`；
- **断点续跑**：`run.py status <lesson_id>` 查看停在哪个阶段；`run.py resume <lesson_id>` 从 `current_stage` 继续；
- **阶段重放**：修订证据包后 `run.py rerun <lesson_id> S5`，仅重跑受影响阶段，不丢失已确认的 S0/S1 产物。

**统一执行入口** `harness/run.py`：

| 命令                                          | 作用                                                      |
| ------------------------------------------- | ------------------------------------------------------- |
| `run.py new <topic> --module 必修二`           | 创建运行单元（lesson_id + state 文件）                            |
| `run.py plan <lesson_id>`                   | S0/S1：输出路由与澄清记录                                         |
| `run.py retrieve <lesson_id>`               | S2：按检索计划生成待执行清单（检索动作由 WorkBuddy 执行，结果回填证据包）             |
| `run.py design <lesson_id>`                 | S3/S4：标记设计阶段，产出草案摘要（设计本身由 Agent 完成）                     |
| `run.py render <lesson_id>`                 | S5：validate → assemble → check_gates → render_documents |
| `run.py deliver <lesson_id>`                | S6：生成交付清单（产物路径 + 来源说明 + 修订选项）                           |
| `run.py settle <lesson_id>`                 | S7：生成候选沉淀包（不写入，等待教师批准）                                  |
| `run.py status / resume / rerun / rollback` | 状态查看、断点续跑、阶段重放、回退                                       |

> 分工边界：**感知与生成**（理解课题、构造检索词、阅读原文、撰写设计）由 WorkBuddy Agent 完成；**确定性与校验**（Schema、展开、门禁、渲染、状态推进）由 run.py 及子脚本完成。run.py 不做任何需要理解语义的事，也**不直连 ima**。

---

## 7. 闭环沉淀（教师批准后进入独立派生库）

harness 与静态 skill 的本质区别之一：**每次运行都在沉淀内容资产**。但沉淀**绝不自动写入原始库**——先产出候选沉淀包，经教师批准后写入**独立派生库**，原始库（课程方案skill资源 / 真题库 / 微信公众号课例）永不自动变更。

### 7.1 独立派生库

- 新建 ima 知识库「**课程方案·沉淀库**」（独立于三个原始库），内部按文件夹分装沉淀物：

```
课程方案·沉淀库/
├── 01_课程资产/       课程设计决策（课标条目→核心问题→阶段结构→检测方式）
├── 02_知识点映射/     课标条目 → 真题题组映射（衔接真题契约阶段二）
└── 03_情境素材/       教师确认高价值的真实情境与数据组合
```

### 7.2 沉淀流程（S7）

1. **自动产出候选沉淀包**（本地 `harness/settle/<lesson_id>/`，不写入任何 ima 库）：课程资产摘要、课标→真题映射建议、高价值情境候选；
2. **教师批准**：交付后明确询问"是否沉淀、沉淀哪些类别"；教师可逐项勾选或全部拒绝；
3. **写入派生库**：仅将批准项写入「课程方案·沉淀库」对应文件夹，记录来源 lesson_id 与检索 media_id；
4. **拒绝即丢弃**：未批准的候选包只保留本地 7 天，之后清理；本地 `cache/misses.json` 记录的是**知识库确实缺失的内容**（检索缺口），不属于沉淀物。

### 7.3 沉淀收益

沉淀数据以"主题关键词"为标题进入派生库后，成为下一次检索的**现成高相关候选**（派生库可纳入检索通道，也可仅作人工查阅），持续提升后续课程的起点质量。

---

## 8. 分阶段实施路线

### Phase 0 — 内容治理（0.5–1 周，可与开发并行）

- [ ] 真题库 raw_data 完成首批蒸馏（按现有契约），新题组页加课标标签（精准筛选用）；
- [ ] （可选）抽查 06_蒸馏成果 51 条的标题与标签完整性；
- [ ] （按需）教材章节索引 markdown——仅当实际定位不准时再补，非默认动作。

### Phase 1 — Harness 骨架（1 周）

- [ ] 新增 `harness/manifest.yaml` + `harness/retrieval-protocol.md` + `harness/evidence-pack.schema.json` + `harness/lesson.schema.json` + `harness/gate-rules.md`；
- [ ] `harness/run.py` 骨架：`new / status / render / deliver` 命令 + `state/<lesson_id>.json` 读写；
- [ ] 改造 `SKILL.md`：步骤2 改为"按检索协议执行四通道检索并组装证据包"（注明调用主体为 WorkBuddy 经 ima-mcp），删除静态课标路由提示；
- [ ] `config/harness_config.json` 登记 3 个原始库 + 派生库的 kb_id / folder_id。

### Phase 2 — 辅助脚本（1–1.5 周）

- [ ] `build_retrieval_plan.py`：输入课题信息，输出检索计划 JSON（含四通道检索词）；
- [ ] `assemble_evidence_pack.py`：汇总 WorkBuddy 检索结果 → 证据包 + 缓存；
- [ ] `validate_lesson.py` + `assemble_lesson.py`：硬 Schema 校验 + 展开 from_shared / from_evidence；
- [ ] `check_gates.py`：门禁检查（含证据引用门禁），输出通过/阻塞清单；
- [ ] `run.py` 补全：`plan / retrieve / design / settle / resume / rerun / rollback`；
- [ ] 用 2–3 个真实课题（含上次的"人口与城镇化"）端到端验证。

### Phase 3 — 闭环沉淀（0.5–1 周）

- [ ] 候选沉淀包生成（`settle` 命令）；
- [ ] 教师批准交互 + 写入独立派生库「课程方案·沉淀库」（01_课程资产 / 02_知识点映射 / 03_情境素材）；
- [ ] 检索缺口统计（知识库确实缺失的内容），反向指导内容治理。

### Phase 4 — 可选增强

- [ ] 官方数据通道（NBS/CMA）接入证据包 `data` 字段，检索结果直接带年份/单位/来源；
- [ ] 多教材版本（湘教版/鲁教版/中图版）入库支持；
- [ ] 证据包可视化复查（HTML 面板）。

---

## 9. 风险与权衡

| 风险                    | 影响           | 缓解                                               |
| --------------------- | ------------ | ------------------------------------------------ |
| ~~ima 切片检索命中率不稳定~~    | —            | **已排除**：检索能力实测可靠（用户确认），不为它设计任何防御机制               |
| 多次 fetch 大 PDF 的耗时/成本 | 体验下降         | 缓存复用 + 只取命中切片所在 media（§4.4）                      |
| 蒸馏进度是硬依赖              | 真题/课例通道早期内容少 | required 分级：真题/课例早期设为"可选"，课标/教材先行                |
| 模型可能绕过证据包凭记忆生成        | 门禁失效         | 证据引用门禁（from_evidence 必须可解析）+ 硬 Schema + 渲染前脚本级强制 |
| 版权风险（教材/真题/课例原文复制）    | 合规问题         | 版权门禁 + 现有 source-and-map-policy.md 的改写规则不变       |
| 回写污染原始库               | 原始库失序        | 已消除：沉淀只写独立派生库，且须教师逐项批准（§7）                       |

---

## 10. 需要你决策的点

1. **Harness 形态**：方案 A＝在现有 skill 包内新增 `harness/` 目录（推荐，零破坏）；方案 B＝独立成新 skill「地理课程 harness」作为编排层，调用现有渲染 skill；
2. **证据包与运行状态存放**：课程产物目录（默认推荐，含 `artifacts/` 与 `harness/state/`）vs ima 派生库（可检索但增加检索噪音）；
3. **派生库建库方式**：新建 ima 库「课程方案·沉淀库」（推荐，与原始库完全隔离）vs 在「课程方案skill资源」库内新建「沉淀」文件夹；
4. **Phase 0 是否现在启动**：真题首批蒸馏 + 标签化可由我推进；教材章节索引降级为按需，不再默认启动。

---

*附：本文档中涉及的 ima 知识库 ID 均来自 2026-08-05 实测查询；库名「课程方案skill资源」即原「skill测试」库。*
