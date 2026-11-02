# @geo-edu/dsh-modelcheck —— 建模完成判定插件（ModelCheck）

为高中地理网页建模（Three.js / SVG / Canvas / 单 HTML）与图像叠加路线提供**可执行的完成判定**：
契约判据、运行时取证、增量验证、组件标注通道、完成门禁。它不替代 `geo-teaching-model` skill 的教学判断，
只回答一个问题——**"怎么判断已经做到了"**。

> 需求来源：[建模完成判定插件需求规格书 v3.2](../../docs/建模完成判定插件-需求规格书.md)
> 实现设计：[一期实现设计](../../docs/modelcheck/设计-一期实现.md)
> 宿主能力实测：[M0 能力矩阵](../../docs/modelcheck/M0-能力矩阵.md)

## 安装（profile 级 bundle）

```text
plugin_manager action=install_bundle target=<仓库根>/packages/dsh-modelcheck
```

安装后：

- 宿主半边注册 `/modelcheck/api`、`/modelcheck/preview/*`、`/modelcheck/assets/*`；
- 客户端半边在会话的 `conversation.view` 槽位出现「建模判定」页签；
- 模型工具表出现 8 个 `modelcheck_*` 工具。

**没有 `.modelcheck/` 目录的项目完全不干预**：工具返回 `{status:"inactive"}`，面板显示未初始化并提供「扫描并初始化」。

## 已建好模型的项目：一键生成 `.modelcheck`

不必再手写三个 JSON。在已有模型项目（有 `index.html` / `dist/index.html` / `src/`）里：

- **面板**：打开「建模判定」→ 未初始化时点「扫描可初始化项目」→ 选择候选 →「初始化」；
- **agent**：调用 `modelcheck_init`。`action:"scan"` 只读探测（一个工作区里多个模型目录会列候选），
  `action:"apply" path:"<relativeRoot>"` 写入 `.modelcheck/config.json` 与 `components.json`，
  并把该项目**绑定到当前会话**，后续 `modelcheck_*` 工具都以它为项目根。

初始化会同时返回 **readiness 接入就绪清单**：项目/取证入口/`__MC_PREVIEW__` 钩子/构建产物/pick 接线/契约，
每条 `ok:false` 都带可执行 `remedy`（文件:行或命令）。Three.js 路线区分
`preview.verifyEntry`（含钩子的校验版，供面板取证）与 `preview.deliveryEntry`（交付成品），
避免“面板把剥离钩子的成品当预览，运行时判据永远 inconclusive”。接入步骤见
[给 agent 的接入指南](../../docs/modelcheck/接入指南-给agent.md)。

扫描会自动推断：预览入口（优先 `dist/index.html`）、技术路线（three/svg/dom/image）、源码清单、
构建产物、项目文档、校验版入口，以及组件候选（`data-mc-id` / `data-role` / three 对象 `name`，含中文名；scene/camera 等通用名会被过滤）。
写入是幂等的：已有文件默认不覆盖（`force:true` 才覆盖），**不会生成任何判据**。
扫描按**文件内容**判断初始化状态，而不是只看目录是否存在：`.modelcheck` 空目录（0 个文件）、
只有一半文件、或 config/components JSON 损坏，都算未完全初始化；`apply` 会补齐缺失或无效的
`config.json` / `components.json`，已有效的文件不动。状态含义：`none` 无目录 / `empty` 空目录 /
`partial` 缺文件或坏 JSON / `ready` 两个文件都在且结构有效（契约仍可能需要你确认后才建立）。

判据仍来自项目《科学性文档》《开发文档》。为减少手写契约的负担，可用轻量列表起草：

```text
modelcheck_contract action=scaffold sourceDocs=["三圈环流教学模型开发文档.md"] criteria=[
  {claim:"教学数据包含「北半球东北信风」命名", rule:{kind:"text", file:"src/circulation.js", mode:"matches", pattern:"东北信风"}},
  {claim:"信风带箭头实际方向为西南向（方位角 225°±10°）", rule:{kind:"direction", component:"东北信风带", expectedAzimuthDeg:225, toleranceDeg:10}}
]
```

草稿写入 `contract.proposed.json`，仍需**用户在面板确认**才生效；agent 不能确认。

## 项目内数据（`.modelcheck/`）

```text
.modelcheck/
  config.json        项目身份、路线、预览入口、预算
  components.json    组件注册表：id/中文标签/代码位置/点选钩子/可监测属性
  contract.json      已确认契约：级别/阻塞/陈述/结构化规则/依赖/证据要求
  contract.proposed.json  agent 提议、等待用户确认的新契约
  evidence.json      每判据当前证据（含版本键、构建哈希、覆盖范围）
  annotations.json   标注批次与请求状态机
  rounds.json        轮次/预算/空转记录
  certification.json 完成认证（绑定契约版本 + 产物哈希）
  reports/           一页式报告存档
  artifacts/         截图/取证产物（按内容哈希命名）
```

示例见 [fixtures/project](fixtures/project/)（一个 0.035 世界单位闭合缝的 SVG 夹具）。

## 模型工具

| 工具 | 用途 |
|---|---|
| `modelcheck_init` | 在已有模型项目里扫描并生成 `.modelcheck/config.json` + `components.json`，绑定到当前会话 |
| `modelcheck_status` | 项目/契约/判据/标注/预算/认证摘要，给出下一步 |
| `modelcheck_contract` | 读契约；提议新契约（写入 `contract.proposed.json`，**必须由用户在面板确认**） |
| `modelcheck_components` | 建模时登记/更新组件表 |
| `modelcheck_verify` | 增量执行判据；先做接入预检（契约/取证入口/钩子/面板），不满足返回 `blocked` + 一条补救；`dryRun:true` 只列证据要求 |
| `modelcheck_annotations` | 读待处理标注；整理为可判定请求；关闭已满足请求 |
| `modelcheck_complete` | 完成门禁：签发认证或返回阻塞项与补救指令 |
| `modelcheck_round` | 记录修改轮次，返回预算/空转判定与恢复梯子文案 |

## 判定语义（与规格书一致）

- 状态是 `pass / fail / inconclusive / unverified / stale` 五态；**只有 `pass` 计入完成**。
- `verify` 还有预检结果 `blocked`（契约未确认、取证入口/钩子缺失、面板未打开）：它不是通过也不是失败，按 `remedy` 修一次后重试。
- `inconclusive`（没查完/判不出来）**不是通过**，也不是失败；取证超时、证据缺失、能力不可用都记它。
- **fail-closed**：工具异常、超时、旧构建、证据上下文不符 → 不通过、不放行。
- **证据分ty**：配置检查不能替代运行时几何检查；`requiredEvidence` 不满足 → `inconclusive`。
- **模型自证无效**：模型自己说"通过了"不算插件验证结果；认证只由 `modelcheck_complete` 依据证据签发。
- **契约变更需重新确认**：删判据、放宽阈值、降低阻塞级别、减少证据要求都要求用户在面板重新确认。
- 证据复用绑定版本键（契约版本 + 规则哈希 + 依赖文件哈希 + 适配器版本 + 上下文 + 构建哈希）；
  依赖一变，旧 `pass` 自动 `stale`，必须复验。

## 组件标注通道（只聚焦模型几何）

**只点模型本身的几何**：结构体、环流圈、气压带/风带、边界线、箭头、图像叠加区域。
文字标签、二维控件、页面框架**不进入点选**——它们用对话文字指代（如“把‘东北信风带’改成……”），
必要时用 `text` 规则对数据/源码判定。

1. 面板「标注」页打开项目预览（同源 iframe，注入取证桥接）；
2. 点「标注模式」→ 点选几何单元；有 `parts`/`instances` 时显示面包屑 `组件 › 部件/实例`（如 `北半球东北信风带 › 北边界线`、`低纬环流圈 › 箭头 #3`）；
3. 未登记的命中会显示命中链与“请让 agent 登记”的提示，不自动写盘；
4. 就地输入要求，**保留用户原话**，可累加、可编辑、可删除；
5. 一次发送 → 生成含 **组件 id + 部件/实例标识 + 中文标签 + 代码位置** 的批次消息，投递到当前会话；
6. agent 修改后，面板重载预览、高亮变动组件、按既定验收方式关单（自动验收或人工确认）。

标注层不会进入教师交付物：`preview.injectBridge:false` 或 `__VERIFY__=0` 时不注入桥接，`.modelcheck/` 不随交付物发布。

**预览沙箱**：预览页运行在不透明源沙箱里（`sandbox="allow-scripts allow-forms allow-modals"`，**不加** `allow-same-origin`），因此模型页脚本读不到父页面、也无法直接调用 `/modelcheck/api` 伪造用户确认。代价是模型页内的相对 `fetch()` 会因跨源失败；需要网络数据时请内联数据或改用 `svg`/`dom` 路线。面板必须停留在「标注」页签且预览可见，运行时几何取证才能回填（隐藏 iframe 的 `getBoundingClientRect` 归零，取不到几何）。

## 能力与限制（如实声明）

| 能力 | 状态 | 说明 |
|---|---|---|
| 契约判据执行（数值/闭合/方向/文案/哈希/SVG 端点） | ✅ 已实现 | 结构化规则，不执行任意表达式、不做 `eval` |
| 运行时几何取证 | ✅ 已实现（需面板打开） | 面板未打开或超时 → `inconclusive`，绝不拿旧证据冒充 |
| 包围盒重叠 | ◐ 仅候选 | 只标记候选相交，**不判穿模** |
| 视觉判据（构图/配色/遮挡） | ◐ 人工 | 需要用户确认；插件不替你判断"好不好看" |
| 增量验证 / 证据版本键 / `stale` | ✅ 已实现 | 依赖变化自动失效 |
| 组件标注 + 投递会话 | ✅ 已实现 | 只对模型几何点选；投递失败保留草稿可重试，幂等不重复生成请求 |
| 几何分层点选（组件 / `parts` / `instances`） | ◐ 已实现，待真机验证 | 组件级与 `parts`（如边界线）已接；`InstancedMesh` 的实例级依赖模型提供 `userData.mcInstances`，真机命中链尚未验收；合并几何仍只能标到组 |
| 接入就绪预检（readiness） | ✅ 已实现 | init/verify 返回具体缺失项与补救；`verify` 不满足前置条件时返回 `blocked` 而不是空等 |
| 校验版/交付版入口分离 | ✅ 已实现 | `preview.verifyEntry` 供面板取证，`preview.deliveryEntry` 为交付成品 |
| 完成拦截（阻止 agent 不调用 `complete` 就结束） | ◐ 可用（有条件） | `agent/turn-stopping` 里用 `sessionController.prompt({mode:'steer'})` 把"未认证"提醒插回下一步，同一 agent+turn 最多 2 次；用户主动停止时不续跑。**不宣称**能阻止用户停止、关闭会话或在新回合强行续跑（源码依据见 M0 能力矩阵） |
| 写前阻止（阻止修改文件） | ❌ 覆盖率不足 | `fs/write-intent` 只由 `write`/`edit`/`str-replace-editor` 派发，`pwsh`/`bash` 写盘不经过它；只做修改后检测与回归复验，不得宣称文件无法被修改 |
| 执行取消（宿主任务） | ❌ 不可用 | 只停止插件自有任务，宿主任务未确认停止 |
| 人工确认来源可信 | ◐ 受限 | 面板点击记录 `confirmedBy:"user"`；无法证明是真人还是模型页面写入时，不签发人工确认 |
| Blender 路线 | ❌ 一期不做 | 见规格书 §2 |
| 多会话/多项目隔离 | ✅ 已实现 | 服务端按 `sessionId` 解析项目根，不接受客户端任意路径 |

`.modelcheck` 缺失时零干预；证据、认证、请求状态均为原子写；并发修改同一契约有冲突检测，不静默覆盖。

**未验证项**：客户端 Slots/Theme inspect 在本会话取证超时（见 M0 能力矩阵 §5）；完成拦截在真实模型上是否会无限续跑、预览 iframe 不透明源下的模型页兼容性、`InstancedMesh` 的 `instanceId`/`instanceMatrix` 真机命中与实例技巧取证，均属未验证——报告里不得写成"已验证"。文字标签与二维控件按设计**不做点选**，不是缺陷。

## 开发与检查

```bash
node --test "packages/dsh-modelcheck/test/*.test.mjs"   # 单元测试
node scripts/modelcheck-verify.mjs --tests               # 静态检查 + 单测
$env:DSH_WEB_URL; node scripts/modelcheck-verify.mjs --runtime   # 安装后的运行时探测
```

验收记录见 [docs/modelcheck/实施记录.md](../../docs/modelcheck/实施记录.md)。
