# geo-teacher 原生 UI 插件 —— 本机探针实验结果（L1–L5）

> 日期：2026-10-03
> 性质：**实验记录（实测证据）**，不是方案。
> 目的：回答修订版方案 §5 的 L1–L5，判定「插件形态的 UI 在本机能否跑通」。
> 探针包：`packages/dsh-geo-teacher-ui`（**已于 2026-10-08 成品化**：探针上报与主机绝对路径移除、素材收归包内、元数据补齐，见其 [README](../packages/dsh-geo-teacher-ui/README.md)；本文件保留当时的实验记录原貌）
> 原始证据：`outputs/geo-ui-plugin-probe/report.jsonl`（客户端-宿主直传的逐条记录；该路径已随探针代码移除，历史文件仍在 `outputs/` 下）

---

## 0. 结论一句话

**能在本机跑通，且链路比预想的短得多：安装即时生效、改一行代码即时热替换、真实槽位即时出现、预设身份可读、直发能力可达。全程没有重启桌面、没有刷新页面、没有任何构建步骤。**

| # | 问题 | 结论 | 关键证据 |
| :-- | :-- | :-- | :-- |
| L1 | 客户端 bundle 的发现口径（独立 bundle 是否可行） | **可行** | 装包后客户端半边自动加载并挂载，`shell.overlay` 出现第 10 个占位者 `geo-teacher-ui-client` |
| L2 | 第三方客户端半边能否拿到预设身份 | **能**（投影 + remote 两条路） | `props.useProjection('agentPreset')` → `"cordis"`；`remote.agentPresets.list()` 返回全部 5 个预设（含 `geo-teacher`） |
| L3 | 能否不占用输入区直接发送 | **能力可达**（未实际发送） | `sessions.using(sid,{source:'controllerOperation'})` 正常进入并 resolve；`binding.session` 有 `beginSubmission`/`prompt`/`command` |
| L4 | 首次安装是否要重启、改代码是否要重启 | **都不需要** | 安装返回 `application:"applied"`；改 `client.js` 后旧条目 unmount、新 bundle mount，`navStartMs` 持续增长（同一页面） |
| L5 | `composer.dock` 在 hero / composer 两种形态下的渲染 | **已判定**：hero 不渲染 dock；同 factory 的 `input.right` 在 hero 照样渲染 | 空白会话期间只有 `input.right` mount、`dock` 全程未 mount；且 hero 下投影能读到暂存预设 |

---

## 1. 已实测确认的打包契约（原 U1/U2 彻底关闭）

| 项 | 实测结论 |
| :-- | :-- |
| `package.json` | `dsh.bundle.patch` 指向 patch 文件；`dsh.client` 只需 `{ "platform": "web" }` 即为合法声明 |
| 入口导出 | `exports["./client"]` 指向 `client.js`（字符串形式即可） |
| bundle 脚本格式 | 普通脚本（非 ESM），执行 `window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => {...} })` |
| factory 语义 | **factory 的返回值就是本模块的导出**，该导出被当作 cordis 插件挂载（有 fiber，`entry.fiber` 存在即挂载成功） |
| 依赖来源 | `require('react')` 合法（平台种子表：react / react/jsx-runtime / react-dom / react-dom/client / @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots 等）；**不 require** 任何其它 Harness 客户端包 |
| 构建 | **不需要**。纯 JS + `React.createElement`，手写即可 |
| patch 行 | `- insert: [{ id: ..., name: '@geo-edu/dsh-geo-teacher-ui' }]` 即可让该包成为 Loader 条目并被扫描 |

## 2. 安装与生效（L1、L4）

- `plugin_manager install_bundle`（本地路径）→ profile 执行 `pnpm add`：
  `+ @geo-edu/dsh-geo-teacher-ui link:E:/geo_edu_agent/packages/dsh-geo-teacher-ui`（329ms，日志 `operation-0CVrW6`）；
- 返回 `{"stage":"enable","enabled":true,"changed":true,"application":"applied"}` —— **`desktop` profile 是 live profile，启用即生效**；
- `$DSH_HOME\profiles\desktop\package.json` 同时被写入依赖与 `dsh.profile.bundles`；
- **全程未重启桌面、未刷新页面**：`client.half.mounted` 里 `readyState: "complete"`、`navStartMs` 从 4375081 → 4416176 → 4450330 → 4467200 单调增长，说明一直是同一个页面实例；
- **热更新确认**：改 `client.js` 后，`slot.unmounted`（旧）→ `client.half.mounted`（新 mark）成对出现，共触发两次（对应两次文件写入），无需任何人工动作。

## 3. 槽位与门控数据源（L2、L5）

- `Slots.listSubTree shell.overlay` 实测出现新占位者：
  `{"registrant":"geo-teacher-ui-client","id":"geo-ui-probe-control","order":9999,"active":true}` —— 与自带 9 个条目并列，**加法式、零遮蔽**；
- 组件收到的 standardProps 实测清单（composer 类席位）：
  `useSessions / useSessionStatus / usePanelInfo / useWorkspaces / useResource / useSessionRetainInfo / sessionId / inputActions / useSession / useConversation / useInput / useTrajectory / useChat / useProjection / renderFactorySlot`；
  根作用域席位（`shell.overlay`）只有 7 个通用 props，无 `sessionId`/`inputActions`；
- **门控可用的真实数据源**：`props.useProjection('agentPreset')` 直接返回字符串预设 id（当前会话实测为 `"cordis"`）。根作用域下为 `undefined`（无会话）。
- **hero 形态实测（L5 复测）**：`conversation.composer.dock` 在空白会话**不渲染**；`conversation.input.right` 在空白会话**照常渲染**；`useProjection('agentPreset')` 在空白会话上可读到**当前暂存/已选**的预设（详见 §6）。

## 4. 预设与直发 API（L2、L3）

服务注入规则（踩坑实录）：

- 客户端服务必须先声明 `inject` 才能访问属性，否则抛 `cannot get property "<name>" without inject`；
- `remote` 命名空间**只在 agent 作用域上下文**上物化：根 ctx 的 `ctx.remote` 抛注入错误，且 `ctx.inject(['remote'], cb)` 的回调**从不触发**（不报错，静默等）；
- 正确姿势：`sessions.using(sid, opts, (ref) => ref.binding.ctx.inject(['remote.agentPresets'], (scoped) => ...))`。

实测拿到的 API 面：

| API | 实测结果 |
| :-- | :-- |
| `ctx.get('sessions')` | 对象，含 `retain`/`using`/`binding`/`scope`/`list`/`manager` 等 |
| `ctx.sessions.using(sid, {source:'controllerOperation'}, cb)` | **正常进入 cb 并 resolve**（无报错） |
| `binding.session` | 有 `beginSubmission` / `prompt` / `command`（`ISession` 面） |
| `remote.agentPresets` | `{ list, read, select, methods, invokeRemote, namespace, ... }` |
| `agentPresets.list()` | `{ok:true, value:{presets:[standard, ptc, minimal, cordis, geo-teacher]}}`，`geo-teacher` 带中文 name/description、order 10 |
| `agentPresets.read(x)` | 参数是**预设 id**，不是 sessionId；传 sessionId 返回 `agent-preset/not-found`，`details.available` 列出全部预设 |

> 未做的事：**没有真正调用 `beginSubmission`/`prompt`**，以免向真实会话注入测试消息。因此"能力可达"已确认，"端到端直发"仍待一次显式授权的验证。

## 5. 对修订版方案的修正

1. **U1/U2/R8 可以彻底删除**：纯 JS 手写、免构建、本机 329ms 装完即生效。
2. **"必须新增一个 profile 级 bundle"确认为可行路线**（L1 正解）；把它并进 preset 包以省一次安装的做法**未测试且已无必要**。
3. **本地回路远优于预期**：改 `client.js` 无需重启/刷新，这改变了工作量估算——UI 迭代几乎和改网页一样快。
4. **门控不再是不确定项**：`useProjection('agentPreset')` 一行搞定；`agentPresets.list()` 还能自建预设选择器，`select` 可做"一键选预设"。
5. **直发有了低风险路线**：`sessions.using` + `beginSubmission`，不必占用 `conversation.composer`（R1/R2/R3 可整体降级）。
6. **仍需注意**：`useProjection('agentPreset')` 在**根作用域/无会话**时为 `undefined`；但在空白会话（hero）上可读，且能读到暂存预设 —— 首屏门控可行（§6）。
7. **空白会话首屏的席位定了**：用 `conversation.input.right`（已实测在 hero 渲染；`input.left` / `input.overlay` 同属该输入卡片内的 list 槽、`replaceRisk: none`，未单独实测）；**不要**用 `composer.dock` 承担首屏——它在 hero 不渲染。
8. **门控在 hero 也可用**：`useProjection('agentPreset')` 在新建会话上返回暂存预设（`standard` → 选中后 `geo-teacher`），因此"只在 geo-teacher 时出现"的首屏 UI 可实现，且不必接管输入区。

## 6. L5 复测记录（已完成）

用户实际操作 → `report.jsonl` 实测：

| 时刻 | 页面状态 | `conversation.input.right` | `conversation.composer.dock` | `useProjection('agentPreset')` |
| :-- | :-- | :-- | :-- | :-- |
| T1 | 已有会话 `session-09c3…`（cordis） | mount | mount | `"cordis"` |
| T2 | 新建会话 `session-30ef…`（默认） | **mount** | **不 mount** | `"standard"` |
| T3 | 同一新建会话，在英雄区选中「地理教师辅助」 | **mount** | **不 mount** | `"geo-teacher"` |
| T4 | 切回 `session-09c3…` | mount | mount | `"cordis"` |

结论：

1. `conversation.composer.dock` **只在"会话中"的输入卡片下方渲染**，空白会话（hero）不渲染 —— 与宿主源码判定（`variant === 'composer' && input !== undefined && sessionId !== undefined`）完全一致；
2. 同一 factory 的 `conversation.input.right` 在 **hero 形态下照样渲染** —— 这是"空白会话首屏可见"的可用加法席位；
3. **hero 形态下预设身份可读**：新建会话先返回 `"standard"`，在英雄区选择「地理教师辅助」后返回 `"geo-teacher"`；
4. 空白会话的预设选择**可以改且可观测**（同一 `sessionId` 从 standard → geo-teacher），说明预设是在**首次发消息时**才最终固化 —— 这对"首屏就按预设显示不同 UI"是关键前提。

## 7. 现场状态与回收

- 探针**当前仍在桌面端生效**：输入区会出现两个 `geo·inputright` / `geo·dock` 小胶囊（深色/浅色都用令牌，可顺便看暗色），另有 1 个不可见的 `shell.overlay` 条目；
- 回收：`plugin_manager remove_bundle @geo-edu/dsh-geo-teacher-ui`（或保留作为后续开发的骨架）；
- 证据文件：`outputs/geo-ui-plugin-probe/report.jsonl`（可整目录删除，不影响其它功能）。

## 8. 环境备注

- 本会话 `pwsh` 恒以 `STATUS_DLL_INIT_FAILED (0xC0000142)` 结束，无法代跑命令；`install_bundle` 由 `plugin_manager` 自行调用 pnpm，不受影响；
- `app.asar` 无法用 read 工具读取（`Cannot mix BigInt`），宿主契约靠 `grep` 从 asar 文本取证据。
