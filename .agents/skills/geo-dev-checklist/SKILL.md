---
name: geo-dev-checklist
description: Use when modifying geo-teacher plugins, composition, or skills — before committing changes and after restarting DSH. Runs `npm run verify:geo` for deterministic checks, then guides through manual review items the script cannot cover. Not a teacher-facing skill.
---

# 地理教师 Agent 开发自检

本技能面向**开发/维护**本项目的 Agent，不进教师运行预设。

## 确定性检查（自动）

运行 `npm run verify:geo`（参数见下表），确认输出 0 项失败：

| 命令 | 用途 |
| :-- | :-- |
| `npm run verify:geo` | 全量检查（源码 + 运行时冒烟） |
| `npm run verify:geo -- --source` | 仅源码静态检查（不需重启） |
| `npm run verify:geo -- --skip-runtime` | 源码检查 + 跳过运行时冒烟 |
| `npm run verify:geo -- --json` | 输出机器可读 JSON |

脚本覆盖 9 项检查：插件语法 / ESM 导入 / apply 冒烟 / 双副本 SHA-256 / YAML 结构 / isolate 白名单 / 路由静态扫描 / 运行时冒烟（/geo/core/health + /geo-teacher） / .backups 存在（仅提示）。

**⚠️ 脚本的路由静态扫描只能发现当前源码中的重复路径，不能发现 DSH 运行进程中旧 generation 未释放路由的问题。** 修改 `agent.cordis.yml` 或插件后**必须重启 DSH 才能生效**。

## 人工判断项（程序无法覆盖）

### 1. 重启后冒烟
- 修改 `agent.cordis.yml` / 插件后，重启 DSH 进程，再跑 `npm run verify:geo -- --runtime`。
- 若运行时冒烟失败（duplicate route），说明**旧 generation 路由仍在占用**——再等几秒重试，或确认进程已完全重启。

### 2. isolate 白名单
- 新增 `ctx.provide('X')` 时，必须同步在 `agent.cordis.yml` 的 geo group `isolate` 里加 `X: true`。
- 运行时会报 `row(s) published process-global service(s) [X]` → 立即加白名单。

### 3. 新增 webServer 路由
- 路由 path 不得与已有路由重复（`/geo/*` 前缀已被占用）。
- 运行时 duplicate route 错误无法通过静态扫描发现——只能靠重启后冒烟。

### 4. 新增插件/工具
- 工具 `ctx.tools.register({ name: 'geo_*', ... })` 前，先用 `ctx.get('tools')` 检查注册表是否存在。
- 若工具注册失败（报 "without inject"），需在插件声明 `inject: ['tools']`。
- 服务 `ctx.provide` 必须在 isolate group 内。

### 5. 代码审查维度（借鉴 dsh-code-review）
审查改动时按以下维度检查：
- **生命周期**：副作用是否归属 fiber？`ctx.effect()` 是否返回 disposer？未声明 inject 的服务访问是否用 `ctx.get()` + undefined 检查？
- **所有权**：新增变量/状态是否属于当前插件？跨插件通信是否通过 `geoKernel` 服务而非直接 import？
- **真实入口路径**：改动是否经得起 `npm run verify:geo` 的完整检查？是否存在 `node --check` 无法覆盖的动态加载路径？
- **模型可见输出**：工具 description 是否精确？返回值是否稳定（无随机性）？信息是否足够让模型正确调用？

### 6. 简化候选提醒
发现以下模式时记录为 TODO（不要在本会话直接删改）：
- 多个插件重复相同的 `sendJson`/`parseQuery`/`renderJson` 函数 → 应抽成共享模块。
- 手写路径解析/JSON Schema 校验 → 评估用 Node 内置或成熟依赖替换。
- 注释里的版本叙述（"v2.0 修订""之前改成"）→ 删除或移入决策记录。

## 术语引用

所有开发产出（提交信息、PR 描述、文档、工具 description）中的地理术语以 `docs/术语表.md` 为准。
