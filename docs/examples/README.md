# 出题任务包样例（开发用）

本目录存放**命题包数据契约**的样例文件，用于校验 schema、编写测试与演示交付结构。

| 文件 | 用途 |
| :-- | :-- |
| `question-package.sample.json` | 命题包样例，对应 `plugins/question/package.schema.json`；对应方案 §6.1 字段表与 §6.3 最小文件结构中的 `package.json` |

## ⚠️ 这是样例，不是真实交付物

样例中的所有**现实性内容都是占位的**：

- `taxonomySources[].contentHash` 为全零占位符，不是真实文件指纹；
- `sources[]` 中每条都在 `limitations` 里标注了「【样例占位】」，课标条目 `verification` 为 `pending`；
- `S3` 教师提供材料的观测来源与规范未记录、`S4` 仅有线索未取得正文；
- `simulations[]` 全部标注 `disclaimer: "预测性认知路径"`，**不是真实学生数据**；
- `confirmations[]` 是为演示确认记录结构而构造的。

**不得**把本文件当作可交付作品，也不得据它引用任何现实事实。

## 唯一确定性的事实来源

`knowledge.coreNodeIds` 与 `design.taxonomyRole` 使用的 `KU-NAT-ATM-HEAT-005`（大气热力环流）
取自 `E:\知识图谱\config\knowledge_taxonomy_natural_geography.yaml`，其 `definition`、
`includes`、`excludes` 为该文件真实内容：

- definition：由地面冷热不均引起的空气垂直与水平运动构成的闭合环流。
- includes：热力环流的形成过程（受热上升、冷却下沉、水平补偿）；海陆风、山谷风、城市热岛环流等应用。
- excludes：全球性大气环流（归入气压带和风带的形成）。

选择这个节点的原因：它同时带有 `includes` / `excludes` 嵌套列表 —— core 的 M1 解析扩展已支持这两个字段；本样例用于验证字段保留，桌面加载状态另见 [M1 实施记录](../geography-question-generation-m1-record.md)。

## 样例覆盖的状态

| 字段 | 取值 | 说明 |
| :-- | :-- | :-- |
| `stage` | `draft_ready` | 已过构思确认，进入初稿阶段 |
| `readiness` | `draft_complete` | **不是** `usable`——因为题组依赖 `V1` 图且 `V1` 仍为 `proposed`，课标条目也待核验 |
| `mode` | `competition` | 参赛模式 |
| `selectedConcept` | `C1`（组合=false） | 教师选定，含原话确认记录 `CF1` |

这一取值组合是刻意的：它演示「必须读图但缺图时只能到初稿完成」这条完成边界（方案 §1），
以及「结构检查通过 ≠ 可使用」——`reviews` 中结构项通过、语义项仍 `pending`。
