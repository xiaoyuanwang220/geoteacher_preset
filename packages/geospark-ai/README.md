# geospark-ai

**GeoSparkAI · 高中地理教师辅助 Agent** 一键安装、升级、自检与卸载工具（运行于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop）。

无需安装 Git、无需克隆源码仓库，只要电脑已安装好 DSH Desktop（现行验证基线 `0.2.2-rc.5`），一行命令完成配置。

## 快速使用

```sh
# 1. 首次一键安装（自动安装核心预设 + 输入区 UI + 高考真题数据包）
npx geospark-ai@latest install --yes

# 国内网络可使用 npmmirror 镜像加速：
npx geospark-ai@latest --registry=https://registry.npmmirror.com install --mirror --yes

# 2. 后续一键升级到最新版
npx geospark-ai@latest update --yes

# 3. 只读自检当前安装状态
npx geospark-ai@latest check

# 4. 干净卸载（保留 ~/.dsh/geo-teacher 下的个人配置与生成产物）
npx geospark-ai@latest uninstall --yes
```

> 若希望仅使用随附考点库并接入自建题库（不下载 15 MB 默认真题数据包），可在安装时附加 `--no-data`。

## 组件构成

| npm 包名 | 职责 | 挂载方式 |
| :-- | :-- | :-- |
| `geospark-ai` | 一键安装 / 升级 / 自检 / 卸载 CLI | `npx` 按需执行 |
| `geospark-ai-preset` | 核心预设 Bundle（7 个功能插件 + 4 个教师技能 + 随附三级考点库） | `dependencies` + `dsh.profile.bundles` |
| `geospark-ai-ui` | 桌面端会话输入区功能与参数选择器 Bundle | `dependencies` + `dsh.profile.bundles` |
| `geospark-ai-data` | 独立高考真题与配图数据包（115 份题组 Markdown + 120 张题图） | 仅 `dependencies`（非 bundle 数据依赖） |

安装或升级完成后，请**完全退出并重新启动 DSH Desktop**，新建会话并选择 **「地理教师辅助」**，输入 `/geo-status` 即可确认运行状态。
