/* ============================================================
   electron/main.js · 桌面版主进程
   职责（即"后台处理"）：
     1. 在 127.0.0.1 的随机空闲端口起一个本地静态服务，给渲染进程一个正规 origin
        （file:// 下 Chromium 会禁用 IndexedDB，音乐导入等能力会失效）
     2. 把前端数据落盘到用户数据目录（不依赖浏览器存储）
     3. 提供原生文件对话框与导出能力
   ============================================================ */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { createChat, lanAddresses } = require('../chatd');

const ROOT = path.join(__dirname, '..');            // 站点根目录
const DATA_DIR = () => path.join(app.getPath('userData'), 'data');

/* 备注：曾经想当然地以为"桌面版慢 = 没走硬件加速"，加过
   ignore-gpu-blocklist / enable-gpu-rasterization。后来用
   app.getGPUFeatureStatus() 在**晚一点**（GPU 进程回报之后）读了一遍，
   发现默认就是 gpu_compositing=enabled / rasterization=enabled，
   所以那几个开关已撤掉 —— 没必要为了同一个结果去绕黑名单。
   真正的问题见下面 getGPUFeatureStatus 的说明：刚启动那几秒还在软件渲染。 */

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};
const TEXT = new Set(['.html', '.css', '.js', '.json', '.svg']);

let server = null;
let baseUrl = '';
/* 茶室的设置：内网开关和房间码都要跨启动记住 ——
   房间码每次都换的话，昨天发给朋友的码今天就失效了。 */
let chatCfg = { lan: false, code: '' };

/* ---------- 茶室 ---------- */
const chat = createChat({
  roomName: '元素茶室',
  code: '',                                   // 启动后由 chatCfg 灌进去
  historyFile: path.join(DATA_DIR(), 'chat-history.json'),
  blobDir: path.join(DATA_DIR(), 'chat-blobs'),
  lanOnly: true,
  lan: () => chatCfg.lan,
  port: () => { try { return server.address().port; } catch (e) { return 0; } }
});
function newCode() { return String(Math.floor(Math.random() * 900000) + 100000); }

function listenHost() { return chatCfg.lan ? '0.0.0.0' : '127.0.0.1'; }

/* ---------- 本地静态服务（顺带把茶室接口挂上去） ---------- */
function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
        /* 茶室接口先接手。挂在同一个 server 上是有意为之：
           同端口=同源，前端不用配 CORS，也不用多开一个端口的防火墙规则。 */
        if (chat.handle(req, res, urlObj)) return;

        const urlPath = decodeURIComponent(String(req.url).split('?')[0]);
        const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
        const file = path.resolve(ROOT, rel);
        if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
        /* 服务端自己的文件不对外发（桌面版开了局域网之后更要注意：
           同网段的人能访问这个服务，没必要把主进程代码也一起递出去）。 */
        if (/^(electron[\\/]|chatd\.js$|server\.js$|package\.json$)/.test(rel)) {
          res.writeHead(404).end('not found'); return;
        }
        const buf = await fsp.readFile(file);
        const ext = path.extname(file).toLowerCase();
        const type = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'content-type': type + (TEXT.has(ext) ? '; charset=utf-8' : ''),
          'cache-control': 'no-store'
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(404).end('not found');
      }
    });
    server.on('error', reject);
    // 端口 0 = 让系统分配空闲端口，避免和用户的其它服务冲突
    server.listen(0, listenHost(), () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}/`;
      console.log('[茶室] 服务 ' + baseUrl + '  监听=' + listenHost() + '  房间码=' + (chatCfg.code || '(无)'));
      resolve(baseUrl);
    });
  });
}

/* 切换内网开关要换监听地址，而监听地址不能在运行时改 ——
   只能关掉重开。重开后端口会变，所以窗口要重新载入一次。
   ★ 茶室用的是 SSE 长连接：不主动把这些连接掐掉，server.close() 会一直等
   它们自己结束，等于永远关不掉，界面就卡死在这里。 */
async function restartServer() {
  if (!server) return baseUrl;
  const old = server;
  server = null;
  await new Promise(r => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    try {
      old.close(fin);
      if (typeof old.closeAllConnections === 'function') old.closeAllConnections();
    } catch (e) { fin(); }
    setTimeout(fin, 1500);       // 兜底：无论如何 1.5 秒后继续
  });
  await startServer();
  if (win) win.loadURL(baseUrl);
  return baseUrl;
}

/* ---------- 数据落盘 ---------- */
async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR(), { recursive: true });
  return DATA_DIR();
}
async function readData(key) {
  try {
    const f = path.join(await ensureDataDir(), key + '.json');
    return JSON.parse(await fsp.readFile(f, 'utf8'));
  } catch (e) { return null; }
}
async function writeData(key, value) {
  const dir = await ensureDataDir();
  const f = path.join(dir, key + '.json');
  await fsp.writeFile(f, JSON.stringify(value, null, 1), 'utf8');
  return true;
}

/* ---------- IPC ---------- */
function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    url: baseUrl
  }));

  ipcMain.handle('data:get', (_e, key) => readData(String(key)));
  ipcMain.handle('data:set', (_e, key, value) => writeData(String(key), value));

  // 导出：把前端数据写成 JSON 文件
  ipcMain.handle('data:export', async (_e, payload) => {
    const r = await dialog.showSaveDialog({
      title: '导出数据',
      defaultPath: `元素手帐-备份-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false };
    await fsp.writeFile(r.filePath, JSON.stringify(payload, null, 1), 'utf8');
    return { ok: true, path: r.filePath };
  });

  // 导入：读回 JSON 备份
  ipcMain.handle('data:import', async () => {
    const r = await dialog.showOpenDialog({
      title: '导入数据', properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try {
      const txt = await fsp.readFile(r.filePaths[0], 'utf8');
      return { ok: true, data: JSON.parse(txt) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 原生多选文件（音乐 / ICS / 图片）
  ipcMain.handle('dialog:open', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog({
      title: opts.title || '选择文件',
      properties: opts.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: opts.filters || [{ name: '全部文件', extensions: ['*'] }]
    });
    if (r.canceled) return { ok: false, files: [] };
    const files = [];
    for (const p of r.filePaths) {
      try {
        if (opts.asPath) files.push({ path: p, name: path.basename(p) });
        else {
          const buf = await fsp.readFile(p);
          files.push({ path: p, name: path.basename(p), data: buf.toString('base64'), size: buf.length });
        }
      } catch (e) { /* 跳过不可读文件 */ }
    }
    return { ok: true, files };
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(String(p)));
  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(String(p)); return true; });

  /* ---------- 茶室 ---------- */
  const chatState = () => {
    const info = chat.info();
    return {
      lan: chatCfg.lan,
      room: info.room,
      code: info.needCode ? chatCfg.code : '',
      port: (() => { try { return server.address().port; } catch (e) { return 0; } })(),
      // 只在开了内网时才报地址，否则前端会给出连不上的邀请地址
      addresses: chatCfg.lan ? lanAddresses() : [],
      members: info.members,
      url: baseUrl
    };
  };
  ipcMain.handle('chat:info', () => chatState());
  ipcMain.handle('chat:setLan', async (_e, on) => {
    chatCfg.lan = !!on;
    await writeData('chat', chatCfg).catch(() => {});
    await restartServer();
    return chatState();
  });
  ipcMain.handle('chat:setCode', async (_e, code) => {
    const c = String(code || '').replace(/\D/g, '').slice(0, 6);
    chatCfg.code = c || newCode();
    chat.setCode(chatCfg.code);
    await writeData('chat', chatCfg).catch(() => {});
    return chatState();
  });
  /* 外链一律交给系统浏览器：顶栏的百度检索、友链站点都走这里。
     只放行 http/https，避免 file:// 之类的本地路径被塞进来。 */
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    const u = String(url || '');
    if (!/^https?:\/\//i.test(u)) return { ok: false, error: '只允许 http/https' };
    await shell.openExternal(u);
    return { ok: true };
  });
}

/* ---------- 窗口 ---------- */
let win = null;
async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 960, minHeight: 640,
    backgroundColor: '#f6f3fb',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'assets', 'app-icon.png'),
    title: '元素手帐',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.once('ready-to-show', () => win.show());
  /* 只在显式设了环境变量时把自己钉在最上层。
     用途：从终端跑性能测量脚本时，终端会抢走焦点，Chromium 一旦判定窗口
     被遮挡就会把 rAF 限流甚至完全停掉，测出来的数字没意义。
     正常使用不会走这条分支。 */
  if (process.env.MJ_DEBUG_TOPMOST) {
    win.setAlwaysOnTop(true, 'screen-saver');
    console.log('[调试] 窗口已置顶（MJ_DEBUG_TOPMOST）');
  }
  await startServer();
  win.loadURL(baseUrl);
  win.on('closed', () => { win = null; });
}

/* ---------- 菜单 ---------- */
function buildMenu() {
  const tpl = [
    {
      label: '文件',
      submenu: [
        { label: '重新载入', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(DATA_DIR()) },
        { label: '导出数据…', click: () => win && win.webContents.send('menu:export') },
        { label: '导入数据…', click: () => win && win.webContents.send('menu:import') },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => win && win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => win && win.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', click: () => win && win.setFullScreen(!win.isFullScreen()) },
        { label: '开发者工具', accelerator: 'F12', click: () => win && win.webContents.toggleDevTools() }
      ]
    },
    {
      label: '茶室',
      submenu: [
        {
          label: '允许局域网访问（同 WiFi 的人可以进）', type: 'checkbox', checked: chatCfg.lan,
          click: async (mi) => {
            chatCfg.lan = mi.checked;
            await writeData('chat', chatCfg).catch(() => {});
            await restartServer();          // 换监听地址必须重开服务，窗口会重新载入
            buildMenu();                    // 重建菜单，让勾选状态和实际一致
          }
        },
        {
          label: '显示房间码…', click: () => {
            const addrs = chatCfg.lan ? lanAddresses() : [];
            let port = 0; try { port = server.address().port; } catch (e) {}
            dialog.showMessageBox(win, {
              type: 'info', title: '茶室',
              message: '房间码：' + chatCfg.code,
              detail: (chatCfg.lan && addrs.length
                ? '把下面的地址发给同一个 WiFi 的人（或在茶室页点「房间码 / 邀请」扫码）：\n' +
                  addrs.map(a => '  ' + (a.name || '') + '  http://' + a.address + ':' + port + '/#/chat').join('\n')
                : '当前只允许本机访问。要邀请别人，先勾上「允许局域网访问」。') +
                '\n\n对方进房需要填这 6 位房间码。'
            });
          }
        },
        { type: 'separator' },
        {
          label: '换一个房间码', click: async () => {
            chatCfg.code = newCode();
            chat.setCode(chatCfg.code);
            await writeData('chat', chatCfg).catch(() => {});
            dialog.showMessageBox(win, { type: 'info', title: '茶室', message: '新房间码：' + chatCfg.code, detail: '之前拿到旧码的人需要重新要一次。' });
          }
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于', click: () => dialog.showMessageBox(win, {
          type: 'info', title: '关于',
          message: '元素手帐 · 桌面版',
          detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron} · Chromium ${process.versions.chrome}\n\n本地服务：${baseUrl}\n数据目录：${DATA_DIR()}`
        }) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

/* ---------- 生命周期 ---------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    /* 诊断用：MJ_DEBUG_GPU=1 时把 GPU 特性状态打出来。
       用来判断"桌面版比浏览器慢"到底是硬件加速没生效（走了软件光栅化），
       还是页面本身太重 —— 这两个的解法完全不同。 */
    if (process.env.MJ_DEBUG_GPU) {
      const dump = tag => {
        try {
          const s = app.getGPUFeatureStatus();
          console.log('[gpu ' + tag + '] gpu_compositing=' + s.gpu_compositing +
            ' rasterization=' + s.rasterization + ' 2d_canvas=' + s['2d_canvas'] +
            ' webgl=' + s.webgl + ' webgl2=' + s.webgl2);
        } catch (e) { console.log('[gpu ' + tag + '] 读取失败:', e.message); }
      };
      // whenReady 那一刻读到的常常还是初始值（GPU 进程还没回报），所以读两次
      dump('刚就绪');
      setTimeout(() => dump('6 秒后'), 6000);
      setTimeout(async () => {
        try {
          const info = await app.getGPUInfo('complete').catch(() => null);
          const aux = (info && info.auxAttributes) || {};
          console.log('[gpu 详情] isSoftwareRendering=' + aux.isSoftwareRendering +
            ' glRenderer=' + aux.glRenderer + ' glVendor=' + aux.glVendor);
          if (info && info.gpuDevice) console.log('[gpu 设备]', JSON.stringify(info.gpuDevice.slice(0, 2)));
        } catch (e) { console.log('[gpu 详情] 失败:', e.message); }
        if (process.env.MJ_DEBUG_GPU_EXIT) app.quit();
      }, 7000);
    }
    /* 先把上次的茶室设置读回来：内网开关决定监听地址，必须在起服务之前就知道；
       房间码也要沿用，不然昨天发给朋友的码今天就失效了。 */
    const saved = await readData('chat').catch(() => null);
    if (saved) { chatCfg.lan = !!saved.lan; chatCfg.code = String(saved.code || ''); }
    if (!chatCfg.code) chatCfg.code = newCode();
    chat.setCode(chatCfg.code);
    // 立刻落盘：不写的话下次启动又会生成一个新码，发出去的邀请码就失效了
    await writeData('chat', chatCfg).catch(() => {});

    registerIpc();
    await createWindow();
    buildMenu();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { if (chat) chat.close(); if (server) server.close(); });
}
