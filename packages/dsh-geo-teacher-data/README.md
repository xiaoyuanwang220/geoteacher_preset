# @geo-edu/dsh-geo-teacher-data

GeoSparkAI（高中地理教师辅助 Agent）的**独立真题与配图数据包**。

## 包定位（遵循 DSH 非 Bundle 依赖规范）

根据 DeepSeek Harness（DSH）包规范，本包属于供业务插件读取的**普通数据依赖包**，而非供用户独立启停的配置层组合包（因此 `package.json` **不声明 `dsh.bundle`**，安装到 profile 时只写入 `dependencies`，不列入 `dsh.profile.bundles`）。

- 消费方：`@geo-edu/dsh-geo-teacher-preset`（在 `optionalDependencies` 中声明本包，由 `plugins/core` 自动解析题库目录；若用户未安装本包而改用自建题库，`dsh-app-boot` 会按可选依赖规则安全跳过）。
- 发布范围（`files` 白名单）：仅打包运行所需的 `obsidian_vault/04_题目/`（115 份题组 Markdown）与 `obsidian_vault/90_附件/`（120 张题图），保持相对图片路径 `../../../90_附件/...` 原样可用；仓库内的 Obsidian 导航与图谱笔记（`00/01/03`）保留在源码仓库中，不打入 npm 发布包以精简安装文件数。

## 导出入口

```js
import { questionBankDir, attachmentsDir, resolveDataPaths } from '@geo-edu/dsh-geo-teacher-data';
```

同时导出 `./package.json` 供宿主或插件通过 `createRequire(...).resolve('@geo-edu/dsh-geo-teacher-data/package.json')` 在不执行模块代码的前提下定位安装目录。
