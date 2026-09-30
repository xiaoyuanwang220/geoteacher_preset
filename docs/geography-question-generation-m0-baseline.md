# 出题功能 M0 基线与可用性记录

> 记录日期：2026-09-27
> 对应阶段：M0「基线与可用性」（见 [执行方案](geography-question-generation-execution-plan.md) §9）
> 完成标准：source 检查不依赖旧副本；真正的 desktop 预设可加载；知道每个证据渠道可用到哪一层
> 性质：本文件记录**实测与源码核对**的结果，不以文档或源码推导代替实际通过记录

---

## 1. 环境基线

### 1.1 桌面运行时

| 项 | 值 | 来源 |
| :-- | :-- | :-- |
| `desktopVersion` | `0.1.7-rc.2` | `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/runtime.json:2` |
| `platform` / `arch` | `win32` / `x64` | 同文件 `:3-4` |
| `payloadDigest` | `a7dddb0dc2b5035d86c7f39a4e2c688ccf531a3ba11d0737d441d6376500c14e` | 同文件 `:5` |
| Node | `24.21.0` | 同文件 `:7` |
| Python | `3.12.14` | 同文件 `:6` |
| pnpm | `11.7.0` | 同文件 `:8` |
| 运行时根 | `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime` | `load_workspace_dependencies` 返回 |
| Node 可执行文件 | `…/dependencies/node/bin/node.exe` | 同上 |
| Python 可执行文件 | `…/dependencies/python/python.exe` | 同上 |
| Python site-packages | numpy 2.3.5 / pandas 3.0.1 / python-docx 1.2.0 / python-pptx 1.0.2 / openpyxl 3.1.5 / Pillow 12.3.0 / lxml 6.1.3 / XlsxWriter 3.2.9 / typing_extensions / et_xmlfile | 同文件 `:9-23` |

**依赖事实**：随发行版 Python **不含 PyYAML**（site-packages 无 `yaml`），与执行方案 §2.5 一致。taxonomy 解析所需的 YAML 能力不能依赖它。

### 1.2 profile 与部署形态

| 项 | 值 | 来源 |
| :-- | :-- | :-- |
| 运行 profile | `desktop` | `<DSH_HOME>/profiles/desktop/` |
| 同机另有 profile | `web`（**不含**本预设；2026-09-30 起也不再含 `@geo-edu/dsh-geo-workbench`——该客户端扩展已退役删除，后续重新设计，见 `docs\决策记录.md`） | `<DSH_HOME>/profiles/web/` |
| 预设依赖声明 | `"@geo-edu/dsh-geo-teacher-preset": "link:E:/geo_edu_agent/.agent-presets/geo-teacher"` | `profiles/desktop/package.json:5` |
| bundle 列表 | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`@geo-edu/dsh-geo-teacher-preset` | 同文件 `:8-14` |
| 预设注册结果 | `@geo-edu/dsh-geo-teacher-preset` v0.1.0，`enabled: true`、`installed: true`、`removable: true`；行 `preset-geo-teacher` → `@deepseek-ai/dsh-agent-preset`（`include:preset-geo-teacher`） | `plugin_manager list_bundles`（本次会话） |
| 默认模型 | provider `commandcode`，model `deepseek/deepseek-v4.1-flash` | `profiles/desktop/cordis.patch.yml:261-265` |

**结论（M0 完成标准 2 的依据）**：desktop profile 的 bundle 列表包含该预设、且其链接目标就是本仓库目录，因此**改仓库即改运行时，不需要 E:→C: 双副本同步**。这是本机开发部署方式，不是所有 DSH 安装的通用规则（其他安装可为包安装或指向别处的 link）。

### 1.3 预设解析路径链

```
profiles/desktop/package.json
  └─ dependencies["@geo-edu/dsh-geo-teacher-preset"] = "link:E:/geo_edu_agent/.agent-presets/geo-teacher"
       └─ 包根            = E:\geo_edu_agent\.agent-presets\geo-teacher
            ├─ package.json      name=@geo-edu/dsh-geo-teacher-preset, dsh.bundle.patch=./cordis.patch.yml
            ├─ cordis.patch.yml  声明行 id=preset-geo-teacher（config.id=geo-teacher, 36 个插件行）
            ├─ plugins\          6 个本地插件，均经包子路径导出
            └─ skills\           技能根（M0 时为 3 个平铺入口；M1 已迁出题技能为目录包）
```

| 解析项 | 结果 | 依据 |
| :-- | :-- | :-- |
| bundle patch 文件 | `./cordis.patch.yml` | `package.json:16-20` |
| 预设身份 | 声明行 `config.id = geo-teacher` | `cordis.patch.yml:20-30` |
| 插件解析基准 | 声明行由 profile 补丁层插入，`record.context.baseUrl` 是 **profile 目录**，故本地插件一律走包子路径导出 | `cordis.patch.yml:11-19` |
| 技能根 | `dirname(createRequire(baseUrl).resolve('@geo-edu/dsh-geo-teacher-preset/package.json')) + '/skills'` → 仓库 `.agent-presets\geo-teacher\skills\` | `cordis.patch.yml:96-100` |
| 旧形态目录 | `$DSH_HOME/.agent-presets/geo-teacher/` **不存在**，且 rc.2 不再读取该形态 | `cordis.patch.yml:1-9`；官方说明「Nothing reads that directory any more」 |

### 1.4 工具与技能可见性

| 观察 | 说明 |
| :-- | :-- |
| 本次会话的工具表**不含任何 `geo_*`** | 本次会话未运行在 geo-teacher 预设上（profile 默认模型 + 通用 persona），属**预期**，不代表预设未挂载 |
| 预设注册状态为 installed+enabled | 见 §1.2 |
| 需要模型侧工具验证时 | 必须在桌面新建一个 geo-teacher 会话，工具表应出现 9 个 `geo_*`：`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_style_profile`、`geo_analyze`、`geo_export_analysis`、`geo_solve`、`geo_judge`、`geo_explain` |

---

## 2. 证据渠道可用性（实测）

测试时间：2026-09-27。测试方式：在本机可用会话中直接调用 `web_search` / `web_fetch`（二者由 host 平面的 web 服务提供；**该次探测时 geo-teacher 预设为 `fetch: false`；随后已改为 `true`，见 §2.3，不代表当前配置仍关闭网页读取**，见 §2.3）。

### 2.1 `web_search`

| 测试 | 观察 |
| :-- | :-- |
| 查「教育部 中国高考评价体系 四翼…」 | 可用；返回 8 条 **URL 列表**，**无摘要答案、无正文** |
| 来源质量 | 混合：含官方 `.gov.cn`/考试院 PDF、期刊站，也含 `sohu.com`、`sina.cn`、微信公众号等聚合内容 |
| 查「城市热岛环流 研究 论文 DOI」 | 可用；返回期刊站与直连 PDF 链接（AMS、MDPI、地球科学期刊等） |
| 查「自然资源部 标准地图 审图号」 | 可用；返回 `gi.mnr.gov.cn` 官方答复页 |

**可用层级：`lead_only`（线索级）**。搜索提供线索与链接，**不提供可直接引用的正文**；权威性必须逐条判断，不能把搜索排名当权威来源。这与技术设计 §7.5 的来源优先级（政府部门/教育考试机构 → 国际组织与国家级科研机构 → 论文出版社/DOI → 权威新闻 → 其他只作线索）一致，也说明"搜索结果"不能直接充当 G2 证据。
> 修正（2026-09-27）：此前本行写作"PRD §7.5"，属悬空引用——PRD 第 7 节只到 §7.4，来源优先级表实为**技术设计 §7.5**。

### 2.2 `web_fetch`

| 测试目标 | 结果 | 可用层级 |
| :-- | :-- | :-- |
| 教育部官网《中国高考评价体系》发布页（https URL） | **失败**：`cross-origin redirect to http://… is not followed automatically` | — |
| 同上（改用重定向目标 http URL） | **成功**：HTTP 200，读到完整正文，含「"四翼"为高考的考查要求，即"基础性、综合性、应用性、创新性"」原句 | `full_text` ✅ |
| AMS 期刊 PDF 下载端点 | HTTP **202**，**响应体为空** | 不可读 ❌ |
| 地球科学期刊 PDF 端点 | HTTP **200**，**响应体为空**（二进制 PDF 未解码为文本） | 不可读 ❌ |
| MDPI 论文落地页 | HTTP **403 Access Denied**（边缘防护拦截非浏览器客户端） | 不可读 ❌ |

**可用层级：文档类 HTML 页面可达 `full_text`；论文类落地页通常只能到 `metadata`/`abstract`；PDF 与防护站点不可读。**

三条必须写入出题流程的失败规则：

1. **HTTP 2xx ≠ 已读取**。202/200 但空响应体必须判为「未读到」，记为 `pending`，**不得**记成 `full_text`。
2. **PDF 端点经此通道返回空**。论文全文若只有 PDF，则实际只能达到 `metadata`（靠搜索结果里的题录信息），不能声称读过全文或引用其中的图与方法。
3. **跨域重定向不自动跟随**。遇到该错误必须改用重定向后的 URL 重试；重试仍失败即按降级处理，不得据原始 URL 声称已核实。

对需求 R6（论文读取范围诚实；技术设计 §7.6）的直接约束：论文的 `accessScope` 只能按**实际取得的内容**填写——可读的 HTML 摘要页记 `abstract`，教师提供的全文才可记 `full_text`；**本机联网渠道下不应出现 `full_text`**。

> 修正（2026-09-27）：此前本行写作"除非教师自行上传了全文或来源站恰好提供可读 HTML 摘要页 [可记 full_text]"，与枚举语义矛盾——摘要页对应 `abstract`，不是 `full_text`。

### 2.3 geo-teacher 预设现状

| 项 | 现状 | 影响 |
| :-- | :-- | :-- |
| `web_search` | 该预设已注册（`tool-web` 的 search 默认 true） | 线索级证据可用 |
| `web_fetch` | M0 前未注册（预设 `tool-web` 设 `fetch: false`）；**已于 2026-09-27 改为 `fetch: true`** | 待完整重启桌面后生效；生效后可达 §2.2 的 HTML 层级 |
| 因此 G2 证据门 | 重启前只能达到线索级，无法满足 PRD §4.4–4.6 对正文依据的要求；重启后 HTML 来源可达全文/摘要级 | 宿主 `web-fetch-http` 提供方已在**同一 desktop profile** 的会话中实测可用（§2.2），本次只改 `tool-web` 一行，不重复注册 web 服务 |

### 2.4 本地数据源

| 数据 | 路径 | 实测 |
| :-- | :-- | :-- |
| 考点树（KPS） | `E:\知识图谱\config\knowledge_taxonomy_*.yaml` | 4 份：natural_geography、human_geography、regional_development、resources_environment_national_security；`meta.version: v0.2-draft`、`meta.status: draft`、`constructed_at: 2026-07-28` |
| 真题库 | `E:\知识图谱\obsidian_vault\04_题目` | 104 个题组单页，8 省（广东/山东/福建/湖南/浙江/安徽/海南/…）× 2024、2025 |
| 技术文档所列 `知识图谱\processed\*`、`03_考点统计\` | **不存在** | 与执行方案 §11 的修正项一致 |

**版本事实**：taxonomy 为 `v0.2-draft`（草稿），任何交付物不得表述为"正式定稿"。

### 2.5 文献检索通道候选（补充实测，2026-09-27）

出题需要论文依据（PRD §4.6），故对候选通道做了实测：

| 通道 | 实测结果 | 可用层级 |
| :-- | :-- | :-- |
| Google Scholar（`scholar.google.com/scholar?q=…`） | **两次均 `TypeError: fetch failed`**（传输层失败，无 HTTP 状态码） | ❌ 不可用 |
| OpenAlex（`api.openalex.org/works?search=…`） | HTTP 200；返回 DOI、标题、年份/日期、期刊+ISSN+出版方、`is_oa`/`oa_url`/`best_oa_location`、作者+ORCID+机构、`abstract_inverted_index`（可还原摘要）、被引数、`has_content`/`content_urls` | ✅ `metadata` + `abstract` |
| Crossref（`api.crossref.org/works?query.bibliographic=…`） | HTTP 200；返回 DOI、标题、期刊、出版日期、URL、被引数、JATS 标记的 `abstract`（需去标签） | ✅ `metadata` + `abstract` |
| Semantic Scholar（Graph API） | HTTP **429**（未带 key 被限流） | ⚠️ 需 API key |
| `web_search` 找 Scholar 入口 | 返回的是图书馆研究指南，**未命中 scholar.google.com** | 线索级，不可依赖 |

**结论**：谷歌学术无官方 API 且对自动化访问强拦截，本通道实测抓不到——**不应把出题流程的论文通道建在它上面**。替代方案是结构化学术 API：OpenAlex 为主（一条 URL 同时给元数据、摘要与 OA 全文位置），Crossref 补 DOI 权威元数据。中文期刊/学位论文库（CNKI/万方/维普）无公开 API 且站点拦截非浏览器客户端，只能靠教师提供全文或经 MCP 连接器。

对实现的含义：文献通道应做成**确定性入口**（插件工具或 MCP），而非让模型手工拼 URL 抓 HTML；输出需规范化为 `sourceId / doi / title / published_at / venue / oa_status / accessScope(=abstract) / url`，并注意 `abstract_inverted_index` 需还原为文本。该项属出题证据层能力，未纳入 M0 交付。

**决策（2026-09-27，已确认）**：文献检索通道**本期不动，只记录在案**。待 M1/M2 再决定是否新增 `geo_literature_search`（OpenAlex + Crossref）或接入学术 MCP。

**该决策对后续阶段的约束**：在文献通道建立前，出题流程按"**无文献通道**"降级运行——论文依据只能来自教师提供的材料，`sources` 不得出现声称经联网核实的 `accessScope`；PRD R6 与 G2 门在该情形下只能判 `pending`，不能判 `pass`，且交付物需明示"论文依据待补"。此项须在 M2 行为场景（含"只读摘要时不使用全文细节"一条）中按此口径验证。

**教师提供材料是支持的输入路径，不是降级**（2026-09-27 确认）：

| 教师提供的形态 | 可用层级 | 依据 |
| :-- | :-- | :-- |
| 粘贴/上传的正文或摘要**文本** | 可读；`accessScope` 按实际形态记 `full_text` 或 `abstract` | 文本文件由 fs 工具直接读取 |
| 论文**图片**（图、表、截图） | 可读；可用于**理解后教学化改绘** | 当前多模态模型 + `read_image`；PRD §7.2 明令不得直接使用论文图 |
| **PDF 文件** | ❌ **读不到** | 随发行版 Python 的 site-packages 无任何 PDF 库（glob `*pdf*` / `*PDF*` 均无命中），且本会话无可用 shell 做文本抽取 |

因此：论文通道暂缺时，"教师给材料"是**正常路径**；教师未给材料时才落到上一段的 `pending` 降级。在补上 PDF 抽取能力前，**PDF 不得被当作可读全文**，也不得据 PDF 声称已核对方法、数值或图示关系。

---

## 3. 旧形态文件退役清点

### 3.1 消费者清单（全仓库检索 `agent.cordis.yml` / `preset.yml`）

| 文件 | 引用性质 | M0 处理 |
| :-- | :-- | :-- |
| `scripts/geo-verify.mjs` | **代码消费者**：读 `agent.cordis.yml` 做 YAML/isolate/路由断言 | ✅ 本次已改写为读 `cordis.patch.yml`，**代码消费者归零** |
| `README.md:39,68` | 文档，把 `agent.cordis.yml` 描述为当前配置 | ✅ 本次更新 |
| `docs/术语表.md:75` | 文档，`standing generation` 定义挂在 `agent.cordis.yml` 上 | ✅ 本次更新 |
| `.agents/skills/geo-dev-checklist/SKILL.md:12-23` | 文档，检查项 4"双副本"与检查项 5 读 `agent.cordis.yml` | ✅ 本次更新 |
| `docs/使用指南.md:67,72` | 文档（面向教师），要求"同步 C: 运行时副本" | ✅ 本次更新 |
| `docs/决策记录.md:8,11` | 历史决策记录（记录当时的依据） | ➖ 保留原文；另追加一条 M0 决策 |
| `docs/harness-skills-应用方案.md:109,118` | 方案文档，其检查项表与重启提示基于旧形态 | ✅ 已在首部加更新说明；表体文字仍为旧形态（后续对齐项，见 §6） |
| `docs/archive/DSH-v0.1.1原生多模态迁移与旧视觉链路下线执行方案.md:64,370` | 当时执行记录，如实描述当时状态 | ➖ 保留（历史记录，不代表当前配置） |

### 3.2 退役标记与物理归档

`agent.cordis.yml` 与 `preset.yml` 已确认为**已退役形态**（rc.2 不读取）。M0 执行：

1. **加退役横幅**——标明退役、指向 `cordis.patch.yml`、给出消费者清点结论；
2. **建立归档目录与说明**——`.backups\geo-teacher-legacy-preset-20260927\README.md`（取代关系、消费者清点、装配失败差异、落地命令、恢复步骤）；
3. **加回归保护**——`geo-verify.mjs` 新增 `retired-form` 项：预设包内不存在这两个文件即通过，存在则提示（不判失败）；
4. **移动文件**——✅ **已于 2026-09-27 执行**。本会话 shell 不可用且无删除/移动类工具，故由本地 `Move-Item` 落地（内容字节级不变，优于重新誊写 289 行 YAML）：

   | 归档文件 | 大小 | 预设包内原路径 |
   | :-- | :-- | :-- |
   | `agent.cordis.yml` | 16 543 B（306 行，退役横幅完整） | 已移除（`Test-Path` → `False`） |
   | `preset.yml` | 670 B（7 行） | 已移除（`Test-Path` → `False`） |

移动后预设包内仅剩 `cordis.patch.yml` 一个 `.yml`，`retired-form` 由提示转为通过——**该项已结**。

---

## 4. M0 变更清单

| 文件 | 变更 |
| :-- | :-- |
| `scripts/geo-verify.mjs` | 改写为针对 rc.2 声明行形态：删除影子副本（`PRESET_RT`/`checkDualCopy`）与 `agent.cordis.yml` 读取；新增预设包导出、bundle patch 声明、`./package.json` 自导出、`skills/` 目录、patch 声明行完整性、插件行 name 完整性、技能入口唯一性与 frontmatter、部署形态（仅提示）等检查；保留讲题流水线回归断言与运行时冒烟；插件语法改用 `process.execPath`；默认冒烟地址改 19387 |
| `scripts/geo-verify.mjs`（追加） | 新增 `retired-form` 回归保护（旧形态文件回到预设包时提示）；修正 `web-fetch` 提示措辞（不再声称"已注册"） |
| `.agent-presets/geo-teacher/agent.cordis.yml` | 加退役横幅后**已移出预设包** → `.backups/geo-teacher-legacy-preset-20260927/agent.cordis.yml`（16 543 B） |
| `.agent-presets/geo-teacher/preset.yml` | 同上 → `.backups/geo-teacher-legacy-preset-20260927/preset.yml`（670 B） |
| `.backups/geo-teacher-legacy-preset-20260927/README.md` | 新增：归档说明（取代关系 / 消费者清点 / 装配失败差异 / 落地命令 / 恢复步骤） |
| `.agent-presets/geo-teacher/cordis.patch.yml` | `tool-web` 的 `fetch: false` → `true`（按 §2 证据需求启用网页读取；仅此一行 + 说明注释） |
| `README.md` | 双副本架构 → link 部署事实；目录表与架构说明改 `cordis.patch.yml` |
| `docs/术语表.md` | `权威源`/`运行时副本`/`双副本`/`standing generation` 四项按 rc.2 更新 |
| `.agents/skills/geo-dev-checklist/SKILL.md` | 检查项清单、重启与热更新边界按 rc.2 更新 |
| `docs/决策记录.md` | 追加 M0 决策行；旧"双副本""standing generation 永不 dispose"两条改标 已废弃 |
| `docs/使用指南.md` | 面板地址改桌面 19387；部署与生效方式改 link 事实；补充"联网证据只有线索级"边界 |
| `docs/harness-skills-应用方案.md` | 标题状态行加 2026-09-27 更新说明（其检查项表已非当前形态） |
| `docs/geography-question-generation-m0-baseline.md` | 本文件（新增） |

**未改**：`plugins/**`、`skills/**`、预设 `package.json`、讲题三工具与两个讲题技能。M0 不挂空插件、不写 references、不迁技能目录包（属 M1）。

---

## 5. 未能执行与待人工验收

| 项 | 状态 | 说明 |
| :-- | :-- | :-- |
| `npm run verify:geo -- --source` | ✅ **已执行（用户，2026-09-27）** | **退出码 0，全绿，5 项提示**（清单见 §5.1）。本会话 shell 不可用（`pwsh` 立即以 `3221225794` / `STATUS_DLL_INIT_FAILED` 结束），故由用户在本地执行 |
| 重启后确认 desktop 预设可加载、9 个 `geo_*` 工具在册 | ✅ **已确认（用户）** | M0 完成标准 2 达成 |
| 确认 `web_fetch` 随 `fetch: true` 注册 | ✅ **已确认（用户，2026-09-27）** | 在 geo-teacher 会话的工具表中确认 `web_fetch` 已在册；§5.2 的覆盖链结论与运行时一致。**M0 全部完成标准达成，无剩余开口** |
| `--runtime` 冒烟 | ✅ **已执行（用户，2026-09-27）** | 完整重启后 **退出码 0，全绿**。M0 完成标准 1、2 均达成 |
| 物理归档旧形态文件 | ✅ **已完成（2026-09-27）** | 两文件已移入 `.backups/geo-teacher-legacy-preset-20260927/`，预设包内 `Test-Path` 双 `False`（§3.2） |
| 仓库 `node_modules` | 不存在 | `package.json` 声明 `yaml: ^2.7.0` 但未安装；改写后 `geo-verify.mjs` 不依赖任何外部包 |

### 5.1 提示项清单

用户首次运行（2026-09-27，加 `retired-form` 之前）得到 **5 项提示**。脚本提示只来自 `addWarn`；下列 4 项无条件，其余取决于文件与包内容：

| # | 提示 id | 内容 | 何时出现 |
| :-- | :-- | :-- | :-- |
| 1 | `patch-js-boundary` | 含 `!!js`；本脚本只做结构扫描、不求值 | 无条件 |
| 2 | `web-fetch` | `tool-web` 的 `fetch` 开关当前值 | 当前命中 |
| 3 | `deploy` | `profile desktop` 部署形态（link → 仓库；**不作为失败项**） | 无条件 |
| 4 | `backups` | `.backups` 目录与备份数 | 无条件 |
| 5 | `skills-body-budget`（推定） | 某技能根正文超 6000 码点工程预算——`geo-question-generator` 最可能命中 | 取决于长度 |

第 5 项若命中 `geo-question-generator`，**属预期，且正是 M1 的拆分依据**（薄路由 + references），不是缺陷。

**注意计数**：M0 追加 `retired-form`，其状态取决于旧形态文件是否还在预设包内：

- 移动前（文件仍在）：`retired-form` 为提示 → **6 项提示**；
- **移动后（当前状态）：`retired-form` 通过 → 回到 5 项提示**。

因此现在重跑 `--source` 应见 **5 项提示，并含一条 `✅ 已退役预设形态文件已归档`**；若仍见 6 项，说明预设包内又出现了旧形态文件。

### 5.2 `fetch: true` 的生效核实（覆盖链）

按执行方案 §2.1「生效配置要核对最终组合，不能只看预设文件」逐层核对：

| 层 | 是否含 `tool-web` 覆盖 | 结论 |
| :-- | :-- | :-- |
| `dsh-base` bundle patch | 有 `include:tool-web` 基础行（未设 `fetch`） | 基础默认 |
| `dsh-web-app` bundle patch | 无 | 不覆盖 |
| **`@geo-edu/dsh-geo-teacher-preset`（本仓库 patch）** | **`tool-web` → `fetch: true`** | **生效值来源** |
| `profiles/desktop/cordis.patch.yml` | 无（全文 301 行仅含 llm-pi-ai / default-model / ui-* / subagent*） | 不覆盖 |
| `$DSH_HOME/cordis.patch.yml`（home 层） | **该文件不存在** | 不覆盖 |
| `--patch` overlay | 桌面应用启动不带该参数 | 不覆盖 |

→ 组合后的生效值为 **`fetch: true`**，且预设已确认挂载（9 个 `geo_*` 在册）。故完整重启后，该预设会话应同时具备 `web_search` 与 `web_fetch`。

> 附注：`cordis_inspect_query` 的 `Config/listConfigs`（`name=@deepseek-ai/dsh-tool-web`）只列出宿主层 `include:tool-web`，`status: "inactive"`。该状态**不代表插件关闭**——本会话 `web_search`/`web_fetch` 均可用即为反证；它也不暴露预设层行与配置值，故不能用它判定 `fetch` 生效值。

**代码正确性依据**：静态结论来自文件直读与 `plugin_manager` / `cordis_inspect_*` 实时查询；`geo-verify.mjs` 已由用户在本地执行验证（退出码 0）。

### 复现与验收命令

```powershell
# 1) 静态检查（本机应全绿；部署形态只出提示）
cd E:\geo_edu_agent
node scripts\geo-verify.mjs --source

# 2) 机器可读输出
node scripts\geo-verify.mjs --source --json

# 3) 完整重启桌面后：运行时冒烟
node scripts\geo-verify.mjs --runtime

# 4) 重启后：确认预设可加载与工具在册
#    桌面新建 geo-teacher 会话，工具表应出现 9 个 geo_*；或
node scripts\geo-verify.mjs            # 默认 source + runtime
```

预期：1) 与 2) 退出码 0；4) 中 `geo_*` 齐全、`geo_solve/geo_judge/geo_explain` 未回归。

---

## 6. 遗留对齐项（不属 M0 交付）

| 项 | 说明 |
| :-- | :-- |
| `docs/harness-skills-应用方案.md` | ✅ 已加 2026-09-27 更新说明（首部）；其 §三-C 表体、§四 命令表与 §九 验收条目仍是旧形态文字，可后续整段重写 |
| `docs/讲题功能设计.md:183,200`、`docs/讲题工作流修复方案.md:47,56` | M0 当时的引用清点；现行部署段落已更新为 link，讲题设计的历史实施段仍保留当时证据 |
| `docs/archive/DSH-v0.1.1原生多模态迁移与旧视觉链路下线执行方案.md` | 历史执行记录，其中 `agent.cordis.yml` 为当时有效路径；保留原文，不追改 |
| 执行方案 §11 的其余对齐项（技术设计、PRD、运行时技能） | 分别属于 M1/M2 范围 |
| 根 `package.json` 的 `yaml` 依赖 | 本次改写后 `geo-verify.mjs` 已不依赖它；M1 引入 taxonomy 解析时应在**预设包**内声明实际运行依赖 |
