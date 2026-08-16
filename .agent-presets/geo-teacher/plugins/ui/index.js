// GeoTeacher Agent — UI 仪表盘插件（geo-ui）
// 服务 /geo-teacher 页面（纯 HTML/JS 仪表盘，前端调用各功能插件 /geo/* API）。

export default {
  name: 'geo-ui',
  inject: ['fs', 'webServer'],
  apply(ctx) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;
    const PAGE_PATH = decodeURIComponent(new URL('./page.html', import.meta.url).pathname).replace(/^\/+/, '');

    webServer.register({
      kind: 'exact',
      path: '/geo-teacher',
      handler: (req, res) => {
        fsService.resolve(PAGE_PATH)
          .then(target => fsService.readText(target))
          .then(html => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html || '<h1>geo-teacher: page not found</h1>');
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('geo-teacher: failed to load page');
          });
      }
    });

    console.log('geo-ui: /geo-teacher 页面已注册');
  }
};
