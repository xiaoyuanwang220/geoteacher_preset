# 在 DSH 原生输入框上改造 —— 修改方案

> 日期：2026-10-03
> 状态：**方案（未实施）**
> 诉求：三标签受理台要**成为原生输入框本身**，而不是在输入框上方/旁边再加一块卡片。
> 现状：`ui-v3.0.0` 已实现"输入框上方的加法卡片"（`conversation.input.dock`），作为本方案的**回退位置**保留。
> 全部结论来自本机实测，证据在 `outputs/geo-ui-plugin-probe/report.jsonl` 与宿主 `app.asar`。

---

## 0. 三条硬约束（先定边界，避免反复）

| # | 事实 | 证据 | 后果 |
| :-- | :-- | :-- | :-- |
| C1 | `conversation.composer` 是 chain 槽（`replaceRisk: none`），第一个 `select` 返回非 null 的条目**独占替换**常驻输入区 | slots 目录 + 实测 `takeOver: true` | 接管 = 原生输入区（含模型/权限/附件/计划/发送）不再渲染 |
| C2 | 工厂子组件**拿不到** `renderSlot`（实测 `hasRenderSlot: false`），`renderFactorySlot` 只能渲染*工厂*，渲染 `conversation.content` 会无限递归 | 实测 observer props + 宿主文档 | **"接管 + 把原生那条挂回来"这条路不存在**，不要再试 |
| C3 | 原生输入状态与动作**可复用**：`useInput()` → `{attachmentIds, draft, draftRev, occurrences, phase, queue}`；`inputActions` → `{setDraft, submit, insertText, addAttachments, removeAttachment, pruneAttachments, captureInsertion}` | 实测 props | 接管后仍可把输入/发送/附件交给原生管线，不必自建发送逻辑 |

补充：客户端可注入的 remote 命名空间（宿主侧证据）包含 `remote.session`、`remote.commands`、`remote.llm`、`remote.settings`、`remote.permissionPresets`、`remote.agentPresets` 等 → **模型选择 / 权限预设 / 计划模式原则上都能在客户端重建**，但都要单独做与验。

---

## 1. 三条路线

### 路线 A：把受理条**嵌进**原生输入框（零遮蔽，先做）
不动结构，原生文本框/模型/权限/附件/计划/发送**全部保留**，我们只往原生输入卡片内部加东西：

| 落点 | 槽位 | 内容 |
| :-- | :-- | :-- |
| 工具行左侧 | `conversation.input.left`（list / session / `replaceRisk: none`） | 三标签（紧凑形态）+ 参数（收成一个 popover） |
| 发送键之前 | `conversation.input.right`（list / session / `replaceRisk: none`） | 「开始讲题」主按钮 |

交互（关键：**用户仍在原生文本框里打字**）：

```
用户在原生输入框输入「2025年广东卷第10题」
  → 选标签「讲题」+ 参数「讲题对象：学生」
  → 点「开始讲题」
  → 读 input.draft → 拼成完整提示词 → inputActions.setDraft(拼好的) → inputActions.submit()
```

- **优点**：零遮蔽、零重建、风险最低；**只有一个输入框**；改动量约半天。
- **代价**：工具行空间紧凑——标签只能用图标+短字，参数必须收成 popover；观感是"原生输入框被增强"，不是原型那种大卡片。
- 可选变体：`只 insertText（把拼好的提示词插入输入框）`，由用户自己按原生发送键确认——更安全，少一次不可预期的提交。

### 路线 B：**接管输入框并复用原生输入状态**（最贴原型，工作量大）
接管 `conversation.composer`，自己画整个输入区（原型形态：三标签横排 + 大文本域 + 参数下拉 + 主按钮），但输入与发送仍交给原生管线：

| 能力 | 做法 | 状态 |
| :-- | :-- | :-- |
| 文本域 | `value = input.draft`；`onChange → inputActions.setDraft(v)` | 依赖已具备 |
| 发送 | `inputActions.submit()`（排队/运行态/pending 全原生） | **待实测** |
| 附件 | 自绘按钮 → `inputActions.addAttachments(files)`；附件条读 `input.attachmentIds`，删除用 `removeAttachment` | 依赖已具备 |
| 模型选择 | `remote.llm` / `remote.settings`（确切端点待查） | 需重建 |
| 权限预设 | `remote.permissionPresets` | 需重建 |
| 计划模式 | `remote.commands`（如 `/plan`） | 需重建 |
| 引用/提及 | `occurrences`（可选） | 需重建（可选） |

- **优点**：观感≈原型；一个输入区；发送与附件走原生。
- **代价**：模型/权限/计划三个控件要**自己重做**（各自有交互与文案），工作量与回归成本明显高于路线 A。
- **强制项**：`select` 里 `if (owner.pendingInteraction) return null`（批准弹窗、计划评审属于同一 factory，接管会连带吃掉）；门控必须**廉价 + 失败即不接管**（`select` 每次渲染都被调用，实测约 30 次/秒）。

### 路线 C（已排除）：接管 + 挂回原生工具条
由 C2 否决，写在此处避免以后再次尝试。

---

## 2. 推荐

1. **先做路线 A**（半天内可验），它已经满足"只有一个输入框、在原生对话框上改"，且完全没有遮蔽风险；
2. 若你要的是原型的**大卡片观感**，再上**路线 B**，并把"重建模型/权限/计划"列为独立工作项（这三个控件不做完，B 就退化成 v3 的能力，只是换了外观）；
3. 两条路线共享同一套资产：三功能定义与提示词拼装、结果弹窗（已实现）、门控读数（已验证）、原生发送链路（`setDraft`+`submit`）。

---

## 3. 路线 B 的分步实施（若决定要做）

| 步 | 内容 | 出口条件 |
| :-- | :-- | :-- |
| P0 | 验证：`setDraft`+`submit` 真实可用；`ctx.inject(['remote.permissionPresets' / 'remote.llm' / 'remote.commands'], cb)` 在第三方 client 半边可注入；`pendingInteraction` 出现时的回落 | 三条都拿到实测结论 |
| P1 | 接管 + 原生 draft 绑定（先不带工具条） | 普通会话逐像素不变；批准弹窗仍在；输入/发送正常 |
| P2 | 附件（addAttachments / removeAttachment / 附件条） | 用原生控件加图后能被我们的输入区识别并一起发出 |
| P3 | 模型 / 权限 / 计划三个控件 | 每个单独评审 + 与原生截屏对照 |
| P4 | 主题（14 令牌）、i18n、无会话态、失败态 | 明暗各一遍；字号缩放一遍 |

---

## 4. 验收与回滚（两条路线共用）

**验收**
1. `desktop` profile bundle 列表含本包且 `enabled: true`；
2. 本预设会话：受理条/输入区在位，发送真实生效（含附件一起走）；
3. 普通会话（非本预设）：输入区、英雄区、批准弹窗与改动前**逐像素一致**；
4. 明/暗主题 + 字号缩放各一遍；
5. 摘除演练：`remove_bundle` → 重启 → 桌面恢复原样，`/geo-teacher` 页面不受影响。

**回滚**：任一路线出问题即摘除 bundle；现 v3 的加法卡片实现可作为立刻回退的位置。

---

## 5. 需要你定的两件事

1. **标签形态**：图标+文字（占位更宽）还是图标+悬浮提示（最省空间）？
2. **「开始讲题」的行为**：`拼好后直接发送`（一键出结果，少一步）还是 `只插入输入框、由你按原生发送键确认`（更可控）？

---

## 6. 本文件不做的事

- 不写代码、不改组合（等你选路线后再动手）；
- 不涉及 preset 分发与可移植性（此前已确认不在范围）。
