# 项目文档索引

现行规则、实施进度和历史证据分别从以下入口读取。源码已落地不代表运行时或教学内容已验收；存在差异时记录待核实项，不以旧方案覆盖当前实现。

| 用途 | 文档 | 当前边界 |
| :-- | :-- | :-- |
| 部署与使用 | [项目说明](../README.md)、[使用指南](使用指南.md) | profile 依赖挂载；本机 link 直连仓库。三个 bundle（预设／输入区 UI／ModelCheck）的接线见 README「快速开始」，数据路径绑定见「配置数据路径」，许可见「许可与致谢」 |
| **运行版本基线** | [DSH 0.2.1-rc.2 基线](DSH-0.2.1-rc.2-基线.md) | **现行版本的唯一环境事实来源**：版本/tag/commit、打包形态下的源码核对方式、0.1.7→0.2.1 的破坏性变更、已复验与未复验面、版本漂移政策。取代 M0 记录中与运行版本相关的部分 |
| 共享术语 | [术语表](术语表.md) | 地理与交付术语的统一来源 |
| 出题需求与设计 | [产品需求](geography-question-generation-product-requirements.md)、[技术设计](geography-question-generation-technical-design.md)、[执行方案](geography-question-generation-execution-plan.md) | V1 设计及 M0–M5 验收要求；不是全部功能完成声明。V1 范围含**两种题型**（材料型选择题组与材料型综合题，一包一题型），命题包格式为 `schemaVersion: 2`（[决策记录](决策记录.md) 2026-10-04 行）。**出题自 2026-10-08 起正在开发**（2026-10-04 之前的暂缓令已解除） |
| 出题实施状态 | [M0](geography-question-generation-m0-baseline.md)、[M1](geography-question-generation-m1-record.md) | M1 源码已落地并**完成桌面验收（2026-10-20）**；命题包 schema v2、双样例与 **M3 校验/投影/渲染**（`plugins/question/package.js`、`geo_question_validate`、CLI `check-package.mjs`、`test/question-package.test.mjs` 55 项）已落地；**M3 工具运行时复跑通过（2026-10-21，同一会话内 7 次调用全部返回 ok）**；**M2 首个完整题组已跑通（2026-10-21，两阶段流程 + 校验修复闭环）**；**未做**语义内容评审、`contentHash` 回填、M4 跨主题与恢复验证 |
| 出题数据样例与迁移 | [样例说明](examples/README.md) | 选择题组与综合题各一份样例；含占位证据与模拟确认，不是真实交付物；附 `schemaVersion: 1 → 2` 迁移表 |
| 讲题规范 | [功能设计](讲题功能设计.md)、[工作流约束](讲题工作流修复方案.md)、[评测方案](讲题评测方案.md) | 三对象规则、答案隔离、DeepSeek 原生图片输入与内容评测 |
| 三对象实施状态 | [方案](讲题功能三对象改造方案-DSH-0.1.7-rc.2.md)、[实施记录](讲题三对象改造-实施记录.md) | **讲题功能开发完成（2026-10-08），转入用户反馈迭代**；**仅剩「四题三对象内容评审」（人工学科评审）未做**——M3 的确定性命令与桌面全清单已于 2026-09-30 完成回填；§6.6 修复的运行时复验、核验材料交接形态与第二阶段「生成题包只读适配」仍待处理 |
| 开发维护 | [Skills 应用方案](harness-skills-应用方案.md)、[简化候选](代码简化TODO.md)、[决策记录](决策记录.md)、[会话轨迹审查](../.agents/skills/geo-dev-checklist/references/session-trajectory-review.md) | 保留当前约束、待办和决策理由；轨迹审查记录读会话轨迹的方式（含 `session.v4.jsonl.zstd` 多帧解压）与「工具调用序列／失败项／模型宣称 vs 报告事实」三维度口径 |
| 工作台与 UI 形态 | [原生 UI 插件方案](geo-teacher-原生UI插件方案.md)、[输入区 UI 插件说明](../packages/dsh-geo-teacher-ui/README.md) | 工作台（`plugins/panel`，任务受理台）**已完成**（2026-10-08）；桌面端输入区插件 `@geo-edu/dsh-geo-teacher-ui` **已成品化（2026-10-08，v0.1.0）**——探针代码与主机绝对路径已移除、素材收归包内、元数据补齐；原生 UI 插件方案文档仍保留槽位契约、路径分级与未验证项 |
| 插件与技能归属 | [功能插件与技能归属方案](geo-teacher-功能插件与技能归属方案.md) | **方案阶段、未实施**：三功能载体的分层判据、技能收归功能插件的目标形态与代价（`geo-verify` 8 处断言重写、失去技能目录热更新）、官方 `dsh-skill-badge` 先例、未验证项；其中「课程方案技能未加载」的缺口已按推荐修法解决（2026-10-24 技能物理移入预设技能根，2026-10-28 对齐修订），本文其余结论不变 |
| 课程方案技能 | [技能说明](../.agent-presets/geo-teacher/skills/cn-high-school-geography-lesson-planning/README.md)、[发布清单](../.agent-presets/geo-teacher/skills/cn-high-school-geography-lesson-planning/RELEASE-MANIFEST.md) | V3.2 已放入预设技能根（`SKILL.md` + 5 份 references + Python 渲染脚本）；**桌面端加载与渲染链路未验收**；采用 Apache-2.0，派生自 *Agent Skills for K-12 Teachers*，`LICENSE` 与 `NOTICE` 随目录保留 |
| 建模完成判定 | [需求规格书](建模完成判定插件-需求规格书.md)、[一期实现设计](modelcheck/设计-一期实现.md)、[解决方案](modelcheck/解决方案-组件粒度与接入流程.md)、[接入指南-给agent](modelcheck/接入指南-给agent.md)、[实施记录](modelcheck/实施记录.md)、[M0 能力矩阵](modelcheck/M0-能力矩阵.md)、[DSH API 取证笔记](modelcheck/DSH-API-notes.md) | 插件 `@geo-edu/dsh-modelcheck` **已安装进 desktop profile 并实测在线**（8 个工具、`conversation.view` 页签、`/modelcheck/*` 路由；141 项单测 + 19 项可执行验收全绿）。已执行 P0（接入就绪/校验入口/verify 预检）与 P1 客户端+数据层（kind/parts/instances、instanceId 命中链、面包屑）；**未验证**：真机 `InstancedMesh` 实例命中/取证、面板视觉与点选全链路、不透明源沙箱兼容性、真实模型上的拦截行为、多会话并发隔离。点选按设计只聚焦模型几何，文字标签/二维控件不点选 |
| 历史证据 | [归档索引](archive/README.md) | 已完成迁移与旧设计，仅供追溯 |

## 文档维护规则

- 按未来决策价值判断保留与归档，不按日期或篇幅删除。
- 现行说明更新事实；实施记录保留验证日期、证据和未完成项。
- 文档只有部分过时时，保留有效约束与独有理由，修正过时段落。
- 归档前明确现行替代入口并处理入站引用；归档正文保留历史原貌，不执行其中的旧部署、升级、清理或回滚命令。
- 决策记录继续采用有效／已废弃的轻量状态。文档归档不引入上游双语配套或冻结校验脚本。
