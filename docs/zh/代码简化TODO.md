# 代码简化审计 TODO 清单

> 来源：`dsh-find-simplifications` 方法论审计（v3.0 方案 P2-1）
> 日期：2026-08-16
> 原则：先证明无生产调用者再删；不破坏已有功能；每次只改一处

## 高优先级（重复函数抽取）

### TODO-1: 抽取共享 `sendJson` / `parseQuery` / `renderJson`

**现状**：`taxonomy`、`bank`、`analysis`、`generator` 四个功能插件各有一份完全相同的 `sendJson`/`parseQuery`/`renderJson` 函数（共 12 份重复，约 60 行×3 = 180 行冗余）。

**建议**：在 `plugins/shared/` 下新建 `http-utils.js`（或放 core 内部），导出三个函数。四个插件改为 import 引用。

**消费者证据**：4 个插件都使用，且 `ui` 插件不使用（它是 HTML 页面，不走 JSON API）。无外部消费者。

**影响**：纯内部重构，不影响工具/API 行为。但需验证 ESM import 路径在 DSH 环境下可用（已有 core 内相对路径导入先例）。

**风险**：低。

---

### TODO-2: 评估 `resolveImagePath` 是否可用 Node 内置替代

**现状**：`core/index.js` 里手写了 `resolveImagePath`（约 15 行），功能等同 `path.resolve(baseDir, rel)` + 反斜杠归一。验证脚本已证明与 `node:path.resolve` 结果完全一致。

**建议**：改为 `import { resolve } from 'node:path'` + `import { normalize } from 'node:path'`（ESM 环境下 `node:path` 可用）。删除手写函数。

**消费者证据**：仅 `core/index.js` 内的 `extractImageRefs` 使用。

**风险**：极低（已有验证）。

---

## 中优先级（手写校验）

### TODO-3: 评估 `validateRaw` 是否可用 `ajv` 或 `zod` 替代

**现状**：`vision/index.js` 里手写了 `validateRaw`（约 25 行），对 Qwen 返回 JSON 做结构校验。校验逻辑相对简单（字段存在性+枚举+类型），手写覆盖已知需求。

**建议**：若后续 schema 扩展（如加更多图类型或字段），改用 JSON Schema 校验库（如 `ajv`，轻量）。当前手写足够，优先级不高。

**消费者证据**：仅 `vision/index.js` 内使用。

**风险**：低（手写覆盖已知需求）。

---

## 低优先级（future）

### TODO-4: 核心插件文件大小

**现状**：`core/index.js` 约 950 行（含解析器+分析引擎+蓝图+风格档案+P1-P3 方法），`vision/index.js` 约 430 行。单文件尚可维护，但若继续增长可考虑拆分。

**建议**：暂不拆。待功能稳定后（如讲题 P1-P3 完成）再评估是否拆 `parsers.js`/`analysis.js`/`skeleton.js` 子模块。

**风险**：不适用（观察项，不改）。
