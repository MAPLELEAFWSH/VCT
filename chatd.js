/* ============================================================
   chatd.js · 「茶室」局域网聊天室的服务端
   ------------------------------------------------------------
   为什么需要它：浏览器不能对外开端口，所以"局域网聊天"必须有一个
   大家都能访问到的中转。桌面版把它挂在主进程的静态服务上（同一端口、
   同一 origin，不需要配 CORS），网页版挂在 server.js 上。

   传输用 SSE（EventSource）而不是 WebSocket，理由：
     · Node 的 http 原生就能做，**不需要任何第三方依赖**（不用装 ws）
     · EventSource 自带断线指数退避重连，省掉一整层重连状态机
     · 消息很小，单向推送完全够用；发消息走普通 POST
   代价是每连接占用一个长连接，房间上限因此设得比较保守。

   安全边界（重要，这些是为"把监听放开到内网"付出的代价）：
     · 不返回任何 CORS 头 → 只有同源的页面能读写，别的网站拿不到数据
     · 只读静态文件服务不变；/api/chat/* 是唯一的写入口
     · 房间码用定长比较，避免时序侧信道
     · 单人限速 + 消息长度上限 + 房间人数上限
     · lanOnly 时只接受私有网段来源，公网来源一律拒绝
   ============================================================ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* 本机的局域网地址：邀请别人时要把这个地址给对方，所以由服务端自己报出来。
   浏览器端拿不到（它只知道自己是 127.0.0.1，别人连不上），只能问服务端。
   一起把网卡名带出去 —— 机器上常有 VMware / Hyper-V / WSL 的虚拟网卡，
   地址看着都像内网地址，只有名字能让用户认出该报哪个。 */
function lanAddresses() {
  const VIRTUAL = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|tap|tun|bluetooth|virtual|radmin|zerotier|tailscale/i;
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name) ? 1 : 0 });
    }
  }
  // 真实网卡排前面；同档次下 192.168 这种家用网段再靠前一点
  out.sort((x, y) => (x.virtual - y.virtual) || (/^192\.168\./.test(y.address) ? 1 : 0) - (/^192\.168\./.test(x.address) ? 1 : 0));
  return out.map(a => ({ name: a.name, address: a.address, virtual: !!a.virtual }));
}

const ELEMS = { anemo: 175, geo: 75, electro: 305, dendro: 125, hydro: 230, pyro: 40, cryo: 200 };
const ELEM_IDS = Object.keys(ELEMS);

const MAX_TEXT = 500;          // 单条消息长度上限
const MAX_NICK = 12;           // 昵称长度上限
const MAX_MEMBERS = 32;        // 同时在线上限
const MAX_HISTORY = 200;       // 内存与落盘保留的条数
const LIVE_TIMEOUT = 50000;    // 多久没动静算掉线
const HEARTBEAT = 20000;       // SSE 心跳间隔（防止中间设备掐掉空闲连接）
const RATE_WINDOW = 6000;      // 限速窗口
const RATE_MAX = 6;            // 窗口内最多几条
const TYPING_THROTTLE = 1200;  // "正在输入"最快多久发一次
const MAX_AVATAR = 256 * 1024;         // 头像上限（客户端已缩到 128px，这里只是兜底）
const MAX_STICKER = 2 * 1024 * 1024;   // 单张表情/动图上限：动图不能重编码，所以给宽一点
const MAX_STICKERS = 200;              // 茶室里最多存多少张表情
const MAX_BLOB_TOTAL = 60 * 1024 * 1024;  // blob 目录软上限
const MAX_PENDING = 1536 * 1024;       // 单个慢客户端的待发缓冲上限（背压）
const MAX_SEQ_GAP = 500;               // 允许客户端补拉的最大条数

/* 只认图片魔数，不认上传者声明的 content-type —— 后者可以随便写。
   动图（GIF/WebP）必须原样存：过一遍 canvas 会把动画压成一张静图。 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return { ext: 'gif', mime: 'image/gif' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/* 私有网段判断：只允许局域网/本机来源。
   支持 IPv4 私有段、回环，以及 IPv6 回环与链路本地/唯一本地地址。 */
function isPrivateAddress(addr) {
  if (!addr) return false;
  let a = String(addr);
  // ::ffff:192.168.1.5 这种 IPv4-mapped 写法先剥掉前缀
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) a = m[1];
  if (a === '::1' || a === 'localhost') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;  // fc00::/7 / fe80::/10
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!v4) return false;
  const [o1, o2] = [Number(v4[1]), Number(v4[2])];
  if (o1 === 127 || o1 === 10) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 169 && o2 === 254) return true;   // 链路本地
  return false;
}

/* 昵称清洗：去掉控制字符和换行，压掉多余空白，限长。
   注意前端一律用 textContent 渲染，所以这里不做 HTML 转义 —— 转义反而会让
   用户看到 &amp; 这种字面量。 */
function cleanNick(v) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NICK);
  return s || ('访客' + String(Math.floor(Math.random() * 9000) + 1000));
}
function cleanText(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')   // 保留 \n \t
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_TEXT);
}

/* 定长比较：长度不同也走完整轮，不提前 return */
function safeEqual(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function readBody(req, limit = 64 * 1024) {
  return new Promise(resolve => {
    let size = 0, dead = false;
    const chunks = [];
    req.on('data', c => {
      if (dead) return;
      size += c.length;
      if (size > limit) { dead = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { resolve(null); }
    });
    req.on('error', () => { dead = true; resolve(null); });
  });
}

function createChat(opts = {}) {
  const roomName = String(opts.roomName || '元素茶室').slice(0, 24);
  let code = opts.code ? String(opts.code) : '';
  /* ★ 必须是函数而不是布尔量。房间码是启动之后才由调用方灌进来的
     （桌面版要先从磁盘读回上次的码），如果在构造时就取一次快照，
     needCode 会永远是 false —— 结果就是"填什么码都能进"，等于没门槛。 */
  const needCode = () => !!code;
  const lanOnly = opts.lanOnly !== false;      // 默认只服务局域网
  const historyFile = opts.historyFile || '';

  /** token -> member */
  const members = new Map();
  /** 消息环形缓冲 */
  let history = [];
  /** 单调递增序号：客户端据此严格排序、发现缺口后补拉 */
  let seq = 0;
  const blobDir = opts.blobDir || '';
  const stickerIndexFile = blobDir ? path.join(blobDir, 'stickers.json') : '';

  /* ---------- blob 存储（头像 / 表情 / 动图） ----------
     内容寻址：文件名就是内容的 sha1。同一张图重复上传只会占一份空间，
     而且并发上传同一张图也不会互相覆盖 —— 名字由内容决定，天然幂等。
     先写临时文件再 rename，避免读到写了一半的文件。 */
  function blobId(buf) { return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 24); }
  function blobFile(id, ext) { return path.join(blobDir, id + '.' + ext); }
  function ensureBlobDir() { if (blobDir) fs.mkdirSync(blobDir, { recursive: true }); }
  function saveBlob(buf, ext) {
    ensureBlobDir();
    const id = blobId(buf);
    const file = blobFile(id, ext);
    if (!fs.existsSync(file)) {
      const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    return id;
  }
  /* 找已存在的 blob：扩展名不确定，挨个试 */
  function findBlob(id) {
    if (!blobDir || !/^[a-f0-9]{24}$/.test(id)) return null;
    for (const ext of ['png', 'gif', 'jpg', 'webp', 'svg']) {
      const f = blobFile(id, ext);
      if (fs.existsSync(f)) return { file: f, ext };
    }
    return null;
  }
  function blobTotal() {
    if (!blobDir) return 0;
    try {
      return fs.readdirSync(blobDir).reduce((s, f) => s + (fs.statSync(path.join(blobDir, f)).size || 0), 0);
    } catch (e) { return 0; }
  }

  /* ---------- 表情库 ---------- */
  let stickers = [];
  function loadStickers() {
    if (!stickerIndexFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(stickerIndexFile, 'utf8'));
      if (Array.isArray(raw)) stickers = raw.slice(-MAX_STICKERS);
    } catch (e) { /* 首次运行没有索引，正常 */ }
  }
  let stickerSaveTimer = null;
  function saveStickers() {
    if (!stickerIndexFile || stickerSaveTimer) return;
    stickerSaveTimer = setTimeout(() => {
      stickerSaveTimer = null;
      try {
        ensureBlobDir();
        const tmp = stickerIndexFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(stickers.slice(-MAX_STICKERS)), 'utf8');
        fs.renameSync(tmp, stickerIndexFile);
      } catch (e) { /* 存不下也不影响聊天 */ }
    }, 600);
  }
  loadStickers();

  /* ---------- 历史落盘 ---------- */
  let saveTimer = null;
  function loadHistory() {
    if (!historyFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      if (Array.isArray(raw)) history = raw.slice(-MAX_HISTORY);
    } catch (e) { /* 首次运行没有文件，正常 */ }
    /* ★ 序号必须在重启后接着排，不能从 0 重新开始。
       历史是从磁盘读回来的，里面还带着上一轮分配的 seq；如果这里清零，
       新消息的 seq 会和旧消息撞号，"按 seq 排序 / 发现缺口补拉"就全乱了。
       另外：早期版本写下的记录可能没有 seq、或者因为重启撞过号，
       这里统一按存储顺序重排成 1..N（顺序本身就是真实先后），
       一次修好，之后每次启动都是自愈的。 */
    let maxSeq = 0, monotonic = true, prev = 0;
    for (const m of history) {
      const s = Number(m.seq) || 0;
      if (s <= prev) monotonic = false;
      prev = s;
      if (s > maxSeq) maxSeq = s;
    }
    if (!monotonic) {
      history.forEach((m, i) => { m.seq = i + 1; });
      maxSeq = history.length;
      scheduleSave();
    }
    seq = maxSeq;
  }
  function scheduleSave() {
    if (!historyFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(historyFile), { recursive: true });
        // 先写临时文件再改名：避免掉电/崩溃留下半个 JSON
        const tmp = historyFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(history.slice(-MAX_HISTORY)), 'utf8');
        fs.renameSync(tmp, historyFile);
      } catch (e) { /* 落盘失败不影响聊天本身 */ }
    }, 800);
  }
  loadHistory();

  /* ---------- 事件推送 ---------- */
  /* 背压：SSE 是单向长连接，如果某个客户端读得很慢（比如手机切到后台），
     res.write 会一直往内存里堆。堆过阈值就直接把这个成员踢掉，
     让他重连补历史 —— 总比整个进程的内存被一个慢客户端拖垮要好。 */
  function send(m, type, data) {
    const res = m && m.res;
    if (!res) return false;
    let payload;
    try { payload = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n'; }
    catch (e) { return false; }
    if (m.pending > MAX_PENDING) {
      if (process.env.MJ_CHAT_DEBUG) console.log('[chatd] 背压踢出', m.nick, m.pending);
      dropMember(m, true, ' 掉线了');
      return false;
    }
    try {
      m.pending += payload.length;
      const ok = res.write(payload, () => { m.pending -= payload.length; if (m.pending < 0) m.pending = 0; });
      if (!ok) { /* 内核缓冲满了，drain 之后回调会把 pending 减回去 */ }
      return true;
    } catch (e) {
      dropMember(m, false);   // 写失败说明对端已经没了
      return false;
    }
  }
  function broadcast(type, data, exceptToken) {
    // 先快照再遍历：send 里失败可能会 dropMember 改动 members
    for (const m of [...members.values()]) {
      if (m.token === exceptToken) continue;
      send(m, type, data);
    }
  }
  function memberList() {
    return [...members.values()]
      .sort((a, b) => a.joined - b.joined)
      .map(m => ({
        token: m.token, nick: m.nick, elem: m.elem, hue: ELEMS[m.elem] || 230,
        typing: m.typingUntil > Date.now(),
        avatar: m.avatar || ''      // blob id，空表示用元素色圆点
      }));
  }
  function pushMembers() { broadcast('members', { members: memberList() }); }

  /* 统一的"追加一条消息"入口：发号、入历史、落盘、广播。
     序号由服务端单线程分配，所以在并发下天然是全序的。 */
  function appendMsg(msg) {
    seq += 1;
    msg.seq = seq;
    history.push(msg);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    scheduleSave();
    return msg;
  }
  function systemMsg(text) {
    const msg = appendMsg({ id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), kind: 'sys', text });
    broadcast('msg', msg);
    return msg;
  }

  function dropMember(m, announce, reason) {
    if (!members.has(m.token)) return;
    members.delete(m.token);
    if (process.env.MJ_CHAT_DEBUG) console.log('[chatd] drop', m.nick, m.token, reason || '', 'members=' + members.size);
    try { if (m.res.writableEnded === false) m.res.end(); } catch (e) { /* 已断开 */ }
    if (announce) systemMsg(m.nick + (reason || ' 离开了茶室'));
    pushMembers();
  }

  /* 掉线回收：SSE 断流时 req 会 close，但某些网络下不一定触发，
     所以再加一道基于 lastSeen 的兜底。 */
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const m of [...members.values()]) {
      if (now - m.lastSeen > LIVE_TIMEOUT) dropMember(m, true, ' 掉线了');
    }
  }, 10000);
  if (reaper.unref) reaper.unref();

  /* ---------- 各接口 ---------- */
  function json(res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': buf.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(buf);
  }

  async function join(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: 'bad-body' });

    if (needCode() && !safeEqual(String(body.code || '').trim(), code)) {
      // 故意不区分"码错了"和"没填"，减少枚举信息
      return json(res, 403, { ok: false, error: 'bad-code' });
    }
    if (members.size >= MAX_MEMBERS) return json(res, 503, { ok: false, error: 'full' });

    const elem = ELEM_IDS.includes(body.elem) ? body.elem : ELEM_IDS[members.size % ELEM_IDS.length];
    const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    // 头像必须是本服务端真的存过的 blob，不能凭客户端说
    const avatar = (body.avatar && findBlob(String(body.avatar))) ? String(body.avatar) : '';
    const m = {
      token,
      nick: cleanNick(body.nick),
      elem,
      avatar,
      joined: Date.now(),
      lastSeen: Date.now(),
      typingUntil: 0,
      res: null,
      pending: 0,
      hits: []
    };
    members.set(token, m);
    if (process.env.MJ_CHAT_DEBUG) console.log('[chatd] join', m.nick, token, 'members=' + members.size);
    return json(res, 200, { ok: true, token, room: roomName, members: memberList(), history: history.slice(-60), seq });
  }

  /* SSE：连接建立时把"我是谁 + 当前名单 + 最近历史"一次性推下去，
     客户端因此不需要额外拉一次接口，也就没有"先渲染空列表再补"的闪烁。
     ★ 同一个 token 重复连进来（断线重连、或者客户端手抖）不会再造一个新成员：
     把旧连接结束掉、把新连接挂上去，人数和名单因此不会出现幽灵成员。 */
  function stream(req, res, q) {
    const token = String(q.get('token') || '');
    const m = members.get(token);
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });

    /* 顶掉同一个 token 的上一条连接。
       ★ 被顶掉的那条连接，它的 'close' 回调是**异步**才跑到的；
       如果把"是否被顶替"记在成员对象上、又在这里马上改回去，
       等旧连接的 close 跑起来时标记已经复位，它就会把新连接也一起
       当成掉线删掉（表现是：重连之后人数反而少一个）。
       所以标记记在各自的 res 上，谁被顶替谁自己知道。 */
    if (m.res && m.res !== res && !m.res.writableEnded) {
      const old = m.res;
      old.__superseded = true;
      try { old.end(); } catch (e) { /* 已经没了 */ }
    }
    m.pending = 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'      // 让 nginx 之类的反代不要缓冲
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    m.res = res;
    m.lastSeen = Date.now();
    if (process.env.MJ_CHAT_DEBUG) console.log('[chatd] stream', m.nick, token);

    send(m, 'hello', {
      you: { token, nick: m.nick, elem: m.elem, hue: ELEMS[m.elem] || 230, avatar: m.avatar },
      room: roomName, members: memberList(), history: history.slice(-60), seq, stickers
    });
    /* 只有"第一次进来"才播报走进来。重连时不播报，否则网络一抖
       整间屋子就会刷一串"某某走进了茶室"。 */
    if (!m.announced) { m.announced = true; systemMsg(m.nick + ' 走进了茶室'); }
    pushMembers();

    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch (e) { /* 下面 close 会清理 */ }
    }, HEARTBEAT);

    const cleanup = (announce) => {
      clearInterval(hb);
      // 被顶替的旧连接不该把顶替它的新连接也带走（标记记在自己的 res 上）
      if (res.__superseded) return;
      if (members.get(token) === m) dropMember(m, announce, ' 离开了茶室');
    };
    req.on('close', () => cleanup(true));
    req.on('error', () => cleanup(true));
    res.on('error', () => cleanup(true));
    return true;
  }

  async function sendMsg(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: 'bad-body' });
    const m = members.get(String(body.token || ''));
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });

    const now = Date.now();
    m.hits = m.hits.filter(t => now - t < RATE_WINDOW);
    if (m.hits.length >= RATE_MAX) return json(res, 429, { ok: false, error: 'too-fast', retryIn: RATE_WINDOW - (now - m.hits[0]) });

    /* 三种消息：文本 / 表情（含动图）/ 图片。
       后两种携带 blob 引用；只接受本服务端真的存过的东西，
       否则别人就要去加载一个不存在的地址，消息看着是坏的。 */
    const kindIn = String(body.kind || 'msg');
    const text = cleanText(body.text);
    let kind = 'msg', blob = '', w = 0, h = 0;
    if (kindIn === 'sticker' || kindIn === 'image') {
      const ref = String(body.blob || '');
      if (ref.startsWith('builtin:')) {
        // 内置表情是客户端自带的 SVG，不需要服务端存，但要校验格式
        if (!/^builtin:[a-z0-9_-]{1,24}$/i.test(ref)) return json(res, 400, { ok: false, error: 'bad-blob' });
        kind = 'sticker'; blob = ref;
      } else {
        if (!findBlob(ref)) return json(res, 400, { ok: false, error: 'no-blob' });
        kind = kindIn === 'image' ? 'image' : 'sticker';
        blob = ref;
      }
      w = Math.max(0, Math.min(4096, Number(body.w) || 0));
      h = Math.max(0, Math.min(4096, Number(body.h) || 0));
      if (!blob) return json(res, 400, { ok: false, error: 'empty' });
    } else if (!text) {
      return json(res, 400, { ok: false, error: 'empty' });
    }

    m.hits.push(now);
    m.lastSeen = now;
    m.typingUntil = 0;

    // 昵称/元素/头像允许随消息一起更新，这样改完立刻生效、不用重新 join
    if (body.nick !== undefined) m.nick = cleanNick(body.nick);
    if (ELEM_IDS.includes(body.elem)) m.elem = body.elem;
    if (body.avatar !== undefined) {
      const a = String(body.avatar || '');
      m.avatar = (a && findBlob(a)) ? a : '';
    }

    const msg = {
      id: 'm' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      t: now, kind, token: m.token, nick: m.nick, elem: m.elem, hue: ELEMS[m.elem] || 230, text
    };
    if (blob) { msg.blob = blob; msg.w = w; msg.h = h; }
    appendMsg(msg);
    /* 不回显给发送者本人：客户端发出去的瞬间就先本地渲染（LAN 上往返只有
       一两毫秒，但本地渲染让输入框清空和气泡出现是同一帧，手感更好），
       这里再回一份就会变成两条。同机多标签那条降级通道本来就不会把消息
       投递给发送者，两边行为因此是一致的。 */
    broadcast('msg', msg, m.token);
    pushMembers();
    return json(res, 200, { ok: true, id: msg.id, seq: msg.seq, t: msg.t });
  }

  async function typing(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: 'bad-body' });
    const m = members.get(String(body.token || ''));
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });
    const now = Date.now();
    m.lastSeen = now;
    /* 昵称/元素/头像搭这趟顺风车。
       客户端改完资料就调一次 typing，服务端在这里更新并推一份新名单，
       这样"换了头像别人立刻能看到"就不需要额外的接口，也不用发一条消息。 */
    let changed = false;
    if (body.nick !== undefined) { const v = cleanNick(body.nick); if (v !== m.nick) { m.nick = v; changed = true; } }
    if (ELEM_IDS.includes(body.elem) && body.elem !== m.elem) { m.elem = body.elem; changed = true; }
    if (body.avatar !== undefined) {
      const a = String(body.avatar || '');
      const ok = (a && findBlob(a)) ? a : '';
      if (ok !== m.avatar) { m.avatar = ok; changed = true; }
    }
    if (changed) pushMembers();
    if (now < (m.typingSentAt || 0) + TYPING_THROTTLE) return json(res, 200, { ok: true, throttled: true });
    m.typingSentAt = now;
    m.typingUntil = now + 3200;
    broadcast('typing', { token: m.token, nick: m.nick, until: m.typingUntil }, m.token);
    return json(res, 200, { ok: true });
  }

  async function leave(req, res) {
    const body = await readBody(req);
    if (body) {
      const m = members.get(String(body.token || ''));
      if (m) dropMember(m, true, ' 离开了茶室');
    }
    return json(res, 200, { ok: true });
  }

  /* ---------- blob 上传 / 读取 ---------- */
  /* 读原始二进制体。
     ★ 超限时不能直接 req.destroy() —— 那会让客户端只看到 ECONNRESET，
     读不到我们想说的"太大了"。正确做法是：停止累积、把剩下的排掉，
     等请求自然结束后再回 413。只有远超上限（恶意灌流）才强行断开。 */
  function readRaw(req, limit) {
    return new Promise(resolve => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared && declared > limit) {
        // 有 content-length 就能立刻回话，连读都不必读
        resolve({ tooLarge: true, buf: null });
        req.resume();   // 把剩下的排掉，让连接可以复用
        return;
      }
      let size = 0, tooLarge = false;
      const chunks = [];
      req.on('data', c => {
        if (tooLarge) {
          size += c.length;
          // 已经明确拒绝了，还继续猛灌就直接断
          if (size > limit * 4) { try { req.destroy(); } catch (e) {} }
          return;
        }
        size += c.length;
        if (size > limit) { tooLarge = true; chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on('end', () => resolve({ tooLarge, buf: tooLarge ? null : Buffer.concat(chunks) }));
      req.on('error', () => resolve({ tooLarge: false, buf: null }));
    });
  }

  async function uploadBlob(req, res, q) {
    const m = members.get(String(q.get('token') || ''));
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });
    const kind = q.get('kind') === 'avatar' ? 'avatar' : 'sticker';
    const limit = kind === 'avatar' ? MAX_AVATAR : MAX_STICKER;

    // 全局配额：别让几百张动图把磁盘写满
    if (blobTotal() > MAX_BLOB_TOTAL) return json(res, 507, { ok: false, error: 'blob-quota' });
    // 上传也要限速，但比发言宽松（一次导入一个表情包是正常操作）
    const now = Date.now();
    m.upHits = (m.upHits || []).filter(t => now - t < 20000);
    if (m.upHits.length >= 30) return json(res, 429, { ok: false, error: 'too-fast' });
    m.upHits.push(now);
    m.lastSeen = now;

    const read = await readRaw(req, limit);
    if (read.tooLarge) return json(res, 413, { ok: false, error: 'too-large', limit });
    const buf = read.buf;
    if (!buf || !buf.length) return json(res, 400, { ok: false, error: 'empty' });
    const sniff = sniffImage(buf);
    if (!sniff) return json(res, 415, { ok: false, error: 'not-image' });
    const id = saveBlob(buf, sniff.ext);
    if (kind === 'avatar') {
      m.avatar = id;
      pushMembers();
    }
    return json(res, 200, {
      ok: true, id, mime: sniff.mime, size: buf.length,
      animated: sniff.ext === 'gif' || sniff.ext === 'webp',
      name: cleanNick(q.get('name') || '').slice(0, 12)
    });
  }

  function getBlob(req, res, id) {
    const found = findBlob(id);
    if (!found) return json(res, 404, { ok: false, error: 'no-blob' });
    let buf;
    try { buf = fs.readFileSync(found.file); } catch (e) { return json(res, 404, { ok: false, error: 'no-blob' }); }
    const mime = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[found.ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'content-length': buf.length,
      // 内容寻址，同一个 id 的内容永远不会变，可以放心长缓存
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff'
    });
    res.end(buf);
    return true;
  }

  /* 把一批表情登记进房间表情库（导入表情包时用）。
     内容寻址 + 按 id 去重，所以重复导入同一张不会出现两条。 */
  async function addStickers(req, res) {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, error: 'bad-body' });
    const m = members.get(String(body.token || ''));
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50) : [];
    const added = [];
    for (const raw of ids) {
      const id = String(raw || '');
      if (!findBlob(id)) continue;
      if (stickers.some(s => s.id === id)) continue;
      if (stickers.length >= MAX_STICKERS) break;
      const s = { id, by: m.nick, t: Date.now(), name: cleanNick(body.name || '') };
      stickers.push(s);
      added.push(s);
    }
    if (added.length) { saveStickers(); broadcast('stickers', { stickers }); }
    return json(res, 200, { ok: true, added: added.length, total: stickers.length, stickers });
  }

  /* 断线重连后补拉缺口：客户端带上自己收到的最大 seq，
     这里把之后的都发回去。有它才能保证"网络抖一下不丢消息"。 */
  function sync(req, res, q) {
    const token = String(q.get('token') || '');
    const m = members.get(token);
    if (!m) return json(res, 403, { ok: false, error: 'no-session' });
    const since = Number(q.get('since') || 0);
    let msgs = history.filter(x => (x.seq || 0) > since);
    let truncated = false;
    if (msgs.length > MAX_SEQ_GAP) { msgs = msgs.slice(-MAX_SEQ_GAP); truncated = true; }
    m.lastSeen = Date.now();
    return json(res, 200, { ok: true, seq, truncated, members: memberList(), msgs, stickers });
  }

  function config(_req, res) {
    // lan = 是否已经绑到内网（没绑的话给再多人地址也没用，别人连不上）
    const lan = typeof opts.lan === 'function' ? !!opts.lan() : opts.lan !== false;
    let port = 0;
    try { port = typeof opts.port === 'function' ? opts.port() : (opts.port || 0); } catch (e) { port = 0; }
    return json(res, 200, {
      ok: true, room: roomName, needCode: needCode(), members: members.size, max: MAX_MEMBERS,
      maxText: MAX_TEXT, maxNick: MAX_NICK, elems: ELEM_IDS,
      maxAvatar: MAX_AVATAR, maxSticker: MAX_STICKER, stickers: stickers.length,
      lan, addresses: lan ? lanAddresses() : [], port
    });
  }

  /* 返回 true 表示这个请求已经被茶室处理掉了 */
  function handle(req, res, urlObj) {
    const p = urlObj.pathname;
    if (!p.startsWith('/api/chat/')) return false;

    // 一道来源闸门：绑定到内网时，公网来源不该能碰到这里
    if (lanOnly) {
      const addr = (req.socket && (req.socket.remoteAddress || '')) || '';
      if (!isPrivateAddress(addr)) return json(res, 403, { ok: false, error: 'lan-only' }), true;
    }
    // 同源策略：同源的简单请求不会带 Origin，带了就必须和 Host 一致
    const origin = req.headers.origin;
    if (origin) {
      let sameOrigin = false;
      try { sameOrigin = new URL(origin).host === req.headers.host; } catch (e) { sameOrigin = false; }
      if (!sameOrigin) return json(res, 403, { ok: false, error: 'cross-origin' }), true;
    }

    /* 图片读取走 GET，浏览器 <img> 直接引用，不带 Origin 头的同源 GET 放行 ✓ */
    if (p.startsWith('/api/chat/blob/')) {
      if (req.method === 'GET') { getBlob(req, res, p.slice('/api/chat/blob/'.length)); return true; }
      return json(res, 405, { ok: false, error: 'method-not-allowed' }), true;
    }

    switch (p) {
      case '/api/chat/config':
        if (req.method === 'GET') { config(req, res); return true; }
        break;
      case '/api/chat/join':
        if (req.method === 'POST') { join(req, res); return true; }
        break;
      case '/api/chat/stream':
        if (req.method === 'GET') { stream(req, res, urlObj.searchParams); return true; }
        break;
      case '/api/chat/sync':
        if (req.method === 'GET') { sync(req, res, urlObj.searchParams); return true; }
        break;
      case '/api/chat/blob':
        if (req.method === 'POST') { uploadBlob(req, res, urlObj.searchParams); return true; }
        break;
      case '/api/chat/stickers':
        if (req.method === 'POST') { addStickers(req, res); return true; }
        break;
      case '/api/chat/send':
        if (req.method === 'POST') { sendMsg(req, res); return true; }
        break;
      case '/api/chat/typing':
        if (req.method === 'POST') { typing(req, res); return true; }
        break;
      case '/api/chat/leave':
        if (req.method === 'POST') { leave(req, res); return true; }
        break;
      case '/api/chat/clear':
        /* 清空历史：只有主机的本机窗口能调（局域网来的不能清别人记录） */
        if (req.method === 'POST') {
          const addr = (req.socket && (req.socket.remoteAddress || '')) || '';
          if (!/^(127\.|::1$|::ffff:127\.)/.test(addr)) return json(res, 403, { ok: false, error: 'host-only' }), true;
          history = [];
          scheduleSave();
          broadcast('cleared', { t: Date.now() });
          return json(res, 200, { ok: true }), true;
        }
        break;
    }
    return json(res, 405, { ok: false, error: 'method-not-allowed' }), true;
  }

  return {
    handle,
    info: () => ({ room: roomName, needCode: needCode(), code, members: members.size, max: MAX_MEMBERS, stickers: stickers.length, seq }),
    setCode: c => { code = c ? String(c) : ''; },
    history: () => history.slice(),
    stickers: () => stickers.slice(),
    close() {
      clearInterval(reaper);
      for (const m of [...members.values()]) dropMember(m, false);
      // 表情索引和聊天记录都用去抖写，退出前补一次，别把最后几条丢了
      if (stickerSaveTimer) { clearTimeout(stickerSaveTimer); stickerSaveTimer = null; }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      if (stickerIndexFile) { try { fs.writeFileSync(stickerIndexFile, JSON.stringify(stickers.slice(-MAX_STICKERS)), 'utf8'); } catch (e) {} }
      if (historyFile) { try { fs.writeFileSync(historyFile, JSON.stringify(history.slice(-MAX_HISTORY)), 'utf8'); } catch (e) {} }
    }
  };
}

module.exports = { createChat, isPrivateAddress, lanAddresses, sniffImage, ELEMS, ELEM_IDS };
