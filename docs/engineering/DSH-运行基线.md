# DSH 运行基线与兼容契约

> 状态：**现行**（当前目标与已核验基线：**DSH Desktop `0.2.2-rc.5`**，会话实测进度见 [验收待办](验收待办.md)）。
> 说明：本文只维护当前有效的运行时环境事实、挂载契约与版本政策；`0.1.7-rc.2` 至 `0.2.2-rc.1` 时期的升级排障记录见 [决策记录](决策记录.md) 与 Git 历史。

---

## 1. 现行验证环境（2026-11-26 本机核验）

| 项 | 现行事实 | 读取来源与说明 |
| :-- | :-- | :-- |
| 宿主版本 | **DSH Desktop `0.2.2-rc.5`**（`dshBuildCommit`: `3f85d888b129…`，更新通道 `nightly`） | 安装包 `FileVersion`、Windows 卸载注册项 `DisplayVersion`、`app.asar/package.json` 与 `resources/runtime/primary-runtime/runtime.json` 一致 |
| 内置运行时 | Electron `44.7.0` ／ Node `24.21.0` ／ pnpm `11.28.5` ／ Python `3.12.14`（含 `python-docx 1.2.0`、`Pillow 12.3.0`） | `<安装目录>/version` 与 `<安装目录>/resources/runtime/primary-runtime/runtime.json` |
| 版本读数优先级 | **安装包内置 runtime ＞ `$DSH_HOME/dsh-runtimes/` 旧缓存** | 桌面就地自动更新不会刷新 `$DSH_HOME/dsh-runtimes` 下的旧 `runtime.json`；`scripts/setup.mjs` 与 `geo_status` 均优先读安装目录内置 runtime |
| 打包形态 | 单文件 `resources/app.asar` | `app.asar` 内路径不可作为普通文件系统目录读取；核对宿主行为需解析 asar 归档或按官方提交查源码 |
| 兼容门策略 | `< 0.2.1` 硬拒绝；`0.2.1` 系列可挂载但少 `list_agents` 等 `0.2.2` 新增能力；`0.2.2-rc.5` 为现行核验基线；其他版本提示“未完整验证” | 最低版本接口清单锁定前暂不声明 `engines.dsh`（宿主 `dsh-app-boot` 对 `engines.dsh` 执行严格 semver 校验） |

---

## 2. Profile 与预设挂载契约

桌面端使用 `<DSH_HOME>/profiles/desktop`（`DSH_HOME` 缺省 `~/.dsh`）。一个组合包（bundle）要生效，**必须同时满足三项**；而供插件读取的纯数据包**只挂 `dependencies`，严禁列入 `bundles`**：

1. 列入 `profile/package.json` 的 `dependencies`；
2. 仅声明了 `dsh.bundle` 的组合包列入 `profile/package.json` 的 `dsh.profile.bundles`（非 bundle 数据包误入 `bundles` 会触发 `not-bundle` / `skippedBundles`）；
3. 在 profile 目录执行一次 `pnpm install` 生成 `node_modules` 解析条目（DSH 启动不会自动安装依赖）。

```jsonc
// <DSH_HOME>/profiles/desktop/package.json（开发态 link 示例；发布态为 semver 版本号）
{
  "dependencies": {
    "@geo-edu/dsh-geo-teacher-preset": "link:<仓库路径>/.agent-presets/geo-teacher",
    "@geo-edu/dsh-geo-teacher-ui":     "link:<仓库路径>/packages/dsh-geo-teacher-ui",
    "@geo-edu/dsh-geo-teacher-data":   "link:<仓库路径>/packages/dsh-geo-teacher-data"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@geo-edu/dsh-geo-teacher-preset",
        "@geo-edu/dsh-geo-teacher-ui"
      ]
    }
  }
}
```

### 关键装配约束

- **禁止相对路径插件名**：预设声明行由 profile 补丁层插入，`baseUrl` 是 profile 目录而非预设包目录。本地插件一律通过 `@geo-edu/dsh-geo-teacher-preset/plugins/<name>` 子路径导出；技能根通过 `createRequire(baseUrl).resolve('@geo-edu/dsh-geo-teacher-preset/package.json')` 定位。
- **服务隔离白名单**：预设内所有 `ctx.provide('X')` 必须在 `cordis.patch.yml` 对应 group 的 `isolate` 中声明 `X: true`（如 `geoKernel: true`），否则宿主会因发布进程级全局服务报错。
- **路由与全局命令回收**：`webServer.register` 对重复 `(kind, path)` 抛错，插件必须通过 `ctx.effect` 注册路由清理函数；`commands.register` 位于全局层，重挂载时须做幂等兜底，防止打挂预设激活。

---

## 3. 宿主关键机制与破坏性边界（DSH ≥ 0.2.1 / 0.2.2-rc.5）

| 机制 | 现行契约 | 本项目约束 |
| :-- | :-- | :-- |
| **桌面端动态端口** | `0.2.1` 起桌面端默认由系统分配端口，每次重启都会变化（固定 `19387` 假设已失效） | `geo-verify.mjs` 运行时探测强制读取环境变量 `DSH_WEB_URL`，未提供时直接报错提示，禁止回落旧端口 |
| **Persona 严格模板** | `@deepseek-ai/dsh-persona` 的 `prefix`/`suffix` 在渲染时严格解析 `{{…}}`，仅注册 `provider` 与 `model`；未注册变量（如旧版 `{{cwd}}`）直接导致整轮会话报错 | `cordis.patch.yml` 的 persona 只使用 `{{model}}`；工作目录由 `includeRuntimeContext: true` 自动提供；时区与当前时间由 `@deepseek-ai/dsh-time-context` 提供 |
| **子代理控制与模型选择** | `0.2.2-rc.1` 起 `list_agents` 并入 `@deepseek-ai/dsh-tool-subagent-control` 主入口（`./list-agents` 子路径已移除），标准预设默认设 `interrupt: false`；`tool-subagent`（`spawn`）需开启 `modelSelection: true`、`modelDiscovery: true` 才会消费 profile 的子代理模型白名单 | 组合文件只声明主入口并对齐 `interrupt: false` 与 `modelSelection`/`modelDiscovery: true`；内部预设 `geo-solver-internal` 仍保持单行 `solver-isolation` 零工具锁定 |
| **成品交付工具 `present`** | `0.2.2` 标准预设挂载 `@deepseek-ai/dsh-tool-present`，供模型将落盘文件（HTML/DOCX 等）声明为会话交付物 | `geo-teacher` 预设同步挂载 `present` 行，避免模型在交付课程方案三件套或导出报告时触发 `UNKNOWN_TOOL` |
| **联网搜索提供方自动路由** | `0.2.2-rc.4` 起底座不再硬编码 `web.searchProvider: deepseek-search-api`：`deepseek-official`/`deepseek-account` 路由默认走官方旧版 Messages 搜索端点，其余自定义路由（如 `llm-pi-ai` 第三方网关）默认走 `deepseek-search-api` | 使用 `llm-pi-ai` 自定义 provider 时维持默认行为；若将官方 `deepseek` provider 重定向至第三方网关，需在 profile 显式配置搜索提供方，防止把网关密钥发往官方端点 |
| **模型拒答错误码独立** | `0.2.2-rc.3` 起 DeepSeek `stop_reason: "refusal"` 独立映射为错误码 `CONTENT_REFUSED`（不再混入 `MALFORMED_RESPONSE`） | 隔离解题或工具异常处理排查 `SOLVER_RUN_FAILED` 时，可通过诊断信息区分模型拒答与响应格式损坏 |
| **工具输出无损 JSON** | DSH 工具边界要求返回值满足 lossless JSON（含 `undefined` 键、`NaN`、`Infinity` 会抛 `INVALID_TOOL_OUTPUT`） | 复杂工具返回前须做无损规整（如 `toLosslessJson`），测试需覆盖真实 `execute()` 出口 |
| **技能目录与裁剪阈值** | 技能 `description` 默认在 500 字符处静默截断，且含 `: `（冒号加空格）未加引号会触发 YAML 解析失败被静默剔除；`tool-result-pruner` 阈值为 8192 Unicode 码点 | `geo-verify.mjs` 对两个技能根强制检查 `description ≤ 500`、YAML 冒号陷阱及正文 `≤ 8192` 码点 |

---

## 4. 修改何时生效（HMR 与重启边界）

| 修改范围 | 生效方式 |
| :-- | :-- |
| 技能入口文件（`SKILL.md`、平铺 `<name>.md`） | 技能发现器默认监听入口，修改后重新调用技能即可生效，无需重启桌面 |
| 技能支持文件（`references/*`、`scripts/*`） | 不触发目录刷新，下次模型显式读取该文件即拿到新内容（已进当前会话历史的旧文本不自动替换） |
| 插件 JS、`cordis.patch.yml`、`package.json` 导出或依赖 | **必须完全退出并重启 DSH Desktop**（注意：点击窗口关闭按钮可能只是隐藏到系统托盘，须确认 Electron 与 Host 进程已退出） |

---

## 5. 版本漂移政策

1. **现行文档只写现行事实**：规范文档与使用指南描述当前有效行为；历史版本结论统一归入 [决策记录](决策记录.md) 与 Git 历史。
2. **升级即重定基线**：DSH 桌面端升级后先核对预设挂载、`/geo/core/health` 与关键工具行为，不得直接沿用旧版本假设。
3. **实证三要素**：任何标为「已验证」的结论必须能说明**在哪个 DSH 版本、用什么手段、观察到什么结果**；发布说明仅作预判，不代替实测。
