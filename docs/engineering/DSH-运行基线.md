# DSH 运行基线与兼容契约

> 状态：**现行**（当前已验证版本：**DSH Desktop `0.2.2-rc.1`**，验收进度见 [验收待办](验收待办.md)）。
> 说明：本文只维护当前有效的运行时环境事实、挂载契约与版本政策；`0.1.7-rc.2` 与 `0.2.1-rc.2` 时期的升级排障记录见 [决策记录](决策记录.md) 与 Git 历史。

---

## 1. 现行验证环境（2026-11-07 实测）

| 项 | 现行事实 | 读取来源与说明 |
| :-- | :-- | :-- |
| 宿主版本 | **DSH Desktop `0.2.2-rc.1`**（官方标签 `dsh-v0.2.2-rc.1`，commit `c59d10aff…`） | 安装包 `FileVersion`、Windows 卸载注册项 `DisplayVersion`、安装目录 `resources/runtime/primary-runtime/runtime.json` 三处一致 |
| 内置运行时 | Electron `44.7.0` ／ Node `24.21.0` ／ pnpm `11.28.5` ／ Python `3.12.14` | `<安装目录>/resources/runtime/primary-runtime/runtime.json` |
| 版本读数优先级 | **安装包内置 runtime ＞ `$DSH_HOME/dsh-runtimes/` 旧缓存** | 桌面就地自动更新不会刷新 `$DSH_HOME/dsh-runtimes` 下的旧 `runtime.json`；`scripts/setup.mjs` 与 `geo_status` 均优先读安装目录内置 runtime |
| 打包形态 | 单文件 `resources/app.asar` | `app.asar` 内路径不可作为普通文件系统目录读取；核对宿主行为需扫描 asar 文本或按官方 tag 查 GitHub 源码 |
| 兼容门策略 | `< 0.2.1` 硬拒绝；`0.2.1` 系列可挂载但少 `list_agents` 工具；`0.2.2-rc.1` 完整验证；更高版本提示“未完整验证” | 最低版本接口清单锁定前暂不声明 `engines.dsh`（宿主 `dsh-app-boot` 对 `engines.dsh` 执行严格 semver 校验） |

---

## 2. Profile 与预设挂载契约

桌面端使用 `<DSH_HOME>/profiles/desktop`（`DSH_HOME` 缺省 `~/.dsh`）。一个 bundle 要生效，**必须同时满足三项**：

1. 列入 `profile/package.json` 的 `dependencies`；
2. 列入 `profile/package.json` 的 `dsh.profile.bundles`；
3. 在 profile 目录执行一次 `pnpm install` 生成 `node_modules` 解析条目（DSH 启动不会自动安装依赖）。

```jsonc
// <DSH_HOME>/profiles/desktop/package.json（开发态 link 示例；发布态为 semver 版本号）
{
  "dependencies": {
    "@geo-edu/dsh-geo-teacher-preset": "link:<仓库路径>/.agent-presets/geo-teacher",
    "@geo-edu/dsh-geo-teacher-ui":     "link:<仓库路径>/packages/dsh-geo-teacher-ui"
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

## 3. 宿主关键机制与破坏性边界（DSH ≥ 0.2.1 / 0.2.2）

| 机制 | 现行契约 | 本项目约束 |
| :-- | :-- | :-- |
| **桌面端动态端口** | `0.2.1` 起桌面端默认由系统分配端口，每次重启都会变化（固定 `19387` 假设已失效） | 运行时探测一律读取环境变量 `DSH_WEB_URL`，禁止写死端口号 |
| **Persona 严格模板** | `@deepseek-ai/dsh-persona` 的 `prefix`/`suffix` 在渲染时严格解析 `{{…}}`，仅注册 `provider` 与 `model`；未注册变量（如旧版 `{{cwd}}`）直接导致整轮会话报错 | `cordis.patch.yml` 的 persona 只使用 `{{model}}`；工作目录由 `includeRuntimeContext: true` 自动提供 |
| **子代理控制入口** | `0.2.2-rc.1` 删除了 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径，`list_agents` 并入主入口 | 组合文件中只声明 `@deepseek-ai/dsh-tool-subagent-control` 主入口，避免因悬空子路径导致 `agent-preset/invalid` |
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
