# npm 一键安装更新与独立真题数据包方案

> 状态：**方案（待实施）** ｜ 立项日期：2026-11-24
> 关联：[本地安装与数据接线契约](../engineering/本地安装与数据接线契约.md)、[DSH 运行基线](../engineering/DSH-运行基线.md)、[决策记录](../engineering/决策记录.md)

---

## 1. 背景与痛点

当前外部用户使用本项目必须先安装 Git、执行 `git clone` 全量克隆仓库，再用 `node scripts/setup.mjs --yes` 以 `link:` 符号链接方式挂载到 DSH Desktop。该方式在推广与后续迭代中存在三项明显障碍：

1. **安装与网络门槛高**：一线地理教师电脑通常未配 Git，且国内直连 GitHub 经常超时。
2. **持续更新脆弱**：一旦教师或本地 Agent 无意修改了克隆目录中的文件，后续 `git pull --ff-only` 即会因冲突中断，需要复杂的排障回滚规程。
3. **代码迭代与 16 MB 题图强捆绑**：每次仅修改几行插件 JS 或技能文案，若把 16.3 MB 真题图文混在主插件包内反复发布，既拖慢包安装速度，也让题库数据与程序逻辑无法独立升级。

---

## 2. 目标架构：四包协同（一键 CLI + 双业务 Bundle + 独立数据包）

采用 npm 公共仓库（完美兼容 `npmmirror.com` 国内镜像加速），按职责拆分为四个包：

| 包名（暂定 `@geo-edu/*`，以实际注册组织名为准） | 角色 | 包含内容与体积量级 | 更新频率 |
| :-- | :-- | :-- | :-- |
| `geospark-ai`（或 `@geo-edu/setup`） | **一键安装/更新 CLI**（带 `bin`） | 升级版 `setup.mjs`：环境与 DSH 版本检查、备份 profile、写入版本依赖与 `bundles`、调用 DSH 内置 pnpm 安装/更新/卸载 | 低频 |
| `@geo-edu/dsh-geo-teacher-preset` | **核心预设 Bundle** | 7 个功能插件 + 4 个教师技能 + `cordis.patch.yml` + **内置轻量考点库 `data/config/`（~160 KB）** + 可选内置课标原文（不含教材正文） | 高频（几百 KB） |
| `@geo-edu/dsh-geo-teacher-ui` | **输入区原生 UI Bundle** | 桌面端会话输入区功能与参数选择器（零构建客户端 + 素材，~50 KB） | 中低频 |
| `@geo-edu/dsh-geo-teacher-data` | **独立真题数据包** | `obsidian_vault/04_题目`（115 份 md）+ `90_附件/题目图片`（120 张图），保留相对路径不变（~16 MB） | 按题库扩充节奏独立发版 |

> **版权隔离收益**：仓库根目录下的 `课本与课标/`（含人教版教材原文）及 `.agents/`、`docs/`、`outputs/` 均不在任何 npm 包的 `files` 白名单中，不会随公网包分发。

---

## 3. 用户侧目标体验

无需安装 Git、无需克隆仓库，只需电脑已装好 DSH Desktop（自带 Node 与 pnpm），一行命令完成全流程：

```sh
# 首次一键安装（自动挂载 preset + UI + 独立真题数据包）
npx geospark-ai@latest install --yes

# 后续一键升级到最新版（支持国内镜像秒更）
npx geospark-ai@latest update --yes

# 不装默认真题包（仅用自带考点库 + 教师自建题库）
npx geospark-ai@latest install --no-data --yes

# 干净卸载（保留 ~/.dsh/geo-teacher/ 下的个人配置与产物）
npx geospark-ai@latest uninstall --yes
```

对于维护者本机开发，保留 `--link <repoPath>` 模式，继续使用 `link:` 符号链接直连工作区，开发体验零回退。

---

## 4. 代码改造清单（上线前必改的 4 处卡点）

### 4.1 `geo-core` 数据路径解耦（`.agent-presets/geo-teacher/plugins/core/index.js`）
- **现状问题**：硬编码 `REPO_ROOT = join(PKG_ROOT, '..', '..')` 寻找 `data/`，在 `node_modules/@geo-edu/dsh-geo-teacher-preset` 下会指向上层 `node_modules` 导致失效。
- **改造方案**：将 `resolveDataDir` 升级为四级单向探针，按顺序命中首个有效目录：
  1. 插件显式 `config` 或 `<DSH_HOME>/geo-teacher/config.json` 用户路径（`source: 'user'`）；
  2. 独立数据包解析路径：`createRequire(import.meta.url).resolve('@geo-edu/dsh-geo-teacher-data/package.json')` 所在目录的真题库，以及预设包内置 `join(PKG_ROOT, 'data', 'config')` 考点库（`source: 'packaged'`）；
  3. 本地开发仓库兜底 `join(PKG_ROOT, '..', '..', 'data')`（`source: 'packaged'`）；
  4. 未命中返回 `missing` 并给出清晰配置指引。

### 4.2 出题模块默认输出目录修复（`plugins/question/index.js` 与 `check-package.mjs`）
- **现状问题**：`check-package.mjs` 在未配置时回退到 `join(REPO_ROOT, 'outputs', '出题')`（npm 模式下会尝试写 `node_modules`）；`plugins/question/index.js` 在无 `config.json` 时 `OUTPUT_ROOT` 为 `null` 直接报错。
- **改造方案**：两侧统一对齐 `geo-core` 的默认习惯，在未显式配置 `questionOutputRoot`/`outputPath`/`workspaceRoot` 时，默认落到 `<DSH_HOME>/geo-teacher/outputs/出题`。

### 4.3 安装器双模式改造与抽包（`scripts/setup.mjs` → `packages/geospark-cli`）
- 默认模式向 `profile/package.json` 写入 npm 版本范围（如 `latest` 或锁定兼容主次版本），把 `@geo-edu/dsh-geo-teacher-preset` 与 `@geo-edu/dsh-geo-teacher-ui` 加入 `dsh.profile.bundles`，把 `@geo-edu/dsh-geo-teacher-data` 加入 `dependencies`（数据包无需入 `bundles`）。
- `verifyStatic` 区分 `npm` 模式（校验 `require.resolve` 可达与包 `version`）与 `--link` 开发模式（校验符号链接目标）。
- 增加 `update` 子命令：调用内置 pnpm 拉取最新包版本并输出变更前后的版本号对照，提醒完整重启 DSH Desktop。

### 4.4 包清单与发布流水线
- 移除 `.agent-presets/geo-teacher/package.json` 的 `"private": true`，补充 `"publishConfig": { "access": "public" }`、`repository`、`keywords`，确认 `skills/cn-high-school-geography-lesson-planning/{LICENSE,NOTICE}`（Apache-2.0）包含在发布文件内。
- 新建 `packages/dsh-geo-teacher-data/package.json`（或发布构建脚本从 `data/obsidian_vault/` 组装 tarball），避免仓库内保存双份 16 MB 数据副本。
- 新增 `npm run release:dry-run`（执行 `npm pack --dry-run` 核验每个包的体积与文件清单，严防敏感文件或缓存打入 tarball）。

---

## 5. 验收门禁

1. **打包白名单核验**：4 个包执行 `npm pack --dry-run`，确认不含 `课本与课标/` 教材正文、`.backups/`、`outputs/`、`.env` 或 `__pycache__`。
2. **本地 Verdaccio / Tarball 模拟安装**：在隔离的临时 `DSH_HOME` profile 上模拟无仓库环境安装 tarball，校验 `require.resolve`、`/geo/core/health`（显示 `packaged`，162 考点 / 279 小问）及零配置下 `geo_question_validate` 默认输出路径正常。
3. **升级与卸载幂等性**：模拟 `0.1.0 → 0.1.1` 执行 `update` 后版本更新且用户 `config.json` 未被覆盖；执行 `uninstall` 后精确移除本项目包且不影响其他插件。
