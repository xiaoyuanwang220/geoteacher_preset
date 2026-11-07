# DSH 0.2.1-rc.2 基线记录

> **现行验证版本（2026-11-07 实测）**：本机 DSH Desktop **`0.2.2-rc.1`**（安装包 `FileVersion`、Windows 卸载注册项 `DisplayVersion`、安装目录 `resources/runtime/primary-runtime/runtime.json` 三处一致；Electron 44.7.0 / Node 24.21.0 / pnpm 11.28.5 / Python 3.12.14）。**实测面**：完整重启后预设挂载成功、`/geo-teacher` 200、`/geo/core/health` 200（162 考点节点 / 115 文件 / 279 小问）。本文以下内容保留 **rc.2 时期**的记录原貌，作为历史基线，不追改。
> 现行口径以 [工作台聚合与一键安装方案](工作台聚合与一键安装方案.md) §2 与 [docs/README](README.md) 索引为准：`0.2.2-rc.1` 记为「已验证版本」；`0.2.1` 系列可安装但未完整验证（0.2.2 移除了 `list-agents` 子路径，0.2.1 上少一个 `list_agents` 工具）；最低版本待接口清单确认，`engines.dsh` 本期不声明。
>
> **2026-11-07 版本变更记录**：
> - **2026-11-04 桌面自动更新到 `0.2.2-rc.1`**（updater 就地更新）。该版本删除了 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 子路径（`list_agents` 并入主入口），旧预设新建会话报 `agent-preset/invalid`；预设已适配（见[决策记录](决策记录.md) 2026-11-07 行）。
> - **版本读数来源变更**：桌面就地更新**不再刷新** `$DSH_HOME/dsh-runtimes/.../runtime.json`（本机仍是 0.2.1-rc.5 旧副本）。现行版本与运行时以**安装目录** `resources/runtime/primary-runtime` 为准；`scripts/setup.mjs` 与 `/geo-status` 已改为优先读安装包内置 runtime（安装器在 Windows 上经卸载注册项定位安装目录），旧副本仅作回落。
> - **文件布局（本机实测）**：安装目录 `E:\deepseekharness`；应用 `resources\app.asar`（0.2.2-rc.1）；运行时 `resources\runtime\primary-runtime`（`payloadDigest 0881fbf6…`）；`$DSH_HOME` = `C:\Users\xxx\.dsh`（profile `desktop`）。
>
> 记录日期：2026-10-21；复验：2026-10-21（预设会话内）、2026-11-02（外部可验面与文档口径）、2026-11-07（0.2.2-rc.1 预设挂载与状态面）
> 触发：桌面从 `0.1.7-rc.2` 升级到 `0.2.1-rc.2` 后，预设会话**整轮运行失败**（见 §4）
> 性质：本文件记录**实测与源码/发布说明核对**的结果，不用"旧版结论"代替新版验证
> 取代范围：本文取代 [M0 基线](geography-question-generation-m0-baseline.md) 中**与运行版本相关**的事实（§1.1、§2 的版本前提）；M0 里与出题流程相关的过程性结论仍然有效，但涉及"机制在 rc.2 上如何表现"的部分须按本文重验
> 原则：**升级即重定基线。**任何"已验证"的结论都绑定它被验证时的版本；不得跨版本沿用。

---

## 1. 环境事实（2026-10-21 实测）

| 项 | 值 | 来源 |
| :-- | :-- | :-- |
| `desktopVersion` | **`0.2.1-rc.2`**（原基线为 `0.1.7-rc.2`） | `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/runtime.json` |
| `payloadDigest` | `e2cef445c262ce6e8d28480b5ebecc8b0c54c06bea7183374debfcf02f30eb7d` | 同上 |
| Node | `24.21.0` | 同上 |
| Python | `3.12.14` | 同上 |
| pnpm | `11.28.5`（M0 时为 `11.7.0`） | 同上 |
| Electron | `44.7.0` | `E:\deepseekharness\version` |
| 平台 | `win32` / `x64` | runtime.json |
| 安装形态 | 单文件打包：`E:\deepseekharness\resources\app.asar`，**182 794 869 B** | 文件系统 |
| 官方标签 | `dsh-v0.2.1-rc.2` | GitHub Releases API |
| commit | `687f282e8625c6b8d11ff58211a90524be2e4317` | GitHub tag API（`type: commit`，非附注标签） |
| 发布 | `2026-10-17T08:16:33Z`，`prerelease: true` | GitHub Releases API |
| 发布说明 | 仅两项：适配 DeepSeek-V4.1-Flash-1017；适配 DeepSeek Search 与 Fetch API（可在网页搜索设置中开启） | 同上 |

**源码可读性变化（重要）**：M0 时期曾在源码 checkout 上做只读核对（附录 A 的 S1—S16 固定 commit 链接）。现在安装是**打包的 app.asar**，`E:\deepseekharness\resources\app.asar\dsh\` **不是可读的真实路径**（`Test-Path` 为 False）。可用的核对手段有两条：

1. 对 app.asar 做**文本扫描**（内容为连续 UTF-8，可按块搜索字符串；包内 README 与源码注释均可读到）；
2. 按 §1 的 tag/commit 到 GitHub 读源码。

凡"M0 附录 A 的源码断言"在 0.2.1 下的有效性，都要按这两条重新核对，**不能因为链接还在就认为结论仍成立**。

## 2. profile 与预设接线（实测）

```jsonc
// <DSH_HOME>/profiles/desktop/package.json（2026-11-02 实测）
"dependencies": {
  "@geo-edu/dsh-geo-teacher-preset": "link:E:/geo_edu_agent/.agent-presets/geo-teacher",
  "@geo-edu/dsh-geo-teacher-ui":     "link:E:/geo_edu_agent/packages/dsh-geo-teacher-ui"
},
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
  "@geo-edu/dsh-geo-teacher-preset", "@geo-edu/dsh-geo-teacher-ui",
  "@deepseek-ai/dsh-experimental-agent-team-profile",
  "@deepseek-ai/dsh-experimental-inspector-profile",
  "@deepseek-ai/dsh-experimental-session-search",
  "@deepseek-ai/dsh-experimental-session-titles-bundle"
] } }
```

- 仍是 **link 直连仓库**，改仓库即改运行时（M0 的这条结论**继续有效**）。
- 新增包必须同时出现在 `dependencies` 与 `dsh.profile.bundles`，只加依赖不会加载。

## 3. 0.2.1 的破坏性变更中，与本项目相关的部分

来源标注：**R** = 0.2.1-rc.1 发布说明「其他变更」；**E** = 本机实测；**A** = app.asar 内包文档。

| # | 变更 | 来源 | 对本项目的影响 | 状态 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | **桌面端默认使用系统分配的端口**，不再固定 | R | 固定 `19387` 的旧假设失效。每次重启端口都变（实测序列 `19387 → 64386 → 64248 → 60965 → 55944`），凡写死端口的检查都必须改读 `DSH_WEB_URL` | ✅ 已确认 |
| 2 | **persona 的 `prefix`/`suffix` 是严格模板**，只按已注册的提示词变量解析 | A（`@deepseek-ai/dsh-persona` 包文档原文：「`{{…}}` groups resolve strictly against registered prompt variables」） | 该段只注册 `provider`／`model`；旧版可用的 `{{cwd}}` 已不再注册，**未注册变量直接让整轮失败**（不是原样保留） | ✅ 已修（§4） |
| 3 | 子路径插件不再读取独立的 `package.json`；显示文本与图标须经对应子路径导出 | R | 本预设六个插件都是 `./plugins/*` 子路径导出，本身不带独立 `package.json`；需确认没有遗留旧形态 | ✅ 已验证（2026-10-21 预设会话正常挂载） |
| 4 | 第三方插件版本兼容性**优先按 `engines.dsh` 判断** | R | 预设与 UI 插件**均未声明 `engines.dsh`**（走"原有规则"）。建议补声明，否则未来升级的兼容判断不可靠 | ⏳ 待办 |
| 5 | 移除 `agent-instructions` 的逐行 `dshHome` 配置，指令目录改从进程 `DSH_HOME` 读取 | R | 本预设该行只配 `maxBytes`，未用 `dshHome`，预期不受影响 | ✅ 已验证（该行只配 `maxBytes`；2026-10-21 会话正常） |
| 6 | 输入区统计扩展拆为 `activity`／`usage`；新增 `conversation.input.model.label` 等扩展位 | R | `packages/dsh-geo-teacher-ui` 使用 `conversation.input.left`／`right` 槽位，**槽位景观已变，须复验仍在** | ⏳ 需复验 |
| 7 | 移除工具展示的 `both` 混合模式，仅保留 `native`／`ptc` | R | 本项目未使用该模式 | ✅ 不适用 |
| 8 | Agent Team 消息直投目标 Inbox，移除独立 outbox/重试/去重 | R | 本项目未自定义 Agent Team 配置 | ✅ 不适用 |

## 4. 唯一已证实的破坏性变更：persona 模板变量

**症状**（用户切到出题模式发第一轮提示词时整轮失败）：

```
unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix";
registered variables: provider, model
```

**定位**：`cordis.patch.yml` 的 persona 行 `prefix` 里写了 `{{cwd}}`。该行**遮蔽**部署默认 persona，因此这条线一断，预设会话什么都跑不起来。

**为什么不原样保留**：persona 模板是**渲染时严格解析**，未注册变量直接抛错（见 §3 第 2 行的包文档原文）。这与"宽松替换"的直觉不同，是本项目踩到的那一点。

**修法**：`prefix` 改为只写 `{{model}}`；并把新契约与失败形态写进注释，防止回退。
**工作目录不丢**：不再由 persona 提供，改由运行时上下文给出（persona 的 `includeRuntimeContext` 默认 `true`，系统提示中会出现 "Current working directory"）。

> **注意**：该变更**未出现在 0.2.1 的两份发布说明里**，是按实测定位的。这说明"发布说明没提"不等于"没改"——升级后的复验不能只依赖 changelog。

## 5. 已在 0.2.1 下实测通过的面

| 面 | 结果 |
| :-- | :-- |
| `/geo/core/health` | HTTP 200，`status=success`，题库 279 题 |
| `/geo/taxonomy/meta` | HTTP 200；`needsReview` = 5、逐节点 `needs_review` 为布尔（修复后） |
| `/geo/taxonomy/tree` | HTTP 200，62325 B |
| `/geo-teacher`（工作台页面） | HTTP 200，28401 B |
| 六插件 apply 冒烟（mock ctx） | 8 个插件文件，注册 10 工具，提供 1 服务 |
| 预设导出与 patch 引用一致 | 7 个包子路径引用全部有导出且目标存在 |
| 单元/行为测试 | 85/85 通过 |
| 会话内 persona 渲染 | 2026-10-21 出题会话整轮正常，无 `unknown prompt variable` |
| 技能发现（`!!js` 的 `customSkillDirs`） | 2026-10-21 会话中 `skill` 成功加载 `geo-question-generator` |
| 工具在会话内可调用 | 2026-10-21 轨迹：`geo_taxonomy`×4、`geo_style_profile`、`geo_search_questions`、`web_search`/`web_fetch`、`geo_question_validate`×7 均返回正常 |
| `geo_question_validate` 调用与写盘 | 2026-10-21：7 次调用全部 ok；`render: true` 产出 `package.json`／`draft.md`／`student.json`／`teacher.json`／`validation.json` |
| 静态检查与行为测试（2026-11-02 复跑） | `geo-verify --source` 0 失败 / 4 提示 / 28 通过；`node --test "test/*.test.mjs"` 96/96 |

## 6. 尚未在 0.2.1 复验的面（不得当作已验证）

2026-10-21 的 M2 会话把原先列出的第 1—5 项一次跑过（见 §5 的新增行）。**以下四项仍未验证**：

1. **输入区 UI 插件槽位**（§3 第 6 行）：0.2.1 改了输入区扩展位并新增 `conversation.input.model.label`；插件使用 `conversation.input.left`／`right`，未在 0.2.1 下逐一确认。
2. **HMR／生效边界**：技能目录热更新、插件改动需重启的边界。
3. **长工具结果的裁剪阈值**（8192 码点）与压缩行为。
4. **`engines.dsh` 缺失**对本预设兼容判断的影响（预设与 UI 插件均未声明）。

> 口径：M2 会话证明的是「这些面在 0.2.1 上跑通过一次」，不是「每个参数组合都验过」。例如工具注册只确认了实际被调用的那几个 `geo_*`，未逐一罗列 10 个。

## 7. 版本漂移政策（本文件确立）

1. **现行口径**处写当前版本；**历史记录**（带日期的实施记录、已归档方案、决策记录历史行）保留当时版本，不追改。判断标准：这句话是在描述"现在"，还是在记录"当时"。
2. 升级后**先重定基线，再继续功能开发**；不允许拿旧版结论直接推进新阶段。
3. 每一条"已验证"都要能回答：**在哪个版本、用什么手段、看到什么**。三条缺一即降级为"未验证"。
4. 发布说明只能用于**预判**，不能用于**确认**：本次 persona 变更就完全没有出现在 changelog 里。
5. 打包安装下，源码核对只能靠 asar 文本扫描或按 tag/commit 读 GitHub；**旧 commit 链接继续有效，但它证明的是旧版行为**。

## 8. 复验清单（按此顺序，一次会话可覆盖大半）

外部可验（无需预设会话）——2026-11-02 已全部通过：

- [x] `/geo/core/health` 200；`/geo/taxonomy/meta` 200 且 `needsReview` 只含真值；`/geo/taxonomy/tree` 200；`/geo-teacher` 200
- [x] `node scripts/geo-verify.mjs --source` 退出码 0（读 `DSH_WEB_URL`，不要写死端口）
- [x] `node --test test/*.test.mjs` 全绿（96 项）

预设会话内（2026-10-21 M2 会话已覆盖带 ✅ 的项）：

- [x] 发一句话，确认 persona 渲染不再报 `unknown prompt variable`
- [ ] 工具表逐一确认 10 个 `geo_*`（已实测调用其中 4 个）
- [x] 技能可加载（`geo-question-generator` 能被 `skill` 工具取到）
- [x] `geo_taxonomy({ query })` 正常返回
- [x] `geo_question_validate` 返回 `status: success`（M3 复跑，7 次调用全部 ok）
- [ ] `/geo-teacher` 工作台页面已 200，三个入口的实际点击未验
- [ ] 输入区插件的功能选择器仍在（§3 第 6 行）

## 9. 已知待办（与 M 阶段解耦）

| 项 | 说明 |
| :-- | :-- |
| `engines.dsh` 声明 | 预设与 UI 插件都未声明；建议在下次动 `package.json` 时补 |
| `scripts/geo-verify.mjs` 默认端口 | 仍写着 `http://127.0.0.1:19387` 作为兜底；端口已改为系统分配，兜底值会误导。应改为"未设 `DSH_WEB_URL` 时明确报错并提示" |
| M0 记录 §1.1、§2 的版本前提 | 已在本文 §1 取代；M0 正文保留原貌（它是 2026-09-27 的实测记录） |
| 执行方案附录 A（S1—S16 固定 commit 链接） | 继续指向 0.1.7-rc.2；引用时应说明"这些链接证明的是旧版行为" |
