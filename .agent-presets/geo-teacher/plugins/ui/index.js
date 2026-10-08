// 已退役：本插件（geo-ui，/geo-teacher 仪表盘）已被 plugins/panel（geo-panel 工作台）取代。
//
// 保留这个文件只为一件事：让 geo-verify 的 plugins/*/index.js 扫描在物理删除前后都通过。
// 它不注册任何路由，因此不会与新工作台争夺 /geo-teacher——同一路径被两个插件注册会让整个
// preset 挂载失败（重复路由）。
//
// 退役前原文：.backups/geo-ui-retired-20261003/index.js
// 完成物理删除（需本地 shell 执行一次，本会话无 shell 且无删除/移动类工具）：
//   Move-Item -Recurse -Force `
//     E:\geo_edu_agent\.agent-presets\geo-teacher\plugins\ui `
//     E:\geo_edu_agent\.backups\geo-ui-retired-20261003\plugin-dir

export default {
  name: 'geo-ui-retired',
  apply() {}
};
