# legacy — 旧草稿归档

本目录存放已不再使用、但保留备查的历史文件。**不参与任何运行时加载**，可随时删除。

| 内容 | 是什么 | 被什么取代 |
| --- | --- | --- |
| `host.js` | 旧动态插件 Host 逻辑（考点树/真题检索/分析/蓝图） | `.agent-presets\geo-teacher\geo-teacher-plugin\index.js`（持久化插件） |
| `client.js` | 旧动态插件 Client UI（侧边栏/浮层面板） | 持久化插件的 `/geo-teacher` 页面 |
| `geo-teacher-agent.js` / `geo-teacher-client.js` | 更早期的插件草稿 | 同上 |
| `plugin.json` / `package.json` | 旧插件包清单（依赖 js-yaml，动态沙箱已禁止 require） | 持久化插件无需 npm 依赖 |
| `question-assistant\` | 出题技能旧变体（ima 调优版，含 references/） | `skills\geo-question-generator.md`（重构后的 DSH 本地版，规范已内联） |

> 如需追溯历史实现，`plugin_definition.md`（已移入 `docs\`）记录了最早期的插件定义与调试过程。
