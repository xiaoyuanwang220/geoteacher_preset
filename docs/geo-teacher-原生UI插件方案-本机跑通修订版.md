# geo-teacher 桌面端原生 UI 插件——「本机跑通」修订版

> 日期：2026-10-03（同日晚，接续原方案）
> 状态：**方案（未实施，本文件不含任何代码改动）**
> 范围：**只回答一件事——插件形态的 UI 能不能先在本机（当前开发机）跑通。**
> 明确不在本次范围：preset 的分发、他人机器、路径可移植性、`private` 包发布、默认预设挑选流程（用户已排除）。
> 目标宿主：DSH Desktop `0.2.0-rc.2`，`$DSH_HOME`（本机为 `<用户目录>\.dsh`），运行 profile `desktop`
> 关系：原方案 [geo-teacher-原生UI插件方案.md](geo-teacher-原生UI插件方案.md) **保留不动**；本文替换其 §2 构建项、§6 R7/R8、§7 U1–U4/U6 的结论，并新增「本地开发回路」与「本机判定实验」。

---

## 1. 结论

**能。本机跑通是三个目标里最容易的一层，而且比原方案估计的更容易。**

原方案把"客户端半边需构建、本会话无 shell 无法代跑 pnpm"当成成本项甚至致命前置（原 §2、R8、U2），并在 U1 里写"打包契约未知"。本次实测把这一层基本查清了：

1. 客户端半边**可以是不经构建的纯 JavaScript**，官方随包出货模板与此用法；
2. 装进 `desktop` profile 的机制**本机已经跑通过一次**（`link:` 本地目录），不需要 DSH 源码树、不需要 checkout 构建；
3. 生效语义**不必重启页面或宿主**（live profile 直接 `applied`）。

真正需要在本机先验的，反过来是原方案没写的两件事：**客户端 bundle 的发现口径**（决定要不要新增一个包）与**本地回路**（改一行怎么看到效果）。

---

## 2. 已查证契约（更新版）

标记：**[已验]** 本次会话实测 / **[已读]** 宿主 `app.asar` 内文档或代码命中 / **[推理]** 由前两者推出，未直接实测。

### 2.1 客户端半边打包契约（原 U1：已解决）

| 项 | 结论 | 依据 |
| :-- | :-- | :-- |
| 声明位置 | `package.json` 的 `dsh.client`：`platform`（必填字符串）、`immediately`（布尔，可选）、`inject`/`external`（字符串数组，可选） | [已读] `dsh-client-modules` 的声明解析与报错文案（`dsh.client.platform must be a string` 等） |
| 入口约定 | `exports["./client"]`，字符串或带字符串 `default` 的对象；声明了 `dsh.client` 却没有该导出口 = 启动期报错 | [已读] `client-modules: <pkg> declares dsh.client but exports no "./client" bundle` |
| 宿主半边 | bundle patch（`dsh.bundle.patch`）里的行；对纯装饰型插件 `index.js` 可只 `export function apply() {}` | [已读] `cordis-plugin-development` SKILL.md |
| 是否需要构建 | **不必须**。`client.js` 为纯 JS、无 JSX/TS，用 `React.createElement`；官方模板就是这样 | [已读] 模板 4 文件；"The browser half is plain JavaScript (no JSX, no TypeScript)" |
| 注册方式 | `ctx.slots.inject('<slot>', () => ctx.slots.register({ name, id, order, label }, () => React.createElement(...)))` | [已读] 模板与动态包示例 |
| 加载链路 | 宿主扫描**已启用的 Loader 条目**组合启动图 → Web 载体经 `/plugins` 提供 bundle → 浏览器**惰性**加载（首次用到才跑） | [已读] `dsh-client-modules` 包文档 |
| 模块来源 | React/Cordis/静态 UI 库来自冻结的 `PLATFORM_MODULES` 基座；基座之外的运行时 import 必须写进 `dsh.client.external`（仅类型 import 会被擦除） | [已读] 同上 |
| 已知启动雷 | 同一包被多个 active Loader source 解析 → 直接报错；声明畸形/缺 bundle 会在启动扫描里**响亮失败**（boot activation audit 报出） | [已读] `resolves from multiple active Loader sources`、`FAILED fiber` |

### 2.2 官方模板与落座建议（`cordis-plugin-development` skill）

模板位置（**在 `app.asar` 内，本会话读不到实体文件，只能按路径抄写**）：
`node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,cordis.patch.yml,index.js,client.js}`

同 skill 的 `references/ui-plugin.md` 给出对本方案直接适用的三条：

1. UI 插件起步就是这四文件；`package.json` 加 `dsh.client` 段与 `./client` 导出，与 bundle patch 并列；
2. **优先选有空间的 slot（如 `conversation.composer.dock`），只有确需浮层且位置已知时才用 `shell.overlay`**；
3. 不要 `require` 其它 Harness Client 包；需要外观就从 primitives 复制 markup/CSS，类名换成本插件前缀，只保留 `--dsw-alias-*` 令牌引用；一个抛异常的组件会**把该 slot 条目打空**。

> 落地建议：既然 `geo-panel` 已是零构建纯 JS，本插件同样按"零构建纯 JS client.js"起步，**不引入 tsdown/vite**，把 U1/U2/R8 整条不确定性从本机路径上移除。

### 2.3 生效语义（原方案完全没写：已解决）

| 问题 | 结论 | 依据 |
| :-- | :-- | :-- |
| 启停是否要重启 | **不要**。`dsh-client-hmr` 文档："普通插件的启停无需刷新页面或重启 Host" | [已读] 该包 README（中英双份） |
| 改代码是否要刷新 | 代码重建会替换受影响插件并**重置其组件状态**（HMR 传输） | [已读] 同上 |
| profile 是 live 还是 startup-only | `set_plugin` 语义：live profile 就地 recompose 并返回 `applied`；startup-only 返回 `restart-required`。`desktop` profile 具备 live profile 的形态特征（自身带 `cordis.patch.yml` patch 层） | [已读] `restart-required`/`applied` 文案 + [已验] profile 目录内容 |
| **待验** | 首次 `install_bundle`（pnpm add + 写 `dsh.profile.bundles`）是否也需要一次重启；以及手写纯 JS 的 `client.js` 改动是否被 HMR 的 watch 覆盖（HMR 的原话是"重载**重建后**的 bundle"） | 见 §5 L4 |

### 2.4 安装机制（本机先例）

`plugin_manager install_bundle` 的行为是：在 **profile 目录** 跑 pnpm add，写入 `dependencies` 与 `dsh.profile.bundles`。

- 本机 `desktop` profile 的可见形态：`$DSH_HOME\profiles\desktop\package.json` → `"@geo-edu/dsh-geo-teacher-preset": "link:E:/geo_edu_agent/.agent-presets/geo-teacher"`，且 `dsh.profile.bundles` 列出该包；
- 同目录 `.plugin-manager\logs\operation-VBQ81T\pnpm.log` 记录了这次安装（`+ @geo-edu/... link:E:/...`，"Already up to date"，pnpm v11.7.0）；
- `web` profile 则用 registry 版本号（`0.1.5-rc.2`）——说明**本地 link 与远端版本两种来源都走过同一条入口**。

结论：本机加一个 UI 包，走同一个 `install_bundle`，用本地路径（`link:`）即可，**不需要 checkout、不需要源码树、不需要我代跑 pnpm**（install 由 `plugin_manager` 自己调 pnpm）。

### 2.5 槽位复核：原方案 §3.1 的修正

| 槽位 | 原方案写 | 实测 | 影响 |
| :-- | :-- | :-- | :-- |
| `conversation.hero.brand.mark` | single/root、`shadows-shipped-ui`、被 `mf` 占用 | **`replaceRisk: none`、当前无人占用**；ownerProps 只有 `{size, className?}` | R3 给它准备的"自绘+回退"成本是**虚构**的；它是免费的品牌位 |
| `shell.overlay` | list/root、`none`、**空** | list/root、`none`、**已有 9 个占位**（session-log-upload-toast、shortcuts、desktop-onboarding、account.platform-page、workspace.* 等） | 加法式，结论不变（新 id 并列），但"空"是错的 |
| `conversation.composer` | chain/session、`none`、`select(owner)`、mf×3 | **一致**（occupants -10/0/1；ownerProps `sessionId`/`session`/`pendingInteraction`；standardProps 含 `useInput`/`inputActions`） | 原方案 §3.1 第 1、3 条成立 |
| `conversation.composer.bar` | single/session-maybe、`shadows-shipped-ui`、variant/inputActions | **一致**（另有 `blocked`/`disabled`/`workspacePickerOpen`/`onRequestWorkspace`/`placeholder`/`accessory`） | 成立 |
| `conversation.hero.workspace` / `hero.agentPreset` | `shadows-shipped-ui`、被 mf(0) 占用 | **一致**；其中 `agentPreset` 的 ownerProps 是 `{children?: never}`，语义是**占用者自己持有 roster 与 staged selection** | 接管它 = 要自己实现预设选择器，成本高于原方案"自绘+回退"的措辞 |
| 14 个主题令牌 | 全部要求 light+dark | **一字不差** | 成立 |
| 客户端 Builtins / 服务 | ctx·React·host.call·styles·console；slots/theme/locale/layout/sessions/uiWorkspace/timer | **一致**（另有 `workspaces`；客户端事件只有 connection/reset、locale/change、slots/changed、theme/change） | 成立 |
| `cordis_*` 不在本会话工具表 | 是 | **是**（host `Tool.listTools` 实测无 `cordis_define`/`cordis_run`） | 成立 |

**新增（原方案漏掉）——`conversation.composer.dock`：** list / session / `replaceRisk: none`，是 `conversation.composer.bar` 的子槽，"输入卡片下方的环境条目"。**限制**：宿主实现只在 `variant === 'composer'`、`input !== undefined`、`sessionId !== undefined` 时渲染它，**空白会话英雄区不覆盖**。这决定了"安全席位"与"原型观感"的分工（见 §6）。

### 2.6 预设身份：原 U3 问错了（已重写）

- `SessionSnapshot` 实测字段只有 `sessionId`/`pendingSubmissions`/`running`/`subagent`/`removed`/`openState`/`openError`/`hasMore`/`loadingOlder`/`promptError`/`blank`/`lastAgentError`/`promptAttempted`/`awaitingFirstTurn`——**没有任何预设字段**。原方案 U3"确认字段名与取值"实际是"该字段不存在"。
- 预设身份在客户端**另有两条可达路径**（[已读]）：会话投影 `agentPreset`（宿主 `sessionProjections.stateOf(session, 'agentPreset')`；客户端标准 props 有 `useProjection`），以及 `ctx.remote.agentPresets.list/read/select`。
- 门控因此可做，但**实现机制要改**：读投影或 remote，不要找 Snapshot 字段。

### 2.7 直发：原方案只写了一条路（补充）

原方案把"直接送进会话"等同于"占用输入区拿 `inputActions`"。实测客户端还有（[已读] `sessions` 服务契约）：

- `ctx.sessions.retain/using(id)` → `SessionReference` → `SessionFace`（`ISession & ObservableSnapshot<SessionSnapshot>`）：`beginSubmission({mode:'queue'|'steer', text, attachments, onRetire})`、`prompt(content, mode, signal?, requestId?)`；
- **约束**：`SessionRetainOptions.source` 是封闭联合，只有 `'controllerOperation' | 'gateway'`——第三方能否合法使用需实测（§5 L3）；
- `ctx.remote.agentPresets.select(sessionId, presetId)` 可用于为会话选择预设。

若 L2/L3 通过，则"面板里点一下：选定/新建 geo-teacher 会话 + 把整理好的需求发进去"可在**不占用输入区**的前提下完成，R1/R2/R3 大部分降级。

### 2.8 动态包（原路径 C）：不能再作为交付形态

[已读] `dsh-cordis-client-runner` 文档明确：动态包 **session-scoped、process-local、重启即清、页面刷新不恢复、需要一次显式 run**。它适合原型验证，**不适合"装一次常驻可用"**。原方案把它列为"备用"是对的，但理由应从"能否注册真实槽位"换成"天生不常驻"。

### 2.9 本会话的环境约束（影响谁来执行）

- **`pwsh` 在本会话恒以 `0xC0000142` / `STATUS_DLL_INIT_FAILED` 结束**，我无法代跑 pnpm、也无法代你重启桌面；`install_bundle` 由 `plugin_manager` 自己调 pnpm，不受此限。
- `app.asar` 是文件而非目录：`read` 工具读它内部路径会报 `Cannot mix BigInt`，`glob` 无法进入；**只能靠 `grep` 按行取证据**（本文 [已读] 类结论均来自此）。

---

## 3. 本机跑通的三条前提（缺一不可，逐条可勾选）

| # | 前提 | 状态 | 验证动作 |
| :-- | :-- | :-- | :-- |
| P1 | 包装形状正确：`dsh.client` + `exports["./client"]` + bundle patch 行 + 纯 JS `client.js` | 契约已查清，未落地 | 抄官方四文件模板，起一个 hello-world |
| P2 | 能装进 `desktop` profile 并被启用 | 机制与先例已有，未对新包演练 | `plugin_manager install_bundle`（本地路径）→ 列表含新包且 `enabled: true` |
| P3 | 生效：页面出现条目；启停无需刷新 | 语义已查清（live profile 直接 `applied`），未实测本包 | 改 `client.js` → 观察是否免重启生效；记录首次是否需要重启 |

---

## 4. 建议的本机架构（先低成本跑通，再决定观感）

**一个包，两个阶段；第一阶段的席位不含任何遮蔽风险。**

- **阶段 A（先做，用来打通全链路）**
  - 席位：`conversation.composer.dock`（list / session / `replaceRisk: none`）放一个最小的可见条目；可选再在 `sidebar.panellist` + `main` 新 key 放独立主面板（`main` 的新 key 不绑会话，符合"面板"语义）。
  - 目的不是好看，而是让"包→安装→发现→/plugins→槽位渲染→主题→启停/摘除"整条链路在**零遮蔽**下成立。
- **阶段 B（A 通过后再做，按需）**
  - 若必须复刻原型的"空白会话英雄区 + 三标签输入区"，才占用 `conversation.composer`（chain）——此时 `conversation.hero.brand.mark` 是**免费席位**，可直接用；
  - `conversation.hero.workspace` / `hero.agentPreset` 只有确实要替换自带控件时才碰，且 `agentPreset` 的接管成本按"自己实现 roster + staged selection"估，不要按"自绘+回退"估。

**门控（若走 profile 级 bundle，则必须有）：**

- 读数用 `agentPreset` 会话投影或 `ctx.remote.agentPresets.read(sessionId)`，**不要**找 `SessionSnapshot` 字段；
- 若占用 `conversation.composer`：selector 首行 `if (pendingInteraction) return null`（R1 成立：`conversation.approval.detail` 与 `conversation.plan-review.actions` 是同一 factory 的子槽，接管会连带吃掉批准与计划评审界面）；
- **注意（对前一轮口头的修正）**：客户端 bundle 是**页面级**加载的，"把 UI 挂进 preset 包"**不会白送 preset 级作用域**——preset 是宿主侧 agent 作用域，客户端没有对应的 realm。挂进 preset 包能省的是**一个包 + 一次安装**，门控仍要自己做。

**风险表（本机口径）**

| # | 风险 | 处置 |
| :-- | :-- | :-- |
| R1 | 接管输入区吃掉批准/计划评审 | `pendingInteraction` 短路 + 回归用例 |
| R2 | 非本预设会话观感变化 | 仅 profile 级 bundle 时存在；投影/remote 门控 + "普通会话逐像素不变"验收 |
| R3 | single 槽遮蔽自带控件 | 阶段 A 不碰；阶段 B 先只碰免费的 `brand.mark`；`workspace`/`agentPreset` 逐个评审 |
| R4 | 暗色下不可用 | 原型硬编码色 → 14 令牌映射；明暗各一遍 |
| R5 | 中文硬编码 | `ctx.locale.register('geo-teacher', ...)`，英文缺失回退中文 |
| R6 | 样式泄漏/卸载残留 | `styles.insert`（随 run 清理）+ `geo-` 类名前缀，不覆写 `--dsw-*` |
| ~~R7~~ | 组合层代价/僵尸扩展 | **本次范围外**（分发不考虑），但"谁 owner、何时退役"仍要写清 |
| ~~R8~~ | 构建链未知 | **已解**：纯 JS 免构建（§2.1/§2.2） |

---

## 5. 本机判定实验（按优先级，都是小时级）

| # | 待验 | 为什么它决定设计 | 步骤 | 判定 |
| :-- | :-- | :-- | :-- | :-- |
| **L1** | 客户端 bundle 的发现口径：给**已经 link 在 profile 里的 preset 包**加 `dsh.client` + `exports["./client"]`，其 bundle 会不会被扫描并提供 | 成立 → UI 与 preset 同包，**本机零新增安装**（preset 已在 profile 里）；不成立 → 必须新增一个独立 profile bundle | ①给包加 `dsh.client`/`./client` 导出与一个最小 `client.js`；②在 `cordis.patch.yml` 插入对应行；③看 boot 图是否含该包 row、slot 是否出现 | 出现 = 同包可行；仅"新 bundle"可行 = 走独立包 |
| **L2** | 第三方 client 半边能否调 `ctx.remote.agentPresets.list/read/select` | 决定门控与"一键选预设"是否成立 | 在 `client.js` 里 `ctx.get('...')`/`ctx.remote` 试探并打印结果 | 能读 = 门控成立；能 select = 可一键化 |
| **L3** | 第三方 client 半边能否 `ctx.sessions.retain/using` + `beginSubmission/prompt` | 决定"直发"能否不占用输入区（R1/R2/R3 是否降级） | 在阶段 A 面板里试提交一句固定文本，看是否进入会话 | 能发 = 走低风险直发路线 |
| **L4** | 首次 `install_bundle` 是否必须重启；改 `client.js` 是否免重启生效 | 决定本地回路速度（最影响日常体感） | 装完后先不重启观察；再改文件观察 | 记录两个布尔值，写进使用说明 |
| **L5** | `conversation.composer.dock` 在 hero 变体下的真实行为 | 决定要不要 chain 接管 | 阶段 A 的条目分别在"空白会话"与"会话中"各看一次 | 只在会话中出现 = 原型首屏必须走 chain |

---

## 6. 本地开发回路（新增章节）

1. **包位置**：workspace 内独立目录（与 preset 包解耦；若 L1 成立可考虑并入 preset 包的 `./client` 子路径）。命名建议 `@geo-edu/dsh-geo-teacher-ui`，`private: true` 即可（本机 link 安装不涉及发布）。
2. **一次安装**：`plugin_manager install_bundle`（本地路径 / `link:`）→ 记录是否要求重启（L4）。
3. **日常迭代**：改 `client.js` → 观察是"直接生效"（HMR/重载）还是需要重新 enable；若必须重启，则本机回路退化为"改完重启桌面"（记录在案，不要假设）。
4. **主题/i18n**：只用 14 个 `--dsw-alias-*` 令牌；文案走 `ctx.locale.register`；明暗各验一遍。
5. **摘除演练**：`remove_bundle` → 确认桌面恢复原样；原 `/geo-teacher` 页面不受影响（两者互不依赖）。

---

## 7. 本机验收（每条都要过）

1. 新包出现在 `desktop` 的 bundle 列表且 `enabled: true`；
2. 桌面端**看得见**条目（阶段 A 在输入区下方 / 面板）；
3. **普通会话**（非 geo-teacher）输入区、英雄区与改动前一致；
4. 明/暗主题 + 字号缩放各一遍；
5. 启停、改写、摘除的回滚演练各一次；
6. 记录"首次安装是否需要重启""改代码是否需要重启"两个事实；
7. 预设包侧不被污染：`npm run verify:geo -- --source` 保持 0 失败（若该命令需 shell，则由你执行，我只出结论清单）。

---

## 8. 工作量（本机口径）

| 工作 | 量级 |
| :-- | :-- |
| L1–L5 判定实验 | 小（半天内可全部出结论） |
| hello-world 包（四文件 + 安装 + 摘除） | 小（照抄模板 + 一次 install） |
| 原型 UI 移植为纯 JS `client.js`（组件化 + 令牌化 + 暗色 + i18n） | 中（成本集中在 R4/R5，不在构建） |
| 阶段 B（chain 接管 + 英雄区） | 中（风险集中处，逐槽评审 + 截屏对照） |

---

## 9. 本文件不做的事

- 不写任何代码、不改组合、不安装任何包（等你点头再说）；
- 不改动原方案 [geo-teacher-原生UI插件方案.md](geo-teacher-原生UI插件方案.md) 与 `docs/决策记录.md`（若你要同步索引/记录，我再加）；
- 不涉及 preset 分发、他人机器、发布与可移植性（用户明确排除）。
