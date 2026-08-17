# GeoTeacher — 地理教师助手 Agent 的 dsh 插件

**GeoTeacher** 是一组基于 **DeepSeek Harness (DSH)** 的 Agent 预设插件（dsh
plugins），把 DSH Agent 变成高中地理教师助手。MIT 许可开源。

> **dsh plugin** —— 本仓库是 DeepSeek Harness (DSH) Agent 运行时的**插件层**，
> 不捆绑 DSH 本体；请自行安装 DSH，再挂载本预设（见 [DEPENDENCIES.md](DEPENDENCIES.md) 与下方快速开始）。

## 功能

### 1. 讲题流水线（`geo_solve → geo_judge → geo_explain`）

像老师一样讲解高考题，且带**反答案泄露设计**：

- `geo_solve` 只返回**题面** + 审题骨架（不含答案/解析/解析派生的干扰项线索），涉图题自动带图转录；
- `geo_judge` 再开放标准答案 + 采分点网格，让模型**核验自己的独立答案**；
- `geo_explain` 重组四段式**讲题稿**（题目定位 → 审题 → 破题 → 反思迁移），含设问类型化组织、要素维度排查与变式推荐。

流水线既靠工具契约约束，也靠 persona/技能里的纪律文本（取题一律走 geo 工具，禁止直读题库 md）。
→ [docs/zh/讲题功能设计.md](docs/zh/讲题功能设计.md) · [docs/en/pipeline-solving.md](docs/en/pipeline-solving.md)

### 2. 视觉识别（`geo-vision`）

把题目图片转录为结构化、经过 schema 校验的文本——**provider 无关**（任意 OpenAI 兼容视觉端点）且**显式优雅降级**（转录失败会如实上报，绝不静默伪装）：

- 内容 hash 缓存、运行日志、运行时开关（`/geo/vision/status|toggle`）；
- 默认开发配置：SiliconFlow + `Qwen/Qwen3-VL-8B-Instruct`（Apache-2.0）；
- **API Key 由你自行配置**——仓库内不含任何凭据。
  → [docs/zh/讲题图像转录方案.md](docs/zh/讲题图像转录方案.md) · [docs/en/vision.md](docs/en/vision.md)

### 其他能力

- 题库与知识点检索（`geo_search_questions`、`geo_question_detail`、`geo_taxonomy`）
- 真题分析与命题蓝图（`geo_analyze`）
- 七维度风格档案（`geo_style_profile`）
- 教师面板（`/geo-teacher`）
- 确定性验证：`npm run verify:geo`

## 快速开始

前置：已运行的 **DeepSeek Harness (DSH)**；验证脚本需要 Node.js；安装脚本建议 Windows PowerShell。

```powershell
# 1. 部署预设到 DSH 的 agent-presets 目录
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 2. 配置数据路径（替换 <...> 占位符）
#    preset/agent.cordis.yml :
#      knowledgeBasePath: <KB_ROOT>/config
#      questionBankPath:  <KB_ROOT>/obsidian_vault/04_题目
#      outputPath:        <WORKSPACE>/outputs

# 3. 配置视觉 provider 与 Key（用户自备凭据）
#    在 DSH settings.yaml 添加 siliconflow 路由（见 config.example.yaml），
#    并设置环境变量 SILICONFLOW_API_KEY。

# 4. 重启 DSH → 新建 geo-teacher 会话 → 提问：「讲解 25 年安徽卷第17题」
```

无需 DSH 的冒烟检查：

```powershell
npm run verify:geo -- --source   # 或：npm test
```

## 样例数据

`sample-data/` 含两份脱敏样例（**2024 山东第16题**、**2025 安徽第17题**），
答案与解析为项目**自编原创**（MIT），并附最小 taxonomy 子集——足以体验解析、检索与讲题流水线。
试卷**配图不随仓库分发**：如需测试视觉路径，请把图片放到 `sample-data/images/`（已 git 忽略）。
实际使用请把插件指向**你自己的题库**（[DEPENDENCIES.md](DEPENDENCIES.md)）。

## 目录结构

```
preset/              dsh 插件 + 技能（待部署产物）
sample-data/         脱敏样例 + taxonomy 子集
scripts/             geo-verify.mjs（检查）、install.ps1（部署）
docs/en, docs/zh     架构 · 流水线 · 视觉 · 教学文档
config.example.yaml  provider / 数据路径配置项
```

## 验证

`npm run verify:geo` —— 插件语法 / ESM 导入 / apply 冒烟 / 双副本哈希 / YAML /
isolate 白名单 / 路由唯一性 / 反泄露断言 / 索引数据断言 / 运行时冒烟（JSON 校验）。

## 许可证与声明

- 代码与文档：**MIT** —— 见 [LICENSE](LICENSE)。
- 第三方组件与使用说明（DSH 运行时、视觉模型、样例真题）：[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- 依赖与部署：[DEPENDENCIES.md](DEPENDENCIES.md)。
