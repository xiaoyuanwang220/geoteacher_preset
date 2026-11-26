# GeoSparkAI · 高中地理教师辅助 Agent

GeoSparkAI 是运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）上的**高中地理教学预设**：它在会话里提供一套地理教师工具链与技能，让模型基于**本地真题库、考点树、课标与教材原文**工作，而不是凭记忆生成教学内容。

它解决的是「通用大模型能写教案、能讲题，但依据不准、容易对着答案编理由」的落差：考点对到本地考点树，真题对到原题与答案，讲题先把答案物理隔离在独立作答完成之后，课程方案先核实课标教材落盘并经教师确认构思后再成稿。本项目坚持明确分工——**确定性工作交给程序，教学判断交给模型，最终把关留给教师**。

> *English summary: GeoSparkAI is a high-school geography teaching agent preset for DeepSeek Harness — isolated exam-question explaining, disciplinary-idea-driven lesson planning, and exam-style item polishing/quick-checks grounded in a local exam bank and curriculum taxonomy.*

## 能做什么

| 功能 | 你能得到 | 当前状态 |
| :-- | :-- | :-- |
| **讲题助手** | 先隔离盲做、再逐问核验、最后教学化成稿的三段式讲题流水线；支持**学生（默认）／教师／命题人**三种讲解对象与同类题比较 | 核心流程已实现；真实题组复验与人工学科评审推进中 |
| **课程方案** | 依据课标、教材原文与学科思想解读，协同产出**教学设计、学生学习材料、课堂观察记录表**三件套，支持 **HTML 与 DOCX 并列成品输出** | 已落地去模板化治理与五阶段流程，完成选必 2 学科思想解读接入试点 |
| **模拟题润色与快测** | 核心用于以高考真题风格标尺润色日常模拟题，延伸支持课后快速检测简题与结构化命题包（选择题组／综合题，自动分离学生与教师投影） | 开发中：底层风格档案、命题蓝图与 `schemaVersion: 2` 结构校验已跑通 |

入口仅保留桌面端**会话输入区功能选择器**与**自然语言对话**（旧 web 工作台页面已下线）。

> ⚠️ **本项目处于持续开发与验证阶段**，接口、数据契约与技能内容仍会演进；哪些已实测、哪些待验收统一以 [验收待办](docs/engineering/验收待办.md) 与 [决策记录](docs/engineering/决策记录.md) 为准。

## 环境要求

| 项 | 要求 |
| :-- | :-- |
| DSH | Desktop **`0.2.2-rc.5`**（现行已验证基线；`< 0.2.1` 不支持，桌面端端口由系统动态分配，以 `DSH_WEB_URL` 为准） |
| 平台 | Windows（本机实测平台）；核心逻辑为纯 Node ESM，其他平台未完整验证 |
| Node | 随 DSH 桌面端附带（实测 `v24.21.0`）；仓库脚本只用 ESM 与 `node:test` |
| Python | `3.12`（仅课程方案 HTML/DOCX 渲染与复核脚本需要，DOCX 依赖 `python-docx`） |
| 数据 | **随附提供**：考点库 `data/config/`、独立真题数据包 `@geo-edu/dsh-geo-teacher-data`（`packages/dsh-geo-teacher-data/obsidian_vault/04_题目/`，含题图）；支持在配置中替换为自有目录 |

## 安装与启动

> 面向无 Git 环境的 **npm 一键安装更新与独立数据包拆分** 正在推进（见 [方案说明](docs/proposals/npm一键安装与数据包拆分方案.md)）；当前仓库检出安装步骤如下：

```sh
git clone https://github.com/xiaoyuanwang220/geoteacher_preset.git geo_edu_agent
cd geo_edu_agent
node scripts/setup.mjs --check   # 只读检查：DSH 版本、profile、包与数据
node scripts/setup.mjs --yes     # 备份清单 → 写入 link 依赖 → pnpm 安装 → 静态校验
```

安装完成后**完全退出并重新启动 DSH Desktop**（关闭窗口可能只是最小化到托盘，请确认进程已退出），新建「地理教师辅助」会话，输入 `/geo-status`（或直接发消息说「查看状态」）确认版本、数据来源与题库题数。

### 卸载与自检

```sh
node scripts/setup.mjs --uninstall --yes   # 卸载（保留个人配置、数据与产物）
npm run verify:geo -- --source             # 确定性源码静态检查
node --test "test/*.test.mjs"              # 行为与边界回归测试
```

## 配置数据路径（可选）

默认直接使用 `data/` 数据，**零配置即可运行**。如需换用自建题库或考点目录，在 `<DSH_HOME>/geo-teacher/config.json`（`DSH_HOME` 默认 `~/.dsh`）中按需填写，同名键覆盖默认路径：

| 配置键 | 用途 | 缺省值 |
| :-- | :-- | :-- |
| `knowledgeBasePath` | 考点库目录（含 `knowledge_taxonomy_*.yaml`） | `data/config/` |
| `questionBankPath` | 真题 Markdown 根目录（保留子目录与题图相对位置） | `@geo-edu/dsh-geo-teacher-data`（`obsidian_vault/04_题目/`） |
| `outputPath` | 分析导出、讲题运行记录等产物目录 | `<DSH_HOME>/geo-teacher/outputs/` |
| `workspaceRoot` | 允许写入产物的沙箱根目录 | `<DSH_HOME>/geo-teacher/` |

## 考点库说明与声明

`data/config/` 下的 4 个 `knowledge_taxonomy_*.yaml` 按 `领域（DM-）→ 主题（TH-）→ 知识单元（KU-）` 三级组织（当前 4 领域、26 主题、132 知识单元，共 162 节点，`meta.version: v0.2-draft`），用于考点检索、定位与分类，库内 `needs_review` 节点在使用时会主动提示「待复核」。

**声明**：考点库的划分、命名与边界均为**维护者个人对高中地理课程内容的理解与教学整理，仅代表个人观点**，不代表教育部、课标编写组或任何机构的官方意见，也不替代课标与教材原文。使用者可随时修改或替换为自建考点库。

## 怎么用

1. **会话输入区**：选中「地理教师辅助」预设后，在输入框工具栏点选「讲题／课程方案」及对应参数（讲解对象，或年级＋授课时间），选定参数会自动通过宿主运行时上下文同步给模型（不污染输入框正文，也不会重复追问课时或年级；模拟题润色与快测出题直接走对话输入）。
2. **自然语言对话**：
   - **讲题**：「这道题怎么做」只调用 `geo_solve` 独立作答；「把这道题讲给学生听」自动连续完成 `geo_solve` → `geo_judge`（开放答案并逐问归档）→ `geo_explain`（输出纯净讲题稿）。
   - **课程方案**：「设计一节人教版选必二《资源枯竭型城市的转型发展》45 分钟教案」加载 `cn-high-school-geography-lesson-planning`，先核实课标教材写入 `依据-<课标编号>.md`，给出 ≤5 行「构思卡」停等你确认后再成稿并渲染 HTML / DOCX 三件套。
   - **模拟题润色 / 快测 / 检索**：「参考广东卷风格润色这道模拟题」「出一组生态脆弱区综合治理的材料题」「人口迁移近几年考得多吗」。

详细操作、话术示例与排障见 [使用指南](docs/使用指南.md)。

## 仓库结构

```text
.agent-presets/geo-teacher/      预设 Bundle（@geo-edu/dsh-geo-teacher-preset）：7 个功能插件 + 4 个教师技能 + cordis.patch.yml
packages/dsh-geo-teacher-ui/     输入区原生 UI 插件（@geo-edu/dsh-geo-teacher-ui）
packages/dsh-geo-teacher-data/   独立真题数据包（@geo-edu/dsh-geo-teacher-data）：高考真题 Markdown、题图与图谱笔记
.agents/skills/                  开发维护技能（代码审查、开发自检、文档写作规范、教材结构化与思想逆向；不进教师预设）
data/config/                     随附考点库（4 份 knowledge_taxonomy_*.yaml）
docs/                            四层文档体系：全局入口与使用指南 / engineering 工程台账 / modules 模块规范 / proposals 待实施方案
课本与课标/                       本地维护参考的课标与教材文本（对外再分发请自行确认出版方授权）
scripts/                         setup 安装器与 geo-verify 确定性检查脚本
test/                            行为与边界测试套件
```

## 文档导航

完整目录见 **[项目文档总索引](docs/README.md)**：

- **快速了解与上手**：[项目介绍与研究规划](docs/项目介绍与研究规划.md) ｜ [使用指南](docs/使用指南.md) ｜ [共享术语表](docs/术语表.md)
- **工程基线与全局台账**：[验收待办](docs/engineering/验收待办.md) ｜ [决策记录](docs/engineering/决策记录.md) ｜ [DSH 运行基线](docs/engineering/DSH-运行基线.md) ｜ [开发与技能规范](docs/engineering/开发与技能规范.md)
- **业务模块现行规范**：[讲题功能与工作流](docs/modules/讲题-功能与工作流规范.md) ｜ [课程方案治理记录](docs/modules/课程方案-治理记录.md) ｜ [选必2学科思想试点](docs/modules/课程方案-选必2学科思想试点.md) ｜ [模拟题润色与快测需求](docs/modules/出题-产品需求.md)
- **待实施演进方案**：[npm 一键安装与数据包拆分](docs/proposals/npm一键安装与数据包拆分方案.md) ｜ [上传试卷讲题方案](docs/proposals/上传试卷讲题方案.md)

## 许可与致谢

- 仓库主体采用 **MIT** 许可，见 [LICENSE](LICENSE)。
- 课程方案技能 `.agent-presets/geo-teacher/skills/cn-high-school-geography-lesson-planning/` 采用 **Apache-2.0** 许可，派生自 *Agent Skills for K-12 Teachers*（Copyright 2026 Anthropic PBC and Learning Commons），分发时须保留其目录内的 `LICENSE` 与 `NOTICE`。
- `课本与课标/` 中课标属教育部公开文件，教材正文权利归原出版方；对外分发前请确认授权（不随 npm 包发布）。
- 感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的智能体桌面与插件框架。
