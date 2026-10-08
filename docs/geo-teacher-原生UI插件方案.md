# geo-teacher 桌面端原生 UI 插件方案

> 日期：2026-10-03
> 状态：**方案的槽位实测与风险分级仍有效；输入区落点已落地并成品化**——`packages/dsh-geo-teacher-ui`（`@geo-edu/dsh-geo-teacher-ui` v0.1.0，2026-10-08 成品化）实现了工具行左／右两处 list 槽位（`conversation.input.left`、`conversation.input.right`）的功能选择与参数设置，并把前缀写进原生输入框；**未走**本文件 §3.1 评估的 `conversation.composer` 链式接管，**也未做**「独立主面板」一步。本文件正文保留当时的评估原貌，实施以该包 [README](../packages/dsh-geo-teacher-ui/README.md) 与 `docs/决策记录.md` 为准。
> 目标宿主：DSH Desktop `0.2.0-rc.2`（`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/runtime.json`），运行 profile `desktop`
> 触发：用户问「这个不能直接以插件形式放在桌面端吗？」
> 现行对照物：宿主插件页面 `.agent-presets/geo-teacher/plugins/panel`（路由 `/geo-teacher`，零构建，已上线）

---

## 1. 结论

**能。** 原型画的正是 DSH **空白会话页**的真实槽位：英雄区、上下文行（工作区选择器 + 预设控件）、三标签输入区、结果弹窗都能落在真实 Slot 上。

但它和当前已上线的宿主页面是**两种东西**：

- 原生路线交付的是**客户端 UI 插件**（`client` 半边 + `dsh.bundle` 接线），作用域是 **profile 级**，部分槽位会**遮蔽自带 UI**；
- 原生路线有一个宿主页面**永远做不到**的能力：输入区槽位的 props 里有 `inputActions`，能把整理好的需求**直接写进真实输入框并发送**，从而消掉现在这版最大的短板——"复制需求 → 手动粘贴"。

因此本方案主张**分两步走**（§5）：先做零遮蔽风险的"独立主面板"打通打包与构建链路，确认可行后再做"输入区链式接管"以求原型级一致。

---

## 2. 现状 vs 原生

| 维度 | 现行：宿主插件页面（`plugins/panel`） | 原生：客户端 UI 插件 |
| :-- | :-- | :-- |
| 入口 | 浏览器地址 `/geo-teacher`（独立页面） | DSH 桌面窗口内的真实位置（主面板 / 输入区 / 英雄区） |
| 应用外壳 | 页面自绘或另开标签，与桌面壳无关 | 由真实外壳提供（标题栏、侧栏、工作区、模型选择） |
| 交互闭环 | **断的**：只能复制提示词让教师自己粘贴 | 可**直接送进会话**（`inputActions` / `useInput`） |
| 主题 | 硬编码 hex 的单一浅色（无暗色） | 必须走主题令牌（14 个 alias，全部要求 light+dark） |
| 生效范围 | 只影响该 URL | profile 级，**必须自己门控**，否则影响所有会话 |
| 构建 | 零构建（纯 HTML/CSS/JS） | 需构建 client 半边（本会话无 shell，无法代跑） |
| 失败代价 | 页面 404 / 白屏，最多影响一个入口 | 首屏或输入区被吃掉（严重：连发消息都受影响） |
| 现状 | ✅ 已上线，待重启验收 | 📄 本方案 |

---

## 3. 实测契约（本次会话实时查询，非文档推断）

证据来源：`cordis_inspect_query`（client `Slots` / `Service` / `Builtin` / `Theme`）、`plugin_manager list_bundles`。查询时间 2026-10-03，宿主 `0.2.0-rc.2`。

### 3.1 原型 ↔ 真实槽位

| 原型部位 | 槽位 | kind / scope | replaceRisk | 现有占位者 | 注册参数 |
| :-- | :-- | :-- | :-- | :-- | :-- |
| 英雄区插图 / 标题上方品牌位 | `conversation.hero.brand.mark` | single / root | `shadows-shipped-ui` | `mf` | 无 |
| 上下文行左（工作区） | `conversation.hero.workspace` | single / root | `shadows-shipped-ui` | `mf` (p0) | 无（`ownerProps`：`open`/`selectedId`/`onPick`/`onClose`） |
| 上下文行右（预设） | `conversation.hero.agentPreset` | single / session-maybe | `shadows-shipped-ui` | `mf` (p0) | 无 |
| **三标签 + 参数下拉 + 提交键** | **`conversation.composer`** | **chain / session** | **none** | `mf` ×3（p -10/0/1） | **`select(owner) => unknown \| null`** |
| 输入区本体 | `conversation.composer.bar` | single / session-maybe | `shadows-shipped-ui` | `mf` (p0) | 无（`ownerProps`：`variant: 'hero'\|'composer'`、`blocked`、`disabled`、`placeholder`…；`inputActions` 属 **standardProps**） |
| 「需求已整理」弹窗 | `shell.overlay` | list / root | `none` | 空 | `id`(+`order`/`label`) |

要点：

1. `conversation.composer` 是 **chain + 纯路由选择器**：条目按 `order` 升序试，**第一个非 null 者胜出**，全为 null 才落回自带输入区。这正是"只在 geo-teacher 会话里接管"的官方口子，`replaceRisk: none`。
2. `conversation.composer.bar` 的 `ownerProps.variant` 是 `'hero' | 'composer'` —— 同一个槽同时服务**空白会话的英雄区输入区**和**会话中的输入区**，即原型所在的位置。
3. `conversation.composer` 的 `ownerProps` 含 `session`、`pendingInteraction`；`standardProps` 含 `useSession`/`useSessions`/`useInput`/`inputActions`/`useChat`/`useConversation`。
4. `conversation.composer` 的子槽 `conversation.approval.detail`、`conversation.plan-review.actions` 属于同一 factory —— 接管时若不顾 `pendingInteraction`，会连批准与计划评审的界面一起吃掉（见 §6 R1）。

### 3.2 客户端服务（`ctx.*`，供 client 半边使用）

| 服务 | 对本方案有用的方法 |
| :-- | :-- |
| `slots` | `register` / `registerFactory` / `inject` —— 占位注册入口 |
| `theme` | `getTheme()` / `register()` / `overrideTokens()` |
| `locale` | `register(ns, dicts)` / `bind(ns)` —— 多语言字典（当前 UI 只有中文） |
| `layout` | `selectPanel(panelId)` / `toggleSidebar()` —— 独立主面板路径需要 |
| `sessions` | `scope(id)` / `binding(id)` / `retain()` —— 读会话上下文 |
| `uiWorkspace` | `startSession()` / `connectWorkspace()` / `openSession()` |
| `timer` | `timeout` / `debounce` / `throttle`（替代裸 setTimeout） |

### 3.3 客户端 Builtin（动态包路径可用符号）

`ctx`（受限 Cordis Context：`get`/`on`/`provide`/`effect`）、`React`（**无 JSX 转换**，`createElement`）、`host.call(method, args)`（到本包 Host 半边的 JSON-RPC）、`styles.insert(css)`（随 Client run 清理）、`console`。

### 3.4 主题令牌（14 个，全部 `requiresLightAndDark: true`）

`--dsw-alias-bg-base`、`-bg-layer-1`、`-bg-layer-2`、`-bg-overlay`、`-border-l1`、`-border-l2`、`-brand-primary`、`-label-primary`、`-label-secondary`、`-state-error-primary`、`-state-idle-primary`、`-state-success-primary`、`-state-warn-primary`、`--dsw-specific-sidebar-fill`。

原型用的是各处硬编码 hex + `:root{background:#fff}`，**没有暗色**。原生落地必须做一层"token 映射 + 暗色"（这是移植的真实成本，不是直接拷贝 CSS）。

### 3.5 组合现状

`desktop` profile 的 bundle 列表（`plugin_manager list_bundles`）：`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@deepseek-ai/dsh-experimental-agent-team-profile`、`@geo-edu/dsh-geo-teacher-preset`（`installed: true`、`removable: true`）。另有 7 个未启用/未安装的可选 bundle。

客户端 UI 在组合里的正常形态是 `@deepseek-ai/dsh-client-ui-*` 行（`dsh-web-app` 里就有 30+ 条，如 `ui-conversation`、`ui-agent-preset`、`ui-plugin-manager`）。也就是说：**加一个客户端 bundle 是这个组合里的常规操作**。

---

## 4. 三条实现路径（按风险升序）

### A. 独立主面板（风险最低，推荐作为第一步）

侧栏图标 + 自己的主面板，完全不碰自带输入区与英雄区：

- 占位：`sidebar.panellist`（list，`replaceRisk: none`）加成图标；`main`（keyed，已占 `conversation`）用新 key 注册工作台面板；
- 打开：`ctx.layout.selectPanel('<newPanelId>')`；
- 内容：原型的工作台本体（英雄区可省，因为这是面板不是首页）+ 三标签 + 参数下拉 + 结果弹窗（`shell.overlay`）；
- 交付：仍然是"复制提示词"，因为输入区不归我们——**但它和现在这版等价，却已经身在桌面窗口里**。

优点：零遮蔽、可随时从 profile 摘掉、失败面 = 一个面板打不开；**副产品是先把"打包 → 构建 → 载入 → 主题/i18n → 槽位注册"整条链路验通**。

### B. 输入区链式接管（最贴原型，作为第二步）

- `conversation.composer` 注册一条 chain 条目，`select` 只在"当前会话是本预设 且 无待处理交互"时返回组件；
- 组件即原型的三标签输入区（含 `variant: 'hero'` 的空白会话形态）；
- 提交经 `inputActions` **直接写入并发送**，不再需要复制按钮；
- 结果弹窗走 `shell.overlay`；
- 英雄区的画与标题：`conversation.hero.brand.mark`（single，会遮蔽自带品牌位，需要"自绘+回退"）。

优点：观感与交互达到原型级，且补上"直接发送"；缺点：**一旦门控写错就影响所有会话的输入区**。

### C. 动态包（免构建，未验证）

DSH 有运行时定义包的能力（`cordis_define` → `cordis_run`，交互区落在 `tool.view.cordis` 卡里），其 client 半边可用 §3.3 的 Builtin。

- 优点：**不需要 pnpm 构建**，也不需要改 profile bundle；
- 缺点：`cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` / `cordis_inspect_self` **不在本会话的工具表里**（它们出现在 GUI 的 tool-view 键表中，属产品已有能力），我无法在本次会话里走这条路；
- 未验证：动态 client 半边能否经 `ctx.get('slots')` 注册**真实槽位**（而不是只渲染在那张 `cordis_run` 卡里）。若可以，C 会变成最省事的第一条路。

---

## 5. 推荐路线

```
第一步  A 独立主面板
        └─ 目的不是"最好看"，而是用最低风险打通：包结构 → 构建 → desktop bundle 载入
           → 槽位注册 → 主题令牌 → i18n → 卸载回滚
第二步  B 输入区链式接管（+ hero.brand.mark）
        └─ 前置：第一步已证明链路可行；且 R1/R2 门控与自绘回退已就位
备用    C 动态包：等确认能被赋予 cordis_* 工具，或确认它能注册真实槽位后再评估
```

现行 `/geo-teacher` 页面**保留**（零构建、今天就可用），作为原生插件不可用时的回退入口；两者共用同一套文案与视觉规范。

---

## 6. 关键风险与预防

| # | 风险 | 触发条件 | 预防 |
| :-- | :-- | :-- | :-- |
| **R1** | 吃掉批准 / 计划评审界面 | 接管输入区时该会话正处于 `pendingInteraction`（工具批准、计划评审、提问） | `select` 首行即 `if (pendingInteraction) return null`；并补回归场景"批准弹窗出现时输入区必须是自带的" |
| **R2** | 非 geo-teacher 会话观感变化 | `select` 未按预设门控 | selector 只在当前会话预设为本预设时返回组件，其余返回 `null`；回归场景"普通会话空白页与输入区逐像素不变" |
| **R3** | single 槽遮蔽自带控件 | 注册 `hero.brand.mark` / `hero.workspace` / `hero.agentPreset`（均 `shadows-shipped-ui`，且已有 `mf` 占位） | 只在必须先自绘时占；占位者内部对"非本预设"分支渲染回自带控件；逐个槽单独评审并留截屏对照 |
| **R4** | 暗色主题下不可用 | 原型为硬编码 hex、无暗色，而令牌全部要求 light+dark | 建立"硬编码色值 → 14 个 token"的映射表；冒烟必须覆盖明/暗两套与字号缩放 |
| **R5** | 中文硬编码 | 客户端 UI 常见要求走 `locale` | 经 `ctx.locale.register` 注册 zh 字典；英文缺失时回退中文，不阻塞交付 |
| **R6** | 样式泄漏 / 卸载残留 | 直接注入全局 CSS | 走 `styles.insert(css)`（随 Client run 清理）；类名加 `geo-` 前缀，不覆写 `--dsw-*` 令牌 |
| **R7** | 组合层代价与"僵尸扩展" | 加 profile 依赖与 lockfile 变更 | 明确 owner 与退役条件；不复现 2026-09-30 `@geo-edu/dsh-geo-workbench` 那条"装上却从不加载"的老路（该扩展只装在可能不用的 profile 上） |
| **R8** | 构建链未知 | 见 §7 U1/U2 | 第一步开工前先确认打包契约，避免写出无法载入的包 |

---

## 7. 未验证项（开工前必须确认）

| # | 未验证 | 为什么没验 | 确认方法 |
| :-- | :-- | :-- | :-- |
| U1 | 第三方 **client 半边**的打包契约：`exports`、`dsh.bundle.patch` 行写法、client 入口声明、构建产物位置 | `E:\deepseekharness\resources\app.asar\dsh\` 不是可读目录（asar 是文件），本会话也没有 DSH 源码树 | 读 DSH 仓库 `packages/` 中任一 `dsh-client-ui-*` 包，或官方插件开发文档 |
| U2 | 是否**必须**在 checkout 内用 `pnpm` 构建（即第三方包能否预先构建好直接载入） | 无 shell，无法试 | 同上；并从 `@deepseek-ai/dsh-client-hmr` / `dsh-client-modules` 的加载方式反推 |
| U3 | `SessionSnapshot` 中"当前预设"的**字段名与取值** | 无法读类型定义 | 从 `ui-agent-preset` 包或 `SessionSnapshot` 类型确认后再写 selector |
| U4 | 动态包（路径 C）能否 `ctx.get('slots')` 注册**真实槽位** | 本会话无 `cordis_*` 工具 | 在持有该工具的会话里做一次最小实验 |
| U5 | `plugin_manager install_bundle` 对本地 `link:` 包的行为（是否触发构建脚本、是否写 lockfile） | 未执行（需 danger-full-access 且有实际包） | 确认包结构后，先在非生产 profile 试 |
| U6 | `sidebar.panellist` 条目与 `main` key 的联动方式（是否 id 直接作 key） | 未读到该 factory | 读 `ui-plugin-manager` 等既有实现 |
| U7 | 主题 `--dsw-*` 变量对第三方 client 样式的可见性 | 合理但未实测 | 第一步落地时在页面上直接读 `getComputedStyle` 验证 |

---

## 8. 验收与回滚

**验收（每步都要）**

1. `npm run verify:geo -- --source` 保持 0 失败（预设包侧不被原生改动污染）；
2. 完整重启桌面后：`desktop` profile 的 bundle 列表含新包且 `enabled: true`；
3. 三条对照场景全部通过：**本预设空白会话**（工作台在位）、**本预设会话中**（输入区/面板正常）、**普通会话**（输入区、英雄区、批准弹窗与改动前一致）；
4. 明/暗主题 + 字号缩放各一遍；
5. 卸载回滚演练：从 profile 移除 bundle → 重启 → 桌面恢复原样、`/geo-teacher` 仍可用。

**回滚**：原生插件与 `/geo-teacher` 页面互不依赖；原生出问题即从 profile 摘除该 bundle 并重启，页面路径不受影响。这也是把"保留页面"写进方案的原因。

---

## 9. 工作量（粗估，待 §7 确认后修正）

| 工作 | 量级 |
| :-- | :-- |
| 确认 U1–U7 契约 | 小（读源码/最小实验） |
| 包骨架 + bundle 接线 + 构建打通 | 小–中（可复用已退役 `@geo-edu/dsh-geo-workbench` 的接线骨架） |
| 原型 UI 移植（React 组件化 + token 化 + 暗色 + i18n） | 中（现有 CSS/文案/图标资产可直接复用，主要成本在 R4/R5） |
| 门控与回归场景（R1/R2/R3） | 中（风险集中处，必须写清楚并逐条验） |
| 输入区直发（B 步，`inputActions`） | 小（拿到 actions 后是接线题） |

---

## 10. 本方案不做的事

- 不改动现行 `plugins/panel` 与 `/geo-teacher`；原生路线是**增补**，不是替换；
- 不在本方案里写入任何代码或组合改动（用户明确选择"先出方案，暂不写码"）；
- 不预先承诺"原生一定上线"：若 §7 的 U1/U2 结论是"第三方客户端包无法脱离 checkout 构建"，则原生路线的成本会显著上升，届时应回到 A/C 之间重新权衡甚至暂缓。

---

## 附：与既有决策的关系

- `docs/archive/geo-teacher-agent-plan.md:144` 当年明确「**不用** slots/客户端插件（需客户端重建与审批流），列为后续选项」——本方案即把该"后续选项"正式提上来评估；
- `docs/决策记录.md` 2026-09-30：地理工作台客户端扩展 `@geo-edu/dsh-geo-workbench` 已退役删除，结论是"后续重新设计"——本方案是那次重新设计的入口，但**尚未**重新创建任何包；
- `docs/geography-question-generation-execution-plan.md:291` 已写明"现有静态 `/geo-teacher` 页不能自动等同于桌面原生面板"——与本方案的判断一致。
