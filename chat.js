/* ============================================================
   chat.js · 「茶室」客户端
   ------------------------------------------------------------
   一个内核 + 两条传输通道，开哪种用哪种：

     lan    服务端可用时（桌面版 / npm run web）→ 真·局域网，
            跨设备、有房间码、历史落盘在主机上。
     local  没有服务端时（直接开静态页 / file://）→ 自动降级成
            同一浏览器多标签互聊（BroadcastChannel + localStorage）。

   两条通道对外暴露同一组接口（join/send/typing/leave），所以上面的
   界面代码完全不知道自己在用哪条 —— 这也是这个模块"不会变死"的原因。

   两条通道的行为刻意保持一致的两点：
     · 发送者本地先行渲染，服务端不回显（LAN 上往返只有一两毫秒，
       但本地渲染让"清空输入框"和"气泡出现"落在同一帧）
     · 消息、昵称一律用 textContent 渲染，不用 innerHTML 拼用户内容
   ============================================================ */
window.MJ2Chat = (() => {
  'use strict';

  const ELEMS = [
    { id: 'anemo', n: '风', hue: 175 }, { id: 'geo', n: '岩', hue: 75 },
    { id: 'electro', n: '雷', hue: 305 }, { id: 'dendro', n: '草', hue: 125 },
    { id: 'hydro', n: '水', hue: 230 }, { id: 'pyro', n: '火', hue: 40 },
    { id: 'cryo', n: '冰', hue: 200 }
  ];
  const elemOf = id => ELEMS.find(e => e.id === id) || ELEMS[4];
  const MAX_TEXT = 500;
  const LOCAL_HISTORY = 60;
  const MAX_AVATAR_SIDE = 256;   // 头像上传前先缩到这个边长

  /* ---------- 内置表情 ----------
     直接画成内联 SVG，不依赖任何图片文件：站点保持"零资源依赖"，
     离线也能用。只用 <img src="data:image/svg+xml,..."> 渲染，
     不进 innerHTML，所以没有脚本执行的余地。 */
  const BUILTIN = [
    { id: 'yeah', t: '好耶', hue: 125 }, { id: 'ok', t: '赞', hue: 200 },
    { id: 'fish', t: '摸鱼', hue: 230 }, { id: 'cry', t: '泪', hue: 305 },
    { id: 'grass', t: '草', hue: 75 }, { id: 'what', t: '？', hue: 40 },
    { id: 'sleep', t: '睡了', hue: 175 }, { id: 'ship', t: '搞定', hue: 40 },
    { id: 'lag', t: '卡了', hue: 75 }, { id: 'thx', t: '谢', hue: 200 }
  ];
  const BUILTIN_MAP = {};
  BUILTIN.forEach(b => { BUILTIN_MAP[b.id] = b; });
  /* 用 hsl() 而不是站点的 oklch()：这段标记会被别的设备上的浏览器渲染，
     hsl 的支持面最广，不会因为配色函数不认而整张空白。 */
  const builtinSVG = b =>
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">' +
    '<rect x="2" y="2" width="92" height="92" rx="20" fill="hsl(' + b.hue + ' 70% 92%)" stroke="hsl(' + b.hue + ' 55% 66%)" stroke-width="4"/>' +
    '<text x="48" y="60" text-anchor="middle" font-family="Noto Sans SC,sans-serif" font-size="' +
    (b.t.length > 1 ? 30 : 42) + '" font-weight="900" fill="hsl(' + b.hue + ' 60% 38%)">' + b.t + '</text>' +
    '</svg>';
  const builtinURL = id => {
    const b = BUILTIN_MAP[id];
    return b ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(builtinSVG(b)) : '';
  };
  /* 消息里的图片引用有三种：builtin:xxx（客户端自带）、blob id（服务端存过）、
     data:...（降级通道下把图直接带在消息里）。 */
  function refURL(ref) {
    const s = String(ref || '');
    if (/^data:image\//i.test(s)) return s;
    if (s.startsWith('builtin:')) return builtinURL(s.slice(8));
    if (/^[a-f0-9]{24}$/.test(s)) return '/api/chat/blob/' + s;
    return '';
  }
  /* 只有服务端认识的 blob id 才值得随每次请求发出去。
     降级通道会把头像存成 data URL，那玩意儿有几十 KB ——
     要是每次打字提示都捎带一份，流量和内存都很浪费。 */
  const avatarForServer = () => (/^[a-f0-9]{24}$/.test(Pref.avatar()) ? Pref.avatar() : '');

  /* ---------- 小工具 ---------- */
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return n;
  }
  const hhmm = t => {
    const d = new Date(t);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };
  /* 稳定取色：同一个昵称总落在同一个元素上，这样没设元素的人也不会乱跳 */
  const hashHue = s => {
    let x = 0;
    for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
    return ELEMS[x % ELEMS.length];
  };
  const rid = () => Math.random().toString(36).slice(2, 10);

  /* 把图片缩到指定边长并转成 data URL。降级通道要用它压头像，
     免得一张手机照直接把 localStorage 配额撑爆。
     动图不经过这里 —— canvas 会把动画压成静图。 */
  function shrinkLocal(file, maxSide) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('not-image')); return; }
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('read'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('decode'));
        img.onload = () => {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.85));
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }

  /* ---------- 偏好持久化 ----------
     昵称和元素用 sessionStorage（每个标签一份），最近用过的值同时记在 localStorage
     里给新标签预填。为什么不用纯 localStorage：同一浏览器的多个标签在"同机多标签"
     通道里代表**不同的人**，共用一个昵称的话，改了一个标签的名字另一个也跟着变，
     两个标签看起来一模一样，根本分不清谁是谁。
     localStorage 那份仍然走站点统一的 Store，桌面版会镜像到磁盘。 */
  const Pref = {
    store: () => (window.MJ2 && window.MJ2.Store) || { get: (k, d) => d, set: () => false },
    sess(k, d) { try { const v = sessionStorage.getItem('mj_chat_' + k); return v == null ? d : v; } catch (e) { return d; } },
    setSess(k, v) { try { sessionStorage.setItem('mj_chat_' + k, v); } catch (e) {} },
    nick() {
      const s = this.sess('nick', '');
      if (s) return String(s).slice(0, 12);
      return String(this.store().get('chat_nick', '') || '').slice(0, 12);
    },
    setNick(v) {
      const s = String(v || '').slice(0, 12);
      this.setSess('nick', s);
      this.store().set('chat_nick', s);
    },
    elem() {
      const v = this.sess('elem', '') || this.store().get('chat_elem', 'hydro');
      return elemOf(v).id;
    },
    setElem(v) {
      const id = elemOf(v).id;
      this.setSess('elem', id);
      this.store().set('chat_elem', id);
    },
    code() { return String(this.store().get('chat_code', '') || '').slice(0, 6); },
    setCode(v) { this.store().set('chat_code', String(v || '').replace(/\D/g, '').slice(0, 6)); },
    /* 自选头像：只存服务端返回的 blob id。用 sessionStorage 让同一浏览器的
       多个标签可以各有各的头像（和昵称同理）。 */
    avatar() {
      const s = this.sess('avatar', '');
      if (s) return s;
      return String(this.store().get('chat_avatar', '') || '');
    },
    setAvatar(id) {
      const v = String(id || '');
      this.setSess('avatar', v);
      this.store().set('chat_avatar', v);
    }
  };

  /* ============================================================
     通道一：lan —— 走服务端的 SSE + POST
     ============================================================ */
  function LanTransport(base) {
    const url = p => base + p;
    let token = '', es = null, closed = false, retry = 0, retryTimer = 0;
    const on = { msg: () => {}, members: () => {}, typing: () => {}, hello: () => {}, sys: () => {}, state: () => {}, stickers: () => {}, resync: () => {}, lastSeq: () => 0 };

    async function post(p, body) {
      const r = await fetch(url(p), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      return { status: r.status, json: j };
    }

    function openStream() {
      if (closed) return;
      es = new EventSource(url('/api/chat/stream?token=' + encodeURIComponent(token)));
      es.addEventListener('hello', e => {
        retry = 0;
        const d = JSON.parse(e.data);
        on.hello(d);
        on.state({ phase: 'live' });
      });
      es.addEventListener('msg', e => {
        const m = JSON.parse(e.data);
        if (m.kind === 'sys') on.sys(m); else on.msg(m);
      });
      es.addEventListener('members', e => on.members(JSON.parse(e.data).members));
      es.addEventListener('typing', e => on.typing(JSON.parse(e.data)));
      es.addEventListener('stickers', e => on.stickers(JSON.parse(e.data).stickers));
      es.addEventListener('cleared', () => on.state({ phase: 'cleared' }));
      es.onerror = () => {
        /* 断线重连。优先用**原来的 token** 重新挂上 SSE ——
           服务端会把旧连接顶掉、把新连接接上，成员从头到尾只有一个，
           人数不会跳、也不会刷一串"某某走进来又离开"。
           只有服务端明确说这个 token 不认识了，才重新 join 换新 token。 */
        if (closed) return;
        if (es) { try { es.close(); } catch (e) {} es = null; }
        on.state({ phase: 'retry', n: retry });
        retry++;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => reattach(), Math.min(700 * retry, 5000));
      };
    }

    /* 重连：先试原 token，不行再 join */
    async function reattach() {
      if (closed) return;
      const r = await fetch(url('/api/chat/sync?token=' + encodeURIComponent(token) + '&since=' + (on.lastSeq ? on.lastSeq() : 0)));
      if (closed) return;
      if (r.ok) {
        let j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        // 把断线期间漏掉的消息补上，再重新挂 SSE
        if (j && j.ok) on.resync(j);
        openStream();
        return;
      }
      await rejoin();     // token 已失效，只能重新进房
    }

    async function rejoin() {
      if (closed) return;
      const r = await post('/api/chat/join', { code: Pref.code(), nick: Pref.nick(), elem: Pref.elem(), avatar: avatarForServer() });
      if (closed) return;
      if (!r.json || !r.json.ok) { on.state({ phase: 'lost', error: r.json && r.json.error }); return; }
      token = r.json.token;
      openStream();
    }

    return {
      name: 'lan',
      /* 先探一下服务端在不在：探测用的就是真正的 config 接口，
         所以"探得到"就等于"能用"，不会出现探到了却连不上。 */
      async probe(timeout = 900) {
        try {
          const ctl = new AbortController();
          const t = setTimeout(() => ctl.abort(), timeout);
          const r = await fetch(url('/api/chat/config'), { signal: ctl.signal, cache: 'no-store' });
          clearTimeout(t);
          if (!r.ok) return null;
          return await r.json();
        } catch (e) { return null; }
      },
      async join(code, nick, elem) {
        const r = await post('/api/chat/join', { code, nick, elem, avatar: avatarForServer() });
        if (!r.json || !r.json.ok) {
          const err = (r.json && r.json.error) || ('http-' + r.status);
          const e = new Error(err);
          e.code = err;
          throw e;
        }
        token = r.json.token;
        openStream();
        return r.json;
      },
      async send(text, nick, elem) {
        const r = await post('/api/chat/send', { token, text, nick, elem, avatar: avatarForServer(), kind: 'msg' });
        if (!r.json || !r.json.ok) {
          const e = new Error((r.json && r.json.error) || ('http-' + r.status));
          e.code = e.message; e.retryIn = r.json && r.json.retryIn;
          throw e;
        }
        return r.json;
      },
      /* 发图片/表情：blob 是服务端已存的 id，或 builtin:xxx */
      async sendSticker(blob, w, h, kind) {
        const r = await post('/api/chat/send', { token, kind: kind || 'sticker', blob, w, h, nick: Pref.nick(), elem: Pref.elem(), avatar: avatarForServer() });
        if (!r.json || !r.json.ok) {
          const e = new Error((r.json && r.json.error) || ('http-' + r.status));
          e.code = e.message;
          throw e;
        }
        return r.json;
      },
      /* 上传原始字节。不设 content-type，让服务端只看魔数决定类型。 */
      async upload(file, kind, name) {
        const r = await fetch('/api/chat/blob?kind=' + encodeURIComponent(kind || 'sticker') +
          '&token=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(name || ''), {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file
        });
        let j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        if (!j || !j.ok) { const e = new Error((j && j.error) || ('http-' + r.status)); e.code = e.message; throw e; }
        return j;
      },
      async addStickers(ids, name) {
        const r = await post('/api/chat/stickers', { token, ids, name: name || '' });
        return (r.json && r.json.ok) ? r.json : null;
      },
      /* 断线之后补拉缺口 */
      async sync(since) {
        const r = await fetch(url('/api/chat/sync?token=' + encodeURIComponent(token) + '&since=' + (since || 0)));
        let j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        return (j && j.ok) ? j : null;
      },
      typing() { post('/api/chat/typing', { token, nick: Pref.nick(), elem: Pref.elem(), avatar: avatarForServer() }).catch(() => {}); },
      clearHistory() { return post('/api/chat/clear', {}); },
      on: (k, fn) => { on[k] = fn; },
      destroy() {
        closed = true;
        clearTimeout(retryTimer);
        if (es) { try { es.close(); } catch (e) {} es = null; }
        // 主动报一声离开，别等心跳超时
        try {
          const b = JSON.stringify({ token });
          if (navigator.sendBeacon) navigator.sendBeacon(url('/api/chat/leave'), new Blob([b], { type: 'application/json' }));
          else post('/api/chat/leave', { token });
        } catch (e) {}
      }
    };
  }

  /* ============================================================
     通道二：local —— 没有服务端时的降级，同一浏览器多标签互聊
     用 BroadcastChannel 发消息（不会投递给发送者自己，和 lan 不回显的
     行为天然一致），用 localStorage 存最近的历史，新开的标签能看到上文。
     ============================================================ */
  function LocalTransport(channelName) {
    const CH = 'mj-chat-' + channelName;
    const HKEY = 'mj2_chat_local_' + channelName;
    const HEARTBEAT = 3000, GONE = 11000;
    let bc = null, me = { token: '', nick: '', elem: '' }, hb = 0, sweep = 0, closed = false;
    const peers = new Map();       // token -> { token, nick, elem, seen, typingUntil }
    const on = { msg: () => {}, members: () => {}, typing: () => {}, hello: () => {}, sys: () => {}, state: () => {} };

    const readHist = () => { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; } };
    const writeHist = arr => { try { localStorage.setItem(HKEY, JSON.stringify(arr.slice(-LOCAL_HISTORY))); } catch (e) {} };
    const list = () => {
      const own = { token: me.token, nick: me.nick, elem: me.elem, avatar: me.avatar || '', typing: false, me: true };
      const others = [...peers.values()]
        .filter(p => Date.now() - p.seen < GONE)
        .map(p => ({ token: p.token, nick: p.nick, elem: p.elem, avatar: p.avatar || '', typing: p.typingUntil > Date.now() }));
      return [own, ...others];
    };
    const pushMembers = () => on.members(list());

    function post(type, data) {
      if (!bc || closed) return;
      try { bc.postMessage(Object.assign({ t: type, from: me.token }, data)); } catch (e) {}
    }
    function announce(type) { post('presence', { type, nick: me.nick, elem: me.elem, avatar: me.avatar || '' }); }

    return {
      name: 'local',
      async probe() { return { ok: true, room: '本机茶室', needCode: false, local: true }; },
      async join(_code, nick, elem) {
        me = { token: rid(), nick, elem };
        peers.clear();
        try { bc = new BroadcastChannel(CH); } catch (e) { bc = null; }
        if (!bc) { const e = new Error('no-broadcast'); e.code = 'no-broadcast'; throw e; }

        bc.onmessage = ev => {
          const d = ev.data;
          if (!d || d.from === me.token) return;
          if (d.t === 'presence') {
            if (d.type === 'bye') {
              if (peers.delete(d.from)) { on.sys({ kind: 'sys', t: Date.now(), text: (d.nick || '有人') + ' 离开了茶室' }); pushMembers(); }
              return;
            }
            const known = peers.has(d.from);
            peers.set(d.from, { token: d.from, nick: d.nick, elem: d.elem, avatar: d.avatar || '', seen: Date.now(), typingUntil: 0 });
            if (d.type === 'hello') {
              on.sys({ kind: 'sys', t: Date.now(), text: d.nick + ' 走进了茶室' });
              announce('here');    // 让对方也知道我在
            }
            pushMembers();
            return;
          }
          if (d.t === 'msg') {
            peers.set(d.from, Object.assign(peers.get(d.from) || {}, { token: d.from, nick: d.nick, elem: d.elem, seen: Date.now(), typingUntil: 0 }));
            const m = { id: d.id, t: d.t0 || Date.now(), kind: 'msg', token: d.from, nick: d.nick, elem: d.elem, hue: elemOf(d.elem).hue, text: d.text };
            /* 历史只由发送方写一份。接收方如果也写，同一条消息会被每个标签
               各写一遍，N 个标签就是 N 份重复。发送方在 send() 里已经写过了。 */
            on.msg(m);
            pushMembers();
            return;
          }
          if (d.t === 'typing') {
            const p = peers.get(d.from) || { token: d.from, nick: d.nick, elem: d.elem, seen: Date.now() };
            p.typingUntil = Date.now() + 3200; p.seen = Date.now();
            peers.set(d.from, p);
            on.typing({ token: d.from, nick: d.nick, until: p.typingUntil });
            return;
          }
        };

        announce('hello');
        hb = setInterval(() => { announce('here'); }, HEARTBEAT);
        sweep = setInterval(() => {
          let changed = false;
          for (const [k, p] of peers) if (Date.now() - p.seen > GONE) { peers.delete(k); changed = true; }
          if (changed) pushMembers();
        }, 4000);
        // 关标签/刷新时道别，别让对方等超时
        window.addEventListener('beforeunload', onUnload);
        on.hello({ you: { token: me.token, nick, elem, hue: elemOf(elem).hue }, room: '本机茶室', members: list(), history: readHist().slice(-60) });
        setTimeout(pushMembers, 60);   // 给别的标签一点时间应答 hello
        return { ok: true, token: me.token };
      },
      async send(text, nick, elem) {
        if (nick) me.nick = nick;
        if (elem) me.elem = elem;
        const m = { id: 'l' + rid(), t: Date.now(), kind: 'msg', token: me.token, nick: me.nick, elem: me.elem, hue: elemOf(me.elem).hue, text };
        const hist = readHist(); hist.push(m); writeHist(hist);
        post('msg', { id: m.id, t0: m.t, nick: me.nick, elem: me.elem, text });
        pushMembers();     // 改过昵称/刚发过言，自己那一条要立刻跟上，别等心跳
        return { ok: true, id: m.id };
      },
      /* 降级通道没有服务端可以存图，所以直接把图片当 data URL 塞进消息。
         动图同样原样保留（不重编码），因此 GIF 在这里也还是会动。
         代价是 localStorage 有配额，所以本地模式把上限压得更低。 */
      async upload(file, kind) {
        const isAvatar = kind === 'avatar';
        const url = isAvatar
          ? await new Promise(res => { shrinkLocal(file, MAX_AVATAR_SIDE).then(res, () => res('')); })
          : await new Promise(res => {
              const fr = new FileReader();
              fr.onload = () => res(String(fr.result || ''));
              fr.onerror = () => res('');
              fr.readAsDataURL(file);
            });
        if (!url) { const e = new Error('not-image'); e.code = 'not-image'; throw e; }
        if (!isAvatar && url.length > 700 * 1024) { const e = new Error('too-large'); e.code = 'too-large'; throw e; }
        /* 降级通道没有服务端，头像就直接用 data URL 本身当标识 ——
           refURL 认 data: 开头，所以界面照样能显示。 */
        if (isAvatar) { me.avatar = url; return { ok: true, id: url, dataURL: url, local: true }; }
        const id = 'loc' + rid();
        return { ok: true, id, dataURL: url, animated: /^data:image\/(gif|webp)/.test(url), local: true };
      },
      async addStickers(ids, name) {
        // 本地没有共享表情库，导入的图直接留在本标签的内存里
        return { ok: true, added: (ids || []).length, local: true };
      },
      async sync() { return { ok: true, local: true, msgs: [], members: list(), seq: 0 }; },
      async sendSticker(blob, w, h, kind, dataURL) {
        const m = {
          id: 'l' + rid(), t: Date.now(), kind: kind === 'image' ? 'image' : 'sticker',
          token: me.token, nick: me.nick, elem: me.elem, hue: elemOf(me.elem).hue,
          blob, w, h, blobData: dataURL || ''
        };
        const hist = readHist(); hist.push(m); writeHist(hist);
        post('msg', { id: m.id, t0: m.t, nick: me.nick, elem: me.elem, blob, w, h, blobData: m.blobData, kind: m.kind });
        pushMembers();
        return { ok: true, id: m.id };
      },
      typing() { post('typing', { nick: me.nick, elem: me.elem }); },
      async clearHistory() { writeHist([]); return { ok: true }; },
      on: (k, fn) => { on[k] = fn; },
      destroy() {
        closed = true;
        clearInterval(hb); clearInterval(sweep);
        window.removeEventListener('beforeunload', onUnload);
        announce('bye');
        if (bc) { try { bc.close(); } catch (e) {} bc = null; }
      }
    };

    function onUnload() { announce('bye'); }
  }

  /* 只在"可能是本地/内网服务"的时候才去探茶室接口。
     为什么不一上来就探：网页版会挂在 GitHub Pages 这类公网静态托管上，
     那里 /api/chat/config 必然 404 —— 请求本身无害（会自动降级成同机多标签），
     但浏览器会在控制台留一条红色 404，公开站点上不该有这种东西。
     本机、内网、.local 这些地址才去探；桌面版与 npm run web 都落在这里。 */
  function mayHaveServer() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /\.local$/i.test(h);
  }

  /* ============================================================
     视图
     ============================================================ */
  function view() {
    const host = h('div', { class: 'mj-view', 'data-view': 'chat' });
    let T = null, alive = true, lastNick = '', rendered = new Set(), lastMsg = null, needCode = false;

    /* ---- 骨架 ---- */
    const elRoom = h('span', { id: 'chRoom', text: '元素茶室' });
    const elMode = h('span', { class: 'ch-mode', id: 'chMode', text: '正在连接…' });
    const elCount = h('span', { class: 'mj-stat', id: 'chCount', text: '—' });
    const btnInvite = h('button', { class: 'mj2-btn', id: 'chInviteBtn', type: 'button', text: '房间码 / 邀请' });
    const btnClear = h('button', { class: 'mj2-btn', id: 'chClearBtn', type: 'button', text: '清空记录' });
    const head = h('div', { class: 'card-base chat-bar' },
      h('h2', { class: 'lb-title' }, '茶室 · ', elRoom),
      elMode, elCount,
      h('span', { class: 'ch-spacer' }),
      btnInvite, btnClear);

    const elMe = h('div', { class: 'ch-me' });
    const elMembers = h('ul', { class: 'ch-members', id: 'chMembers' });
    const rail = h('aside', { class: 'ch-rail card-base' },
      h('div', { class: 'ch-rail-t' }, '在场'), elMembers, elMe);

    const elStream = h('div', { class: 'ch-stream', id: 'chStream' });
    const elTyping = h('div', { class: 'ch-typing', id: 'chTyping' });
    const taText = h('textarea', { id: 'chText', rows: '2', maxlength: String(MAX_TEXT), placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）', 'aria-label': '消息内容' });
    const elCounter = h('span', { class: 'ch-counter', id: 'chCounter', text: '0/' + MAX_TEXT });
    const btnSend = h('button', { class: 'mj2-btn ch-send', id: 'chSend', type: 'button', text: '发送' });
    /* 表情面板 */
    const elStickerPanel = h('div', { class: 'ch-sticker-panel', id: 'chStickers' });
    const btnSticker = h('button', {
      class: 'mj2-btn ch-sticker-btn', id: 'chStickerBtn', type: 'button',
      title: '表情 / 图片', 'aria-label': '打开表情面板', 'aria-expanded': 'false', text: '☺'
    });
    const btnImage = h('button', {
      class: 'mj2-btn ch-sticker-btn', id: 'chImageBtn', type: 'button',
      title: '发一张图片或动图', 'aria-label': '发送图片或动图', text: '🖼'
    });
    const input = h('div', { class: 'ch-input' }, taText,
      h('div', { class: 'ch-bar' }, btnSticker, btnImage, elCounter, btnSend));
    const roomBox = h('section', { class: 'ch-room card-base' }, elStream, elTyping, elStickerPanel, input);

    const wrap = h('div', { class: 'ch-wrap' }, rail, roomBox);

    /* 进门页：需要房间码、或者要确认昵称时显示 */
    const elGateCard = h('div', { class: 'ch-gate-card card-base' });
    const elGate = h('div', { class: 'ch-gate', id: 'chGate' }, elGateCard);

    /* 邀请面板：房间码 + 二维码 */
    const elInviteCard = h('div', { class: 'ch-invite-card card-base' });
    const elInvite = h('div', { class: 'ch-invite', id: 'chInvite' }, elInviteCard);

    host.append(head, wrap, elGate, elInvite);

    /* ---- 渲染：成员 ---- */
    function renderMembers(list) {
      if (!alive) return;
      elCount.textContent = list.length + ' 人在场';
      elMembers.textContent = '';
      for (const m of list) {
        const e = elemOf(m.elem);
        /* "我"的判定：降级通道自己带了 me 标记；服务端给的名单只有 token，
           要靠自己的 token 比对 —— 不比对的话局域网模式下谁都认不出自己。 */
        const mine = !!m.me || !!(T && T.meToken && m.token === T.meToken);
        elMembers.appendChild(h('li', { class: 'ch-member' + (mine ? ' me' : '') + (m.typing ? ' typing' : ''), style: '--h:' + e.hue },
          avatarNode(m.avatar, e),
          h('span', { class: 'ch-mname' }, m.nick + (mine ? '（我）' : '')),
          h('span', { class: 'ch-msig', text: m.typing ? '正在输入…' : '' })));
      }
    }

    /* ---- 渲染：消息 ---- */
    function msgNode(m, mine) {
      const e = elemOf(m.elem) || hashHue(m.nick);
      const kids = [h('div', { class: 'ch-head' }, h('b', { text: m.nick }), h('time', { text: hhmm(m.t) }))];
      if ((m.kind === 'sticker' || m.kind === 'image') && (m.blob || m.blobData)) {
        const src = m.blobData || refURL(m.blob);
        if (src) {
          const img = h('img', {
            class: 'ch-pic' + (m.kind === 'sticker' ? ' is-sticker' : ''),
            src, alt: m.kind === 'sticker' ? '表情' : '图片',
            loading: 'lazy', decoding: 'async'
          });
          // 尺寸：优先用发送时记录的宽高，避免加载完成后页面跳动（CLS）
          if (m.w && m.h) img.setAttribute('style', 'aspect-ratio:' + m.w + '/' + m.h);
          kids.push(h('div', { class: 'ch-pic-wrap' }, img));
        } else {
          kids.push(h('div', { class: 'ch-text', text: '（这张图找不到了）' }));
        }
      }
      if (m.text) kids.push(h('div', { class: 'ch-text', text: m.text }));
      const body = h('div', { class: 'ch-body' }, ...kids);
      const av = avatarNode(m.avatar, e);
      return h('div', { class: 'ch-msg' + (mine ? ' mine' : ''), style: '--h:' + e.hue, 'data-id': m.id }, av, body);
    }
    /* 有自选头像就显示头像，否则退回元素色圆点 */
    function avatarNode(avatarId, e, cls) {
      const url = refURL(avatarId);
      if (url) return h('img', { class: 'ch-av ch-av-img' + (cls ? ' ' + cls : ''), src: url, alt: '', loading: 'lazy', decoding: 'async' });
      return h('span', { class: 'ch-av' + (cls ? ' ' + cls : ''), style: '--h:' + e.hue, text: e.n });
    }
    function atBottom() { return elStream.scrollHeight - elStream.scrollTop - elStream.clientHeight < 90; }
    function stick(force) { if (force || atBottom()) elStream.scrollTop = elStream.scrollHeight; }

    /* ---- 消息落地：去重 + 定序 ----
       并发下消息可能乱序到达（补拉与实时推送交错），所以不能只按"到达顺序"追加：
         · 有 seq 的按 seq 排序插入，小的插前面
         · 重复的（同 id，或 seq 不比自己记录的更大）直接丢掉
         · 发现 seq 跳号就补拉缺口
       本地乐观渲染的消息还没有 seq，先按到达顺序放在末尾，拿到 seq 后再归位。 */
    let lastSeq = 0;
    function seqOf(m) { return Number(m && m.seq) || 0; }
    function insertOrdered(nodeEl, seq) {
      // 从后往前找第一个 seq 比自己小的节点，插在它后面
      let ref = null;
      const nodes = elStream.querySelectorAll('.ch-msg[data-seq]');
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (Number(nodes[i].dataset.seq) < seq) { ref = nodes[i].nextSibling; break; }
      }
      if (ref) elStream.insertBefore(nodeEl, ref);
      else if (seq > 0 && nodes.length === 0) elStream.appendChild(nodeEl);
      else elStream.appendChild(nodeEl);
    }
    function addMsg(m, force) {
      if (!alive || !m || !m.id) return;
      if (rendered.has(m.id)) return;
      const s = seqOf(m);
      if (s > 0 && s <= lastSeq) { rendered.add(m.id); return; }   // 已经见过这一段了
      rendered.add(m.id);
      const mine = !!(T && m.token === T.meToken);
      const node = msgNode(m, mine);
      if (s > 0) node.dataset.seq = String(s);
      const prev = lastMsg;
      // 同一个人连着说话时，把头像和信息行收起来，看起来更像一页手帐
      const cont = !!(prev && prev.token === m.token && m.t - prev.t < 180000 && s > 0);
      if (cont) node.classList.add('cont');
      if (s > 0) {
        /* 号跳了说明中间漏了（网络抖动，或者刚好卡在重连之间）：
           记下来，等这条插进去之后去补拉缺口。 */
        const gapped = lastSeq > 0 && s > lastSeq + 1;
        // 有号就按号归位（补拉与实时推送可能交错）
        const tail = elStream.lastElementChild;
        const tailSeq = tail && tail.dataset ? Number(tail.dataset.seq) || 0 : 0;
        if (tailSeq && s < tailSeq) insertOrdered(node, s);
        else elStream.appendChild(node);
        if (s > lastSeq) lastSeq = s;
        if (gapped) fillGap();
      } else {
        elStream.appendChild(node);
      }
      lastMsg = m;
      stick(force);
    }
    function addSys(t) {
      if (!alive) return;
      elStream.appendChild(h('div', { class: 'ch-sys', text: t }));
      stick();
    }
    /* 补拉缺口：把 since 之后的消息按序补进来 */
    let gapPending = false;
    async function fillGap() {
      if (!T || !T.sync || gapPending) return;
      gapPending = true;
      try {
        const r = await T.sync(lastSeq);
        if (!alive || !r) return;
        if (Array.isArray(r.msgs)) r.msgs.forEach(x => { if (x.kind !== 'sys') addMsg(x); });
        if (Array.isArray(r.members)) renderMembers(r.members);
        if (Array.isArray(r.stickers)) setStickers(r.stickers);
        if (r.truncated) addSys('中间断得有点久，只补回了最近的一部分。');
      } catch (e) { /* 补拉失败不影响实时消息 */ }
      finally { gapPending = false; }
    }

    /* ---- 正在输入 ---- */
    const typingMap = new Map();
    function renderTyping() {
      if (!alive) return;
      const now = Date.now();
      const names = [...typingMap.entries()].filter(([, v]) => v > now).map(([k]) => k);
      elTyping.textContent = names.length
        ? names.join('、') + (names.length > 1 ? ' 正在输入…' : ' 正在输入…')
        : '';
      elTyping.classList.toggle('on', names.length > 0);
    }

    /* ---- 表情面板 ---- */
    let roomStickers = [];       // 房间里大家导入的表情（服务端存着 blob）
    let localStickers = [];      // 降级通道下本标签导入的（data URL，只在本机有效）
    function setStickers(list) {
      roomStickers = Array.isArray(list) ? list.slice() : [];
      renderStickers();
    }
    function renderStickers() {
      if (!alive) return;
      elStickerPanel.textContent = '';
      const mk = (src, label, onPick) => h('button', {
        class: 'ch-sticker', type: 'button', title: label, 'aria-label': label, onclick: onPick
      }, h('img', { src, alt: label, loading: 'lazy', decoding: 'async' }));

      const secA = h('div', { class: 'ch-sticker-sec' }, h('span', { class: 'ch-sticker-t' }, '贴纸'));
      const gridA = h('div', { class: 'ch-sticker-grid' },
        BUILTIN.map(b => mk(builtinURL(b.id), b.t, () => sendSticker('builtin:' + b.id))));
      secA.appendChild(gridA);
      elStickerPanel.appendChild(secA);

      const mineList = roomStickers.length ? roomStickers : localStickers;
      const secB = h('div', { class: 'ch-sticker-sec' },
        h('span', { class: 'ch-sticker-t' }, roomStickers.length ? '房间表情' : (localStickers.length ? '我导入的（本机可见）' : '')));
      if (mineList.length) {
        secB.appendChild(h('div', { class: 'ch-sticker-grid' }, mineList.map(s =>
          mk(s.dataURL || refURL(s.id), s.name || '表情', () => sendSticker(s.id, s.dataURL)))));
      }
      elStickerPanel.appendChild(secB);

      elStickerPanel.appendChild(h('div', { class: 'ch-sticker-bar' },
        h('button', { class: 'ed-add', type: 'button', onclick: () => importStickers('sticker') }, '＋ 导入表情包'),
        h('button', { class: 'ed-add', type: 'button', onclick: () => importStickers('image') }, '＋ 导入动图'),
        h('span', { class: 'mj-stat', style: 'margin-left:auto', text: roomStickers.length ? roomStickers.length + ' 张，全房间可见' : '' })));
    }
    /* 导入：可以一次选多张（一整个表情包）。
       ★ 动图（GIF/WebP）不做任何缩放或重编码 —— 一旦过 canvas，
       动画就没了，只剩第一帧。所以原样上传。 */
    function importStickers(kind) {
      if (!T) return;
      const inp = h('input', {
        type: 'file', accept: 'image/png,image/gif,image/webp,image/jpeg,image/*',
        multiple: kind === 'sticker', class: 'mj2-hidden-input', 'aria-label': '选择表情或图片'
      });
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const files = [...(inp.files || [])];
        inp.remove();
        if (!files.length || !T) return;
        let okCount = 0, failCount = 0;
        const ids = [], datas = [];
        for (const f of files) {
          try {
            const up = T.name === 'lan'
              ? await T.upload(f, 'sticker', f.name)
              : await T.upload(f, 'sticker', f.name);
            ids.push(up.id);
            if (up.dataURL) datas.push(up);
            okCount++;
          } catch (e) { failCount++; }
        }
        if (!okCount) { addSys('这几张都没传上去（可能是格式不支持或文件太大）。'); return; }
        if (T.name === 'lan') {
          const r = await T.addStickers(ids, files.length === 1 ? files[0].name : '表情包');
          if (r && Array.isArray(r.stickers)) setStickers(r.stickers);
          /* 服务端按内容去重：同样一张图再导入一次不会变成两条。
             所以这里要报"实际新加了几张"，不然会让人以为点了没反应。 */
          const added = (r && typeof r.added === 'number') ? r.added : okCount;
          addSys(added ? '表情库新增 ' + added + ' 张' + (failCount ? '，' + failCount + ' 张没成功' : '') + '。'
            : '这 ' + okCount + ' 张之前就在表情库里了。');
        } else {
          datas.forEach(d => localStickers.push({ id: d.id, dataURL: d.dataURL, name: d.name || '表情' }));
          addSys('导入了 ' + okCount + ' 张' + (failCount ? '，' + failCount + ' 张没成功' : '') + '（本机可见）。');
        }
        renderStickers();
      });
      inp.click();
    }
    /* 发一张表情/图片 */
    async function sendSticker(ref, dataURL) {
      if (!T) return;
      const kind = String(ref).startsWith('builtin:') || !dataURL ? 'sticker' : 'sticker';
      // 本地先渲染，和文字消息一样
      const tmp = {
        id: 'tmp' + rid(), t: Date.now(), kind, token: T.meToken, nick: Pref.nick(),
        elem: Pref.elem(), hue: elemOf(Pref.elem()).hue, blob: ref, blobData: dataURL || ''
      };
      addMsg(tmp, true);
      elStickerPanel.classList.remove('on');
      btnSticker.setAttribute('aria-expanded', 'false');
      try {
        const r = await T.sendSticker(ref, 0, 0, kind, dataURL);
        const node = elStream.querySelector('[data-id="' + tmp.id + '"]');
        if (node && r && r.id) {
          node.dataset.id = r.id;
          rendered.add(r.id);
          if (r.seq) { node.dataset.seq = String(r.seq); if (r.seq > lastSeq) lastSeq = r.seq; }
        }
      } catch (e) {
        const node = elStream.querySelector('[data-id="' + tmp.id + '"]');
        if (node) node.classList.add('failed');
        addSys(e.code === 'too-fast' ? '发得太快了，缓一缓。' : '这张没发出去。');
      }
    }
    /* 直接发一张图（不进表情库，只作为一条消息） */
    function sendImageDirect() {
      if (!T) return;
      const inp = h('input', { type: 'file', accept: 'image/*', class: 'mj2-hidden-input', 'aria-label': '选择要发送的图片' });
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f || !T) return;
        try {
          const up = await T.upload(f, 'sticker', f.name);
          await sendSticker(up.id, up.dataURL);
        } catch (e) {
          addSys(e.code === 'too-large' ? '这张图太大了（动图上限 2MB）。' : '这张图没发出去。');
        }
      });
      inp.click();
    }
    btnSticker.addEventListener('click', () => {
      const on = elStickerPanel.classList.toggle('on');
      btnSticker.setAttribute('aria-expanded', String(on));
      if (on) renderStickers();
    });
    btnImage.addEventListener('click', sendImageDirect);

    /* ---- 状态条 ---- */
    function setMode(text, cls) {
      elMode.textContent = text;
      elMode.className = 'ch-mode' + (cls ? ' ' + cls : '');
    }

    /* ---- 侧栏"我" ---- */
    function renderMe() {
      elMe.textContent = '';
      const e = elemOf(Pref.elem());
      const nick = h('span', { class: 'ch-nick mj-editable', tabindex: '0', title: '点击改昵称' },
        Pref.nick() || '（点一下起个名字）');
      const commit = () => {
        const v = (nick.textContent || '').trim().slice(0, 12);
        Pref.setNick(v);
        nick.textContent = v || '（点一下起个名字）';
        renderMe();
        if (T && T.typing) T.typing();      // 顺风车把新昵称同步给服务端
      };
      nick.addEventListener('click', () => { if (nick.isContentEditable) return; nick.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); nick.focus(); });
      nick.addEventListener('blur', () => { nick.contentEditable = 'false'; document.dispatchEvent(new Event('mj-editing-end')); commit(); });
      nick.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); nick.blur(); } });

      /* 自选头像：点自己那个圆点就换。有自选图就显示图，
         再点一次出「换一张 / 用回元素色」。 */
      const avBtn = h('button', {
        class: 'ch-avbtn', type: 'button', title: '点击设置头像',
        'aria-label': '设置我的头像',
        onclick: ev => { ev.stopPropagation(); pickAvatar(); }
      }, avatarNode(Pref.avatar(), e), h('span', { class: 'ch-avpen', text: '✎' }));

      const dots = h('div', { class: 'ch-elems' }, ELEMS.map(el =>
        h('button', {
          class: 'ch-edot' + (el.id === Pref.elem() ? ' on' : ''), type: 'button', title: el.n + '元素',
          'aria-label': '选 ' + el.n + ' 元素', style: '--h:' + el.hue,
          onclick: () => { Pref.setElem(el.id); renderMe(); if (T && T.typing) T.typing(); }
        }, el.n)));

      elMe.append(
        h('div', { class: 'ch-me-t' }, '我'),
        h('div', { class: 'ch-me-row' }, avBtn, nick),
        dots,
        h('div', { class: 'ed-bar', style: 'margin-top:.4rem' },
          h('button', { class: 'ed-add', type: 'button', onclick: () => pickAvatar() }, '换头像'),
          Pref.avatar() ? h('button', { class: 'ed-add', type: 'button', onclick: () => { Pref.setAvatar(''); renderMe(); if (T && T.typing) T.typing(); } }, '用元素色') : null));
    }
    /* 选头像 → 压到 256px → 上传 → 立刻同步给别人 */
    function pickAvatar() {
      const inp = h('input', { type: 'file', accept: 'image/*', class: 'mj2-hidden-input', 'aria-label': '选择头像图片' });
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f || !T) return;
        try {
          let up;
          if (T.name === 'lan') {
            const small = await shrinkLocal(f, MAX_AVATAR_SIDE).catch(() => '');
            if (!small) { addSys('这张图读不出来，换一张试试。'); return; }
            const blob = await (await fetch(small)).blob();
            up = await T.upload(blob, 'avatar', 'avatar');
            Pref.setAvatar(up.id);
          } else {
            up = await T.upload(f, 'avatar');
            Pref.setAvatar(up.id);
            if (T.me) T.me.avatar = up.id;
          }
          renderMe();
          if (T.typing) T.typing();
          addSys('头像换好了');
        } catch (e) {
          addSys(e.code === 'too-large' ? '这张图太大了，换一张小一点的。'
            : e.code === 'not-image' ? '这个文件不是图片。'
            : '头像没传上去，稍后再试。');
        }
      });
      inp.click();
    }

    /* ---- 邀请面板 ---- */
    let roomCfg = null;      // 探测到的 /api/chat/config 结果，里面带着服务端自报的局域网地址
    /* 地址可能是字符串（桌面版 IPC）或 {name,address}（服务端 config），统一成后者 */
    const normAddr = a => typeof a === 'string' ? { name: '', address: a } : { name: a.name || '', address: a.address };
    async function renderInvite() {
      elInviteCard.textContent = '';
      const isLan = T && T.name === 'lan';
      let addrs = [], port = location.port, code = Pref.code();

      // 桌面版：主进程知道得最准（内网开关 + 端口 + 真实网卡地址）
      if (isLan && window.mjDesktop && window.mjDesktop.chatInfo) {
        try {
          const info = await window.mjDesktop.chatInfo();
          if (info) {
            if (info.code) code = info.code;
            if (info.lan && info.addresses && info.addresses.length) {
              addrs = info.addresses.map(normAddr);
              port = info.port || port;
            }
          }
        } catch (e) { /* 拿不到就退回下面的网页版逻辑 */ }
      }
      // 网页版：服务端在 config 里自报地址（绑了 0.0.0.0 才会给）
      if (!addrs.length && isLan && roomCfg && roomCfg.lan && roomCfg.addresses && roomCfg.addresses.length) {
        addrs = roomCfg.addresses.map(normAddr);
        port = roomCfg.port || port;
      }
      // 兜底：如果这个页面本来就是从局域网地址打开的，那这个地址就是可分享的
      if (!addrs.length && isLan && !/^(127\.|localhost$|\[?::1\]?$)/.test(location.hostname)) {
        addrs = [{ name: '', address: location.hostname }];
      }
      if (!alive) return;

      const lines = [];
      lines.push(h('h3', {}, isLan ? '把同 WiFi 的人叫进来' : '这是同一台机器的茶室'));
      if (isLan && addrs.length) {
        const urlOf = a => 'http://' + a.address + ':' + port + '/#/chat';
        // 二维码只给排第一的那个地址（多半就是真实网卡），其余列出来备用
        const first = addrs[0];
        lines.push(h('div', { class: 'ch-inv-row' },
          h('span', { class: 'ch-inv-l' }, first.name || '地址'),
          h('code', { text: urlOf(first) })));
        const cv = window.MJ2QR ? MJ2QR.canvas(urlOf(first), 4) : null;
        if (cv) lines.push(h('div', { class: 'ch-qr' }, cv, h('p', { class: 'mj-stat', text: '手机连同一个 WiFi，扫码直接进茶室' })));
        if (addrs.length > 1) {
          lines.push(h('p', { class: 'mj-stat', style: 'margin:.5rem 0 .2rem', text: '这台机器上还有别的网卡，如果上面的地址连不上，依次试这些：' }));
          for (const a of addrs.slice(1, 4)) {
            lines.push(h('div', { class: 'ch-inv-row' },
              h('span', { class: 'ch-inv-l' }, a.name || '地址'),
              h('code', { text: urlOf(a) }),
              a.virtual ? h('span', { class: 'mj-stat', text: '（虚拟网卡，多半连不上）' }) : null));
          }
        }
        if (code) lines.push(h('div', { class: 'ch-inv-row', style: 'margin-top:.5rem' },
          h('span', { class: 'ch-inv-l' }, '房间码'),
          h('b', { class: 'ch-code', text: code }),
          h('span', { class: 'mj-stat', text: '对方进房时要填这个' })));
      } else if (isLan) {
        lines.push(h('p', { class: 'mj-stat', text: '现在是本机模式：只有这台电脑能连。想跨设备聊天，在桌面版里打开「局域网茶室」开关（或在 blog-sample 里用 MJ_HOST=0.0.0.0 npm run web 启动）。' }));
        if (code) lines.push(h('div', { class: 'ch-inv-row' },
          h('span', { class: 'ch-inv-l' }, '房间码'), h('b', { class: 'ch-code', text: code })));
      } else {
        lines.push(h('p', { class: 'mj-stat', text: '没检测到茶室服务（当前是直接打开的静态页）。现在这条通道是同一浏览器多标签互聊：再开一个标签页打开 #/chat，两边就能对上话。' }));
        lines.push(h('p', { class: 'mj-stat', text: '想要跨设备聊天，用桌面版打开，或在 blog-sample 里执行 npm run web。' }));
      }
      lines.push(h('div', { class: 'ed-bar' }, h('button', { class: 'ed-add', type: 'button', onclick: () => elInvite.classList.remove('on') }, '知道了')));
      elInviteCard.append(...lines);
    }

    /* ---- 进门页 ---- */
    function showGate(reason) {
      elGateCard.textContent = '';
      const nickI = h('input', { type: 'text', maxlength: '12', value: Pref.nick(), placeholder: '你的名字（最多 12 字）', 'aria-label': '昵称' });
      let codeI = null;
      const kids = [h('h3', {}, reason === 'bad-code' ? '房间码不对' : '进茶室')];
      if (needCode) {
        codeI = h('input', { type: 'text', inputmode: 'numeric', maxlength: '6', value: Pref.code(), placeholder: '6 位房间码', 'aria-label': '房间码', class: 'ch-code-in' });
        kids.push(h('label', { class: 'ch-field' }, h('span', {}, '房间码'), codeI));
        if (reason === 'bad-code') kids.push(h('p', { class: 'ch-err', text: '再核对一下主机上显示的那 6 位数字。' }));
      }
      kids.push(h('label', { class: 'ch-field' }, h('span', {}, '昵称'), nickI));
      kids.push(h('div', { class: 'ed-bar' },
        h('button', {
          class: 'ed-add', type: 'button',
          onclick: () => {
            const nick = (nickI.value || '').trim().slice(0, 12);
            Pref.setNick(nick);
            if (codeI) Pref.setCode(codeI.value);
            start(nick);
          }
        }, '进去')));
      elGateCard.append(...kids);
      elGate.classList.add('on');
      (codeI || nickI).focus();
    }

    /* ---- 启动 ---- */
    async function start(nick) {
      elGate.classList.remove('on');
      const wantLan = mayHaveServer();
      let transport = null, cfg = null;

      if (wantLan) {
        const probe = LanTransport('');
        cfg = await probe.probe();
        if (cfg && cfg.ok) { transport = probe; needCode = !!cfg.needCode; roomCfg = cfg; }
      }
      if (!transport) transport = LocalTransport('main');
      T = transport;
      T.meToken = '';

      T.on('state', s => {
        if (s.phase === 'live') setMode(T.name === 'lan' ? '局域网' : '同机多标签', 'ok');
        else if (s.phase === 'retry') setMode('重连中…', 'warn');
        else if (s.phase === 'lost') setMode('连接断开', 'bad');
        else if (s.phase === 'cleared') { elStream.textContent = ''; rendered.clear(); lastMsg = null; lastSeq = 0; addSys('记录已清空'); }
      });
      T.on('hello', d => {
        elRoom.textContent = d.room || '茶室';
        T.meToken = d.you.token;
        lastNick = d.you.nick;
        // 连上了就把"正在找茶室…"那句占位话去掉
        const ph = elStream.querySelector('.ch-sys');
        if (ph && /正在找茶室/.test(ph.textContent)) ph.remove();
        /* ★ 回放历史之前必须把 lastSeq 清 0。
           如果先把它设成"房间当前序号"，历史里每一条的 seq 都比它小，
           就会被当成"已经见过的重复消息"全部丢掉 —— 表现就是进房后
           聊天记录一片空白。正确顺序是：先按 seq 逐条铺历史（addMsg
           会自己把 lastSeq 顶上去），铺完再对齐房间当前序号。 */
        lastSeq = 0;
        (d.history || []).forEach(m => {
          if (m.kind === 'sys') return;      // 历史里的系统消息不再重放，避免一进来就是一堆"某人走进来"
          addMsg(m, true);
        });
        // 刚进房不存在"缺口"要补，直接对齐到房间当前序号
        lastSeq = Math.max(lastSeq, Number(d.seq) || 0);
        if (Array.isArray(d.stickers)) { roomStickers = d.stickers.slice(); renderStickers(); }
        renderMembers(d.members || []);
        stick(true);
      });
      T.on('msg', m => addMsg(m));
      T.on('sys', m => addSys(typeof m === 'string' ? m : m.text));
      T.on('members', list => renderMembers(list));
      T.on('stickers', list => setStickers(list));
      T.on('typing', d => { typingMap.set(d.nick, d.until); renderTyping(); });
      /* 重连补拉回来的缺口：按 seq 顺序补进列表，并刷新名单/表情库 */
      T.on('resync', d => {
        lastSeq = Math.max(lastSeq, Number(d.seq) || 0);
        if (Array.isArray(d.msgs)) d.msgs.forEach(m => { if (m.kind !== 'sys') addMsg(m); });
        if (Array.isArray(d.members)) renderMembers(d.members);
        if (Array.isArray(d.stickers)) setStickers(d.stickers);
      });
      T.on('lastSeq', () => lastSeq);

      try {
        await T.join(cfg && cfg.needCode ? Pref.code() : '', nick, Pref.elem());
        T.meToken = T.meToken || ((T.me && T.me.token) || '');
        setMode(T.name === 'lan' ? '局域网' : '同机多标签', 'ok');
        if (T.name === 'local') elRoom.textContent = '本机茶室';
      } catch (e) {
        if (e.code === 'bad-code') { showGate('bad-code'); return; }
        if (e.code === 'full') { addSys('茶室满了，等有人离开再来。'); setMode('房间已满', 'bad'); return; }
        // 其它错误：退回同机多标签，保证功能永远可用
        T = LocalTransport('main');
        T.on('hello', d => { T.meToken = d.you.token; (d.history || []).forEach(m => addMsg(m, true)); renderMembers(d.members || []); stick(true); });
        T.on('msg', m => addMsg(m));
        T.on('sys', m => addSys(typeof m === 'string' ? m : m.text));
        T.on('members', list => renderMembers(list));
        T.on('typing', d => { typingMap.set(d.nick, d.until); renderTyping(); });
        T.on('stickers', list => setStickers(list));
        T.on('resync', d => { if (Array.isArray(d.msgs)) d.msgs.forEach(m => addMsg(m)); });
        T.on('lastSeq', () => lastSeq);
        await T.join('', nick, Pref.elem());
        T.meToken = T.meToken || '';
        setMode('同机多标签', 'ok');
      }
      // 侧栏"我"是在进房之前渲染的，这时候昵称才真正定下来，重画一次
      renderMe();
      taText.focus();
    }

    /* ---- 发送 ---- */
    async function send() {
      const text = taText.value.replace(/\s+$/, '');
      if (!text.trim() || !T) return;
      taText.value = '';
      updateCounter();
      const nick = Pref.nick();
      // 本地先用一个临时 id 渲染，等接口回来再对齐真实 id（失败就标红）
      const tmp = { id: 'tmp' + rid(), t: Date.now(), kind: 'msg', token: T.meToken, nick, elem: Pref.elem(), hue: elemOf(Pref.elem()).hue, text };
      addMsg(tmp, true);
      try {
        const r = await T.send(text, nick, Pref.elem());
        const node = elStream.querySelector('[data-id="' + tmp.id + '"]');
        if (node && r && r.id) {
          node.dataset.id = r.id;
          rendered.add(r.id);
          // 把自己这条也纳入序号体系，否则后面的乱序判断会以它为准出错
          if (r.seq) { node.dataset.seq = String(r.seq); if (r.seq > lastSeq) lastSeq = r.seq; }
        }
      } catch (e) {
        const node = elStream.querySelector('[data-id="' + tmp.id + '"]');
        if (node) node.classList.add('failed');
        addSys(e.code === 'too-fast' ? '说得太快了，缓一缓再发。' : '这条没发出去，检查一下连接。');
      }
    }
    function updateCounter() { elCounter.textContent = taText.value.length + '/' + MAX_TEXT; }

    taText.addEventListener('input', () => {
      updateCounter();
      if (T && T.typing && taText.value.trim()) T.typing();
    });
    taText.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      e.stopPropagation();
    });
    btnSend.addEventListener('click', send);
    btnInvite.addEventListener('click', () => { renderInvite(); elInvite.classList.toggle('on'); });
    elInvite.addEventListener('click', e => { if (e.target === elInvite) elInvite.classList.remove('on'); });
    btnClear.addEventListener('click', async () => {
      if (!T) return;
      if (!confirm('清空茶室的聊天记录？这一步不可撤销。')) return;
      const r = await T.clearHistory();
      if (r && r.json && r.json.ok === false) { addSys('只有主机那台电脑能清空记录。'); return; }
      elStream.textContent = ''; rendered.clear(); lastMsg = null; addSys('记录已清空');
    });

    /* 打字提示会过期，定期重画一遍 */
    const tick = setInterval(renderTyping, 900);

    /* ---- 起步 ---- */
    renderMe();
    addSys('正在找茶室…');
    (async () => {
      const wantLan = mayHaveServer();
      let cfg = null;
      if (wantLan) cfg = await LanTransport('').probe();
      if (!alive) return;
      const lan = !!(cfg && cfg.ok);
      if (cfg && cfg.ok) roomCfg = cfg;
      needCode = !!(cfg && cfg.needCode);
      if (lan && needCode && !Pref.code()) {
        elRoom.textContent = (cfg && cfg.room) || '茶室';
        setMode('局域网 · 需要房间码', 'ok');
        showGate();
        return;
      }
      start(Pref.nick());
    })();

    return {
      host,
      destroy() {
        alive = false;
        clearInterval(tick);
        if (T && T.destroy) T.destroy();
        T = null;
      }
    };
  }

  return { view, ELEMS, elemOf };
})();
