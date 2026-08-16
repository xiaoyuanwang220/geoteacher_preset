# 中国地理权威数据——调用顺序

仅当 `search_official_sources` 与 `fetch_official_source` 可用，而且课程需要现实、最新或区域特定数据时使用。调用完成后直接进入课程设计，不在聊天中汇报工具过程或候选列表。

**可用工具：** `list_official_sources`、`search_official_sources`、`fetch_official_source`。当前已启用 `nbs`（国家统计局）与 `cma`（中国气象局）。

1. **选择来源**：人口、经济、产业和区域统计优先使用 `nbs`；气温、降水、气候公报和气象灾害优先使用 `cma`。任务跨来源或无法判断时使用 `all`，必要时先调用 `list_official_sources()`。

2. **搜索来源**：根据课程任务确定指标、地区和年份，调用 `search_official_sources(query, source="all", limit=5, sort="relevance")`。从结果中选择发布日期、栏目和内容类型最合适的1至2项；搜索结果只作为候选来源。

3. **读取原文**：对选中的 HTML 页面调用 `fetch_official_source(url)`。PDF 当前只作为来源入口，不声称已读取正文。

4. **提取并核验**：只保留原文明确给出的指标、数值、单位、地区、统计时期和必要口径，并记录原文标题、发布日期和链接。仅将 `status="ok"` 且正文足以支持的数据写入课程；其他状态或字段缺失时更换来源，不得从摘要或截断内容补全数值。

**最多进行3轮连接器搜索。** 统一工具不可用但旧版 `search_nbs_sources` 与 `fetch_nbs_source` 可用时，仅对国家统计局来源使用旧版调用。连接器不可用或仍无可用数据时，按 `source-and-map-policy.md` 联网核验；联网仍无法满足任务时，再改用教师资料、明确标注的教学模拟数据，或说明缺少不可替代的真实数据。

→ **数据检索完成，立即进入课程设计。**
