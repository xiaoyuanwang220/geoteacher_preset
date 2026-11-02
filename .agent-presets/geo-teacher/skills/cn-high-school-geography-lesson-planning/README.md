# 中国普通高中地理课程设计 Skill（V3.2）

为高中地理教师生成课标对齐的课堂材料：教学设计、学生学习材料、课堂观察记录表，以及课程确实需要的地图或数据材料（HTML/DOCX）。

## 定位

本 Skill 面向**探究型课堂**——学生在教师支持下自己建立结论的课。素养导向下的课堂以学生自主建构为核心；灌输式讲授、题海讲练型需求不在服务范围内。

在此范围内，本 Skill 是**外围辅助**，不干预教学设计本身：

| 由模型自主完成（本 Skill 不作规定） | 由本 Skill 提供（模型原生不具备） |
|---|---|
| 情境选择、问题链编排、任务设计、教学判断 | 依据核验（课标/教材原文）、真实素材核实、材料源格式与渲染、交付前自查 |

依据来源固定为：**课标与教材原文自 ima 知识库取用；真实素材（数据、案例）经联网搜索核实来源、年份与口径**。两侧都核不到时按 `references/source-and-map-policy.md` 标注为教学模拟数据，不得伪造数值或冒用机构来源。

## 安装

使用 WorkBuddy 的 Skill 安装能力导入本目录，保持 `references/`、`scripts/` 与 `SKILL.md` 的相对位置不变。

## 文件构成

生成路径与纪律见 `SKILL.md`。`references/` 五件，按阶段读取：

| 文件 | 内容 | 读取时机 |
|---|---|---|
| `source-and-map-policy.md` | 来源优先级、联网核验、数据与案例规则、中国地图合规 | 阶段 2 涉及现实材料、地图或高考真题时 |
| `subject-notes.md` | 课标定位与解读、地理学科判断、认知深度判据、借角度看问题、灵感索引 | 阶段 1、3 按需 |
| `lesson-format.md` | `lesson.json` 结构、三件套写作要求、展开边界 | 阶段 5 展开时 |
| `delivery-checklist.md` | 渲染前的交付自查清单 | 阶段 6 |
| `example_lesson.json` | 渲染契约样例（内容为占位），只用于比对结构，不作教学内容参考 | 验证渲染链、核对块字段时 |

`scripts/` 提供材料源渲染：`render_documents.py` 及其依赖。

## 交付后的改进回路（可选）

教师对已交付课程不满意并提出具体调整要求时，可启用改进专家 `cn-geo-lesson-improve-designer`：它只改问题链与任务链，给出不超过两个改造候选，由教师选定后回到阶段 4 重新确认。**触发权在教师**，主流程不自行调用，也不得用它替代阶段 6 自查。专家包由 WorkBuddy 单独分发，不包含在本目录中。

## 文档渲染

HTML 渲染只需要 Python 3。生成 DOCX 还需要：

```text
python-docx>=1.1.2
```

（实测环境：Python 3.9 / 3.12 + python-docx 1.2.0。DOCX 输出为 A4 页面，中文行文用宋体、标题用黑体，西文用 Arial。）

示例命令：

```powershell
python scripts\render_documents.py lesson.json --format both --outdir output
```

如果 `python` 不是 WorkBuddy 环境中的命令，请使用该环境配置的 Python 3 解释器。DOCX 依赖不可用时可先输出 HTML；不得改回作者电脑的绝对解释器路径。

## 许可

本项目按 Apache License 2.0 发布，详见 `LICENSE` 与 `NOTICE`。
