# 会话轨迹审查：读取方法与字段

> 本文件是 `geo-dev-checklist` 的支撑材料。正文定「审什么」，这里定「怎么把轨迹读出来」。
> 触发场景：改了模型可见行为之后，跑一轮真实任务、把轨迹取回来审。

## 1. 两个来源，读法完全不同

| 来源 | 形态 | 能否直接读 |
| :-- | :-- | :-- |
| 主动导出（推荐） | `outputs/出题/session.v4.jsonl` 之类的**明文** JSONL | ✅ 逐行 `JSON.parse` |
| 桌面自带会话日志 | `<DSH_HOME>/sessions/<project>/<sessionId>/session.v4.jsonl.zstd` | ⚠️ **多帧 zstd 追加** |
| 会话投影缓存 | `<DSH_HOME>/storages/session_projcache/sessions/<sessionId>.json` | ✅ 明文 JSON，但**只有摘要/截断文本** |

### ⚠️ 多帧 zstd 的坑

DSH 的会话日志是**每追加一段就压一个 zstd 帧**，一个文件里有多个帧拼接。
Node 的 `zlib.zstdDecompressSync(buf)` **只解第一帧**就返回——对一个 2.5 MB 的日志，只会得到约 200 字符，看起来像「日志是空的」。

绕法二选一：

1. **按帧魔数切帧**再逐帧解压（`28 B5 2F FD`）。启发式，压缩数据内部理论上也可能出现该字节序列，所以每帧解压失败就跳过：
   ```js
   const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
   const starts = [];
   for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 4)) starts.push(i);
   let text = '';
   for (let k = 0; k < starts.length; k++) {
     const from = starts[k];
     const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
     try { text += zlib.zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); } catch { /* 跳过错帧 */ }
   }
   ```
   `createZstdDecompress()` 流式解压同样只到第一帧结束，别指望它跨帧。
2. **改读投影缓存**（`storages/session_projcache/sessions/<sessionId>.json`）。它是明文，够定位「哪一轮、用了哪些工具、模型怎么总结的」，但文本是**截断**的（末尾带 `…`），拿不到完整工具返回。

**结论**：要审完整工具返回，让会话把轨迹导出成明文 JSONL；只有缓存时，接受它只能回答「有没有调用」这类问题。

## 2. 事件类型与关键字段

明文 JSONL 每行一个事件，`{ type, seq, time, data }`。常用：

| `type` | 关键路径 | 说明 |
| :-- | :-- | :-- |
| `agent-preset/selected` | `data.agentPreset` | 确认这一轮跑在**预期预设**上（如 `geo-teacher`） |
| `user/message` | `data.content[].text` | 用户输入；`source.kind === 'runtime-context'` 的是系统注入，别当成用户话 |
| `assistant/message` | `data.message.content[]` | 元素 `type: "text"` 为正文，`type: "tool-call"` 为工具调用 |
| `tool/call` | `data.name`、`data.arguments` | **`arguments` 是 JSON 字符串**，要再 `JSON.parse` 一次 |
| `tool/result` | `data.message.content[].text` | 返回正文在这里；**不在** `data.result` / `data.output` |
| `turn/start` / `turn/end` | `data.turn` | 数「用户交互了几轮」 |
| `step/start` / `step/end` | `data.step` | 数「模型迭代了几步」 |

`tool/call` 与 `tool/result` 按**出现顺序一一配对**（也可用 `data.callId` / `data.message.toolCallId` 配对，更稳）。

错误判定：`tool/result` 里 `data.isError === true`，或 `data.error.code` 非空。常见码见 SKILL.md 维度 B。

## 3. 提取骨架

```js
import { readFileSync } from 'node:fs';
const events = readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const textOf = (m) => ((m && m.content) || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const calls   = events.filter((e) => e.type === 'tool/call').map((e) => e.data);
const results = events.filter((e) => e.type === 'tool/result').map((e) => e.data);

calls.forEach((c, i) => {
  const r = results[i] || {};
  const err = r.isError === true || (r.error && r.error.code) ? 'ERROR ' + ((r.error && r.error.code) || '') : 'ok';
  console.log(`[${i + 1}] ${c.name} ${c.arguments}  ->  ${err}`);
  if (err !== 'ok') console.log('    ' + textOf(r.message).slice(0, 300));
});
```

## 4. 一次真实读数（2026-10-21 M2，可作对照基准）

```
轨迹行数 294；4 turn；66 tool call / 66 tool result
预设 geo-teacher
geo_question_validate ×7，全部 ok（3 次 target=concepts、4 次 target=draft+render）
geoTaxonomy ×4、geo_style_profile、geo_search_questions、web_search/web_fetch ×5
错误 3 项：read FS_NOT_FOUND / edit FS_AMBIGUOUS_EDIT / present UNKNOWN_TOOL
```

审计结论（当时挖出的三个缺陷）见 `docs/决策记录.md` 2026-10-21 行。**这份读数是「一条正常的轨迹长什么样」的参照**：调用序列合理、校验器被反复调用、错误项都是模型侧小失误——评审者的注意力应该放在「产物结论与模型宣称是否一致」上，而不是只看有没有报错。
