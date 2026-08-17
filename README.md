# GeoEduAgent — 高中地理教师辅助 Agent

基于 DeepSeek Harness (DSH) 构建的高中地理教师辅助系统，运行于 DSH Web GUI（`http://127.0.0.1:3080`）。

## 当前状态

- ✅ **插件化重构（方案 P0–P2）已完成并挂载验证通过**：`geo-core`（内核服务 geoKernel）+ taxonomy / bank / analysis / generator / ui 六个插件。
- ✅ **HTTP 冒烟全绿**：`/geo/core/health`（考点 157 / 题库 85 文件 / 203 题）、`/geo/taxonomy/tree`、`/geo/bank/search`、`/geo/analysis/run`（真题分析+命题蓝图）、`/geo/generator/style`（七维度风格档案）、`/geo-teacher` 仪表盘。
- ✅ **模型工具链已实现**（6 个，注册到 geo-teacher 预设层）：`geo_taxonomy`、`geo_search_questions`、`geo_question_detail`、`geo_analyze`、`geo_export_analysis`、`geo_style_profile`。
- ✅ **出题技能**：`geo-question-generator` 已重构（补 frontmatter，DSH 本地数据源）。
- 🔜 **待重启生效**：模型工具链、导出 Markdown 的沙箱策略修复（写 `outputs\`）。
- 📌 **工具注册技术要点**：persistent preset 插件**不能裸 import 宿主包**（C: 用户根无 node_modules，Node 标准解析失败）；`ctx.tools.register` 接受直接构造的 `ToolDefinition` 对象（不要求 defineTool），`output.schema` 用标准 JSON Schema（如 `{type:'object', additionalProperties:true}`）。
- 🔜 **下一步（P3–P6）**：课程方案技能包接入、人格路由、面板收尾（见 `docs\geo-teacher-agent-plan.md`）。

## 预设的双副本架构（重要）

| 副本 | 路径 | 角色 |
| :--- | :--- | :--- |
| **权威源** | `E:\geo_edu_agent\.agent-presets\geo-teacher\` | 开发/版本管理的主副本（改这里） |
| **运行时副本** | `C:\Users\xxx\.dsh\.agent-presets\geo-teacher\` | DSH 实际加载的副本（AgentPresets 只扫描该用户根） |

**为什么必须双副本**（调查结论，详见方案文档附录 B）：
- `dsh web` 启动时**强制**把 `agent-presets` 的 `roots` 覆盖为部署 shipped 根 → 无法通过配置让 DSH 直接扫描 E: 目录；
- AgentPresets 的发现用 Node `readdir + isDirectory()`，**junction 被当作符号链接跳过** → 目录联接（方案 B 初版）也不可行；
- 因此 C: 用户根必须放真实目录（约 110KB），E: 作为权威源。

**修改预设后请同步**（E: → C:）：

```powershell
Copy-Item 'E:\geo_edu_agent\.agent-presets\geo-teacher\*' 'C:\Users\xxx\.dsh\.agent-presets\geo-teacher\' -Recurse -Force
```

> 建议后续把 `E:\geo_edu_agent\.agent-presets\` 纳入 git，作为唯一可编辑源。

## 目录结构

| 路径 | 说明 |
| :--- | :--- |
| `.agent-presets\geo-teacher\` | **预设权威源**：`plugins\{core,taxonomy,bank,analysis,generator,ui}` + `skills\` + `agent.cordis.yml` |
| `docs\` | 文档：`geo-teacher-agent-plan.md`（架构与实施方案）、`plugin_definition.md`（历史定义） |
| `skills\` | 技能源工作区镜像（`geo-question-generator.md` 与 `cn-high-school-geography-lesson-planning\` 课程方案技能包） |
| `outputs\` | 产物输出（真题分析 Markdown、未来的课程方案 docx/html） |
| `legacy\` | 旧草稿归档（旧动态插件 host.js/client.js 等，不参与运行，可删） |
| `.backups\` | 阶段备份（如 `geo-teacher-20260814-221212\`，P2 前状态） |

## 数据源

| 数据 | 路径 | 说明 |
| :--- | :--- | :--- |
| 考点库（KPS） | `E:\知识图谱\config\knowledge_taxonomy_*.yaml` | domain → theme → knowledge_unit 三级，节点带 `id/name/definition` |
| 真题库 | `E:\知识图谱\obsidian_vault\04_题目` | 按 `省份/年份/题组单页.md` 组织，动态增长 |

## 架构（当前，插件化）

```
浏览器 /geo-teacher 仪表盘（考点真题 / 出题助手 / 课程方案）
   │  HTTP
   ▼
/geo/taxonomy/*  /geo/bank/*  /geo/analysis/*  /geo/generator/*  /geo/core/health
   │  功能插件（webServer 路由，注入 geoKernel 服务）
   ▼
geo-core（内核服务 geoKernel：考点树 / 题库加载 / 真题分析 / 命题蓝图 / 风格档案）
   │  fs 服务
   ▼
本地数据源（E:\知识图谱）· 输出（E:\geo_edu_agent\outputs）
```

- `agent.cordis.yml` 中 geo group 用 `isolate: geoKernel` 隔离内核服务（预设私有）。
- 关键经验：插件回调签名是 `apply(ctx, config)`（配置是第二参数，不是 `ctx.config`）；服务访问 `ctx['服务名']`；服务名与 isolate 键必须一致（避免点号）。

## 相关文档

- `docs\使用指南.md` — **使用指南**（Web 面板 / 对话工具 / 出题技能三种用法 + 话术示例）
- `docs\讲题功能设计.md` — **讲题功能设计**（设问先行/定向读材料、地理思维逻辑、一线教师评审修订、四段式讲题稿模型、技术落地与实施步骤）
- `docs\讲题评测方案.md` — **讲题真题评测方案**（P4：分层抽样清单 + 五项指标打分表 + 通过门槛）
- `docs\讲题图像转录方案.md` — **讲题图像转录预处理方案**（Qwen3.6 Plus 视觉读图转录 → 结构化 GeoVisionResult → DeepSeek 解题；`geoVision` 服务 + `geo_solve` 自动带图已启用：`provider: opencode-go, model: qwen3.6-plus`；V1.1 修复模型选择与调用契约后，**待 DSH 重启做真实图 E2E 验证**，见 `docs\视觉与工作流修复方案.md`）
- `docs\harness-skills-应用方案.md` — **DSH 仓库 Skills 应用方案**（v3.0：11 个官方开发技能按四类归类；开发 Skill 放 `.agents/skills/`；`geo-verify.mjs` 确定性检查程序 + 项目 `package.json`；共享术语表；讲题稿"过程性元话语与作者痕迹检测"；含上游 commit SHA/下载包哈希/MIT 信息与验收标准）
- `docs\geo-teacher-agent-plan.md` — 地理教师 Agent 插件化与课程方案生成方案（附录 A/B：迁移与双副本调查）
- `docs\plugin_definition.md` — 早期插件定义与调试历史
- `legacy\README.md` — 归档内容清单
