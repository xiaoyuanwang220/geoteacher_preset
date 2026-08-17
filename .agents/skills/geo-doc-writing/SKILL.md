---
name: geo-doc-writing
description: Use when writing, reviewing, or editing geo-teacher documentation, skill files, tool descriptions, or deliverable prose. Enforces proposition-preservation, eliminates author-session residue, and routes all geographic terminology to the shared glossary. Not a teacher-facing skill.
---

# 地理教师 Agent 开发写作规范

本技能面向**开发/维护**本项目的 Agent，不进教师运行预设。教师端写作规则已分别嵌入各教师技能（出题/解题/讲题/课程方案），共同以 `docs/术语表.md` 为唯一权威。

## 原则

1. **保留完整命题**：编辑时不得遗漏原关键命题（obligation / invariant / precondition / consequence）。
2. **只删废话，不删契约**：一句话若是契约（caller 需要的条件、副作用、失败模式），必须保留；若是版本叙述（"v2 修订""之前改成"）、推理残留（"我推测""我认为"）、评审痕迹（"reviewer 指出"），则删除。
3. **术语以 `docs/术语表.md` 为准**：所有产出中的地理术语必须与术语表一致；表外术语显式标注"待确认"。
4. **proposition-preservation 有边界**：它只能检查编辑时是否遗漏原命题；**不能证明**答案正确、答案与解析一致、地理事实准确——这些需领域 Rubric。

## 过程性元话语与作者痕迹检测

删除以下内容（但保留可教学推理）：

| 需删除 | 示例 |
| :-- | :-- |
| 模型自述 | "我这样想""我推测""我认为应该" |
| 版本痕迹 | "v2.0 修订""之前改为""现在改为" |
| 评审痕迹 | "reviewer 指出""评审建议" |
| 对解析的机械复述 | 照抄真题解析原文（讲题稿应教学化重组，非复读） |

**必须保留**（可教学推理）：
- 审题（设问拆解）
- 证据（材料引用）
- 原理（知识选择依据）
- 因果链（推理步骤）
- 干扰项排除（为什么不是另一个答案）

## 适用范围

本规范适用于：
- `docs/` 下的文档（使用指南、讲题设计、术语表、决策记录等）
- `.agents/skills/` 下的开发技能（geo-dev-checklist、geo-doc-writing）
- 工具 description（`ctx.tools.register` 里的 `description` 字段）
- 方案/PR/提交信息中的地理相关内容

**不适用于**：
- 教师技能内容（已内嵌各自规范）
- 已归档的历史文档（`legacy/`、`docs/讲题功能设计.md` 的旧版记录段）
- 代码注释中的实现说明（非地理术语，不在此规范范围）

## 术语引用

所有开发产出中的地理术语以 `docs/术语表.md` 为准。新增术语须先在术语表追加，再在产出中使用。
