# assets/ —— 插件自带静态资源

宿主半边（`../index.js`）只从本目录按文件名取图，经 `/geo-teacher-ui/assets/<name>` 提供，且只发栅格图（png/jpg/jpeg/webp/gif）。

当前客户端半边（`../client.js`）尚未引用任何图片：品牌位文案是文本替换，图标是内联 SVG。这里为「品牌位地球仪插图」保留入口——把图片放进本目录即可生效，无需改代码。

需要放入的文件（原始素材在仓库的开发目录，发布包不含它）：

| 文件名 | 来源 |
| :-- | :-- |
| `globe.png` | `outputs/geo-ui-prototype/public/assets/globe.png` |

放入命令（仓库根执行）：

```powershell
New-Item -ItemType Directory -Force packages\dsh-geo-teacher-ui\assets | Out-Null
Copy-Item outputs\geo-ui-prototype\public\assets\globe.png packages\dsh-geo-teacher-ui\assets\
```

未放入时该路由恒 404，客户端界面不受影响。
