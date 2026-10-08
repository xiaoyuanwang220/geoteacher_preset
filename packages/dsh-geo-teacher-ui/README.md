# @geo-edu/dsh-geo-teacher-ui

geo-teacher 预设的桌面端原生 UI 插件。它在 DSH 的会话输入区就地接管两处零遮蔽槽位，把「讲题／出题／课程方案」的功能选择与参数设置放进原生输入框，不再需要另开网页工作台。

## 它做什么

| 位置 | 槽位 | 内容 |
| :-- | :-- | :-- |
| 工具行左侧 | `conversation.input.left` | 按当前功能切换的设置下拉：讲解对象｜题型+难度｜年级+时间 |
| 工具行右侧 | `conversation.input.right` | 功能选择器（讲题／出题／课程方案），紧邻原生模型选择器左侧 |

选择功能或改动设置时，插件把

```
请按「<功能>」功能处理：
<设置项>：<值>

需求：
```

作为前缀写入**原生输入框**，教师自己写的正文原样保留；三个功能各自的正文与选项分别记忆，切换时互换。发送仍走原生发送按钮，文本、附件与排队都使用原生状态。

只在 `agentPreset === "geo-teacher"` 的会话里生效；退出该预设或卸载时还原占位提示与英雄区文案。

## 安装

本插件是 bundle，按 profile 依赖挂载。在目标 profile 的 `package.json` 里加依赖并列入 `dsh.profile.bundles`：

```json
{
  "dependencies": {
    "@geo-edu/dsh-geo-teacher-ui": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@geo-edu/dsh-geo-teacher-ui"
      ]
    }
  }
}
```

客户端半边由 `dsh-client-modules` 依本包 `package.json` 的 `dsh.client` 声明自动发现，**零构建**：`client.js` 是手写脚本，经 `window.__ModuleLoader__.load({id, factory})` 注册，安装时不需要跑打包器。

改完需**完整重启桌面**（关闭主窗口可能只是隐藏，需确认进程已退出）。

## 配置

无。插件所有行为由代码内的三功能定义决定（`client.js` 的 `MODES` 与 `INITIAL_VALUES`），不需要路径或凭据。讲题对象默认取**学生**，与 geo-teacher 预设 persona 的「默认 student、不自动选 teacher」一致。

## 静态资源

宿主半边只从本包 `assets/` 取图，经 `/geo-teacher-ui/assets/<name>` 提供，只发栅格图。当前客户端未引用图片，该路由为品牌位插图预留；详见 [`assets/README.md`](assets/README.md)。

## 已知边界

- 占位提示与英雄区文案是**就地改写宿主 DOM**（按文本匹配 + 定时校正），因为宿主未开放这两处的改写 API。宿主升级若改动这些文案，改写会失效——表现为提示回到原生文本，功能选择器与设置不受影响。
- 槽位作用域是 **profile 级**，插件靠 `agentPreset` 自行门控；门控失效会影响其它预设的会话。
- 不提供 `image/svg+xml`：本路由与 DSH Web API 同源，顶层 SVG 能执行脚本。

## 许可

MIT
