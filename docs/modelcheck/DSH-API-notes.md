# ModelCheck × DSH 0.2.1-rc.2 API 笔记（实现者可直接抄的契约）

> 目标版本：`dsh-v0.2.1-rc.2` / commit `687f282e8625c6b8d11ff58211a90524be2e4317`（DSH Desktop 社区版同版本内核）。
> 原则：本文件每一条都标注出处（源码路径+行，或本机 inspect/实测）。**没有出处的写法不要抄。** 标 `未验证` 的，先按最小例子验一次再用。
> 与 [M0 能力矩阵](M0-能力矩阵.md) 配套：矩阵回答"能不能"，本文回答"怎么写"。

---

## a. ToolDefinition：必填字段、cwd、上下文注入

### a.1 接口（固定版本源码）

`packages/core/tools/src/index.ts#L213-L300`：

```ts
/** Tool-owned canonical output contract used after the body returns a JSON value. */
export interface ToolOutputDefinition {
  readonly schema: JsonSchemaNode                 // 对 execute 返回值强制校验
  render(args: unknown, value: JsonValue): ContentBlock[]   // 纯函数：模型可见内容
  presentationMeta?(args: unknown, value: JsonValue): JsonValue  // 可回放的展示元数据
}

export interface ToolDefinition extends ToolSchema {   // ToolSchema: { deferLoading?, name, description, parameters: Record<string,unknown> }
  readonly output: ToolOutputDefinition                   // 必填
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>   // 返回 canonical JSON 值，不是文本
  projectContent?(exec, result): ContentBlock[] | undefined        // 选填：post-execute 之前安装内容
  finalizeContent?(exec, result): ContentBlock[] | undefined       // 选填：最终内容最后一改
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

`ToolSchema` 定义在 `packages/llm/llm/src/types.ts#L491`：`{ deferLoading?: true; name: string; description: string; parameters: Record<string, unknown> }`。
`ToolRunContext`（`packages/core/tools/src/index.ts#L419-L436`）：

```ts
export interface ToolRunContext extends ToolExecution {
  deferContext(context: UserMessage): void   // 结果落地后，把一条上下文追加进会话
  concludeTurn(): void                       // 标记本次成功结果为"本回合到此为止"
}
// ToolExecution 里与本插件相关的字段：callId、name、arguments、agent?: Agent、signal: AbortSignal、token
```

### a.2 本仓可用的注册方式：**直接写字面量**（推荐，已被本机验证）

本项目的宿主插件是 **link 到 profile 之外的本地包**，`bare import '@deepseek-ai/dsh-tools'` 会失败（C 盘用户根没有那些 node_modules）。已跑通的写法是直接给 `ctx.tools.register` 一个字面量对象，`parameters`/`output.schema` 用**原始 JSON Schema**：

```js
// 来源：.agent-presets/geo-teacher/plugins/analysis/index.js#L481-L499（本机 0.2.1-rc.2 运行中）
ctx.tools.register({
  name: 'geo_analyze',
  description: '……（模型可见的完整描述）',
  parameters: {
    type: 'object',
    properties: { qid: { type: 'string', description: '题目 ID' } },
    required: ['qid'],
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args, exec) {
    return await kernel.analyzeQuestion(args.qid)
  },
})
```

> `defineTool()`（`packages/core/tools/src/schema.ts#L483-L632`）只是糖：把 `ParameterSchemaSpec` 编译成同一份 JSON Schema，并替你做参数校验与 presentation 的软校验。**能用糖的地方优先用糖**；不能用（无宿主包依赖）就照上面的字面量写，注册器接受同一个形状。

### a.3 ToolRunContext.agent → cwd（项目根）

官方做法（`packages/fs/tool-fs/src/session-cwd.ts#L17-L30`）：

```ts
const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
return { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal }
```

`workingDirectory.ensure(agent, signal)` 会校验目录存在，失效时回退到会话原目录并提交（`packages/session/working-directory/src/index.ts#L126-L152`）。
ModelCheck 的规则：
- 工具从这里拿**项目根**，再接 `.modelcheck/`；**不接受** `args` 里的任意绝对路径。
- 没有 `exec.agent`（非会话调用）时直接报错，不要猜目录。
- 读文件用 `ctx.fs.resolve(path, { cwd, signal })` + `readText/readBytes`；写文件用 `writeText(target, content, intent, signal, sandboxPolicy?)`。

### a.4 工具结果能否注入上下文

能，两条：

| 手段 | 效果 | 出处 |
|---|---|---|
| `exec.deferContext(createUserMessage({content, source}))` | 本次结果落地后追加一条上下文（保留自己的 source），按调用顺序 | `packages/core/tools/src/index.ts#L419-L436`；官方用例 `packages/core/tools/src/ptc.ts#L642-L655`、`packages/goal/tool-goal/src/index.ts#L320` |
| `exec.concludeTurn()` | 标记"本回合结束"，仅成功结果有效（composite 需从嵌套结果转发） | 同上；用例 `packages/plan/plan-mode/src/index.ts#L337`、`packages/subagent/subagent/src/structured.ts#L104` |

ModelCheck 的用法：`modelcheck_complete` 认证成功时可以 `exec.concludeTurn()`；判据失败需要模型"下一步必须修"时，可以在工具结果里直接给结构化补救指令（**不要**用 `deferContext` 伪造"用户说的话"）。

### a.5 陷阱

- `execute` 的返回值必须是 `output.schema` 能校验的 JSON 值；模型看到的是 `render` 的结果。**不要把 HTML/截图塞进 render 文本**（体积与转义都会出事）。
- 注册返回 disposer，必须 `ctx.effect(() => ctx.tools.register(...), 'modelcheck:tool-xxx')`，否则 HMR/unload 后残留（`packages/AGENTS.md`：registry 贡献要证明 disposal）。
- `parameters` 里不要写 `required: true` 这种 spec 语法——那是 `defineTool` 的参数糖；**字面量注册要写标准 JSON Schema**（`required: [...]`）。两者混用不会报错但会静默丢约束。

---

## b. Host 插件模块形状（`index.js`）

### b.1 两种合法形态，选一种，不要混

| 形态 | 写法 | 现状 |
|---|---|---|
| 命名导出（上游全部包） | `export const name`、`export const inject`、`export const Config`、`export function apply(ctx, config)`，**无 default export** | 上游规则，`packages/AGENTS.md`：function plugin 用命名导出且不得有 default export |
| default 导出整个插件对象 | `export default { name, inject, apply(ctx) {...} }` | 本仓现有插件在用（`plugins/panel/index.js#L41-L44`），0.2.1 运行正常（P） |

**唯一禁忌**：`export function apply(...)` 之后再 `export default apply`（default 是裸函数）。Cordis Loader 的 `unwrapExports` 会优先取 `.default`，把命名导出里的 `inject/name` 丢掉，导致 `apply` 跑在没有注入的 fiber 里并抛 `cannot get property "x" without inject`。详见 `docs/postmortem/0001-acp-default-export-drops-inject.md`。

### b.2 最小骨架（ModelCheck 宿主半边，与本仓既有插件同形）

```js
// packages/dsh-modelcheck/index.js
// 只 import node: 内置模块。宿主包（@deepseek-ai/*）在这里 import 会失败：
// 本包 link 在 profile 依赖之外，解析不到那些 node_modules。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const name = 'modelcheck'
export const inject = ['webServer', 'tools', 'sessions', 'sessionController', 'workingDirectory', 'fs', 'connection']

export function apply(ctx) {
  // 1) 每一个注册都必须可回收：用 ctx.effect 包一层
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/modelcheck/api',
    handler: (req, res) => { void handleApi(ctx, req, res) },
  }), 'modelcheck:api-route')

  // 2) 事件监听同样是 effect
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    // 见 §h：在这里 agent.steer(...) 才能让回合继续
  }), 'modelcheck:turn-stopping-guard')
}
```

### b.3 `ctx.effect` 契约

`docs/cordis-api/fiber.md#L8-L35`（生成自 vendor/cordis `src/fiber.ts#L415`）：

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect,      label?: string): AsyncDisposable<Promise<void>>
```

- `execute` 立即执行；它返回的 disposer 被收集，在**调用返回的 disposer** 或 **fiber 卸载**时按逆序执行，谁先到算谁。
- 二次调用返回的 disposer 是 no-op；fiber 已销毁时抛 `CordisError('INACTIVE_EFFECT')`。
- 注册类 API 自己返回 disposer（`webServer.register`、`tools.register`、`slots.register`、`ctx.on`），直接 `return` 它即可。

### b.4 ESM 约束

- `package.json` 必须 `"type": "module"`；宿主半边走 `main`/`exports["."]`，客户端半边走 `exports["./client"]`（本仓两个包都是这样，P）。
- 不需要顶层 await；`apply` 可以是 async（`packages/client/connection/src/index.ts#L126` 就是 async apply）。
- 可选服务用 `ctx.get('name')` 读取；**声明在 `inject` 里的**才用 `ctx.name` 属性访问（`packages/AGENTS.md`；postmortem 的第二个 bug 就是这条）。

---

## c. Web 路由（`webServer.register`）

### c.1 契约

`packages/host/webserver/src/index.ts#L43-L53`：

```ts
export type WebRouteKind = 'exact' | 'prefix'
export interface WebRoute {
  kind: WebRouteKind
  path: string                                  // 绝对路径，结尾不带斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>  // 自己拥有完整响应生命周期
}
```

- **重复注册**同一 `(kind, path)` 直接抛 `webserver: duplicate ${kind} route "${path}"`（`#L366-L373`）。`/geo-teacher` 这类顶层路径已被占用时换前缀。
- **匹配语义**：先查 exact 表；未命中则在 prefix 表里找"`pathname === prefix` 或 `pathname.startsWith(prefix + '/')`"的**最长前缀**（`#L543-L552`）。所以 `prefix:'/modelcheck'` 不会吃掉 `/modelchecker`。
- **没有 body 解析**：`handler` 拿到的是原始 `IncomingMessage`，JSON body 要自己读（限长 + `JSON.parse` try/catch）。参考本仓 `plugins/panel/index.js#L72-L106` 的 `readBytes` 静态资源写法与 `parse` 习惯。
- **没有兜底错误处理**：webserver 只在 `handle()` reject 且头未发出时回 400（`#L439-L457`）；handler 内 `.catch` 必须自己收尾（`res.writableEnded` / `res.headersSent` 都要判）。
- **鉴权**：自定义路由默认**不鉴权**（只有 `/api` 前缀路由调用 `connection.admit`，`packages/client/connection/src/index.ts#L146-L160`）。要"已认证浏览器会话"就自己写：

```js
const admission = ctx.connection.admit(req)          // rpc-host.ts#L129-L140
if ('rejection' in admission) {
  res.writeHead(admission.rejection)                 // 401 / 403
  res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
  return
}
```

### c.2 最小可抄片段（JSON API + HTML 页面）

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/modelcheck/api',
  handler: async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' })
    const admission = ctx.connection.admit(req)
    if ('rejection' in admission) return send(res, admission.rejection, { ok: false, error: 'unauthorized' })
    let body
    try { body = JSON.parse(await readBody(req, 1 << 20)) }
    catch { return send(res, 400, { ok: false, error: 'bad-json' }) }
    const result = await dispatch(ctx, body)          // 你的业务
    send(res, 200, result)
  },
}), 'modelcheck:api-route')
```

`send`/`readBody` 自己写（`res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(x))`）。

### c.3 页面 / 静态资源

- 页面：`kind:'exact', path:'/modelcheck/panel'` 返回 HTML；静态：`kind:'prefix', path:'/modelcheck/assets'`，**只按白名单文件名**下发（本仓 `server/static.js` 已有实现：单段文件名正则 + MIME 白名单 + 大小上限）。
- 不要提供任意 `.svg`：与 DSH Web API 同源，顶层 SVG 能执行脚本（本仓 `plugins/panel/index.js#L26-L34` 已踩过）。
- 如果页面要挂在宿主 index 里而不是独立 URL，用 `webServer.tapIndex(html => ...)`（注册顺序执行）或 `websocket/index-inject` 行；但 `renderIndex` **只由 fallback owner 调用**（`#L578-L586`），自定义路由要自己调 `ctx.webServer.renderIndex(html)`。

### c.4 未验证

- 桌面壳（Electron）是否在响应头加 CSP：上游源码没有，壳是社区项目，**未验证**。落地前在面板页里查一次 `document.querySelector('meta[http-equiv="Content-Security-Policy"]')` 和实际 iframe 加载。

---

## d. 客户端插件（`client.js`）

### d.1 加载形状（唯一合法入口）

```js
// 普通脚本（非 ESM），执行 window.__ModuleLoader__.load
window.__ModuleLoader__.load({
  id: '@geo-edu/dsh-modelcheck',          // 必须等于 package.json name
  factory(require) {                       // require 只能命中 11 个平台种子
    const React = require('react')
    const h = React.createElement
    return {                               // 返回值就是本模块导出，被当作 cordis 插件挂载
      name: 'modelcheck-client',
      inject: ['slots'],
      apply(ctx) { /* ... */ },
    }
  },
})
```

出处：本仓 `packages/dsh-geo-teacher-ui/client.js#L17-L20`（运行中）；模板 `packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/client.js`；构建器产物同形 `packages/client/tsdown.client.ts#L664`。
`require` 种子表（`packages/client/web/src/seed.ts#L30-L42`）**只有**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`、`@tanstack/react-virtual`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。其它一律 `require` 不到（会抛 `client-modules: require("x") missed the module table`，`packages/client/modules/src/client/system.ts#L328-L334`）。

`package.json` 声明（本仓 `packages/dsh-geo-teacher-ui/package.json` 同形，P）：

```json
{
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
}
```

### d.2 `conversation.view` 注册（可直接抄的两次真实注册）

槽位声明：`'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }` — `packages/client/ui-conversation/src/client/contract/slots.ts#L257-L258`。
`register(options, Component)` 的 list 槽必填 `id`，可选 `order`（升序，页签顺序）、`label`（字符串或**函数**，用于本地化）、`locale`（字典命名空间）、`children`（子槽声明）、`inject`（业务面工厂）、`store`（每个会话的 store 座位）。
出错条件（`packages/client/ui-slots/src/index.ts#L1207-L1249`）：未声明的槽位抛错；list 槽缺 `id` 抛错；同 `id` 同 `priority` 重复注册抛错；`children` 的键被别人声明过抛错。

已发布插件的注册（`packages/client/ui-trajectory/src/client/index.ts#L79-L110`）：

```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view',
  id: 'trajectory',
  order: 10,
  locale: NS,
  label: () => t('view.trajectory'),                     // 函数形式跟随语言
  children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
  inject: (sessionId: SessionId): TrajectoryViewInjected => { /* 业务面，按 sessionId 取数据 */ },
}, TrajectoryView))
```

聊天视图（`packages/client/ui-chat/src/client/apply.ts#L227-L245`）：

```ts
ctx.slots.inject('conversation.view', () => ctx.slots.register({
  name: 'conversation.view', id: 'chat', order: 0,
  label: () => t('view.chat'), locale: NS,
  children: { 'conversation.chat.flow': { kind: 'single', scope: 'session', inject: CHAT_FLOW_INJECT } },
  store: chatStore,
  inject: (sessionId: SessionId): ChatViewInjected => { /* ... */ },
}, ChatFlow))
```

**必须用 `ctx.slots.inject(key, cb)`**：槽位由父条目声明，父条目可能晚于你的插件到达；`inject` 会等它出现（本仓 UI 插件已经这么写，`client.js#L562-L587`；探针也记录过"未声明槽位直接 register 抛错"）。
页面显示规则：`conversation.view` 位于 `conversation.session` 内，**空会话整块不渲染**（`DefaultConversationViews.tsx#L32`）；`trajectory` 页签在 developer tools 关闭时被过滤（`apply.ts#L212`），自定义 `id` 不受影响。

### d.3 槽位内容能拿到的 props

`ConvViewProps = PropsRuntime<'conversation.view'> = OwnerOf<K> & KeyPropsOf & SlotInjectFace & ScopeStandardProps<'session'>`（`packages/client/ui-slots/src/index.ts#L251-L262`）。

| 来源 | props |
|---|---|
| owner（父级 `renderSlot` 传入） | `inspectCall: ((callId:string)=>void) 或 undefined`、`viewRequest: ConversationViewRequest 或 null`、`openView(view, focus)`、`completeViewRequest()` — `slots.ts#L389-L399` |
| session 标准包（`packages/client/ui-session/src/client/index.ts#L166-L175`） | `sessionId: SessionId`、`useSession(selector)`、`useProjection(key)`、`useAccess(action)` |
| 全局包（同文件 `#L157-L164`） | `useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess` |
| 你注册时 `inject:` 返回的对象 | 任意业务面（官方视图用它注入数据源/回调） |

既往探针实测（composer 类席位，`P`）：`useProjection / useSession / useConversation / useInput / inputActions / renderFactorySlot` 等；`useProjection('agentPreset')` 返回预设 id 字符串。`conversation.view` 属 session 作用域，按声明只保证上表；**具体清单未在本会话逐一实测**（client inspect 超时），以源码类型为准。

### d.4 切换当前视图

只有一条路：视图组件从 props 拿到 `openView(view, focus)`（`slots.ts#L399`，实现 `apply.ts#L389-L392` 写会话 store 的 `view`）。`UiConversation` 服务没有选择视图的方法（`assembly.ts#L187-L262`）。
→ 面板内部想"发送后回到对话"时调用 `openView('chat', '')`；**不要**设计外部自动切页签。

### d.5 样式与主题

- 客户端半边注入 `<style>`：`document.createElement('style')` + `id='modelcheck-panel-styles'`，卸载时移除（本仓 `client.js#L136-L147`、`#L583-L587`）。
- 类名加前缀（`mc-`），颜色只用主题令牌；令牌前缀是 **`--dsw-`**（不是 `--dsh-`）。
- 面板相关令牌（均来自 `packages/client/ui-theme/src/styles/design-platform.css`，共 113 个语义别名）：
  - 底色：`--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-mask-1`
  - 边框：`--dsw-alias-border-l1/l2/l3/l4`
  - 文字：`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-label-dimmed`
  - 交互：`--dsw-alias-interactive-bg-hover`、`--dsw-alias-interactive-bg-active`
  - 品牌/状态：`--dsw-alias-brand-primary`、`--dsw-alias-state-success-primary/secondary`、`--dsw-alias-state-warn-primary`、`--dsw-alias-state-error-primary`
  - 其他：`--dsw-alias-menu-surface-fill`、`--dsw-alias-tooltip-bg`、`--dsw-specific-bubble`
- **不要**在客户端半边用 `styles.insert`：那是"动态包浏览器半"的内置符号，手写 bundle 没有（见 §e）。

---

## e. `host.call`：0.2.1-rc.2 对第三方 bundle **不可用**

### e.1 结论与证据

`host.call(method, args)` 属于 **动态 Cordis 包**（模型运行时通过 `cordis` 工具写出来的插件）的浏览器半边：那一半在 `evaluator` 里以 async 函数体求值，固定符号面是 `React`、`console`、`styles`、`host`，并明确告诉作者"网络属于宿主半边：在那里用 `harness.handle(method, fn)` 注册，在这里用 `host.call(method, args)` 调用" — `packages/extensions/cordis-client-runner/src/client/evaluator.ts#L25-L71`；`packages/extensions/cordis-client-runner/README.zh.md`（"浏览器半用纯 JavaScript 编写 … 它拿到一组固定的名字——`React`、`console`、`styles` 与 `host`"）。`host.call` 的签名在 `.../src/client/providers.ts#L58`：`host.call(method: string, args?: JsonValue): Promise<JsonValue>`。

静态 bundle（我们的形态）的 factory 只有一个入参 `require`，没有 `host` 注入；`require` 命中不了任何"invoke seam"。→ **`host.call` 不可用。**

### e.2 回退方案（本条为 ModelCheck 选定的主链路）

**同源 `fetch` 到本插件自己的 webServer 路由**：

```js
// 客户端半边
async function mcApi(payload) {
  const res = await fetch('/modelcheck/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },   // 简单请求也 OK；带自定义头会触发预检，需要 CORS
    credentials: 'same-origin',                        // 默认就是同源；显式写清楚
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`modelcheck api ${res.status}`)
  return await res.json()
}
```

宿主半边用 §c.1 的 `ctx.connection.admit(req)` 做浏览器会话校验。这条链路：不依赖任何宿主客户端包、不需要 `host.call`、同源无 CORS 问题。

**次选**：使用既有客户端服务。第三方 client 插件可以 `inject:['sessions']`，经 `ctx.sessions.binding(sessionId).session.prompt(content, mode, signal, requestId)` 发消息——探针确认该面存在（`sessions.using / binding.session.beginSubmission|prompt|command`，`P`），但**从未实际发送过**，记为未验证；且它把业务判断留在客户端，不利于"确认必须宿主侧"的信任模型。

### e.3 动态包不是本项目的路线

`cordis-host-runner` / `cordis-client-runner` 是"agent 运行时自我修改"能力（`packages/extensions/`），依赖页面在每次 run 之前保持连接、刷新后不恢复定义（README 生命周期一节）。ModelCheck 需要**安装即长期存在**，不应走这条路。

---

## f. `sessionController.prompt`：形状、合法性、mode、requestId

### f.1 形状

`packages/api/session-controller/src/types.ts#L85-L98`、`#L343-L357`：

```ts
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: Branded<'file-upload-receipt-id'> }

export interface SessionPromptRequest {
  readonly requestId: SessionRequestId      // 客户端铸造，持久化在用户消息 source.rpcId 上
  readonly sessionId: SessionId
  readonly mode: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]   // 至少一个非空白 text 或一个附件
  readonly clientTimeZone?: string
}
// 返回 { accepted: true }
```

方法签名（`packages/api/session-controller/src/index.ts#L461-L462`）：`prompt(request, signal: AbortSignal)`。宿主内直接调用：`await ctx.sessionController.prompt({...}, signal)`。

### f.2 从宿主插件调用是否合法

合法。`@Remote` 只是暴露层，方法是普通 TS 方法；`packages/schedule` 的官方做法是宿主自己恢复 Agent 再投递（`packages/schedule/schedule/src/runtime.ts#L101-L124`）。
两个必须知道的差异：
1. `principalOf(this.ctx.invocation)` 在宿主直调时通常为 `undefined`，所以落盘 source 是 `{kind:'user', rpcId:requestId}`（无 principal）——这是"用户消息"，但不是"某个远端 peer 发的"（`index.ts#L477-L485`）。
2. 方法内部会 `resolveAgent(sessionId)` 恢复冷会话；会话不存在/已归档会抛 `RemoteError('session/not-found'|…)`，请按错误码分支处理。

### f.3 `mode` 语义（源码级）

`packages/api/session-controller/src/commands.ts#L350-L351`：

```ts
if (request.mode === 'steer') agent.steer(message)
else agent.followup(message)
```

`packages/core/agent-loop/src/agent.ts#L163-L169`：`followup` → `send(..., 'next-turn', true)`（下一回合、唤醒驱动）；`steer` → `send(..., 'next-step', true)`（最近的下一步；**正在运行的回合**会在这个回合的下一个 step 消费它；空闲时等同开新回合）。
ModelCheck：标注批次用 `mode:'queue'`（不插队、不打断模型当前工作）；"立刻停下改这个"才用 `'steer'`，且要接受它会改变模型当前回合的上下文顺序。

### f.4 requestId 要求

- **必须**提供，且同一逻辑批次（重试）必须复用同一 id。
- 去重实现：`hasPromptRequest(agent, requestId)` 扫 `inbox.nextTurn`、`inbox.nextStep` 与整段 session 事件里的 `source.rpcId`（`commands.ts#L584-L596`），命中即返回 `{accepted:true}`。
- 所以：**"批次 ID"就是 requestId**，重试天然幂等；不要用随机数当 requestId（会重复投递），也不要把"每次重试"当新批次。
- 类型是 branded string；运行时就是字符串，插件内自己生成稳定 ID（如 `mc-<batchId>-<attemptSeq?>` —— 若要"同批次只投一次"就**不要**加 attemptSeq）。

### f.5 投递失败的处理

- 抛 `RemoteError`：`session/not-found`、`session/agent-busy`、`session/attachment-invalid`、`gateway/bad-request`。捕获后把批次状态留在 `draft/sent-failed`，回给面板 `{ok:false, error}`；用户重试时用同一 requestId。
- 投递成功后再 `sessions.flush`（可选，`packages/schedule/schedule/src/runtime.ts#L124` 用来确认落盘）——注意 flush 只保证持久化，不保证模型已消费。

---

## g. 取证 / iframe 约束

### g.1 能不能嵌

- 主 Web 应用**没有 CSP 响应头**（全仓检索只有媒体引用与账号平台设了 CSP：`packages/api/session-controller/src/media-references.ts#L19`、`packages/credentials/deepseek-account-platform/src/index.ts#L645`）→ 同源 iframe 指向 `/modelcheck/preview/...` 可以加载。
- 桌面壳（Electron，社区项目）是否另加 CSP：**未验证**，落地前实测一次。
- 同源 iframe 的代价：它拥有同源权限（可读写父页面、可带 cookie 调 `/modelcheck/api`）。**要把预览当不可信内容**，就用 `sandbox="allow-scripts"`（不给 `allow-same-origin`）：
  - 好处：opaque origin，读不到父页面；SameSite=Strict 的会话 cookie 不会随跨站请求发出，`connection.admit` 会 401。
  - 代价：`localStorage`/同源 `fetch` 凭据不可用；一切回传只能走 `postMessage`（正是我们想要的）。
  - **未验证**：本机没有实测该 sandbox 形态下 Three.js/图片/`bridge.js` 的实际行为。

### g.2 `postMessage` 校验清单（照抄）

```js
window.addEventListener('message', (event) => {
  if (event.source !== iframeRef.current?.contentWindow) return   // 只认自己的 iframe
  if (event.origin !== window.location.origin && event.origin !== 'null') return
  const data = event.data
  if (!data || data.channel !== 'modelcheck') return
  switch (data.type) { /* mc:ready / mc:evidence / mc:pick / mc:error */ }
})
```

再加：字段白名单、单条消息 ≤ 1 MiB、`requestId` 必须匹配在途请求、证据数据结构校验（不要 `JSON.parse` 后直接信）。
模型页面**只能回取证数据与点选事件**，永远不能提交"用户确认"（规格 §17.3）。确认只能由面板 UI 经 `connection.admit` 通过的请求发出。

### g.3 预览页面怎么生成

- 路由：`kind:'prefix', path:'/modelcheck/preview'`，按会话解析项目根（`sessionId → sessions.get → workingDirectory.ensure`），再定位 `config.preview.entry`；**拒绝**任何 `..`、绝对路径、软链逃逸。
- 注入桥接：把 `<script src="/modelcheck/assets/bridge.js"></script>` 插到入口 HTML 的 `<head>` 最前（或 `</body>` 前）；用 `__VERIFY__` 之类的开关控制，交付版剥离（规格 §8.6）。
- `Cache-Control: no-cache`；reload 用 `?v=<buildHash>` 破缓存。
- 版本一致性：响应头/桥接握手都带 `buildHash`；面板只接受与当前 `buildHash` 相同的证据（规格 §17.2）。

### g.4 主题令牌

见 §d.5。若预览页也由我们产出，把令牌值复制进预览页的 CSS 变量（iframe 不会继承父页面 CSS 变量）。

---

## h. 完成拦截：源码结论 + 可抄片段

### h.1 源码怎么说（决定性）

`packages/core/agent-loop/src/agent.ts#L360-L366`：

```ts
signal.throwIfAborted()
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial('agent/turn-stopping', { turn, signal })
  signal.throwIfAborted()
}
if (turnEnds && this.inbox.nextStep.length === 0) break
target = 'next-step'
```

读法：
1. 监听器的**返回值不参与判断**（事件签名 `Promise<void> | void`）。想"否决结束"没有返回值可用。
2. 监听器在运行期间调用 `agent.steer(message)`，会把消息放进 `next-step` 队列；上面第 3 行看到队列非空 → 不 break → 回到循环顶部 `preStep('next-step')` → 模型再走一步。
3. 官方就是这么做的：`packages/experimental/hooks-codex/src/index.ts#L258-L273`（注释："A blocking Stop hook steers at the stopping boundary, which makes the machine observe pending input and run another step."）。
4. 测试固定了这一行为：`packages/core/agent-loop/tests/contract-regressions.spec.ts#L319` "steer() from an agent/turn-stopping listener continues the same turn"（断言出现第 2 次模型请求）。
5. **抛异常不是拦截**：监听器 throw → 回合以 `{kind:'error'}` 结束（`contract-regressions.spec.ts#L346`）。
6. **没有内置轮次上限**：`packages/core/agent-loop/README.md#L220` —— "No built-in turn budget … a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`"。所以续跑必须自限，否则就是我们自己要治的"空转"。
7. 只在 `turnEnds !== null` 且队列空时触发；**用户取消/模型报错不经过这里**（`agent.ts#L368-L383`）。所以拦不住"用户按停止"。

### h.2 `agent/pre-step` 能做什么（PreStepDecision）

`packages/core/agent/src/runtime-types.ts#L112-L119`：

```ts
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

- `reject` → `turnEnds = {kind:'blocked'}`，回合结束（`agent.ts#L318-L322`）——**用于"这个步骤非法，别进入"**，不是"继续"。
- `enter` → 用你给的 `messages` 作为该步输入；默认实现会在末尾追加运行时上下文（`agent.ts#L274-L288`）。所以**注入"必须调用 modelcheck_complete"这类提醒的另一个位置**是 `pre-step` 的 `messages` 追加（不影响用户消息队列）。
- 官方示例把 `PreStepDecision` 用于"拒绝 + 折叠上下文"，见 `hooks-codex/src/index.ts#L202-L225`。

### h.3 ModelCheck 的拦截片段（含自限）

**首选写法：不构造消息，用 `sessionController.prompt` 的 `steer` 模式**（它就是 `agent.steer`，见 §f.3；本仓宿主插件 import 不到 `@deepseek-ai/dsh-llm`，这条路不需要该包）：

```js
const interventions = new Map()   // key: `${agent.id}:${turn}` → count

ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
  if (signal.aborted) return
  const key = `${agent.id}:${turn}`
  const used = interventions.get(key) ?? 0
  if (used >= MAX_INTERVENTIONS_PER_TURN) return          // 默认 2；超限只记录，不续跑
  const project = resolveActiveProject(agent)             // 同步内存缓存；监听器里不做重 I/O
  if (project === undefined || project.certified) return
  interventions.set(key, used + 1)
  await ctx.sessionController.prompt({
    requestId: `mc-nudge-${agent.id}-${turn}-${used + 1}`,  // 稳定且唯一；prompt 内部还会按它去重
    sessionId: agent.id,
    mode: 'steer',
    content: [{ type: 'text', text: '【ModelCheck】本回合未通过完成门禁：先运行 modelcheck_verify，再调用 modelcheck_complete。' }],
  }, signal)
}), 'modelcheck:turn-stopping')
```

**备选写法（仅当该模块能 import 宿主包时）**：`agent.steer(createUserMessage({ content: [...], source: { kind: 'modelcheck' } }))` —— `createUserMessage` 来自 `@deepseek-ai/dsh-llm`（`packages/llm/llm/src/message.ts`）；`MessageSourceMap` 需要模块增强（照抄 `hooks-codex/src/index.ts#L22-L27` 的 `declare module`），这样审计时能区分"插件注入"与"用户发言"。本仓 link 安装的插件 import 不到该包，所以默认不用它。

要点：
- 监听器里**不要做重 I/O**：它在回合关闭路径上被 `await`；只读内存缓存，重活丢给队列/后台。
- `interventions` 是**进程内**内存表：重启即清空，可接受（重启后没有正在进行的回合）。
- 用 `mode:'steer'` 而不是 `'queue'`：`queue` 会在本回合关闭后才开新回合，对"拦截结束"无效。
- 若 `project` 状态需要异步刷新，不要等它——先按缓存判断，必要时本轮不拦；下一轮还有机会。

### h.4 明确不能承诺的

| 场景 | 能否拦 | 说明 |
|---|---|---|
| 模型停止输出且不调 `complete` | **能续跑**（有次数上限） | `turn-stopping` + `steer` |
| 用户点"停止"/取消 | 不能 | 取消走 abort 分支，不触发 `turn-stopping` |
| 模型报错结束 | 不能 | 同上 |
| 会话关闭 / 切换项目 | 不能 | 宿主层面无此扩展点 |
| agent 空闲后用户不发消息 | 不能 | 没有驱动就没有回合，任何插件都叫不醒（除非 `followup` 主动投递） |
| 强制模型"必须调用某工具" | 不能保证 | 只能提示 + 用自己的工具层拒绝"未完成即认证" |

---

## 附：实现检查清单（提交前逐条打勾）

- [ ] 宿主半边只 import `node:` 内置模块；客户端半边只 `require` 11 个种子内的模块。
- [ ] 每个 `register`/`on` 都包在 `ctx.effect(..., 'modelcheck:xxx')` 里，卸载无残留。
- [ ] 所有路由 `path` 是字面量；`/modelcheck/api` 第一行做 `ctx.connection.admit(req)`。
- [ ] 所有路径来自 `sessionId → workingDirectory.ensure`，从不信任请求体里的路径。
- [ ] 投递用稳定 requestId；失败保留草稿；重试不新增批次。
- [ ] `agent/turn-stopping` 监听器：无返回值、不抛异常、内存里自限次数、不做重 I/O。
- [ ] 预览 iframe `sandbox="allow-scripts"`；`postMessage` 校验 source/origin/channel/字段/大小。
- [ ] 面板确认记录写明"来自已认证浏览器会话"，不写"真人已核验"。
- [ ] 颜色只用 `--dsw-alias-*`；样式 `<style id>` 卸载时移除。
- [ ] README 的"能力与限制"与 [M0 能力矩阵](M0-能力矩阵.md) §4 的承诺逐字一致。
