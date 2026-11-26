# geospark-ai-ui

GeoSparkAI（`geo-teacher` 预设）的桌面端原生 UI 插件。它在 DSH 的会话输入区就地接管两处零遮蔽槽位，提供「讲题／课程方案」的功能选择与参数设置，并通过宿主动态运行时上下文（`systemPrompt.context`）实时送达模型。

> 说明：出题模块正围绕「模拟题高考化润色与快测出题」调整交互方向，输入区暂不展示旧版出题按钮（仍可通过自然语言对话调用）。

## 它做什么

| 位置 | 槽位 | 内容 |
| :-- | :-- | :-- |
| 工具行左侧 | `conversation.input.left` | 按当前功能切换的参数下拉：讲解对象（学生／教师／命题人）｜年级（高一／高二／高三）+ 时间（45分钟／10分钟） |
| 工具行右侧 | `conversation.input.right` | 功能选择器（讲题／课程方案），紧邻原生模型选择器左侧 |

### 参数如何送达 Agent（不污染输入框）

1. 客户端按 `sessionId` 独立维护会话选择状态（未绑定会话前的选择在新建会话时自动继承）。
2. 会话挂载及每次切换功能或参数时，客户端立即向同源宿主路由 `POST /geo-teacher-ui/state` 同步 `{ sessionId, preset, active, values }`。
3. 宿主半边（`index.js`）经 `@deepseek-ai/dsh-system-prompt` 的 `systemPrompt.context` 注册 `geo-teacher-ui:selection`，`dsh-agent-loop` 在每轮请求准入（`refreshContext`）时自动把当前会话选定参数注入模型运行时上下文：
   - **原生输入框保持干净**：不向编辑器注入文本前缀，两行输入提示正常展示，不冲掉教师拖入的 `@文件`／`@目录` 引用胶囊；
   - **默认项同样生效**：即使教师保持默认的 `高一 + 45分钟` 或 `学生` 未额外点击下拉项，宿主也会收到并注入当前工具栏展示值，模型直接采用、不再重复追问课时或年级；
   - **严格作用域隔离**：仅在 `agentPreset === "geo-teacher"` 的主会话生效；隔离解题子会话（独立 `childSessionId`）与其它预设会话均返回空串（零泄漏）。

## 安装

本插件是 bundle，按 profile 依赖挂载。在目标 profile 的 `package.json` 里加依赖并列入 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "geospark-ai-ui": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "geospark-ai-ui"
      ]
    }
  }
}
```

客户端半边由 `dsh-client-modules` 依本包 `package.json` 的 `dsh.client` 声明自动发现，**零构建**：`client.js` 是手写脚本，经 `window.__ModuleLoader__.load({id, factory})` 注册，安装时不需要跑打包器。

改完需**完整退出并重启 DSH Desktop**（关闭主窗口可能只是隐藏，需确认进程已退出）。

## 配置

无。插件行为由代码内的双功能定义决定（`client.js` 的 `MODES` 与 `INITIAL_VALUES`，与 `index.js` 校验枚举对齐）。讲题对象默认取**学生**，与 geo-teacher 预设 persona 的「默认 student、不自动选 teacher」一致。

## 静态资源与状态路由

- `GET /geo-teacher-ui/assets/<name>`：只发本包 `assets/` 下的栅格图（禁 `image/svg+xml`）；详见 [`assets/README.md`](assets/README.md)。
- `POST /geo-teacher-ui/state` ／ `GET /geo-teacher-ui/state?sessionId=<id>`：同源会话输入区选项同步与只读诊断接口（拒绝跨源写入）。

## 已知边界

- 占位提示与英雄区文案是**就地改写宿主 DOM**（按文本匹配 + 定时校正），因为宿主未开放这两处的改写 API。宿主升级若改动这些文案，改写会失效——表现为提示回到原生文本，功能选择器与参数注入不受影响。
- 槽位作用域是 **profile 级**，插件靠 `agentPreset` 自行门控；切换到非 `geo-teacher` 预设时会主动通知宿主清理该 `sessionId` 的选择状态。

## 许可

MIT
