# geospark-ai-preset

**GeoSparkAI · 高中地理教师辅助 Agent** 核心预设组合包（DSH Bundle），运行于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Desktop（现行验证基线 `0.2.2-rc.5`）。

## 一键安装与升级（推荐）

无需克隆源码仓库，在已安装 DSH Desktop 的电脑上执行：

```sh
npx geospark-ai@latest install --yes
```

后续一键升级：

```sh
npx geospark-ai@latest update --yes
```

安装或升级后请**完全退出并重新启动 DSH Desktop**，新建会话选择 **「地理教师辅助」** 即可使用。

## 包内构成

- `cordis.patch.yml`：声明 `geo-teacher` 教学主预设与 `geo-solver-internal` 零工具隔离解题内部预设；
- `plugins/`：`core`、`taxonomy`、`bank`、`analysis`、`generator`、`question`、`solver-isolation` 七个插件；
- `skills/`：讲题、解题、课程方案（Apache-2.0 派生，保留目录内 `LICENSE` 与 `NOTICE`）、模拟题润色与出题四个教师技能；
- `data/config/`：随包内置高中地理三级考点库（4 份 YAML，162 个节点，零配置开箱即用）。

配套组件：
- 输入区原生 UI 插件：`geospark-ai-ui`
- 独立高考真题数据包：`geospark-ai-data`（非 bundle 数据依赖，可按需安装或替换为自有题库）

完整文档与配置说明见主包 [`geospark-ai`](https://www.npmjs.com/package/geospark-ai) 与 [GitHub 仓库](https://github.com/xiaoyuanwang220/geoteacher_preset)。
