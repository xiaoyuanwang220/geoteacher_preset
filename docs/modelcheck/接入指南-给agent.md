# ModelCheck 接入指南（给 agent，一页）

> 目的：让你在**已有模型项目**里接入 ModelCheck 时不需要读插件源码。
> 总原则：**点选只聚焦模型本身的几何**；文字标签、二维控件、页面框架不做点选（用文字指代）。

## 0. 你只需要记住三件事

1. **身份**：可点选的是几何（结构体/环域/环流圈/气压带风带/边界线/箭头/图像区域）。要么有稳定对象名，要么有 `parts`/`instances` 目录。
2. **入口**：Three.js 需要 `window.__MC_PREVIEW__`，且**取证用校验版、交付用成品**（`preview.verifyEntry` / `deliveryEntry`）。
3. **纪律**：判据来自项目《科学性文档》《开发文档》，由用户确认；`inconclusive`/`blocked` 不是通过；不要用点击位置猜身份。

## 1. 标准接入顺序（每步只做一件事）

```text
modelcheck_init action=scan          # 只读：候选/入口/路线/组件候选
modelcheck_init action=apply path=…  # 写 config+components，绑定会话；返回 readiness
  ↓ 看 readiness.checks：先修 block，再处理 warn
modelcheck_components action=upsert  # 修正 pick/kind/parts/instances（见 §3）
modelcheck_contract action=scaffold  # 用轻量 criteria 起草契约
  ↓ 请用户在面板「确认契约」（agent 不能确认）
modelcheck_verify dryRun=true        # 只列证据要求，不等待
  ↓ 打开「建模判定」→「标注」页签并保持预览可见
modelcheck_verify                    # 取运行时证据；blocked/inconclusive 按 remedy 修
modelcheck_complete                  # 全过才签发认证
```

## 2. Three.js 路线的最小接线

1. **钩子**（校验版构建里）：
   ```js
   window.__MC_PREVIEW__ = { scene, camera, renderer, THREE };
   ```
   `reactivity`：没有 `THREE` 时射线不可用，只能退化命中，不能声称能点。
2. **稳定对象名**：每个可标注几何 `name` 与 `userData.mcId` 用稳定 id；建议加 `userData.mcKind`（`structure|region|cell|belt|arrow|image-region`）。
3. **入口分离**：构建产出两份——
   - 交付版（剥离钩子）：`preview.deliveryEntry`；
   - 校验版（含钩子）：`preview.verifyEntry`。
   面板取证只加载 `verifyEntry`；不要用交付版做运行时取证。

## 3. 组件/单元约定（components.json v2）

```jsonc
{
  "id": "nh-trade-winds",
  "label": "北半球东北信风带",
  "kind": "belt",                  // 见下方枚举
  "route": "three",
  "pick": "mcbelt-nh-trade",       // 场景对象名/选择器
  "locator": { "file": "src/main.js", "symbol": "beltBand", "line": 190 },
  "annotatable": true,
  "parts": [                        // 一个组件内部有名字的不同部件
    { "key": "ring-north", "label": "北边界线", "selector": { "type": "name", "value": "mcring-nh-trade-n" } }
  ],
  "instances": [                    // 同类重复部件（箭头/纬线圈）
    { "key": "arrow-3", "label": "箭头 #3", "instanceId": 3, "locator": { "file": "src/data.js", "symbol": "WINDS", "line": 38 } }
  ]
}
```

- `kind` 枚举：`structure | region | cell | belt | arrow | image-region | other`（**没有 label/ui**）。
- 选择标识统一写 `组件id#key`（用于标注、判据和证据）。
- 实例 key 必须由数据生成、可复现：`seriesId:index`；不要用“点击位置就近匹配”。
- `InstancedMesh` 的实例目录挂到 mesh：`mesh.userData.mcInstances = [{ k, index, label?, axis? }]`；部件挂 `userData.mcParts`。
- 合并几何（多根流管融成一个 mesh）如果没有子对象身份，只能标到组，并在报告里如实说明。

## 4. verify 的三种返回

| 返回 | 含义 | 你该做什么 |
|---|---|---|
| `status:"blocked"` | 预检没过（契约未确认 / 取证入口缺 / 钩子缺 / 面板未开） | 按 `remedy` 修**一次**；不要重复调用空等 |
| `status:"inconclusive"` | 取证不足或规则判不出来 | 补齐证据（面板、pick、实例目录）后复验 |
| `status:"ok"` | 已执行，看每条 `results[id].status` | 只把 `pass` 当通过 |

- `dryRun:true` 只列每条判据需要的证据类型与来源，不写证据。
- `allowOffline:true` 只用于“面板确实打不开、只跑配置类判据”，运行时判据仍然 `inconclusive`，不能据此认证。

## 5. 常见错误 → 处理

| 现象 | 原因 | 处理 |
|---|---|---|
| 点选无反应 | 校验版没钩子 / 面板在交付版 | 检查 `readiness` 的 `hook`、`verifyEntry` |
| 点中但报“未登记” | `pick` 与场景名不一致 | 用 `readiness.wiring.unwired[].suggestedPick` 修正，或按 `chain` 登记 |
| 箭头只能点到整组 | `InstancedMesh` 无实例目录 / 流管被合并 | 按 §3 加 `instances`；合并几何就只能到组 |
| verify 一直 inconclusive | 面板不在「标注」页签 / 钩子缺失 | 打开面板并保持预览；先修 block |
| 文案标签点不到 | **设计如此** | 用文字指代（“把‘东北信风带’改成…”），不要要求点选 |

## 6. 纪律

- 不内置/不套用通用判据模板；判据来源必须写进 `source`（文档+条款+哈希）。
- 用户确认不可替代：`contract/confirm`、`annotations/accept` 只能由面板点击。
- 不要把 `inconclusive`、`blocked`、旧证据复用当通过。
- 改共享配置/材质时，先声明允许变化的组件范围，改后复验未声明组件。

## 7. 一次性自检清单

- [ ] `readiness.checks` 无 `block`
- [ ] `verifyEntry` 与 `deliveryEntry` 都存在且分开
- [ ] 校验版含 `__MC_PREVIEW__`，交付版已剥离
- [ ] 组件都有 `kind`；可点的 `pick` 能在源码里找到
- [ ] 需要单支箭头的组件有 `instances`（含稳定 key）
- [ ] 契约来源条款齐、用户在面板确认
- [ ] 面板「标注」页签打开后再 verify
