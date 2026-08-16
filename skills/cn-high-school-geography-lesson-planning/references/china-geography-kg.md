# 中国高中地理知识图谱——调用顺序

供本技能步骤2在 `china-geography-kg` 工具可用时使用。工具不可用时跳过本文件，按 `SKILL.md` 的课标核验与回退规则继续设计。工具可用时，在课程草案或完整材料生成前完成查询；只提取下列指定内容，不向教师单独汇报内部检索结果。

## 定位课标

使用 `find_standard_statement` 查询普通高中地理课程标准。

- 教师提供课标编号或本地条目标识时，优先按 `code` 查询；没有结果时改用关键词。
- 教师只提供课题时，以主题词和行为要求组成 `keywords`，已知模块时同时传入 `module`。
- 从返回的 `standards` 中选择与模块、主题和认知要求最匹配的条目；有 `subStandards` 时选择本课实际承担的条目。
- 最多尝试3次。仍无可用结果时停止检索，按 `SKILL.md` 标注“课标原文待教师核对”，不得用课例反推或冒充课标原文。

从选定条目提取课标原文、`code`、模块、来源和 `caseIdentifierUUID`。`caseIdentifierUUID` 用于后续查询。

## 高中地理课程设计

可用工具：`find_standard_statement`、`find_standards_progression_from_standard`、`find_learning_components_from_standard`、`find_misconceptions_for_standard`、`find_curriculum_lessons`、`find_materials_for_lesson`。

先定位课标，再并行完成第2至第5项查询，最后读取课例材料。

1. **课标。** 按上文定位目标课标。教学设计只在规定位置完整呈现一次经核验的课标原文。

2. **前置与后续。** 调用 `find_standards_progression_from_standard(caseIdentifierUUID, direction="backward")`，提取与本课最相关的前置知识或地理方法；确有必要时再以 `direction="forward"` 查询后续连接。结果用于判断课程起点，不强制形成唯一学习顺序。

3. **学习组成要素。** 调用 `find_learning_components_from_standard(caseIdentifierUUID)`，提取最多5项与本课相关的概念、证据类型、地理行为或质量要求。将其转化为学习目标和观察点，不直接复制成固定目标模板。

4. **学习困难。** 调用 `find_misconceptions_for_standard(caseIdentifierUUID, subject="高中地理")`，选择最相关的3项。每项只保留学生表现、可能原因和教师动作，并结合当前课题重新表述；无结果时按学科知识合理预判，不伪造知识图谱来源。

5. **相关课例。** 调用 `find_curriculum_lessons(caseIdentifierUUID=<目标课标UUID>)`，优先选择模块、主题、教材版本状态和认知任务最匹配的一项课例。教师未确认教材版本时，不把版本专属内容当作默认要求。

6. **课例材料。** 使用返回的 `lessonIdentifier` 调用 `find_materials_for_lesson(lessonIdentifier, materialSource=["lesson", "activity"])`，按需提取：核心问题、主要任务关系、地理证据与表征、关键教师动作、学生困难、课堂检测及适用条件。舍弃完整活动叙述、学生原文和无法核验的来源信息。

7. **核心素养。** 根据课标与主要任务选择1至2项主要地理核心素养，不另行调用知识图谱工具。

知识图谱结果是设计依据和候选资源，不是必须照搬的教学序列。按照 `geography.md` 根据课题、学情和课时组织课程，始终创作原创任务与材料。

工具已连接却完全跳过本流程属于严重失败。某一辅助查询无结果时不要反复调用；使用已有可靠信息继续设计，并按实际核验状态表述。

完成查询后直接进入步骤3，不向教师展示工具名称、UUID、课例检索列表或内部结果摘要。
