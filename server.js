/* ============================================================
   server.js · 网页版的本地静态服务（开发/预览用）
   除了静态文件，还挂上了「茶室」的接口，所以 `npm run web` 之后
   这个地址本身就是一间可以用的局域网聊天室（同一 WiFi 的设备都能连）。
   直接双击 index.html（file://）时没有这个服务，前端会自动降级成
   同一浏览器多标签互聊，模块不会变死。
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createChat } = require('./chatd');

const root = __dirname; // serves blog-sample dir
const port = Number(process.env.MJ_PORT || 5210);
// 想让别的设备连进来就设 MJ_HOST=0.0.0.0；默认只绑本机
const host = process.env.MJ_HOST || '127.0.0.1';

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };

/* 房间码：命令行给了就用给定的，否则随机生成 6 位并打印出来 */
const chat = createChat({
  roomName: process.env.MJ_CHAT_ROOM || '元素茶室',
  code: process.env.MJ_CHAT_CODE || String(Math.floor(Math.random() * 900000) + 100000),
  historyFile: path.join(__dirname, '.chat-data', 'history.json'),
  // 头像/表情/动图都存这儿（内容寻址，可放心长缓存）
  blobDir: path.join(__dirname, '.chat-data', 'blobs'),
  lanOnly: true,
  // 只有绑到 0.0.0.0 时别人才连得上，这时候才对外报局域网地址
  lan: () => host === '0.0.0.0' || host === '::',
  port: () => { try { return server.address().port; } catch (e) { return port; } }
});

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // 茶室的接口先接手；不是它的请求才继续走静态文件
  if (chat.handle(req, res, urlObj)) return;

  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(root, rel);
  if (!file.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }
  /* 服务端自己的文件不对外发：它们只该被 Node require，
     浏览器要了也没用，白白把实现细节摊开。 */
  if (/^(electron[\\/]|chatd\.js$|server\.js$|package\.json$)/.test(rel)) {
    res.writeHead(404).end('not found'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type + (type.startsWith('text') ? '; charset=utf-8' : '') });
    res.end(buf);
  });
});
server.listen(port, host, () => {
  console.log('SERVING http://' + host + ':' + port + '/');
  console.log('茶室房间码 ' + chat.info().code + '（可用 MJ_CHAT_CODE 指定）');
});
// 存活 8 小时后自动收尾，避免留下僵尸进程；需要更久直接重启即可
setTimeout(() => { console.log('lifetime reached, shutting down'); chat.close(); server.close(); process.exit(0); }, 8 * 60 * 60 * 1000);
