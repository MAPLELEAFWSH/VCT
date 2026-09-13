/* ============================================================
   enhance.js · 站点的运行时层（路由、开场、可编辑系统、小游戏、粒子、性能调度）
   原则：不重写 index.html 里已有的骨架，只做增强与重组
     · 既有 main#content 的子节点被收进 home 视图，其余视图由本文件构建
     · 元素力直接映射到主题的 --element-hue，不另起一套色彩系统
     · 每个模块：输入 → 输出 → 清理（cleanup 可重入）
   来源与许可见 README.md「致谢与来源」。
   ============================================================ */
(() => {
  'use strict';

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const TOUCH = matchMedia('(hover: none)').matches;
  const MOBILE = matchMedia('(max-width: 720px)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

  /* ---------- 全局清理登记（仅页面离开时执行，路由切换不碰常驻模块） ---------- */
  const globalCleaners = [];
  const onPageGone = (fn) => globalCleaners.push(fn);
  addEventListener('pagehide', () => { while (globalCleaners.length) { try { globalCleaners.pop()(); } catch (e) {} } });

  const State = {
    read() { try { return JSON.parse(localStorage.getItem('mj_state') || '{}'); } catch (e) { return {}; } },
    write(p) { const n = Object.assign(this.read(), p); try { localStorage.setItem('mj_state', JSON.stringify(n)); } catch (e) {} return n; }
  };

  /* ============================================================
     0. 统一帧调度器
     原实现有 3 个各自独立的 rAF 循环（光标 / 记忆 / 标题刚体），
     全部无条件每帧空转。这里合并成单循环 + 按可见性挂载，页面隐藏时整体停机。
     ============================================================ */
  const Raf = (() => {
    const subs = new Set();
    let running = false, paused = document.hidden;
    // 帧内 JS 耗时统计：这是判断"能否稳定 60fps"的真实依据（16.7ms 预算）
    const stats = { frames: 0, jsTotal: 0, jsMax: 0, delivered: 0 };
    function loop(now) {
      if (paused || subs.size === 0) { running = false; return; }
      stats.frames++;
      const list = Array.from(subs);
      const t0 = performance.now();
      for (let i = 0; i < list.length; i++) { try { list[i](now); } catch (e) { console.warn('[raf]', e); } }
      const cost = performance.now() - t0;
      stats.jsTotal += cost;
      if (cost > stats.jsMax) stats.jsMax = cost;
      requestAnimationFrame(loop);
    }
    function start() { if (running || paused || subs.size === 0) return; running = true; requestAnimationFrame(loop); }
    document.addEventListener('visibilitychange', () => { paused = document.hidden; if (!paused) start(); });
    onPageGone(() => subs.clear());
    return {
      add(fn) { subs.add(fn); start(); return () => subs.delete(fn); },
      remove(fn) { subs.delete(fn); },
      get size() { return subs.size; },
      get stats() { return { frames: stats.frames, jsAvgMs: stats.frames ? +(stats.jsTotal / stats.frames).toFixed(3) : 0, jsMaxMs: +stats.jsMax.toFixed(3) }; },
      resetStats() { stats.frames = 0; stats.jsTotal = 0; stats.jsMax = 0; }
    };
  })();

  /* 只在元素进入视口时才挂到调度器上，离开即摘除 */
  function whenVisible(node, on, margin = '25% 0px') {
    let off = null;
    const io = new IntersectionObserver(es => {
      if (es[0].isIntersecting) { if (!off) off = on(); }
      else if (off) { off(); off = null; }
    }, { rootMargin: margin });
    io.observe(node);
    return () => { io.disconnect(); if (off) off(); };
  }

  /* ============================================================
     1. 元素力 → 既有 --element-hue
     输入：点击色点   输出：--element-hue 变化 + 全站主题色跟随
     ============================================================ */
  const ELEMENTS = [
    { id: 'anemo', name: '风', hue: 175, c: '#74c2a8' },
    { id: 'geo', name: '岩', hue: 75, c: '#fab72e' },
    { id: 'electro', name: '雷', hue: 305, c: '#af8ec1' },
    { id: 'dendro', name: '草', hue: 125, c: '#a5c83b' },
    { id: 'hydro', name: '水', hue: 230, c: '#4cc2f1' },
    { id: 'pyro', name: '火', hue: 40, c: '#ef7938' },
    { id: 'cryo', name: '冰', hue: 200, c: '#9fd6e3' }
  ];
  const elById = id => ELEMENTS.find(e => e.id === id) || ELEMENTS[4];
  let currentEl = State.read().el || 'hydro';
  function setElement(id) {
    const e = elById(id); currentEl = e.id;
    document.documentElement.style.setProperty('--element-hue', String(e.hue));
    $$('.mj-els button').forEach(b => b.classList.toggle('on', b.dataset.el === e.id));
    State.write({ el: e.id });
    if (window.__mjRig) window.__mjRig.setColor(e.c);
  }

  /* ============================================================
     2. 自定义光标
     ============================================================ */
  const Cursor = (() => {
    if (TOUCH || REDUCED) return { destroy() {} };
    const host = el('div', '', '<div class="ring"></div><div class="dot"></div><div class="tag"></div>');
    host.id = 'mj-cursor';
    document.body.append(host);
    document.body.classList.add('mj-cursor-on');
    const ring = $('.ring', host), dot = $('.dot', host), tag = $('.tag', host);

    let mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my, last = 0;
    // 拖尾已移除：12 个 DOM 节点的高频增删本身就是在低帧率下加重拖动延迟的一环，
    // 且与"页面需要减冗余"的方向相反。环改为“按时间”缓动，帧率变化时手感一致。
    const SEL = 'a,button,input,[role="button"],.mj-wall-photo,.mj-chip,.mj-kcard,.mj-card,.mj-friend,.mj-tl-card,canvas';
    let hot = null;

    const onMove = e => {
      mx = e.clientX; my = e.clientY;
      dot.style.transform = `translate(${mx}px,${my}px)`;
      wake();                 // 鼠标动了才唤醒缓动循环
    };
    const onOver = e => {
      const t = e.target;
      if (t === hot) return;
      hot = t;
      const hit = t.closest ? t.closest(SEL) : null;
      const isHot = !!hit;
      if (host.classList.contains('hover') !== isHot) host.classList.toggle('hover', isHot);
      if (isHot) {
        const text = hit.dataset.cursor || (hit.tagName === 'CANVAS' ? '操作' : '');
        if (tag.textContent !== text) tag.textContent = text;
        tag.style.display = text ? '' : 'none';
      }
    };
    const down = () => host.classList.add('down');
    const up = () => host.classList.remove('down');
    const leave = () => host.classList.add('off');
    const enter = () => host.classList.remove('off');

    /* ★ 空闲就停机。
       原来的环是无条件每帧写的：即使鼠标完全不动、环早就贴上去了，
       也照样每帧算一次指数逼近、写一次 transform，把整条渲染流水线一直唤醒着。
       看文章的时候鼠标往往几秒都不动，这份"安静的额外占用"完全没必要。
       现在环一旦收敛到目标位置就把自己从调度器上摘下来（Raf 在没有任何订阅者时
       会彻底停掉 rAF），下一次 mousemove 再唤醒 —— 静止时页面是真的静止。 */
    let offRaf = null;
    function wake() { if (!offRaf) { last = 0; offRaf = Raf.add(loop); } }
    function park() { if (offRaf) { offRaf(); offRaf = null; } }

    const loop = now => {
      if (!last) last = now;
      const dt = Math.min(64, now - last); last = now;
      /* 与帧率无关的指数逼近：k = 1 - e^(-dt/τ)，τ 越小跟手越快。
         原来是 1 - 0.0001^(dt/1000)，等效时间常数 τ ≈ 108ms —— 拖尾感很明显。
         现在 τ = 42ms，接近刚好"看得到缓动"又不觉得延迟。 */
      const k = 1 - Math.exp(-dt / 42);
      rx += (mx - rx) * k; ry += (my - ry) * k;
      if (Math.abs(mx - rx) < 0.05 && Math.abs(my - ry) < 0.05) {
        rx = mx; ry = my;
        ring.style.transform = `translate(${rx}px,${ry}px)`;
        park();                       // 已经贴住了，停到下次移动
        return;
      }
      ring.style.transform = `translate(${rx}px,${ry}px)`;
    };

    addEventListener('mousemove', onMove, { passive: true });
    addEventListener('mouseover', onOver, { passive: true });
    addEventListener('mousedown', down); addEventListener('mouseup', up);
    document.addEventListener('mouseleave', leave); document.addEventListener('mouseenter', enter);

    /* ★ 编辑态必须交还系统光标。
       本站用 cursor:none + 自绘光标，一旦进入 input / textarea / contenteditable，
       自绘的环和圆点会压在文本插入符上，既看不见 I 形光标也看不清光标位置 ——
       这就是"自定义编辑时光标显示 bug"。焦点进入可编辑元素时给 body 挂
       .mj-native-cursor，CSS 里恢复系统光标并隐藏自绘光标。 */
    const EDITABLE = 'input, textarea, select, [contenteditable="true"], [role="textbox"], .ed-on';
    const isEditing = () => {
      const a = document.activeElement;
      return !!(a && a.closest && a.closest(EDITABLE));
    };
    const syncCursorMode = () => {
      document.body.classList.toggle('mj-native-cursor', isEditing());
    };
    document.addEventListener('focusin', syncCursorMode, true);
    document.addEventListener('focusout', () => setTimeout(syncCursorMode, 0), true);
    /* 键盘进入编辑时 contentEditable 是在 focusin 之后才设上的，
       所以光靠 focusin 抓不到 —— Editable 进入/退出编辑会派发这两个事件。 */
    document.addEventListener('mj-editing-start', syncCursorMode);
    document.addEventListener('mj-editing-end', syncCursorMode);

    /* 起始不再挂常驻循环：先把环摆到初始位置，等第一次 mousemove 再唤醒。 */
    ring.style.transform = `translate(${rx}px,${ry}px)`;
    dot.style.transform = `translate(${mx}px,${my}px)`;
    const destroy = () => {
      removeEventListener('mousemove', onMove); removeEventListener('mouseover', onOver);
      removeEventListener('mousedown', down); removeEventListener('mouseup', up);
      document.removeEventListener('mouseleave', leave); document.removeEventListener('mouseenter', enter);
      document.removeEventListener('focusin', syncCursorMode, true);
      park(); host.remove();
      document.body.classList.remove('mj-cursor-on', 'mj-native-cursor');
    };
    onPageGone(destroy);
    return { destroy };
  })();

  /* ============================================================
     3. 标题刚体：切片 / 分离 / 重组（开场与 Works 共用）
     ============================================================ */
  function TitleRig(canvas, opts) {
    const ctx = canvas.getContext('2d');
    const o = Object.assign({ text: '元素手帐', sub: 'ELEMENTAL JOURNAL', bands: 14, color: '#4cc2f1', fill: '#ffffff', grid: 'rgba(255,255,255,.045)' }, opts);
    let w = 0, h = 0, progress = 1, cuts = [], raf = 0, t = 0, bandSrc = null;

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      w = r.width; h = r.height;
    }
    function ensureBands() {
      if (w < 2 || h < 2) return;
      const off = document.createElement('canvas');
      off.width = Math.round(w); off.height = Math.round(h);
      const oc = off.getContext('2d');
      const fs = Math.min(w / (o.text.length + 1.4), h * .32);
      oc.textAlign = 'center'; oc.textBaseline = 'middle'; oc.fillStyle = o.fill;
      oc.font = `700 ${fs}px "Noto Sans SC",system-ui,sans-serif`;
      oc.fillText(o.text, w / 2, h * .46);
      oc.globalAlpha = .55;
      oc.font = `600 ${Math.max(9, fs * .15)}px "JetBrains Mono",monospace`;
      oc.fillText(o.sub, w / 2, h * .46 + fs * .74);
      bandSrc = { src: off, count: o.bands };
    }
    function bandTransform(i) {
      const k = 1 - progress;
      const seed = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
      const dir = ((i % 5) - 2) / 2;
      const push = 110 + seed * 210;
      return { x: dir * push * k + Math.sin(t * .0011 + i) * 8 * k, y: (seed - .5) * push * .7 * k, rot: (seed - .5) * .5 * k, a: .22 + .78 * progress * (.55 + .45 * seed) };
    }
    function draw() {
      if (w < 2 || h < 2) return;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = o.grid; ctx.lineWidth = 1;
      for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      if (!bandSrc) ensureBands();
      if (!bandSrc) return;
      const n = bandSrc.count, bh = h / n, sh = bandSrc.src.height, bhSrc = sh / n, sw = bandSrc.src.width;
      for (let i = 0; i < n; i++) {
        const p = bandTransform(i);
        for (const c of cuts) {
          const d = Math.abs((i + .5) * bh - c.y * h);
          if (d < bh * 2.6) p.x += 46 * (1 - d / (bh * 2.6)) * c.life;
        }
        ctx.save();
        ctx.globalAlpha = p.a;
        ctx.translate(w / 2 + p.x, (i + .5) * bh + p.y);
        ctx.rotate(p.rot);
        ctx.shadowColor = o.color; ctx.shadowBlur = 14 * progress;
        ctx.drawImage(bandSrc.src, 0, i * bhSrc, sw, bhSrc, -w / 2, -bh / 2, w, bh);
        ctx.restore();
      }
      cuts.forEach(c => {
        ctx.save();
        ctx.globalAlpha = c.life * .8; ctx.strokeStyle = o.color; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(c.x * w - 60, c.y * h); ctx.lineTo(c.x * w + 60, c.y * h); ctx.stroke();
        ctx.restore();
      });
    }
    let unsub = null, offVis = null;
    function loop() { t += 16; cuts.forEach(c => c.life -= .018); cuts = cuts.filter(c => c.life > 0); draw(); }
    const onResize = () => { resize(); bandSrc = null; draw(); };
    addEventListener('resize', onResize);
    resize(); ensureBands(); draw();
    // 只在画布进入视口时挂到调度器上；display:none 期间不会触发，天然省电
    if (!REDUCED) offVis = whenVisible(canvas, () => { unsub = Raf.add(loop); return () => { if (unsub) unsub(); unsub = null; }; }, '10% 0px');

    const api = {
      setProgress(p) { progress = Math.max(0, Math.min(1, p)); if (REDUCED) draw(); },
      addCut(nx, ny) { cuts.push({ x: nx, y: ny, life: 1 }); if (REDUCED) draw(); },
      setColor(c) { o.color = c; draw(); },
      /* 容器从 display:none 变为可见后必须重新量尺寸，否则 w/h 仍是 0，条带永远建不出来 */
      refresh() { resize(); bandSrc = null; ensureBands(); draw(); return w > 2 && h > 2; },
      destroy() { if (offVis) offVis(); if (unsub) unsub(); removeEventListener('resize', onResize); }
    };
    return api;
  }

  /* ============================================================
     4. 开场动画：门扉 + 能量反馈 + 标题画布 + 自动/跳过
     ★ 现在页面里**只有这一处**开场了：原来还有一层从参考项目带进来的
     #splash（参考主题的名字 + 假进度条），已按要求整块删除。
     每会话只播一次（sessionStorage.mj_opened），且随时能"跳过开场"。
     ============================================================ */
  const Opening = (() => {
    const seen = (() => { try { return sessionStorage.getItem('mj_opened') === '1'; } catch (e) { return false; } })();
    if (seen || REDUCED) { try { sessionStorage.setItem('mj_opened', '1'); } catch (e) {} return { destroy() {} }; }

    const host = el('div');
    host.id = 'mj-opening';
    host.style.display = 'none';
    /* 排版用 flex 竖列：标题画布 → 门扉 → 底部（头像 / 加载条 / 提示）。
       背景层（天空、涟漪、波浪）一律绝对定位，不参与 flex 流，所以永远不会和上面四块抢位置。 */
    host.innerHTML = `
      <div class="mj-open-sky" aria-hidden="true">
        <span class="bloom b1"></span><span class="bloom b2"></span><span class="bloom b3"></span>
      </div>
      <canvas id="mj-title-canvas" aria-hidden="true"></canvas>
      <div class="mj-waves" aria-hidden="true"><i class="w1"></i><i class="w2"></i><i class="w3"></i></div>
      <div class="mj-open-core" id="mjOpenCore" role="button" tabindex="0" aria-label="点击头像开启">
        <!-- 涟漪放进头像容器里：圆心 = 头像圆心，不靠"视口居中"去凑，
             换视口高度 / 改文案都不会再对不上 -->
        <div class="mj-ripples" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <div class="mj-open-avatar"><img id="mjOpenAvatar" alt="" /></div>
      </div>
      <div class="mj-open-foot">
        <div class="mj-loadbar" role="progressbar" aria-label="开场进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="mjLoadBar">
          <div class="mj-loadbar-track"><i id="mjOpenBar"></i></div>
          <div class="mj-loadbar-num"><span id="mjOpenPct">0%</span> · 开场进度</div>
        </div>
        <div class="mj-gate-label" id="mjGateLabel">点击头像 · 元素力将为你开启</div>
        <div class="mj-opening-hint" id="mjOpenHint">AUTO · 自动推进中</div>
      </div>
      <div class="mj-opening-ctrl">
        <button class="mj-obtn" id="mjAuto" type="button">暂停自动</button>
        <button class="mj-obtn" id="mjSkip" type="button">跳过开场</button>
      </div>`;
    document.body.appendChild(host);

    /* 头像跟随用户自己改过的头像（Profile 模块存在 localStorage.mj2_profile 里） */
    (() => {
      const im = $('#mjOpenAvatar', host); if (!im) return;
      let src = 'assets/paper/avatar.svg';
      try {
        const saved = JSON.parse(localStorage.getItem('mj2_profile') || '{}');
        if (saved && saved.avatar) src = saved.avatar;
      } catch (e) {}
      im.src = src;
      im.addEventListener('error', () => { im.src = 'assets/paper/avatar.svg'; }, { once: true });
    })();

    const core = $('#mjOpenCore', host), label = $('#mjGateLabel', host), hint = $('#mjOpenHint', host);
    const bar = $('#mjOpenBar', host), autoBtn = $('#mjAuto', host), skipBtn = $('#mjSkip', host);
    const pct = $('#mjOpenPct', host), loadWrap = $('#mjLoadBar', host);
    const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb);
    const rig = TitleRig($('#mj-title-canvas', host), {
      text: '元素手帐', sub: '记录日常 · 手帐二次元',
      // 与浅色纸感主题统一：墨色标题 + 深色网格（原来固定白字，在浅底上看不见）
      fill: cssVar('--ink-strong', '#1c1e26'), grid: 'rgba(28,30,38,.06)'
    });
    window.__mjRig = rig;

    let auto = true, started = false, done = false, p = 0, raf = 0, last = 0;
    // 加载推进时长：4400 → 2400ms。加上收尾的 850ms 停留 + 900ms 淡出，
    // 整段开场从约 6.2s 压到约 4.2s，不再让人等。
    const DUR = 2400;

    function tick(now) {
      if (done) return;
      if (!last) last = now;
      const dt = now - last; last = now;
      if (auto) p = Math.min(1, p + dt / DUR);
      bar.style.width = (p * 100).toFixed(1) + '%';
      pct.textContent = Math.round(p * 100) + '%';
      loadWrap.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      rig.setProgress(p);
      if (p >= 1) finish(false); else raf = requestAnimationFrame(tick);
    }
    function burst(x, y) {
      for (let i = 0; i < 3; i++) {
        const r = el('span', 'mj-energy');
        r.style.left = x + 'px'; r.style.top = y + 'px'; r.style.animationDelay = (i * 110) + 'ms';
        host.appendChild(r); setTimeout(() => r.remove(), 1050 + i * 110);
      }
    }
    function finish(byUser) {
      if (done) return; done = true; cancelAnimationFrame(raf);
      core.classList.add('open');
      label.textContent = byUser ? '元素力已回应你' : '自动推进完成';
      const gr = core.getBoundingClientRect();
      if (byUser) burst(gr.left + gr.width / 2, gr.top + gr.height / 2);
      rig.setProgress(1);
      try { sessionStorage.setItem('mj_opened', '1'); } catch (e) {}
      setTimeout(() => {
        host.classList.add('gone');
        if (Achievements) Achievements.unlock('gate');
        setTimeout(() => { rig.destroy(); host.remove(); window.__mjRig = null; }, 900);
      }, 850);
    }
    function onCore() {
      if (done) return;
      const r = core.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      MangaFX.burst(cx, cy);       // 漫画集中線（能量环由 finish() 统一放，避免这里重复放一遍）
      finish(true);
    }
    function onCoreKey(e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onCore(); }
    }
    function onAuto() { auto = !auto; autoBtn.textContent = auto ? '暂停自动' : '继续自动'; hint.textContent = auto ? 'AUTO · 自动推进中' : 'PAUSED · 已暂停'; last = 0; }
    function onSkip() { finish(false); }

    core.addEventListener('click', onCore);
    core.addEventListener('keydown', onCoreKey);
    autoBtn.addEventListener('click', onAuto);
    skipBtn.addEventListener('click', onSkip);

    // 开场本身即加载动画：直接接管，移除既有 splash，避免两个加载屏前后叠 10 秒
    const sp = $('#splash');
    if (sp && sp.parentNode) sp.parentNode.removeChild(sp);
    host.style.display = '';

    // 容器刚变为可见，必须等一次布局完成再量尺寸，否则画布是 0×0
    let tries = 0;
    (function ready() {
      if (!rig.refresh() && ++tries < 40) { requestAnimationFrame(ready); return; }
      rig.setProgress(0);
      p = 0; last = 0;
      if (!REDUCED) raf = requestAnimationFrame(tick);
    })();

    const destroy = () => { cancelAnimationFrame(raf); rig.destroy(); core.removeEventListener('click', onCore); core.removeEventListener('keydown', onCoreKey); autoBtn.removeEventListener('click', onAuto); skipBtn.removeEventListener('click', onSkip); host.remove(); };
    onPageGone(destroy);
    return { destroy, rig, get canvasReady() { return rig.refresh(); } };
  })();

  /* ============================================================
     5. Opening Memory：滚动叙事（复用既有壁纸作为记忆画面）
     ============================================================ */
  /* 5 幕（原 9 幕）：每幕一张全屏图，9 幕等于 9 个全屏图片图层，
     且 520vh 会把真正的文章内容推到 5 屏之后 —— 性能与"主次分明"同时受损。 */
  const MEMORY_TIMELINE = [
    { start: 0, enterEnd: .08, leaveStart: .19, end: .24, drift: -12, lift: -3 },
    { start: .19, enterEnd: .27, leaveStart: .38, end: .43, drift: 8, lift: 0 },
    { start: .38, enterEnd: .46, leaveStart: .55, end: .60, drift: -16, lift: -5 },
    { start: .60, enterEnd: .68, leaveStart: .78, end: .84, drift: 10, lift: -8 },
    { start: .84, enterEnd: .90, leaveStart: 1, end: 1, drift: 0, lift: 0, persistent: true }
  ];
  /* 场景与文案都按"一个普通人的一天"来写：起床泡茶、出门、做饭、读书、睡前写下今天。
     背景图是程序化生成的纸感墨晕（assets/paper/），不依赖任何第三方素材。 */
  const MEMORY_SCENES = [
    { img: 'assets/paper/bg-03.svg', el: 'anemo', cap: '第 01 幕 · 天刚亮，先泡一杯茶', pos: '50% 50%' },
    { img: 'assets/paper/bg-04.svg', el: 'geo', cap: '第 02 幕 · 出门走走，随手拍了几张', pos: '44% 52%' },
    { img: 'assets/paper/bg-05.svg', el: 'hydro', cap: '第 03 幕 · 回来做饭，锅里咕嘟咕嘟', pos: '48% 54%' },
    { img: 'assets/paper/bg-06.svg', el: 'electro', cap: '第 04 幕 · 下午读一会儿书', pos: '50% 46%' },
    { img: 'assets/paper/bg-07.svg', el: 'cryo', cap: '第 05 幕 · 夜里把今天写下来', pos: '50% 50%' }
  ];
  /* 按"媒体时间"释放：真实视频接入时把 clock 换成 video.currentTime 即可。
     照片墙展示 6 张，用另外 6 张背景图（与上面 5 幕不重复）。 */
  const RELEASE_TRACK = [
    { at: 2.6, kind: 'photo', label: '清晨', scene: 0, img: 'assets/paper/bg-01.svg' },
    { at: 6.4, kind: 'clue', label: '线索 A', scene: 0, img: 'assets/paper/bg-02.svg', clue: 'A' },
    { at: 10.2, kind: 'photo', label: '路上', scene: 1, img: 'assets/paper/bg-03.svg' },
    { at: 14.0, kind: 'clue', label: '线索 B', scene: 2, img: 'assets/paper/bg-04.svg', clue: 'B' },
    { at: 17.8, kind: 'reward', label: '隐藏奖励', scene: 3, img: 'assets/paper/bg-06.svg' },
    { at: 21.6, kind: 'reward', label: '夜里', scene: 4, img: 'assets/paper/bg-07.svg' }
  ];
  const MEDIA_DURATION = 24;

  /* —— gateStory.ts 的数学原样移植 —— */
  const unit = v => Math.max(0, Math.min(1, v));
  const smooth = v => { const q = unit(v); return q * q * (3 - 2 * q); };
  const between = (v, s, e) => unit((v - s) / (e - s));
  function advanceMemoryProgress(progress, target, velocity, fr, strength, damping) {
    const speed = (velocity + (target - progress) * strength * fr) * Math.pow(damping, fr);
    const candidate = progress + speed * fr;
    const next = Math.max(Math.min(progress, target), Math.min(Math.max(progress, target), candidate));
    return { progress: next, velocity: next === candidate ? speed : 0 };
  }
  function getMemoryFrame(i, fill, intro) {
    const s = MEMORY_TIMELINE[i]; if (!s) return null;
    const persistent = !!s.persistent;
    const local = between(fill, s.start, persistent ? 1 : s.end);
    const leave = persistent ? 1 - smooth(between(intro, .025, .23)) : 1 - smooth(between(fill, s.leaveStart, s.end));
    const opacity = smooth(between(fill, s.start, s.enterEnd)) * leave;
    const approach = i === 7, impact = i === 4 ? Math.sin(local * Math.PI * 4) * (1 - local) : 0;
    return {
      opacity,
      scale: REDUCED ? 1.02 : approach ? 1.035 + local * .245 : 1.035 + local * .012,
      shiftX: REDUCED ? 0 : (local - .5) * s.drift + impact * 3,
      shiftY: REDUCED ? 0 : s.lift * local + impact * 1.5
    };
  }
  function getMemoryBlackout(fill, intro) {
    if (intro > 0 || fill <= .735 || fill >= .975) return 0;
    const close = smooth(between(fill, .735, .825));
    const open = 1 - smooth(between(fill, .87, .975));
    return close * open * (REDUCED ? .3 : 1);
  }

  const Memory = (() => {
    /* ★ 优先接管 index.html 里那个占位节点。
       它的高度（186vh）在第一帧就占住了位置，所以往里面填内容不会引起位移；
       只有占位不存在时（比如被别的宿主裁掉过）才自己建一个再插。 */
    const host = document.getElementById('mj-memory') || el('section');
    if (!host.id) host.id = 'mj-memory';
    if (!host.getAttribute('aria-label')) host.setAttribute('aria-label', 'Opening Memory');
    host.innerHTML = `
      <div class="stage">
        <div class="mj-mem-bar"><i id="mjMemBar"></i></div>
        <div id="mjMemLayers"></div>
        <div id="mjMemObjects"></div>
        <div id="mj-blackout"></div>
        <p id="mj-mem-cap"></p>
        <p id="mj-mem-hint">向下滚动 · 记忆开始播放</p>
        <div class="mem-picker" id="mjScenePicker">
          <span class="mem-picker-t">换这一幕的照片</span>
          <span class="mem-picker-row" id="mjSceneRow"></span>
          <!-- ★ 明确告诉操作者"现在正在改哪一张、它长什么样"。
               只给 1–5 号圆点的话，根本不知道它对应幕里的哪张、更不知道墙上哪张照片会跟着变。 -->
          <span class="mem-picker-now" id="mjSceneNow"></span>
          <span class="mem-picker-row">
            <button class="ed-add" type="button" id="mjScenePick">选择图片…</button>
            <button class="ed-add" type="button" id="mjSceneReset">全部用回默认</button>
          </span>
        </div>
      </div>`;
    /* 占位节点本来就在正确的位置上，就不要再搬它一次（搬动 = 一次重排） */
    if (!host.parentNode) {
      const banner = $('#banner-wrapper');
      if (banner && banner.parentNode) banner.parentNode.insertBefore(host, banner.nextSibling);
      else document.body.appendChild(host);
    }

    const layersHost = $('#mjMemLayers', host), objHost = $('#mjMemObjects', host);
    const blackout = $('#mj-blackout', host), cap = $('#mj-mem-cap', host), hint = $('#mj-mem-hint', host), bar = $('#mjMemBar', host);

    /* 用户换成自己的照片后场景图、照片墙都跟着换，存在 State.sceneImgs。
       没换过就用默认图。照片墙的每一项带 scene 字段，和对应那一幕共用替换图。 */
    const sceneImg = (i, fallback) => (State.read().sceneImgs || {})[i] || fallback;

    MEMORY_SCENES.forEach((sc, i) => {
      const c = elById(sc.el).c;
      const l = el('div', 'mj-mem-layer');
      // 图片不在这里落地：5 张全屏图同时进渲染树是最贵的资源。
      // 改为按当前幕位置懒挂背景图，最多同时保留 3 张。
      l.dataset.img = sceneImg(i, sc.img);
      l.dataset.pos = sc.pos;
      l.innerHTML = `<div class="shot"></div><div class="tint" style="--sc:${c}"></div><div class="vig"></div>`;
      layersHost.appendChild(l);
    });
    const layers = $$('.mj-mem-layer', layersHost);
    /* ★ 必须显式取到舞台元素：进度公式要用它的 offsetHeight 和 sticky top。
       之前这里漏了声明，`stage.offsetHeight` 抛 ReferenceError，
       而 Raf.add 会吞掉回调异常 —— 表现为"进度条永远是 0%、照片墙不揭示"，
       控制台还完全干净，非常难查。 */
    const stage = $('.stage', host);

    const got = new Set(State.read().objects || []);

    /* 照片墙「走过的地方」：6 张横向不规则摆放的照片，之间用线相连（像一条走过路线）。
       未解锁的灰暗模糊，解锁后显色，收取后盖 ✓。 */
    const wallBox = el('div', 'mj-wall-box');
    wallBox.innerHTML = `<div class="mj-wall-title"><span class="en">PLACES I'VE BEEN</span>走过的地方</div>`;
    const wall = el('div', 'mj-wall');
    wall.id = 'mjPhotoWall';
    // 连线层：画在所有照片之下
    const SVGNS = 'http://www.w3.org/2000/svg';
    const lineSvg = document.createElementNS(SVGNS, 'svg');
    lineSvg.setAttribute('class', 'mj-wall-line');
    lineSvg.setAttribute('aria-hidden', 'true');
    const linePath = document.createElementNS(SVGNS, 'path');
    linePath.setAttribute('fill', 'none');
    lineSvg.appendChild(linePath);
    wall.appendChild(lineSvg);
    wallBox.appendChild(wall);
    objHost.appendChild(wallBox);

    /* 用户换成自己的照片后，场景图和照片墙都跟着换。
       存储在 State.sceneImgs = { <场景序号>: dataURL }，与默认图并存 ——
       没换过就用默认，换过就用用户的。照片墙的每一项带 scene 字段，
       所以它和对应那一幕共用同一张替换图。 */
    const shotFor = o => sceneImg(o.scene, o.img);

    const objects = RELEASE_TRACK.map((o, i) => {
      const n = el('button', 'mj-wall-photo locked');
      n.type = 'button';
      n.dataset.cursor = o.label;
      n.setAttribute('aria-label', o.label + '（未解锁）');
      // 不规则：随机竖向偏移 + 轻微旋转，形成"贴了一墙"的错落感
      const seed = (i * 2654435761) % 1000 / 1000;
      const seed2 = (i * 40503 + 7) % 997 / 997;
      n.style.setProperty('--dy', Math.round(seed * 48 - 24) + 'px');
      n.style.setProperty('--rot', (seed2 * 11 - 5.5).toFixed(1) + 'deg');
      n.style.setProperty('--delay', (i * 55) + 'ms');
      // 底部不再放文字说明：名称只留在 aria-label 里，视觉上只有照片本身
      n.innerHTML = `<span class="ph" style="background-image:url('${shotFor(o)}')"></span>`;
      n.addEventListener('click', () => {
        if (n.classList.contains('locked') || n.classList.contains('got')) return;
        n.classList.add('got');
        n.setAttribute('aria-label', o.label + '（已收取）');
        got.add(i);
        if (o.clue) Achievements.findClue(o.clue, o.label);
        else if (o.kind === 'reward') Achievements.unlock('reward');
        else Achievements.unlock('photo');
        if (got.size === RELEASE_TRACK.length) Achievements.unlock('collector');
        State.write({ objects: [...got] });
        const r = n.getBoundingClientRect();
        MangaFX.burst(r.left + r.width / 2, r.top + r.height / 2);
      });
      wall.appendChild(n);
      return n;
    });
    // 已收集的直接进入 released + got：只加 got 会跳过揭示过渡，两个状态不一致
    got.forEach(i => { if (objects[i]) { objects[i].classList.add('show', 'got'); objects[i].classList.remove('locked'); } });

    /* 连线：穿过已点亮照片的中心，形成一条"走过的路线"。
       旋转后的 getBoundingClientRect 是外接矩形，但中心仍是视觉中心，可直接用。 */
    let lineRaf = 0, lineTimer = 0;
    function drawLine() {
      const shown = objects.filter(n => n.classList.contains('show'));
      if (shown.length < 2) { linePath.setAttribute('d', ''); return; }
      const wr = wall.getBoundingClientRect();
      lineSvg.setAttribute('viewBox', `0 0 ${Math.round(wr.width)} ${Math.round(wr.height)}`);
      const pts = shown.map(n => {
        const r = n.getBoundingClientRect();
        return { x: r.left - wr.left + r.width / 2, y: r.top - wr.top + r.height * .42 };
      });
      let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], mx = (a.x + b.x) / 2;
        d += ` C ${mx.toFixed(1)} ${a.y.toFixed(1)}, ${mx.toFixed(1)} ${b.y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      }
      linePath.setAttribute('d', d);
    }
    // 照片有 0.65s 过渡，等落位后再量；双 rAF 保证读到最终布局
    const scheduleLine = () => {
      cancelAnimationFrame(lineRaf); clearTimeout(lineTimer);
      lineRaf = requestAnimationFrame(() => requestAnimationFrame(drawLine));
      lineTimer = setTimeout(drawLine, 760);
    };
    addEventListener('resize', scheduleLine);
    scheduleLine();

    let target = 0, progress = 0, velocity = 0, intro = 1, last = 0, activeIdx = -1, dirty = true, painted = -1;
    const released = new Set(got);
    let pickerRow = null, pickIdx = 0;

    /* ---------- 场景照片替换 ----------
       5 幕各有一张默认图，用户点一下就能换成自己的照片。
       换过之后：这一幕的全屏图 + 照片墙里属于这一幕的那张，一起换掉。
       图统一压到 1600px / q0.82 再存（太大会撑爆 localStorage 配额）。 */
    (function setupScenePicker() {
      const host2 = $('#mjScenePicker', host);
      pickerRow = $('#mjSceneRow', host);
      const nowEl = $('#mjSceneNow', host);
      if (!host2 || !pickerRow) return;
      pickerRow.innerHTML = MEMORY_SCENES.map((sc, i) =>
        `<button class="mem-dot" type="button" data-sc="${i}" title="第 ${i + 1} 幕 · ${String(sc.cap || '').replace(/^\s*第\s*\d+\s*幕\s*·\s*/, '')}" aria-label="选择第 ${i + 1} 幕">${i + 1}</button>`).join('');
      const savedMap = () => State.read().sceneImgs || {};
      const refresh = () => {
        const saved = savedMap();
        $$('button', pickerRow).forEach((b, i) => b.classList.toggle('has', !!saved[i]));
      };
      /* 把"正在改哪一幕 / 它现在是什么图 / 墙上哪几张会跟着变"讲清楚 */
      const capOf = sc => String(sc.cap || '').replace(/^\s*第\s*\d+\s*幕\s*·\s*/, '');
      const paintNow = () => {
        if (!nowEl) return;
        const sc = MEMORY_SCENES[pickIdx] || {};
        const saved = !!savedMap()[pickIdx];
        const wallIdx = RELEASE_TRACK.map((o, i) => (o && o.scene === pickIdx ? i : -1)).filter(i => i >= 0);
        nowEl.innerHTML = '';
        const thumb = document.createElement('img');
        thumb.className = 'mem-now-thumb';
        thumb.alt = '';
        thumb.src = sceneImg(pickIdx, sc.img);
        const txt = document.createElement('span');
        txt.className = 'mem-now-txt';
        // 种子里的 cap 自带"第 01 幕 ·"前缀，这里去掉，免得和前面的"第 N 幕"重复
        const cap = capOf(sc);
        txt.textContent = '正在改：第 ' + (pickIdx + 1) + ' 幕'
          + (cap ? ' · ' + cap : '')
          + (wallIdx.length ? '（照片墙第 ' + wallIdx.map(i => i + 1).join('、') + ' 张会一起换）' : '')
          + (saved ? ' · 已换成你自己的图' : ' · 当前是默认图');
        nowEl.append(thumb, txt);
      };
      refresh(); paintNow();
      host2.addEventListener('click', e => {
        const dot = e.target.closest('[data-sc]');
        if (dot) {
          pickIdx = +dot.dataset.sc;
          $$('button', pickerRow).forEach(b => b.classList.toggle('sel', b === dot));
          paintNow();
          return;
        }
        if (e.target.closest('#mjScenePick')) {
          const target = pickIdx;            // 记住点"选择图片"时选中的是哪一幕
          const sc = MEMORY_SCENES[target] || {};
          pickImage({ maxSide: 1600, quality: .82, label: '选择第 ' + (target + 1) + ' 幕的照片' }, (url, cancelled) => {
            if (cancelled) return;
            if (!url) { alert('这张图读不出来，换一张试试。'); return; }
            const m = Object.assign({}, State.read().sceneImgs || {});
            m[target] = url;
            State.write({ sceneImgs: m });
            applyScene(target, url);
            refresh(); paintNow();
            const wallIdx = RELEASE_TRACK.map((o, i) => (o && o.scene === target ? i : -1)).filter(i => i >= 0);
            Achievements.toast('★', '第 ' + (target + 1) + ' 幕已换图',
              (capOf(sc) ? capOf(sc) + '　' : '') + (wallIdx.length ? '照片墙第 ' + wallIdx.map(i => i + 1).join('、') + ' 张同步换好了' : '照片墙没有对应项'));
          });
          return;
        }
        if (e.target.closest('#mjSceneReset')) {
          State.write({ sceneImgs: {} });
          MEMORY_SCENES.forEach((sc, i) => applyScene(i, sc.img));
          $$('.mj-wall-photo', wall).forEach((n, i) => {
            const o = RELEASE_TRACK[i]; if (!o) return;
            const ph = $('.ph', n); if (ph) ph.style.backgroundImage = `url('${o.img}')`;
          });
          refresh(); paintNow();
        }
      });
      $$('button', pickerRow)[0].classList.add('sel');
    })();

    /* 把某一幕换成指定图片：同时更新图层缓存与已挂载的 background-image */
    function applyScene(i, url) {
      const L = layers[i];
      if (L) {
        L.dataset.img = url;
        const shot = L.firstElementChild;
        if (shot && shot.dataset.on) {
          shot.style.backgroundImage = `url("${url}")`;
          shot.style.backgroundPosition = L.dataset.pos;
        }
      }
      // 照片墙里属于这一幕的项一起换
      $$('.mj-wall-photo', wall).forEach((n, k) => {
        const o = RELEASE_TRACK[k]; if (!o || o.scene !== i) return;
        const ph = $('.ph', n); if (ph) ph.style.backgroundImage = `url('${url}')`;
      });
    }

    // 滚动只置脏标记；真正的布局读取挪到帧内，避免每个 scroll 事件都强制重排
    function measure() { dirty = true; }
    function frame(now) {
      if (dirty) {
        dirty = false;
        /* 进度 = 舞台被钉住后滚了多远 / 可钉住的总长度。
           舞台 sticky 在 top: var(--nav-h)，所以板块顶边从导航栏下沿一路走到
           −(板块高 − 舞台高) 的过程，就是"模块内叙事"播放的全过程；
           走完之后板块才继续上移（模块间滚动）。 */
        const r = host.getBoundingClientRect();
        const range = r.height - stage.offsetHeight;
        const top = parseFloat(getComputedStyle(stage).top) || 0;
        target = range > 0 ? unit((top - r.top) / range) : 0;
      }
      if (!last) last = now;
      const dt = Math.min(50, now - last); last = now;
      /* ★ 关键：直接采用滚动算出的 target，不再过 advanceMemoryProgress 那层弹簧。
         原来弹簧有阻尼滞后，手已经滚过去了画面还在追 —— 那才是"两套滚动打架"的来源。 */
      progress = target; velocity = 0;
      if (intro > 0) intro = Math.max(0, intro - dt / 1400);

      // 静止时不再写 DOM：这是本页最贵的一段循环
      if (Math.abs(progress - painted) < .0004 && intro > 0) return;
      painted = progress;
      const fill = progress;

      for (let i = 0; i < layers.length; i++) {
        const f = getMemoryFrame(i, fill, intro); if (!f) continue;
        const L = layers[i];
        // 不可见图层直接退出渲染树，避免 9 张全屏图一起参与合成
        const vis = f.opacity > .008 ? '' : 'hidden';
        if (L.style.visibility !== vis) L.style.visibility = vis;
        if (vis) continue;
        L.style.opacity = f.opacity.toFixed(3);
        L.style.transform = `translate3d(${f.shiftX.toFixed(2)}px,${f.shiftY.toFixed(2)}px,0) scale(${f.scale.toFixed(4)})`;
      }
      blackout.style.opacity = getMemoryBlackout(fill, intro).toFixed(3);
      bar.style.width = (fill * 100).toFixed(1) + '%';

      let idx = -1;
      for (let i = MEMORY_TIMELINE.length - 1; i >= 0; i--) if (fill >= MEMORY_TIMELINE[i].start) { idx = i; break; }
      if (idx !== activeIdx) {
        activeIdx = idx;
        if (idx >= 0) { cap.textContent = MEMORY_SCENES[idx].cap; cap.classList.add('on'); }
        else cap.classList.remove('on');
        if (pickerRow) $$('button', pickerRow).forEach((b, i) => {
          b.classList.toggle('on', i === idx);
          b.setAttribute('aria-current', String(i === idx));
        });
      }
      // 图片虚拟化：只让当前位置前后各一幕持有背景图，其余释放
      layers.forEach((L, i) => {
        const shot = L.firstElementChild;
        if (Math.abs(i - idx) <= 1 && idx >= 0) {
          if (!shot.dataset.on) {
            shot.style.backgroundImage = `url("${L.dataset.img}")`;
            shot.style.backgroundPosition = L.dataset.pos;
            shot.dataset.on = '1';
          }
        } else if (shot.dataset.on) {
          shot.style.backgroundImage = 'none';
          delete shot.dataset.on;
        }
      });
      hint.textContent = fill >= .995 ? '记忆播放完毕 · 继续向下' : '向下滚动 · 记忆开始播放';

      const clock = fill * MEDIA_DURATION;
      RELEASE_TRACK.forEach((o, i) => {
        if (released.has(i) || clock < o.at) return;
        released.add(i);
        const n = objects[i];
        n.classList.remove('locked');
        n.classList.add('show');
        n.setAttribute('aria-label', o.label + '（可收取）');
        scheduleLine();
      });
    }
    addEventListener('scroll', measure, { passive: true });
    addEventListener('resize', measure);
    // 只在记忆区进入视口时挂载循环，离开立即摘除
    const offVis = whenVisible(host, () => { last = 0; painted = -1; dirty = true; return Raf.add(frame); });
    measure();

    const destroy = () => {
      offVis();
      removeEventListener('scroll', measure); removeEventListener('resize', measure);
      removeEventListener('resize', scheduleLine);
      cancelAnimationFrame(lineRaf); clearTimeout(lineTimer);
      host.remove();
    };
    onPageGone(destroy);
    return { host, remeasure: measure, destroy };
  })();

  /* ============================================================
     6. 成就 / 线索 / 隐藏奖励
     ============================================================ */
  const Achievements = (() => {
    const ACH = [
      { id: 'gate', n: '开场已过', d: '亲手开启了这一页' },
      { id: 'photo', n: '拾起照片', d: '在记忆里点开一张照片' },
      { id: 'reward', n: '意外收获', d: '发现了隐藏奖励' },
      { id: 'collector', n: '记忆收藏家', d: '收齐记忆里的可交互物' },
      { id: 'cutter', n: '看完每一支片子', d: '把作品集里的作品逐个打开看过' },
      { id: 'matcher', n: '全部配对', d: '翻牌配对翻完七对元素' },
      { id: 'archivist', n: '档案管理员', d: '用检索找到目标文章' }
    ];
    const CLUES = [{ k: 'A', n: '嫉妒舞台' }, { k: 'B', n: '飞来之物' }, { k: 'C', n: '寻找自我' }, { k: 'D', n: '开场彩蛋' }, { k: 'E', n: '记忆归还' }];
    const s = State.read();
    const got = new Set(s.ach || []), clues = new Set(s.clues || []);

    const toasts = el('div'); toasts.id = 'mj-toasts'; document.body.appendChild(toasts);
    const panel = el('div', 'closed'); panel.id = 'mj-panel';
    panel.innerHTML = `<div class="mj-panel-title">探索进度</div><div class="sub" id="mjPanelSub">还没有开始探索</div>
      <div class="mj-achs" id="mjAchs"></div><div class="mj-clues" id="mjClues"></div>`;
    document.body.appendChild(panel);

    // HUD 按钮：挂在既有 #floating-controls 里，与既有按钮同风格
    const cnt = el('span', 'cnt'); cnt.textContent = '0/6';
    const hudBtn = el('button', 'icon-btn mj-hudbtn');
    hudBtn.id = 'mjHud';
    hudBtn.type = 'button';
    const glyph = el('span', '', '✦'); glyph.setAttribute('aria-hidden', 'true');
    hudBtn.appendChild(glyph);
    hudBtn.appendChild(cnt);
    const fc = $('#floating-controls');
    if (fc) fc.insertBefore(hudBtn, fc.firstChild); else document.body.appendChild(hudBtn);

    function render() {
      cnt.textContent = got.size + '/6';
      // 可见文字必须包含在可访问名称里（label-content-name-mismatch）
      hudBtn.setAttribute('aria-label', `探索进度 ${got.size}/6`);
      hudBtn.setAttribute('aria-expanded', String(!panel.classList.contains('closed')));
      $('#mjPanelSub', panel).textContent = got.size ? `已解锁 ${got.size} 项 · 线索 ${clues.size}/5` : '还没有开始探索';
      $('#mjAchs', panel).innerHTML = ACH.map(a => `<div class="mj-ach ${got.has(a.id) ? 'got' : ''}"><span class="d">${got.has(a.id) ? '✓' : ''}</span><span>${a.n}</span></div>`).join('');
      $('#mjClues', panel).innerHTML = CLUES.map(c => `<span class="k ${clues.has(c.k) ? 'found' : ''}">${clues.has(c.k) ? '◆' : '◇'} ${c.k} · ${clues.has(c.k) ? c.n : '未发现'}</span>`).join('');
      if (clues.size >= 5 && !panel.dataset.done) { panel.dataset.done = '1'; toast('✦', '隐藏章节已开启', '记忆归还 · 五条线索集齐'); }
    }
    function toast(ic, title, sub) {
      const t = el('div', 'mj-toast', `<span class="ic">${ic}</span><span><b>${title}</b>${sub ? `<span>${sub}</span>` : ''}</span>`);
      toasts.appendChild(t);
      requestAnimationFrame(() => t.classList.add('in'));
      setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 500); }, 3300);
    }
    function unlock(id) {
      if (got.has(id)) return; got.add(id); State.write({ ach: [...got] });
      const a = ACH.find(x => x.id === id); if (a) toast('★', a.n, a.d);
      render();
    }
    function findClue(k, label) {
      if (clues.has(k)) return; clues.add(k); State.write({ clues: [...clues] });
      toast('◆', '线索 ' + k, label || ''); render();
    }
    const onHud = () => { const c = panel.classList.toggle('closed'); hudBtn.setAttribute('aria-expanded', String(!c)); };
    hudBtn.addEventListener('click', onHud);
    const onDoc = e => { if (!panel.classList.contains('closed') && !panel.contains(e.target) && !hudBtn.contains(e.target)) { panel.classList.add('closed'); hudBtn.setAttribute('aria-expanded', 'false'); } };
    document.addEventListener('click', onDoc);
    render();
    return { unlock, findClue, toast, got, clues };
  })();

  /* ============================================================
     6.5 漫画集中線：交互时从事件点炸开
     输入：屏幕坐标   输出：一次性径向动线   清理：动画结束自动移除
     ============================================================ */
  const MangaFX = (() => {
    if (REDUCED) return { burst() {} };
    function burst(x, y) {
      const d = el('div', 'mj-burst');
      d.setAttribute('aria-hidden', 'true');
      d.style.left = x + 'px';
      d.style.top = y + 'px';
      document.body.appendChild(d);
      setTimeout(() => d.remove(), 720);
    }
    return { burst };
  })();

  /* ============================================================
     7. 内容数据：从既有 DOM 读取，保证单一真实来源
     ============================================================ */
  /* 分类由标签推导（内容仍以既有 DOM 为唯一来源，不额外维护一份数据）。
     三档都是生活向的，不绑定任何专业领域。 */
  const CAT_LIFE = ['生活', '日常', '随笔', '日记', '心情', '手帐', '散步'];
  const CAT_FOOD = ['料理', '食谱', '厨房', '烘焙', '咖啡', '吃'];
  function deriveCat(tags) {
    if (tags.some(t => CAT_FOOD.indexOf(t) > -1)) return 'food';
    if (tags.some(t => CAT_LIFE.indexOf(t) > -1)) return 'life';
    return 'note';
  }
  function readPostsFromDOM() {
    const cards = $$('#post-list .post-card');
    const out = cards.map((c, i) => {
      const tags = $$('.post-tags .chip', c).map(t => t.textContent.trim());
      return {
        i,
        slug: 'post-' + i,
        title: ($('.post-title', c) || {}).textContent?.trim() || ('文章 ' + (i + 1)),
        desc: ($('.post-desc', c) || {}).textContent?.trim() || '',
        cover: ($('.post-cover img', c) || {}).getAttribute?.('src') || 'assets/paper/bg-03.svg',
        tags,
        cat: deriveCat(tags),
        date: ($('.post-meta .m', c) || {}).textContent?.trim() || '',
        pinned: !!$('.post-pinned', c)
      };
    });
    if (out.length) return out;
    return [{ i: 0, slug: 'post-0', title: '示例文章', desc: '正文待补充。', cover: 'assets/paper/bg-03.svg', tags: [], cat: 'tech', date: '2026-01-01', pinned: false }];
  }
  const POSTS = readPostsFromDOM();
  /* 四篇都是"普通人也会遇到的生活小事"，不指向任何专业领域，
     这样首页对谁都读得通 —— 换成自己的内容时直接改卡片即可。 */
  const ARTICLE_BODIES = {
    0: [['h2', '先别急着买家具'], ['p', '刚搬进来那阵子，我列了一张很长的购物清单，后来发现真正需要的只有三样：一张能放下电脑的桌子、一把坐得住的椅子、一盏不刺眼的灯。剩下的都是住进去之后才会慢慢知道自己要不要。'], ['h2', '光从哪边进来，比什么都重要'], ['p', '第一周我把桌子靠着唯一的插座放，结果下午屏幕反光，什么都看不清。第二周把它挪到侧面，光线从左手边过来，整个下午都能安静坐着。桌子的位置其实是光决定的，不是插座。'], ['h2', '留一块空地'], ['p', '房间最舒服的地方往往是那块什么都没放的空地。它让房间有呼吸的余地，也让你在搬动东西时有余地。'], ['blockquote', '住得舒服的房间不是"布置完的"，是"还在变的"。']],
    1: [['h2', '我把闹钟放到了床以外'], ['p', '试过提前睡、试过睡前不看手机、试过给自己设奖励，全都没用。真正管用的只有一条：把闹钟放在必须下床才能关的地方。起身那一下是整件事的转折点，剩下的就顺了。'], ['h2', '早上那半小时做什么'], ['p', '不要安排难的事。我的顺序是：拉开窗帘、烧水、把昨天没洗的杯子洗掉。三件都很小，但做完之后会有一种"今天已经开始了"的感觉，这一天就不太容易垮掉。'], ['h2', '允许自己失败'], ['p', '一个月里能做到二十天就算成功。剩下那十天睡过去也没关系，第二天照旧——比"连续打卡"更重要的是不把断掉当成结束。'], ['blockquote', '早起不是为了多做事，是为了让一天开始得不慌。']],
    2: [['h2', '它不像在讲道理'], ['p', '有些书急着告诉你结论，这本不是。它更像是把一件事慢慢摊开给你看，看着看着你自己就明白了。读的时候我几次停下来，不是因为难，是因为想再看看那句话。'], ['h2', '我在最后一章停了很久'], ['p', '最后一章讲的是"结束"。看完那一段我合上书坐了一会儿，没有立刻翻回去找笔记——那种想再看一遍、又舍不得读完的感觉，很久没有过了。'], ['h2', '怎么记一本这样的书'], ['p', '不抄句子。只写"我在哪一页停了下来、为什么停"。过半年再看这几行，比看一堆摘抄有用得多。'], ['blockquote', '摘抄记的是作者说了什么；停下来的地方记的是你当时在哪里。']],
    3: [['h2', '不用守着锅'], ['p', '慢炖的好处是把"看着火"这件事从流程里去掉了。材料切好放进去，盖上盖子，两个小时之后它自己就好了。中间那两小时可以做别的事，也可以什么都不做。'], ['h2', '配比与时间'], ['p', '我的基本盘是：肉先煎到上色、加水没过、小火两小时，最后十五分钟再放盐。盐早放肉会紧，这是失败两次之后才记住的。根茎类一起下，绿叶类最后五分钟再放。'], ['h2', '一次做两顿的量'], ['p', '慢炖的时间成本主要在"等"上，做一份和做两份几乎没差别。第二份放凉冷藏，第二天热一下就能吃——这是这道菜真正省事的地方。'], ['blockquote', '把火关小，让时间替你干活。']]
  };

  /* ============================================================
     7.5 文案自定义（Editable）
     站内所有"栏目说明"和"关于"页的条目都可以就地改，改完存进 mj_state.edits。
     两种用法：
       1) 自动绑定：给元素加 data-ed="key"，Editable.applyAll() 会用覆盖值回填并挂上编辑行为；
       2) 主动取值：Editable.get(key, default)，用于 JS 里拼的模板（比如关于页的条目）。
     ============================================================ */
  const Editable = (() => {
    const bag = () => State.read().edits || {};
    const get = (key, fallback) => {
      const v = bag()[key];
      return (v === undefined || v === '') ? fallback : v;
    };
    const set = (key, val) => {
      const m = Object.assign({}, bag());
      if (val === undefined || val === null) delete m[key]; else m[key] = String(val);
      State.write({ edits: m });
    };
    const resetAll = () => { State.write({ edits: {} }); return location.reload(); };
    const pencil = '<span class="ed-pen" aria-hidden="true">✎</span>';

    /* 把元素变成"点一下就能改"的可编辑文本 */
    function bind(el, key) {
      if (!el || el.dataset.edBound === '1') return;
      el.dataset.edBound = '1';
      el.classList.add('mj-editable');
      el.title = '点击修改这段文字';
      /* 不要给这些元素挂 role="textbox"：它们本身是 h2/h3/span，
         硬套 textbox 会被无障碍审计判成"角色不当"（ARIA role should be appropriate）。
         改为保留原生语义 + tabindex + aria-label，键盘按回车/空格同样能进入编辑。 */
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', (el.textContent || '').replace('✎', '').trim().slice(0, 24) + '，按回车可修改');
      if (!el.querySelector(':scope > .ed-pen')) el.insertAdjacentHTML('beforeend', pencil);

      const raw = () => el.textContent.replace('✎', '').trim();
      const enter = () => {
        if (el.isContentEditable) return;
        el.dataset.edPrev = raw();
        el.contentEditable = 'true';
        el.classList.add('ed-on');
        document.dispatchEvent(new Event('mj-editing-start'));
        el.focus();
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      };
      const commit = () => {
        if (!el.isContentEditable) return;
        el.contentEditable = 'false';
        el.classList.remove('ed-on');
        document.dispatchEvent(new Event('mj-editing-end'));
        const v = raw();
        if (v && v !== el.dataset.edPrev) { set(key, v); el.classList.add('ed-saved'); setTimeout(() => el.classList.remove('ed-saved'), 700); }
      };
      el.addEventListener('click', e => { if (e.target.closest('.ed-pen') || !el.isContentEditable) { e.preventDefault(); e.stopPropagation(); enter(); } });
      el.addEventListener('blur', commit);
      el.addEventListener('keydown', e => {
        if (!el.isContentEditable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enter(); return; }
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.textContent = el.dataset.edPrev || ''; el.insertAdjacentHTML('beforeend', pencil); el.blur(); }
        e.stopPropagation();
      });
    }

    /* 自动给"每个栏目的标题 / 说明"挂上可编辑：
       - 首页主副标题  #banner-text h1 / .subs span → banner.title / banner.sub1 / banner.sub2
       - 视图标题   .list-bar .lb-title      → view.<view>.title
       - 视图说明   .list-bar .mj-stat       → view.<view>.desc
       - 侧栏栏目   .widget-head             → widget.<序号>.<原标题>  */
    function applyAll() {
      const edits = bag();
      // 首页大标题与副标题
      const bt = $('#banner-text');
      if (bt) {
        const h1 = $('h1', bt);
        // 只取 .subs 的直接子 span：里面还有装饰用的嵌套 span，用后代选择器会误绑
        const subs = $$('.subs > span', bt);
        if (h1) { const k = 'banner.title'; if (edits[k]) h1.textContent = edits[k]; bind(h1, k); }
        subs.forEach((s, i) => { const k = 'banner.sub' + (i + 1); if (edits[k]) s.textContent = edits[k]; bind(s, k); });
      }
      $$('.mj-view').forEach(v => {
        const view = v.dataset.view || 'x';
        const lb = $('.list-bar', v);
        if (!lb) return;
        const t = $('.lb-title', lb), d = $('.mj-stat', lb);
        if (t) { const k = 'view.' + view + '.title'; if (edits[k]) t.textContent = edits[k]; bind(t, k); }
        if (d) { const k = 'view.' + view + '.desc'; if (edits[k]) d.textContent = edits[k]; bind(d, k); }
      });
      $$('.widget-head').forEach((h, i) => {
        const label = h.querySelector('.ed-label') || h;
        const def = (label.textContent || '').trim();
        const k = 'widget.' + i + '.' + def.slice(0, 8);
        if (edits[k]) label.textContent = edits[k];
        label.dataset.edDefault = def;
        bind(label, k);
      });
      $$('[data-ed]').forEach(el => {
        const k = el.dataset.ed;
        const def = el.dataset.edDefault || (el.textContent || '').trim();
        el.dataset.edDefault = def;
        if (edits[k]) el.textContent = edits[k];
        bind(el, k);
      });
    }
    return { get, set, bind, applyAll, resetAll, all: bag };
  })();

  /* ============================================================
     7.6 可增删的条目列表（EdList）
     上一版只能改文字，不能加/删条目。这里给"会变长的内容"一套统一模型：
     数据存 State.lists[name]，渲染由各处的 render 负责，
     增/删/改都写回数组，所以条目数量本身也是数据的一部分。
     界面用统一的小控件：[+] 新增，[×] 删除，文字点一下就地改。
     ============================================================ */
  const EdList = (() => {
    const all = () => State.read().lists || {};
    const seedOf = seed => (typeof seed === 'function' ? seed() : seed);
    /* 取/存"某个名字下的一段数组"。
       不传 section 时，这个名字本身就是数组（公告、标签）；
       传了 section 时，这个名字下是一个对象，各 section 是数组（关于页的 5 个区块）。 */
    const get = (name, seed, section) => {
      const v = all()[name];
      const base = (v === undefined) ? seedOf(seed) : v;
      if (!section) return Array.isArray(base) ? base : seedOf(seed);
      const sec = base && base[section];
      return Array.isArray(sec) ? sec : seedOf(seed)[section] || [];
    };
    const setSec = (name, seed, section, arr) => {
      const m = Object.assign({}, all());
      if (!section) { m[name] = arr; }
      else {
        const cur = all()[name];
        const base = Object.assign({}, (cur === undefined ? seedOf(seed) : cur));
        base[section] = arr;
        m[name] = base;
      }
      State.write({ lists: m });
      return arr;
    };
    const reset = (name, section) => {
      const m = Object.assign({}, all());
      if (!section) delete m[name];
      else { const base = Object.assign({}, m[name] || {}); delete base[section]; m[name] = base; }
      State.write({ lists: m });
    };
    /* extra：可选的额外按钮，插在 ＋/× 前面（友链用它放"换回色块"）。
       放在同一个 .ed-tools 里，就能共用悬停显形和 24×24 的点击区，
       不用再为它写一条新的显形规则。 */
    const tools = (name, i, section, extra) => `
      <span class="ed-tools">
        ${extra || ''}
        <button class="ed-mini" type="button" data-ed-add="${name}" data-i="${i}"${section ? ` data-sec="${section}"` : ''} title="在这条后面插入一条" aria-label="新增一条">＋</button>
        <button class="ed-mini danger" type="button" data-ed-del="${name}" data-i="${i}"${section ? ` data-sec="${section}"` : ''} title="删除这条" aria-label="删除这一条">×</button>
      </span>`;
    const blankFor = sample => {
      if (Array.isArray(sample)) return sample.map(() => '');
      if (sample && typeof sample === 'object') { const o = {}; Object.keys(sample).forEach(k => o[k] = ''); return o; }
      return '';
    };
    /* 统一的增删处理；SEEDS 由调用方通过 register 注入，用于"第一次新增"时的样板 */
    const SEEDS = {};
    const register = (name, seed) => { SEEDS[name] = seed; };
    const handle = (e, rerender) => {
      const add = e.target.closest('[data-ed-add]');
      const del = e.target.closest('[data-ed-del]');
      if (!add && !del) return false;
      const btn = add || del;
      const name = add ? add.dataset.edAdd : del.dataset.edDel;
      const section = btn.dataset.sec || null;
      const i = +btn.dataset.i;
      const seed = SEEDS[name] || (() => []);
      const arr = get(name, seed, section).slice();
      if (add) {
        // 第一次新增时用一条空白样板；否则照抄相邻那条的结构
        const sample = arr.length ? arr[Math.min(Math.max(i, 0), arr.length - 1)] : blankFor(seedOf(seed));
        arr.splice(arr.length ? i + 1 : 0, 0, blankFor(sample));
        setSec(name, seed, section, arr);
      } else {
        if (arr.length <= 1) { Achievements.toast('◆', '至少留一条', '不然这块就空了'); return true; }
        arr.splice(i, 1);
        setSec(name, seed, section, arr);
      }
      rerender(name, section);
      return true;
    };
    /* 让某个文本节点可编辑并写回数组。
       apply(arr, value) 负责把新值放到正确位置 —— 行式条目 [键, 值] 和
       字符串条目共用同一个入口，不需要分支。 */
    function bindItem(el, name, seed, section, idx, apply) {
      if (!el || el.dataset.edBound === '1') return;
      el.dataset.edBound = '1';
      el.classList.add('mj-editable');
      el.title = '点击修改';
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      el.setAttribute('aria-label', (el.textContent || '').replace('✎', '').trim().slice(0, 20) + '，按回车可修改');
      const read = () => (el.textContent || '').replace('✎', '').trim();
      const enter = () => {
        if (el.isContentEditable) return;
        el.dataset.edPrev = read();
        el.contentEditable = 'true';
        el.classList.add('ed-on');
        document.dispatchEvent(new Event('mj-editing-start'));
        el.focus();
        const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      };
      const commit = () => {
        if (!el.isContentEditable) return;
        el.contentEditable = 'false';
        el.classList.remove('ed-on');
        document.dispatchEvent(new Event('mj-editing-end'));
        const v = read();
        if (v === el.dataset.edPrev) return;
        const arr = get(name, seed, section).map(x => Array.isArray(x) ? x.slice() : x);
        if (arr[idx] === undefined) return;
        if (typeof apply === 'function') apply(arr, v); else arr[idx] = v;
        setSec(name, seed, section, arr);
        el.classList.add('ed-saved'); setTimeout(() => el.classList.remove('ed-saved'), 700);
      };
      el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); enter(); });
      el.addEventListener('blur', commit);
      el.addEventListener('keydown', e => {
        if (!el.isContentEditable && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); enter(); return; }
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        if (e.key === 'Escape') { el.textContent = el.dataset.edPrev || ''; el.blur(); }
        e.stopPropagation();
      });
    }
    return { get, setSec, reset, tools, handle, bindItem, register, blankFor };
  })();

  /* 把用户选的图片缩到指定长边并转成 JPEG data URL。
     直接存原图进 localStorage 会撑爆配额（一张手机照就好几 MB），
     所以统一压到 1280px / q0.8，一张约 120–260KB，几处加起来仍在安全范围内。 */
  function shrink(file, maxSide, quality) {
    return new Promise(resolve => {
      if (!file || !/^image\//.test(file.type)) { resolve(null); return; }
      const fr = new FileReader();
      fr.onerror = () => resolve(null);
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          try {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const g = cv.getContext('2d');
            g.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', quality || .8));
          } catch (e) { resolve(null); }
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }

  /* 选一张图 → 压缩 → 交给 onPick(dataUrl, cancelled)。
     ★ 隐藏 input 的生死由这里管。之前每个调用点都自己 new 一个 input、
       只在 change 里 remove()：用户一按取消，change 根本不触发，
       那个 input 就永远留在 <body> 里（1px、opacity 0、pointer-events none，
       看不见但一直在，取消几次就攒几个）。选中/取消/读不出来，三条路都会摘掉它。
     cancelled 用来区分"用户取消"和"图坏了" —— 前者不该弹提示。 */
  function pickImage(opts, onPick) {
    const o = opts || {};
    const inp = el('input', 'mj2-hidden-input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.setAttribute('aria-label', o.label || '选择一张图片');
    let done = false;
    const finish = (file, cancelled) => {
      if (done) return;
      done = true;
      inp.remove();
      window.removeEventListener('focus', onFocus);
      if (cancelled || !file) { onPick(null, !!cancelled); return; }
      shrink(file, o.maxSide || 1280, o.quality || .8).then(url => onPick(url, false));
    };
    /* 取消时浏览器不给任何事件，只能用"窗口重新拿到焦点 + files 还是空的"来兜底。
       Chrome 会先发 change 再回焦点，所以这里要确认 files 确实为空。 */
    const onFocus = () => setTimeout(() => {
      if (!inp.files || !inp.files.length) finish(null, true);
    }, 500);
    inp.addEventListener('change', () => finish(inp.files && inp.files[0], false));
    inp.addEventListener('cancel', () => finish(null, true));
    window.addEventListener('focus', onFocus);
    document.body.appendChild(inp);
    inp.click();
  }

  /* ============================================================
     7.7 街机厅（贪吃蛇 / 俄罗斯方块 / 打砖块）
     三款都是 canvas 游戏，共用一层薄壳：DPR 尺寸、rAF 循环、可见性门控、
     键盘输入、最高分持久化。同一时刻只挂一个游戏 —— 只有一个 rAF 订阅。
     键盘只在舞台获得焦点时接管（否则会抢走页面滚动）。
     ============================================================ */
  const Arcade = (() => {
    const best = k => Number(State.read().best && State.read().best[k]) || 0;
    const saveBest = (k, v) => {
      const b = Object.assign({}, State.read().best || {});
      if (v > (b[k] || 0)) { b[k] = v; State.write({ best: b }); return true; }
      return false;
    };

    /* 游戏外壳：给一个 canvas + HUD，返回 { frame, setHud, over } */
    function shell(stage, opts) {
      const o = Object.assign({ w: 480, h: 360, key: 'x' }, opts);
      stage.innerHTML = `
        <div class="ga-bar">
          <span class="ga-hud" id="gaHud"></span>
          <span class="ga-hint">${o.hint || ''}</span>
        </div>
        <canvas class="ga-canvas" id="gaCanvas" width="${o.w}" height="${o.h}"></canvas>
        <div class="ga-bar">
          <button class="mj-chip" type="button" data-ga="restart">重新开始</button>
          <button class="mj-chip" type="button" data-ga="pause">暂停 / 继续</button>
          <span class="ga-hud" id="gaBest">最高 ${best(o.key)}</span>
        </div>`;
      const cv = $('#gaCanvas', stage);
      const ctx = cv.getContext('2d');
      const hud = $('#gaHud', stage), bestEl = $('#gaBest', stage);
      const size = () => {
        const r = cv.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio || 1, 2);
        cv.width = Math.max(1, Math.round(r.width * dpr));
        cv.height = Math.max(1, Math.round(r.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { w: r.width, h: r.height };
      };
      let box = size();
      const setHud = txt => { if (hud.textContent !== txt) hud.textContent = txt; };
      const setBest = v => { if (saveBest(o.key, v)) bestEl.textContent = '最高 ' + v; };
      return { cv, ctx, stage, size, get box() { return box; }, remeasure() { box = size(); }, setHud, setBest, o };
    }

    /* ---------- 贪吃蛇 ---------- */
    function snake(stage) {
      const s = shell(stage, { w: 480, h: 360, key: 'snake', hint: '方向键 / WASD 转向 · 空格暂停' });
      const COLS = 24, ROWS = 18;
      let snakeArr, dir, next, food, acc, step, score, alive, paused, t = 0;
      const reset = () => {
        snakeArr = [{ x: 8, y: 9 }, { x: 7, y: 9 }, { x: 6, y: 9 }];
        dir = { x: 1, y: 0 }; next = dir; food = randFood();
        acc = 0; step = 140; score = 0; alive = true; paused = false; t = 0;
        s.setHud('得分 0');
      };
      function randFood() {
        for (let i = 0; i < 400; i++) {
          const f = { x: (Math.random() * COLS) | 0, y: (Math.random() * ROWS) | 0 };
          if (!snakeArr.some(n => n.x === f.x && n.y === f.y)) return f;
        }
        return { x: 1, y: 1 };
      }
      const turn = (x, y) => { if (dir.x === -x && dir.y === -y) return; next = { x, y }; };
      const keys = e => {
        const k = e.key.toLowerCase();
        if (k === 'arrowleft' || k === 'a') turn(-1, 0);
        else if (k === 'arrowright' || k === 'd') turn(1, 0);
        else if (k === 'arrowup' || k === 'w') turn(0, -1);
        else if (k === 'arrowdown' || k === 's') turn(0, 1);
        else if (k === ' ') paused = !paused;
      };
      function update(dt) {
        if (!alive || paused) return;
        acc += dt;
        while (acc >= step) {
          acc -= step;
          dir = next;
          const head = { x: snakeArr[0].x + dir.x, y: snakeArr[0].y + dir.y };
          if (head.x < 0 || head.y < 0 || head.x >= COLS || head.y >= ROWS ||
              snakeArr.some((n, i) => i < snakeArr.length - 1 && n.x === head.x && n.y === head.y)) {
            alive = false; s.setBest(score); return;
          }
          snakeArr.unshift(head);
          if (head.x === food.x && head.y === food.y) {
            score += 10; food = randFood();
            step = Math.max(70, 140 - Math.floor(score / 50) * 8);
            s.setHud('得分 ' + score);
          } else snakeArr.pop();
        }
      }
      function draw(dt) {
        t += dt;
        const { w, h } = s.box, cw = w / COLS, ch = h / ROWS;
        s.ctx.clearRect(0, 0, w, h);
        s.ctx.fillStyle = 'rgba(127,127,140,.08)';
        for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++)
          if ((x + y) % 2 === 0) s.ctx.fillRect(x * cw, y * ch, cw, ch);
        s.ctx.fillStyle = '#ef7938';
        s.ctx.beginPath();
        s.ctx.arc((food.x + .5) * cw, (food.y + .5) * ch, Math.min(cw, ch) * .34, 0, 6.283);
        s.ctx.fill();
        snakeArr.forEach((n, i) => {
          s.ctx.fillStyle = i === 0 ? '#4cc2f1' : `rgba(76,194,241,${Math.max(.35, 1 - i / (snakeArr.length + 6))})`;
          const pad = i === 0 ? .06 : .12;
          s.ctx.fillRect((n.x + pad) * cw, (n.y + pad) * ch, cw * (1 - pad * 2), ch * (1 - pad * 2));
        });
        if (!alive) overlay('游戏结束 · 得分 ' + score, '按「重新开始」或空格重来');
        else if (paused) overlay('已暂停', '空格继续');
      }
      const overlay = (a, b) => {
        const { w, h } = s.box;
        s.ctx.fillStyle = 'rgba(11,14,19,.68)';
        s.ctx.fillRect(0, 0, w, h);
        s.ctx.fillStyle = '#fff';
        s.ctx.textAlign = 'center';
        s.ctx.font = '700 20px system-ui,sans-serif';
        s.ctx.fillText(a, w / 2, h / 2 - 8);
        s.ctx.font = '400 13px system-ui,sans-serif';
        s.ctx.fillStyle = 'rgba(255,255,255,.72)';
        s.ctx.fillText(b, w / 2, h / 2 + 18);
      };
      reset();
      return { keys, update, draw, reset, s };
    }

    /* ---------- 俄罗斯方块 ---------- */
    function tetris(stage) {
      const s = shell(stage, { w: 300, h: 480, key: 'tetris', hint: '← → 移动 · ↑ 旋转 · ↓ 软降 · 空格直落' });
      const COLS = 10, ROWS = 20;
      const SHAPES = {
        I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
        J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
        L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
        O: [[1, 1], [1, 1]],
        S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
        T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
        Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
      };
      const COLORS = { I: '#4cc2f1', J: '#4a6fd0', L: '#ef7938', O: '#fab72e', S: '#74c2a8', T: '#af8ec1', Z: '#e0586a' };
      let board, cur, nextK, acc, drop, score, lines, level, over, paused;
      const empty = () => Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
      const pick = () => {
        const ks = Object.keys(SHAPES);
        return ks[(Math.random() * ks.length) | 0];
      };
      const spawn = () => {
        const k = nextK || pick();
        nextK = pick();
        const m = SHAPES[k].map(r => r.slice());
        cur = { k, m, x: ((COLS - m[0].length) / 2) | 0, y: 0 };
        if (hit(cur.m, cur.x, cur.y)) { over = true; s.setBest(score); }
      };
      const hit = (m, px, py) => m.some((row, y) => row.some((v, x) => {
        if (!v) return false;
        const bx = px + x, by = py + y;
        return bx < 0 || bx >= COLS || by >= ROWS || (by >= 0 && board[by][bx]);
      }));
      const rot = m => m[0].map((_, i) => m.map(r => r[i]).reverse());
      const merge = () => cur.m.forEach((row, y) => row.forEach((v, x) => {
        if (v && cur.y + y >= 0) board[cur.y + y][cur.x + x] = cur.k;
      }));
      const clear = () => {
        let n = 0;
        for (let y = ROWS - 1; y >= 0; y--) {
          if (board[y].every(Boolean)) { board.splice(y, 1); board.unshift(new Array(COLS).fill(null)); n++; y++; }
        }
        if (n) {
          lines += n; score += [0, 100, 300, 500, 800][n] * level;
          level = 1 + Math.floor(lines / 10);
          drop = Math.max(110, 720 - (level - 1) * 62);
          s.setHud(`得分 ${score} · ${lines} 行 · 等级 ${level}`);
        }
      };
      const reset = () => {
        board = empty(); score = 0; lines = 0; level = 1; drop = 720; acc = 0;
        over = false; paused = false; nextK = pick(); spawn();
        s.setHud('得分 0 · 0 行 · 等级 1');
      };
      const keys = e => {
        if (over) { if (e.key === ' ') reset(); return; }
        const k = e.key.toLowerCase();
        if (k === 'p') { paused = !paused; return; }
        if (paused) return;
        if (k === 'arrowleft' || k === 'a') { if (!hit(cur.m, cur.x - 1, cur.y)) cur.x--; }
        else if (k === 'arrowright' || k === 'd') { if (!hit(cur.m, cur.x + 1, cur.y)) cur.x++; }
        else if (k === 'arrowup' || k === 'w') { const m = rot(cur.m); if (!hit(m, cur.x, cur.y)) cur.m = m; }
        else if (k === 'arrowdown' || k === 's') { if (!hit(cur.m, cur.x, cur.y + 1)) { cur.y++; score += 1; } }
        else if (k === ' ') {
          while (!hit(cur.m, cur.x, cur.y + 1)) { cur.y++; score += 2; }
          merge(); clear(); spawn();
        }
      };
      function update(dt) {
        if (over || paused) return;
        acc += dt;
        while (acc >= drop) {
          acc -= drop;
          if (!hit(cur.m, cur.x, cur.y + 1)) cur.y++;
          else { merge(); clear(); spawn(); if (over) return; }
        }
      }
      function draw() {
        const { w, h } = s.box, cw = w / COLS, ch = h / ROWS;
        s.ctx.clearRect(0, 0, w, h);
        s.ctx.fillStyle = 'rgba(127,127,140,.07)';
        for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++)
          if ((x + y) % 2 === 0) s.ctx.fillRect(x * cw, y * ch, cw, ch);
        const cell = (x, y, c, a) => {
          s.ctx.globalAlpha = a == null ? 1 : a;
          s.ctx.fillStyle = c;
          s.ctx.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2);
          s.ctx.globalAlpha = 1;
        };
        board.forEach((row, y) => row.forEach((k, x) => { if (k) cell(x, y, COLORS[k]); }));
        if (!over) cur.m.forEach((row, y) => row.forEach((v, x) => { if (v && cur.y + y >= 0) cell(cur.x + x, cur.y + y, COLORS[cur.k], .92); }));
        // 下一个方块
        const nm = SHAPES[nextK];
        s.ctx.fillStyle = 'rgba(255,255,255,.06)';
        s.ctx.fillRect(w - 58, 6, 52, 46);
        nm.forEach((row, y) => row.forEach((v, x) => {
          if (!v) return;
          s.ctx.fillStyle = COLORS[nextK];
          s.ctx.fillRect(w - 54 + x * 11, 12 + y * 11, 9, 9);
        }));
        if (over) overlay('游戏结束 · 得分 ' + score, '空格重来');
        else if (paused) overlay('已暂停', 'P 继续');
      }
      const overlay = (a, b) => {
        const { w, h } = s.box;
        s.ctx.fillStyle = 'rgba(11,14,19,.7)';
        s.ctx.fillRect(0, 0, w, h);
        s.ctx.fillStyle = '#fff';
        s.ctx.textAlign = 'center';
        s.ctx.font = '700 20px system-ui,sans-serif';
        s.ctx.fillText(a, w / 2, h / 2 - 8);
        s.ctx.font = '400 13px system-ui,sans-serif';
        s.ctx.fillStyle = 'rgba(255,255,255,.72)';
        s.ctx.fillText(b, w / 2, h / 2 + 18);
      };
      reset();
      return { keys, update, draw, reset, s };
    }

    /* ---------- 打砖块 ---------- */
    function breakout(stage) {
      const s = shell(stage, { w: 480, h: 380, key: 'breakout', hint: '← → 或移动鼠标控制挡板 · 空格暂停' });
      const COLS = 9, ROWS = 5;
      let paddle, ball, bricks, left, score, lives, paused, over, launched, level;
      const reset = (keepScore) => {
        paddle = { w: 92, h: 10, x: 0, y: 0 };
        ball = { x: 0, y: 0, r: 5, vx: 0, vy: 0, sp: 250 };
        bricks = [];
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) bricks.push({ c, r, alive: true });
        left = bricks.length;
        if (!keepScore) { score = 0; lives = 3; level = 1; }
        paused = false; over = false; launched = false;
        layout();
        s.setHud(`得分 ${score} · 命 ${lives}`);
      };
      const layout = () => {
        const { w, h } = s.box;
        paddle.x = (w - paddle.w) / 2; paddle.y = h - 24;
        if (!launched) { ball.x = w / 2; ball.y = paddle.y - ball.r - 2; ball.vx = 0; ball.vy = 0; }
      };
      const launch = () => {
        if (launched || over) return;
        launched = true;
        const a = (-70 + Math.random() * 40) * Math.PI / 180;
        ball.vx = Math.sin(a) * ball.sp;
        ball.vy = -Math.abs(Math.cos(a) * ball.sp);
      };
      const keys = e => {
        const k = e.key.toLowerCase();
        if (k === ' ') { if (!launched) launch(); else paused = !paused; e.preventDefault(); return; }
        if (k === 'arrowleft' || k === 'a') paddle.x -= 26;
        if (k === 'arrowright' || k === 'd') paddle.x += 26;
        if (over && k === 'enter') reset();
      };
      function update(dt) {
        if (over || paused) return;
        const { w, h } = s.box;
        paddle.x = Math.max(0, Math.min(w - paddle.w, paddle.x));
        if (!launched) { ball.x = paddle.x + paddle.w / 2; ball.y = paddle.y - ball.r - 2; return; }
        const f = dt / 1000;
        ball.x += ball.vx * f; ball.y += ball.vy * f;
        if (ball.x < ball.r) { ball.x = ball.r; ball.vx = Math.abs(ball.vx); }
        if (ball.x > w - ball.r) { ball.x = w - ball.r; ball.vx = -Math.abs(ball.vx); }
        if (ball.y < ball.r) { ball.y = ball.r; ball.vy = Math.abs(ball.vy); }
        // 挡板
        if (ball.vy > 0 && ball.y + ball.r >= paddle.y && ball.y - ball.r <= paddle.y + paddle.h &&
            ball.x >= paddle.x - 4 && ball.x <= paddle.x + paddle.w + 4) {
          ball.y = paddle.y - ball.r;
          const rel = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
          const ang = Math.max(-60, Math.min(60, rel * 60)) * Math.PI / 180;
          ball.sp = Math.min(430, ball.sp + 6);
          ball.vx = Math.sin(ang) * ball.sp;
          ball.vy = -Math.abs(Math.cos(ang) * ball.sp);
        }
        // 砖块
        const bw = (w - 16) / COLS, bh = 18, top = 34;
        for (const b of bricks) {
          if (!b.alive) continue;
          const bx = 8 + b.c * bw, by = top + b.r * bh;
          if (ball.x + ball.r > bx && ball.x - ball.r < bx + bw - 3 &&
              ball.y + ball.r > by && ball.y - ball.r < by + bh - 3) {
            b.alive = false; left--; score += 10;
            s.setHud(`得分 ${score} · 命 ${lives}`);
            const overlapX = Math.min(ball.x + ball.r - bx, bx + bw - 3 - (ball.x - ball.r));
            const overlapY = Math.min(ball.y + ball.r - by, by + bh - 3 - (ball.y - ball.r));
            if (overlapX < overlapY) ball.vx = -ball.vx; else ball.vy = -ball.vy;
            break;
          }
        }
        if (left === 0) { level++; reset(true); s.setHud(`第 ${level} 关 · 得分 ${score}`); return; }
        // 掉底
        if (ball.y - ball.r > h) {
          lives--;
          if (lives <= 0) { over = true; s.setBest(score); } else { launched = false; ball.sp = 250; }
          s.setHud(`得分 ${score} · 命 ${Math.max(0, lives)}`);
        }
      }
      function draw() {
        const { w, h } = s.box;
        s.ctx.clearRect(0, 0, w, h);
        const bw = (w - 16) / COLS, bh = 18, top = 34;
        const PAL = ['#4cc2f1', '#74c2a8', '#fab72e', '#af8ec1', '#ef7938'];
        bricks.forEach(b => {
          if (!b.alive) return;
          s.ctx.fillStyle = PAL[b.r % PAL.length];
          s.ctx.globalAlpha = .9;
          s.ctx.fillRect(8 + b.c * bw + 2, top + b.r * bh + 2, bw - 5, bh - 5);
          s.ctx.globalAlpha = 1;
        });
        s.ctx.fillStyle = '#4cc2f1';
        s.ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
        s.ctx.fillStyle = '#fff';
        s.ctx.beginPath(); s.ctx.arc(ball.x, ball.y, ball.r, 0, 6.283); s.ctx.fill();
        if (!launched && !over) {
          s.ctx.fillStyle = 'rgba(255,255,255,.7)';
          s.ctx.textAlign = 'center';
          s.ctx.font = '400 13px system-ui,sans-serif';
          s.ctx.fillText('空格发球', w / 2, h - 44);
        }
        if (over) {
          s.ctx.fillStyle = 'rgba(11,14,19,.7)'; s.ctx.fillRect(0, 0, w, h);
          s.ctx.fillStyle = '#fff'; s.ctx.textAlign = 'center';
          s.ctx.font = '700 20px system-ui,sans-serif';
          s.ctx.fillText('游戏结束 · 得分 ' + score, w / 2, h / 2 - 8);
          s.ctx.font = '400 13px system-ui,sans-serif';
          s.ctx.fillStyle = 'rgba(255,255,255,.72)';
          s.ctx.fillText('按「重新开始」再来一局', w / 2, h / 2 + 18);
        } else if (paused) {
          s.ctx.fillStyle = 'rgba(11,14,19,.6)'; s.ctx.fillRect(0, 0, w, h);
          s.ctx.fillStyle = '#fff'; s.ctx.textAlign = 'center';
          s.ctx.font = '700 20px system-ui,sans-serif';
          s.ctx.fillText('已暂停', w / 2, h / 2);
        }
      }
      reset(false);
      return { keys, update, draw, reset: () => reset(false), s, onMove(x) { const r = s.cv.getBoundingClientRect(); paddle.x = x - r.left - paddle.w / 2; } };
    }
    return { snake, tetris, breakout, best, saveBest };
  })();

  /* ============================================================
     8. 视图
     ============================================================ */
  const CL = id => elById(id).c;
  const ph = (id, seed) => `background:linear-gradient(${140 + seed * 37}deg, ${CL(id)}, color-mix(in oklab, ${CL(id)} 45%, #0b0e13))`;

  /* 视图一律通过 posts() 取数据：模块层接上后以可编辑的数据源为准，否则回落到静态 HTML 解析 */
  function posts() {
    const P = window.MJ2 && window.MJ2.Posts;
    return (P && P.all().length) ? P.all() : POSTS;
  }

  const Views = {
    blog() {
      const cats = [{ id: 'all', n: '全部' }, { id: 'life', n: '生活' }, { id: 'food', n: '厨房' }, { id: 'note', n: '笔记' }];
      const tags = [...new Set(posts().flatMap(p => p.tags))];
      let st = { q: '', tag: null, cat: 'all' };
      const host = el('div', 'mj-view');
      host.dataset.view = 'blog';
      host.innerHTML = `
        <div class="sheet list-bar"><h2 class="lb-title">时间线归档</h2><span class="mj-stat" id="mjBlogCount">显示 ${posts().length} / ${posts().length} 篇</span>
          <button class="mj2-btn" type="button" id="mj2NewPost" style="margin-left:auto">＋ 新建文章</button></div>
        <div class="sheet" style="padding:1rem">
          <div class="mj-tools">
            <input type="search" id="mjBlogQ" placeholder="搜索标题、摘要或标签…" aria-label="搜索文章" />
            <div class="mj-chips" id="mjBlogCats">${cats.map(c => `<button class="mj-chip ${c.id === 'all' ? 'on' : ''}" type="button" data-c="${c.id}">${c.n}</button>`).join('')}</div>
          </div>
          <div class="mj-chips" id="mjBlogTags" style="margin-top:.6rem">${tags.map(t => `<button class="mj-chip" type="button" data-t="${t}">#${t}</button>`).join('')}</div>
        </div>
        <div class="sheet" style="padding:1.1rem"><div class="mj-timeline" id="mjBlogList"></div></div>`;
      function render() {
        const q = st.q.trim().toLowerCase();
        const list = posts().filter(p =>
          (st.cat === 'all' || p.cat === st.cat) &&
          (!st.tag || p.tags.includes(st.tag)) &&
          (!q || (p.title + p.desc + p.tags.join(' ')).toLowerCase().includes(q)));
        $('#mjBlogList', host).innerHTML = list.length ? list.map(p => `
          <div class="mj-tl"><div class="mj-tl-date">${p.date}${p.pinned ? ' · 置顶' : ''}</div>
          <a class="mj-tl-card" href="#/blog/${p.slug}"><h3>${p.title}</h3><p>${p.desc}</p>
          <div class="mj-tl-meta">${p.tags.map(t => `<span>#${t}</span>`).join('')}<span>·</span><span>${(cats.find(c => c.id === p.cat) || {}).n || p.cat}</span></div></a></div>`).join('')
          : `<div class="mj-empty">没有匹配的文章，换个关键词或清掉筛选试试。</div>`;
        $('#mjBlogCount', host).textContent = `显示 ${list.length} / ${posts().length} 篇`;
        if (q.length >= 2 && list.length && !Achievements.got.has('archivist')) Achievements.unlock('archivist');
      }
      const onInput = e => { st.q = e.target.value; render(); };
      const onClick = e => {
        const c = e.target.closest('[data-c]'), t = e.target.closest('[data-t]');
        if (c) {
          st.cat = c.dataset.c; st.tag = null;
          $$('#mjBlogCats .mj-chip', host).forEach(x => x.classList.toggle('on', x === c));
          $$('#mjBlogTags .mj-chip', host).forEach(x => x.classList.remove('on'));
          render(); return;
        }
        if (t) {
          const same = st.tag === t.dataset.t;
          st.tag = same ? null : t.dataset.t;
          $$('#mjBlogTags .mj-chip', host).forEach(x => x.classList.toggle('on', !same && x === t));
          render();
        }
      };
      $('#mjBlogQ', host).addEventListener('input', onInput);
      host.addEventListener('click', onClick);
      const np = $('#mj2NewPost', host);
      if (np) np.addEventListener('click', () => { if (window.MJ2 && window.MJ2.PostsUI) window.MJ2.PostsUI.open(null); });
      render();
      return { host, destroy() { host.remove(); } };
    },

    article(slug) {
      const p = posts().find(x => x.slug === slug);
      const host = el('div', 'mj-view');
      host.dataset.view = 'article';
      if (!p) { host.innerHTML = `<div class="sheet"><div class="mj-empty">没有找到这篇文章。</div></div>`; return { host, destroy() { host.remove(); } }; }
      const body = p.body || ARTICLE_BODIES[p.i] || [['p', p.desc || '正文整理中。']];
      host.innerHTML = `
        <div class="sheet" style="padding:1.3rem">
          <div class="mj2-actions">
            <button class="mj2-btn" type="button" data-act="back">← 返回列表</button>
            <button class="mj2-btn" type="button" data-act="edit">编辑本文</button>
            <button class="mj2-btn" type="button" data-act="del">删除</button>
          </div>
          <article class="mj-article">
            <div class="mj-tl-meta"><span>${p.date}</span><span>·</span><span>我</span></div>
            <h1>${p.title}</h1>
            <p class="lede">${p.desc}</p>
            <div class="mj-chips" style="margin:1rem 0 1.6rem">${p.tags.map(t => `<span class="mj-chip">#${t}</span>`).join('')}</div>
            ${body.map(([k, v]) => k === 'h2' ? `<h2>${v}</h2>` : k === 'blockquote' ? `<blockquote>${v}</blockquote>` : k === 'code' ? `<pre><code>${v.replace(/</g, '&lt;')}</code></pre>` : `<p>${v}</p>`).join('')}
            <div class="mj-sec" style="margin-top:2rem">
              <h3>继续阅读</h3>
              <div class="mj-chips">${posts().filter(x => x.slug !== slug).slice(0, 3).map(x => `<a class="mj-chip" href="#/blog/${x.slug}">${x.title}</a>`).join('')}</div>
            </div>
          </article>
        </div>`;
      const rb = el('div', 'mj-readbar', '<i></i>'); document.body.appendChild(rb);
      const onAct = e => {
        const b = e.target.closest('[data-act]');
        if (!b || !window.MJ2 || !window.MJ2.PostsUI) return;
        const act = b.dataset.act;
        if (act === 'back') { location.hash = '#/blog'; return; }
        if (act === 'edit') window.MJ2.PostsUI.open(p.slug);
        if (act === 'del' && confirm('删除《' + p.title + '》？此操作不可撤销。')) {
          window.MJ2.Posts.remove(p.slug);
          window.MJ2.PostsUI.toast('已删除《' + p.title + '》');
          location.hash = '#/blog';
        }
      };
      host.addEventListener('click', onAct);
      const onScroll = () => {
        const r = $('.mj-article', host).getBoundingClientRect();
        const total = r.height - innerHeight + 260;
        $('i', rb).style.width = (Math.max(0, Math.min(1, (-r.top + 140) / Math.max(1, total))) * 100).toFixed(1) + '%';
      };
      addEventListener('scroll', onScroll, { passive: true }); onScroll();
      return { host, destroy() { removeEventListener('scroll', onScroll); host.removeEventListener('click', onAct); rb.remove(); host.remove(); } };
    },

    /* 作品集：把"分镜切割操作台"换掉。
       那个画布是个和作品没关系的互动玩具，来这儿的人想看的是**作品本身**。
       现在是一条条的真实作品：封面 / 标题 / 类型 / 时间 / 简介，
       封面点一下能换，条目能增删，类型能筛选 —— 和站里其它区块一样可改。

       数据放在 State.lists.works，每条是 5 元组
         [封面, 标题, 类型, 时间·时长, 简介]
       ★ 封面**存在元组里**而不是另开一个按下标索引的表：
         增删条目时下标会整体平移，外挂的图片表一定会错位（XP 那栏就吃过这个亏）。 */
    works() {
      const host = el('div', 'mj-view');
      host.dataset.view = 'works';
      /* 本地小工具：el() 的第三个参数是 innerHTML，用户写的标题/简介不能往里塞，
         所以这里一律用 textContent 建节点。 */
      const mk = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };
      const seed = () => ([
        ['assets/paper/bg-03.svg', '海边的一天', '摄影', '2026 · 一组照片', '阴天去的，风很大，反而拍到了想要的灰蓝色。挑出九张放在这里。'],
        ['assets/paper/bg-06.svg', '一个人的晚饭', '料理', '2026', '三道菜的配比与时间，附一份采购清单，一个人做也不会浪费。'],
        ['assets/paper/bg-05.svg', '今年读过的书', '阅读', '2025', '十二本书的短评，最后挑出最想推荐的三本。'],
        ['assets/paper/bg-04.svg', '旧木桌翻新', '手作', '2025', '打磨、上油、换把手，一个周末做完，比买新的有成就感。'],
        ['assets/paper/bg-07.svg', '城市散步地图', '日常', '2024', '把常走的那几条小路画成了一张手绘地图，标着哪里能坐下来。'],
        ['assets/paper/bg-01.svg', '第一次做面包', '料理', '2024', '失败两次之后终于发起来了，把配比和温度都记了下来。']
      ]);
      EdList.register('works', seed);
      const rows = () => EdList.get('works', seed);

      let filter = '全部';
      const elChips = mk('div', 'mj-work-chips');
      const elGrid = mk('div', 'mj-works');
      const elCount = mk('span', 'mj-stat');
      const bar = mk('div', 'sheet list-bar');
      bar.append(mk('h2', 'lb-title', '作品集'),
        mk('span', 'mj-stat', '封面可换、条目可增删、类型可筛选'),
        mk('span', 'mj-spacer'), elCount);
      const wrap = mk('div', 'sheet mj-works-wrap');
      wrap.append(elChips, elGrid);
      host.append(bar, wrap);

      /* 打开过的作品：攒够三支揭示线索 C，全部看过解锁成就。
         用标题做键而不是下标 —— 下标会随增删平移，标题是内容本身。 */
      const opened = new Set();

      function openWork(i) {
        const w = rows()[i];
        if (!w) return;
        const [cover, title, cat, meta, desc] = w;
        const box = mk('div', 'mj-work-modal');
        const card = mk('div', 'mj-work-modal-card sheet');
        const coverWrap = mk('div', 'mj-work-modal-cover');
        if (cover) {
          const im = mk('img');
          im.src = cover; im.alt = '';
          coverWrap.appendChild(im);
        } else {
          coverWrap.appendChild(mk('div', 'ph', '')).setAttribute('style', ph(ELEMENTS[i % 7].id, i));
        }
        const body = mk('div', 'mj-work-modal-body');
        const metaRow = mk('div', 'mj-work-meta');
        if (cat) metaRow.appendChild(mk('span', 'chip', cat));
        if (meta) metaRow.appendChild(mk('span', 'mj-work-when', meta));
        body.append(mk('h3', null, title || '未命名作品'), metaRow,
          mk('p', 'mj-work-desc', desc || '（还没有写简介）'));
        card.append(coverWrap, body);
        const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = e => { if (e.key === 'Escape') close(); };
        const x = mk('button', 'mj-work-modal-x', '×');
        x.type = 'button'; x.setAttribute('aria-label', '关闭');
        x.addEventListener('click', close);
        box.append(card, x);
        box.addEventListener('click', e => { if (e.target === box) close(); });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(box);
        x.focus();

        const all = rows().length;
        opened.add(String(title || i));
        if (opened.size >= 3) Achievements.findClue('C', '看过三支片子');
        if (all && opened.size >= all) Achievements.unlock('cutter');
      }

      function paint() {
        const list = rows();
        const cats = ['全部', ...Array.from(new Set(list.map(w => String(w[2] || '').trim()).filter(Boolean)))];
        elChips.textContent = '';
        cats.forEach(c => {
          const b = mk('button', 'mj-chip' + (filter === c ? ' on' : ''), c);
          b.type = 'button';
          b.setAttribute('aria-pressed', String(filter === c));
          b.addEventListener('click', () => { filter = c; paint(); });
          elChips.appendChild(b);
        });
        const shown = list.map((w, i) => ({ w, i })).filter(({ w }) => filter === '全部' || String(w[2] || '').trim() === filter);
        elCount.textContent = (filter === '全部' ? shown.length : shown.length + ' / ' + list.length) + ' 件作品';

        elGrid.textContent = '';
        shown.forEach(({ w, i }) => {
          const [cover, title, cat, meta, desc] = w;
          const card = mk('article', 'mj-work');
          card.dataset.w = String(i);
          const coverBox = mk('div', 'mj-work-cover');
          coverBox.title = '点击看详细，右下角铅笔换封面';
          if (cover) {
            const im = mk('img');
            im.src = cover; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async';
            coverBox.appendChild(im);
          } else {
            const phEl = mk('div', 'ph');
            phEl.setAttribute('style', ph(ELEMENTS[i % 7].id, i));
            coverBox.appendChild(phEl);
          }
          coverBox.append(mk('span', 'mj-work-pen', '✎'), mk('span', 'mj-work-more', '看详细'));
          const metaRow = mk('div', 'mj-work-meta');
          if (cat) metaRow.appendChild(mk('span', 'chip', cat));
          if (meta) metaRow.appendChild(mk('span', 'mj-work-when', meta));
          const tools = mk('div', 'ed-bar mj-work-tools');
          const pick = mk('button', 'ed-mini', '换图');
          pick.type = 'button'; pick.title = '换封面';
          pick.addEventListener('click', ev => { ev.stopPropagation(); pickCover(i); });
          tools.appendChild(pick);
          /* ★ EdList.tools() 返回的是**HTML 字符串**。
             用 append(字符串) 会当成文本节点插进去，页面上就会直接显示
             <span class="ed-tools">… 这堆源码（"作品栏出现原始 HTML"就是这个）。
             要解析成元素必须走 insertAdjacentHTML / innerHTML。 */
          tools.insertAdjacentHTML('beforeend', EdList.tools('works', i));
          card.append(coverBox,
            mk('h3', null, title || '未命名作品'),
            metaRow,
            mk('p', 'mj-work-desc', desc || '（还没有写简介）'),
            tools);
          elGrid.appendChild(card);
        });
        if (!shown.length) elGrid.appendChild(mk('p', 'mj-sub', '这个类型下还没有作品'));
      }

      /* 就地改文字：第 1/2/3/4 格分别是标题 / 类型 / 时间 / 简介 */
      function bindText() {
        $$('.mj-work', elGrid).forEach(card => {
          const i = +card.dataset.w;
          [[1, 'h3'], [2, '.mj-work-meta .chip'], [3, '.mj-work-when'], [4, '.mj-work-desc']].forEach(([slot, sel]) => {
            const node = $(sel, card);
            if (node) EdList.bindItem(node, 'works', seed, null, i, (arr, v) => {
              const cur = Array.isArray(arr[i]) ? arr[i].slice() : ['', '', '', '', ''];
              cur[slot] = v; arr[i] = cur;
            });
          });
        });
      }

      function pickCover(i) {
        pickImage({ maxSide: 960, quality: .8, label: '选择作品封面' }, (url, cancelled) => {
          if (cancelled) return;
          if (!url) { alert('这张图读不出来，换一张试试。'); return; }
          const arr = rows().map(x => Array.isArray(x) ? x.slice() : ['', '', '', '', '']);
          if (!arr[i]) return;
          arr[i][0] = url;
          EdList.setSec('works', seed, null, arr);
          paint(); bindText();
          Achievements.toast('★', '换好封面', '第 ' + (i + 1) + ' 件作品');
        });
      }

      elGrid.addEventListener('click', e => {
        if (EdList.handle(e, () => { paint(); bindText(); })) return;
        const card = e.target.closest('.mj-work');
        if (!card) return;
        if (e.target.closest('.mj-work-tools') || e.target.closest('.ed-tools')) return;
        openWork(+card.dataset.w);
      });

      paint(); bindText();
      return { host, destroy() { host.remove(); } };
    },

    games() {
      const host = el('div', 'mj-view');
      host.dataset.view = 'games';
      const TABS = [
        { id: 'snake', n: '贪吃蛇', d: '方向键转向，吃到东西变长变快', el: 'hydro' },
        { id: 'tetris', n: '俄罗斯方块', d: '消行升级，右上角是下一个方块', el: 'electro' },
        { id: 'breakout', n: '打砖块', d: '挡板接球，打光砖块进下一关', el: 'pyro' },
        { id: 'flip', n: '记忆翻牌', d: '七对元素打乱铺开，一次翻两张', el: 'dendro' }
      ];
      host.innerHTML = `
        <div class="sheet list-bar"><h2 class="lb-title">游乐场</h2><span class="mj-stat">四款都能玩 · 点画面获得键盘焦点</span></div>
        <div class="mj-game-tabs" id="mjGameTabs" role="tablist">
          ${TABS.map((t, i) => `<button class="ga-tab${i === 0 ? ' on' : ''}" type="button" role="tab"
            aria-selected="${i === 0}" data-g="${t.id}">
            <span class="ga-tab-ic" style="${ph(t.el, i)}"></span>
            <span class="ga-tab-tx"><b>${t.n}</b><em>${t.d}</em></span>
            <span class="ga-best" data-best="${t.id}">–</span>
          </button>`).join('')}
        </div>
        <div class="sheet" style="padding:1rem">
          <div class="mj-stage" id="mjGameStage" tabindex="0"></div>
        </div>`;

      const stage = $('#mjGameStage', host);
      let active = null, activeId = '', offVis = null, unsub = null, raf = 0, lastT = 0;
      let keyHandler = null, moveHandler = null, resizeHandler = null;

      const paintBest = () => {
        TABS.forEach(t => {
          const el2 = $(`[data-best="${t.id}"]`, host);
          if (!el2) return;
          const b = t.id === 'flip'
            ? (Number(State.read().best && State.read().best.flip) || 0)
            : Arcade.best(t.id);
          el2.textContent = b ? '最高 ' + b : '–';
        });
      };

      const teardown = () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (offVis) { offVis(); offVis = null; }
        if (unsub) { unsub(); unsub = null; }
        if (keyHandler) { stage.removeEventListener('keydown', keyHandler); keyHandler = null; }
        if (moveHandler) { stage.removeEventListener('mousemove', moveHandler); moveHandler = null; }
        if (resizeHandler) { removeEventListener('resize', resizeHandler); resizeHandler = null; }
        // 记忆翻牌是纯 DOM 的，没有 game 对象
        if (active && active.s === undefined) { /* noop */ }
        active = null;
      };

      /* 三个 canvas 游戏共用这套：测量 → 循环 → 键盘 → 可见性门控 */
      function mountCanvas(g) {
        const draw = (now) => {
          const dt = lastT ? Math.min(50, now - lastT) : 16;
          lastT = now;
          g.update(dt);
          g.draw(dt);
          raf = requestAnimationFrame(draw);
        };
        keyHandler = e => {
          const k = e.key;
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'].includes(k)) e.preventDefault();
          g.keys(e);
          if (e.key === ' ') e.preventDefault();
        };
        stage.addEventListener('keydown', keyHandler);
        if (g.onMove) {
          moveHandler = e => g.onMove(e.clientX);
          stage.addEventListener('mousemove', moveHandler);
          stage.addEventListener('touchmove', e => { if (e.touches[0]) g.onMove(e.touches[0].clientX); }, { passive: true });
        }
        resizeHandler = () => { g.s.remeasure(); };
        addEventListener('resize', resizeHandler);
        // 点画面就把焦点收进来：键盘只在舞台有焦点时才被接管，不会抢走页面滚动
        stage.addEventListener('mousedown', () => stage.focus());
        stage.addEventListener('touchstart', () => stage.focus(), { passive: true });
        // 挂载时布局还没落位，等一帧再量，否则画布是 0×0
        requestAnimationFrame(() => { g.s.remeasure(); lastT = 0; });
        offVis = whenVisible(stage, () => { lastT = 0; raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf); });
        stage.focus();
        stage.querySelectorAll('[data-ga]').forEach(b => b.addEventListener('click', () => {
          if (b.dataset.ga === 'restart') { g.reset(); lastT = 0; }
          else { g.keys({ key: ' ', preventDefault() {} }); }
        }));
      }

      /* 记忆翻牌：沿用之前的 DOM 实现，接到同一个舞台里 */
      function mountFlip() {
        stage.innerHTML = `
          <div class="ga-bar"><span class="ga-hud" id="gaHud">步数 0 · 已配对 0/7</span>
            <span class="ga-hint">用最少步数翻完七对元素</span></div>
          <div class="mj-flip" id="mjFlipGrid"></div>
          <div class="ga-bar"><button class="mj-chip" type="button" data-flip="reset">重新洗牌</button>
            <span class="ga-hud" id="gaBestFlip">–</span></div>`;
        const ORDER = ['anemo', 'pyro', 'cryo', 'hydro', 'electro', 'dendro', 'geo'];
        const grid = $('#mjFlipGrid', stage);
        let deck = [], open = [], moves = 0, pairs = 0, lock = false;
        const hud = $('#gaHud', stage), bestEl = $('#gaBestFlip', stage);
        const paint = () => {
          if (hud) hud.textContent = `步数 ${moves} · 已配对 ${pairs}/7`;
          if (bestEl) { const b = Number(State.read().best && State.read().best.flip) || 0; bestEl.textContent = b ? '最高（最少步数）' + b : '–'; }
        };
        const deal = () => {
          deck = ORDER.concat(ORDER).map((id, i) => ({ id, k: i })).sort(() => Math.random() - .5);
          open = []; moves = 0; pairs = 0; lock = false;
          grid.innerHTML = deck.map((c, i) => {
            const e = elById(c.id);
            return `<button class="mj-fcard" type="button" data-i="${i}" aria-pressed="false" aria-label="第 ${i + 1} 张，未翻开">
              <span class="face back" aria-hidden="true"></span>
              <span class="face front" style="--c:${e.c}"><b>${e.name}</b></span></button>`;
          }).join('');
          paint();
        };
        const flip = i => {
          if (lock) return;
          const card = grid.querySelector(`[data-i="${i}"]`);
          if (!card || card.classList.contains('done') || card.classList.contains('open')) return;
          card.classList.add('open');
          card.setAttribute('aria-pressed', 'true');
          card.setAttribute('aria-label', elById(deck[i].id).name + '，已翻开');
          open.push(i);
          if (open.length < 2) return;
          moves++; paint();
          const [a, b] = open;
          if (deck[a].id === deck[b].id) {
            open = []; pairs++; paint();
            [a, b].forEach(k => {
              const c = grid.querySelector(`[data-i="${k}"]`);
              c.classList.add('done');
              c.setAttribute('aria-label', elById(deck[k].id).name + '，已配对');
            });
            if (pairs === ORDER.length) {
              const rec = Object.assign({}, State.read().best || {});
              if (!rec.flip || moves < rec.flip) { rec.flip = moves; State.write({ best: rec }); }
              Achievements.unlock('matcher');
              Achievements.toast('★', '全部配对', `${moves} 步翻完七对元素`);
              paint();
            }
          } else {
            lock = true;
            setTimeout(() => {
              [a, b].forEach(k => {
                const c = grid.querySelector(`[data-i="${k}"]`);
                if (!c) return;
                c.classList.remove('open');
                c.setAttribute('aria-pressed', 'false');
                c.setAttribute('aria-label', `第 ${k + 1} 张，未翻开`);
              });
              open = []; lock = false;
            }, 720);
          }
        };
        keyHandler = e => {
          const fc = e.target.closest && e.target.closest('.mj-fcard');
          if (fc && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); flip(+fc.dataset.i); }
        };
        stage.addEventListener('click', e => {
          if (e.target.closest('[data-flip="reset"]')) { deal(); return; }
          const fc = e.target.closest('.mj-fcard');
          if (fc) flip(+fc.dataset.i);
        });
        stage.addEventListener('keydown', keyHandler);
        deal();
      }

      function show(id) {
        teardown();
        activeId = id;
        $$('.ga-tab', host).forEach(b => {
          const on = b.dataset.g === id;
          b.classList.toggle('on', on);
          b.setAttribute('aria-selected', String(on));
        });
        if (id === 'flip') { mountFlip(); paintBest(); return; }
        stage.innerHTML = '';
        const g = id === 'snake' ? Arcade.snake(stage) : id === 'tetris' ? Arcade.tetris(stage) : Arcade.breakout(stage);
        active = g;
        mountCanvas(g);
        paintBest();
      }

      const onClick = e => {
        const t = e.target.closest('[data-g]');
        if (t) { show(t.dataset.g); return; }
      };
      host.addEventListener('click', onClick);
      show('snake');

      return {
        host,
        destroy() {
          teardown();
          host.removeEventListener('click', onClick);
          host.remove();
        }
      };
    },

    /* 项目：仿 B 站的图文模式。
       一个项目 = 封面 + 标题 + 分类/日期 + 摘要 + 一串"块"，
       块可以是**文字 / 图片 / 视频**，按顺序排下来就是一篇正文。
       增删查改全都有：新建/删除项目，编辑标题摘要，块可以加、删、上下移动、改内容。

       数据存在 State.lists.projects，每个元素是一个**对象**（不是元组）——
       因为正文是嵌套的块数组，扁平元组表达不了。这里只用 EdList 当持久层
       （get/setSec），UI 自己画。 */
    projects() {
      const host = el('div', 'mj-view');
      host.dataset.view = 'projects';
      const mk = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
      };
      const seed = () => ([
        {
          cover: 'assets/paper/bg-03.svg', title: '海边的一天', cat: '摄影', date: '2026-03',
          tags: ['照片', '阴天', '散步'],
          summary: '阴天去的，风很大，反而拍到了想要的灰蓝色。把这一天的照片、走过的路线和当时的想法整理成一篇图文。',
          blocks: [
            { t: 'text', v: '本来想等一个晴天再去，后来想通了：阴天的海是灰蓝色的，和晴天完全两种东西。到了之后发现人很少，风把浪推得很高。' },
            { t: 'image', src: 'assets/paper/bg-05.svg', cap: '涨潮前的那二十分钟' },
            { t: 'text', v: '拍了大概六十张，回来只留下九张。留下的标准不是"好看"，而是"能让我想起当时站在那儿的感觉"。' },
            { t: 'video', src: '', cap: '这一天的短片（把 B 站链接填进来就会内嵌播放）' }
          ]
        },
        {
          cover: 'assets/paper/bg-06.svg', title: '一个人的晚饭', cat: '料理', date: '2026-02',
          tags: ['食谱', '配比'],
          summary: '三道菜的配比与时间，附一份采购清单 —— 一个人做饭最容易浪费，这份清单按一人份算。',
          blocks: [
            { t: 'text', v: '一个人做饭最大的问题不是麻烦，是买多了用不完。所以这份清单只写一人份的量，剩下的食材也会给一个去处。' },
            { t: 'image', src: 'assets/paper/bg-04.svg', cap: '三道菜的成品' }
          ]
        },
        {
          cover: 'assets/paper/bg-05.svg', title: '今年读过的书', cat: '阅读', date: '2025-12',
          tags: ['书单', '短评'],
          summary: '十二本书的短评，不抄句子，只写"在哪一页停了下来、为什么停"。',
          blocks: [
            { t: 'text', v: '比起摘抄，我更想留下的是"当时读到哪一句停了一下"。那种停顿过半年再看还在，摘抄就不一定了。' },
            { t: 'image', src: 'assets/paper/bg-07.svg', cap: '今年读完的一摞' }
          ]
        },
        {
          cover: 'assets/paper/bg-04.svg', title: '旧木桌翻新', cat: '手作', date: '2025-08',
          tags: ['动手', '周末'],
          summary: '打磨、上油、换把手，一个周末做完。记下用了什么、花了多久、哪一步最容易做坏。',
          blocks: [
            { t: 'text', v: '桌面原本有很多烫痕，买了砂纸从粗到细过三遍。上油是最有成就感的一步，木头颜色一深，旧痕几乎就看不见了。' }
          ]
        }
      ]);
      EdList.register('projects', seed);

      const list = () => {
        const arr = EdList.get('projects', seed);
        // 老数据/异常数据兜一下，避免某一项缺字段时整页炸掉
        return (Array.isArray(arr) ? arr : []).map(p => (p && typeof p === 'object') ? p : { title: String(p || ''), blocks: [] });
      };
      const save = arr => EdList.setSec('projects', seed, null, arr);
      const mutate = fn => { const arr = list().map(p => Object.assign({}, p, { blocks: (p.blocks || []).slice() })); fn(arr); save(arr); render(); };

      let mode = 'list';       // list | article
      let idx = -1;            // 当前打开的项目
      let editing = false;     // 文章是否处于编辑态
      let cat = '全部';

      const host2 = mk('div', 'mj-proj');
      host.appendChild(host2);

      const esc = s => String(s == null ? '' : s);
      /* 视频地址只允许这几家的嵌入页，以及直链视频文件。
         直接把用户填的 URL 塞进 iframe 等于开了一个任意嵌入的口子。 */
      const videoEmbed = url => {
        const u = String(url || '').trim();
        if (!u) return null;
        let m = /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(u);
        if (m) return { kind: 'iframe', src: 'https://player.bilibili.com/player.html?bvid=' + m[1] + '&autoplay=0' };
        m = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]{6,})/i.exec(u);
        if (m) return { kind: 'iframe', src: 'https://www.youtube.com/embed/' + m[1] };
        m = /^https?:\/\/youtu\.be\/([\w-]{6,})/i.exec(u);
        if (m) return { kind: 'iframe', src: 'https://www.youtube.com/embed/' + m[1] };
        if (/^https?:\/\/[^\s"'<>]+\.(mp4|webm|ogg|mov)(\?[^\s"'<>]*)?$/i.test(u)) return { kind: 'file', src: u };
        return { kind: 'link', src: u };
      };

      function blockNode(b, i) {
        const wrap = mk('div', 'mj-blk');
        wrap.dataset.b = String(i);
        const bar = mk('div', 'mj-blk-bar');
        const bAdd = mk('button', 'ed-mini', '＋');
        bAdd.type = 'button'; bAdd.title = '在这块下面插一块文字';
        bAdd.addEventListener('click', () => mutate(arr => { arr[idx].blocks.splice(i + 1, 0, { t: 'text', v: '' }); }));
        const bUp = mk('button', 'ed-mini', '↑');
        bUp.type = 'button'; bUp.title = '上移';
        bUp.addEventListener('click', () => mutate(arr => {
          if (i <= 0) return;
          const bl = arr[idx].blocks; const t = bl[i - 1]; bl[i - 1] = bl[i]; bl[i] = t;
        }));
        const bDown = mk('button', 'ed-mini', '↓');
        bDown.type = 'button'; bDown.title = '下移';
        bDown.addEventListener('click', () => mutate(arr => {
          const bl = arr[idx].blocks;
          if (i >= bl.length - 1) return;
          const t = bl[i + 1]; bl[i + 1] = bl[i]; bl[i] = t;
        }));
        const bDel = mk('button', 'ed-mini danger', '×');
        bDel.type = 'button'; bDel.title = '删除这一块';
        bDel.addEventListener('click', () => mutate(arr => { arr[idx].blocks.splice(i, 1); }));
        bar.append(bAdd, bUp, bDown, bDel);
        wrap.appendChild(bar);

        if (b.t === 'image') {
          const fig = mk('figure', 'mj-blk-fig');
          const img = mk('img');
          img.loading = 'lazy'; img.decoding = 'async'; img.alt = '';
          if (b.src) img.src = b.src; else { img.style.display = 'none'; }
          const phBox = mk('div', 'mj-blk-drop', b.src ? '点击换图' : '点击选图');
          const pickBox = mk('div', 'mj-blk-media');
          if (b.src) pickBox.appendChild(img); else pickBox.appendChild(phBox);
          if (b.src) pickBox.appendChild(phBox);
          pickBox.title = '点击更换这张图';
          pickBox.addEventListener('click', () => {
            pickImage({ maxSide: 1280, quality: .82, label: '选择一张图片' }, (u, cancelled) => {
              if (cancelled) return;
              if (!u) { alert('这张图读不出来，换一张试试。'); return; }
              mutate(arr => { arr[idx].blocks[i] = Object.assign({}, arr[idx].blocks[i], { src: u }); });
            });
          });
          const cap = mk('figcaption', 'mj-blk-cap' + (editing ? ' mj-editable' : ''), b.cap || (editing ? '（点一下写图注）' : ''));
          if (editing) {
            cap.setAttribute('tabindex', '0');
            cap.addEventListener('click', () => { if (cap.isContentEditable) return; cap.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); cap.focus(); });
            cap.addEventListener('blur', () => {
              cap.contentEditable = 'false';
              document.dispatchEvent(new Event('mj-editing-end'));
              const v = cap.textContent.trim();
              if (v !== String(b.cap || '')) mutate(arr => { arr[idx].blocks[i] = Object.assign({}, arr[idx].blocks[i], { cap: v }); });
            });
            cap.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); cap.blur(); } });
          }
          fig.append(pickBox, cap);
          wrap.appendChild(fig);
          return wrap;
        }

        if (b.t === 'video') {
          const src = esc(b.src);
          const emb = videoEmbed(src);
          if (emb && emb.kind === 'iframe') {
            const f = mk('iframe', 'mj-blk-video');
            f.src = emb.src; f.loading = 'lazy'; f.allowFullscreen = true;
            f.setAttribute('allow', 'accelerometer; encrypted-media; picture-in-picture');
            f.setAttribute('title', esc(b.cap) || '嵌入视频');
            wrap.appendChild(f);
          } else if (emb && emb.kind === 'file') {
            const v = mk('video', 'mj-blk-video');
            v.src = emb.src; v.controls = true; v.preload = 'metadata';
            wrap.appendChild(v);
          } else {
            const box = mk('div', 'mj-blk-vplay');
            box.append(mk('span', 'mj-blk-vico', '▶'), mk('span', null, emb ? '这个地址没法直接内嵌，点开新窗口看' : '还没有填视频地址'));
            if (emb && emb.kind === 'link') {
              const a = mk('a', 'mj-blk-vlink', src);
              a.href = emb.src; a.target = '_blank'; a.rel = 'noopener noreferrer';
              box.appendChild(a);
            }
            wrap.appendChild(box);
          }
          if (editing) {
            const row = mk('div', 'mj-blk-vurl');
            row.appendChild(mk('span', 'k', '视频地址'));
            const inp = mk('input', 'mj-inp');
            inp.type = 'url';
            inp.value = src;
            inp.placeholder = 'B 站 / YouTube 链接，或 .mp4 直链';
            inp.setAttribute('aria-label', '视频地址');
            const commit = () => {
              const v = inp.value.trim();
              if (v !== src) mutate(arr => { arr[idx].blocks[i] = Object.assign({}, arr[idx].blocks[i], { src: v }); });
            };
            inp.addEventListener('blur', commit);
            inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
            row.appendChild(inp);
            wrap.appendChild(row);
          }
          const cap = mk('div', 'mj-blk-cap' + (editing ? ' mj-editable' : ''), b.cap || (editing ? '（点一下写说明）' : ''));
          if (editing) {
            cap.setAttribute('tabindex', '0');
            cap.addEventListener('click', () => { if (cap.isContentEditable) return; cap.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); cap.focus(); });
            cap.addEventListener('blur', () => {
              cap.contentEditable = 'false';
              document.dispatchEvent(new Event('mj-editing-end'));
              const v = cap.textContent.trim();
              if (v !== String(b.cap || '')) mutate(arr => { arr[idx].blocks[i] = Object.assign({}, arr[idx].blocks[i], { cap: v }); });
            });
            cap.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); cap.blur(); } });
          }
          if (b.cap || editing) wrap.appendChild(cap);
          return wrap;
        }

        // 文字块
        const p = mk('p', 'mj-blk-text' + (editing ? ' mj-editable' : ''), b.v || (editing ? '（点一下开始写）' : ''));
        if (editing) {
          p.setAttribute('tabindex', '0');
          p.addEventListener('click', () => { if (p.isContentEditable) return; p.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); p.focus(); });
          p.addEventListener('blur', () => {
            p.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = p.innerText.replace(/\n{3,}/g, '\n\n').trim();
            if (v !== String(b.v || '')) mutate(arr => { arr[idx].blocks[i] = Object.assign({}, arr[idx].blocks[i], { v }); });
          });
          p.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') p.blur(); });
        }
        wrap.appendChild(p);
        return wrap;
      }

      function renderList() {
        const arr = list();
        const cats = ['全部', ...Array.from(new Set(arr.map(p => String(p.cat || '').trim()).filter(Boolean)))];
        if (!cats.includes(cat)) cat = '全部';
        const shown = arr.map((p, i) => ({ p, i })).filter(({ p }) => cat === '全部' || String(p.cat || '').trim() === cat);

        const bar = mk('div', 'sheet list-bar');
        bar.append(mk('h2', 'lb-title', '项目'),
          mk('span', 'mj-stat', '仿图文模式：每个项目可以有文字、图片和视频'),
          mk('span', 'mj-spacer'));
        const addBtn = mk('button', 'mj2-btn', '＋ 新建项目');
        addBtn.type = 'button';
        addBtn.addEventListener('click', () => {
          mutate(a => {
            a.unshift({ cover: '', title: '新项目', cat: '未分类', date: new Date().toISOString().slice(0, 7),
              tags: [], summary: '', blocks: [{ t: 'text', v: '' }] });
          });
          idx = 0; mode = 'article'; editing = true; render();
          Achievements.toast('★', '建好了', '往下写内容吧');
        });
        bar.appendChild(addBtn);

        const chipBox = mk('div', 'sheet mj-proj-chips');
        cats.forEach(c => {
          const b = mk('button', 'mj-chip' + (c === cat ? ' on' : ''), c);
          b.type = 'button';
          b.addEventListener('click', () => { cat = c; render(); });
          chipBox.appendChild(b);
        });

        const grid = mk('div', 'mj-proj-grid');
        shown.forEach(({ p, i }) => {
          const card = mk('article', 'mj-proj-card');
          const cov = mk('div', 'mj-proj-cover');
          if (p.cover) { const im = mk('img'); im.src = p.cover; im.alt = ''; im.loading = 'lazy'; cov.appendChild(im); }
          else { const d = mk('div', 'ph'); d.setAttribute('style', ph(ELEMENTS[i % 7].id, i)); cov.appendChild(d); }
          cov.appendChild(mk('span', 'mj-proj-more', '打开'));
          cov.addEventListener('click', () => { idx = i; mode = 'article'; editing = false; render(); });
          const body = mk('div', 'mj-proj-body');
          body.append(
            mk('h3', null, p.title || '未命名项目'),
            (() => { const m = mk('div', 'mj-proj-meta');
              if (p.cat) m.appendChild(mk('span', 'chip', p.cat));
              if (p.date) m.appendChild(mk('span', 'mj-proj-date', p.date));
              return m; })(),
            mk('p', 'mj-proj-sum', p.summary || '（还没有写摘要）'),
            (() => { const t = mk('div', 'mj-proj-tags');
              (p.tags || []).slice(0, 4).forEach(x => t.appendChild(mk('span', 'tag', '#' + x)));
              const n = (p.blocks || []).length;
              t.appendChild(mk('span', 'mj-proj-n', n + ' 块内容'));
              return t; })());
          const tools = mk('div', 'mj-proj-tools');
          const del = mk('button', 'ed-mini danger', '×');
          del.type = 'button'; del.title = '删除这个项目';
          del.addEventListener('click', ev => {
            ev.stopPropagation();
            if (!confirm('删除「' + (p.title || '未命名项目') + '」？')) return;
            mutate(a => { a.splice(i, 1); });
          });
          tools.appendChild(del);
          card.append(cov, body, tools);
          grid.appendChild(card);
        });
        if (!shown.length) grid.appendChild(mk('p', 'mj-sub', '这里还没有项目，点右上角「＋ 新建项目」开始。'));
        host2.textContent = '';
        host2.append(bar, chipBox, grid);
      }

      function renderArticle() {
        const arr = list();
        const p = arr[idx];
        if (!p) { mode = 'list'; return renderList(); }
        const back = mk('div', 'sheet list-bar');
        const backBtn = mk('button', 'mj2-btn', '← 返回列表');
        backBtn.type = 'button';
        backBtn.addEventListener('click', () => { mode = 'list'; editing = false; render(); });
        const editBtn = mk('button', 'mj2-btn', editing ? '结束编辑' : '编辑');
        editBtn.type = 'button';
        editBtn.addEventListener('click', () => { editing = !editing; render(); });
        back.append(backBtn, mk('span', 'mj-spacer'), mk('span', 'mj-stat', editing ? '点文字就能改，工具条能增删挪动' : ''), editBtn);

        const art = mk('article', 'sheet mj-article mj-article-bili');
        // 封面
        const cover = mk('div', 'mj-art-cover');
        if (p.cover) { const im = mk('img'); im.src = p.cover; im.alt = ''; cover.appendChild(im); }
        else { const d = mk('div', 'ph'); d.setAttribute('style', ph(ELEMENTS[idx % 7].id, idx)); cover.appendChild(d); }
        if (editing) {
          cover.title = '点击更换封面';
          cover.appendChild(mk('span', 'mj-art-cover-pen', '✎'));
          cover.addEventListener('click', () => {
            pickImage({ maxSide: 1280, quality: .82, label: '选择项目封面' }, (u, cancelled) => {
              if (cancelled || !u) return;
              mutate(a => { a[idx].cover = u; });
            });
          });
        }
        const title = mk('h1', 'mj-art-title' + (editing ? ' mj-editable' : ''), p.title || (editing ? '（写个标题）' : '未命名项目'));
        if (editing) {
          title.setAttribute('tabindex', '0');
          title.addEventListener('click', () => { if (title.isContentEditable) return; title.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); title.focus(); });
          title.addEventListener('blur', () => {
            title.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = title.textContent.trim();
            if (v !== String(p.title || '')) mutate(a => { a[idx].title = v; });
          });
          title.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
        }
        const meta = mk('div', 'mj-art-meta');
        const catEl = mk('span', 'chip' + (editing ? ' mj-editable' : ''), p.cat || (editing ? '分类' : ''));
        if (editing) {
          catEl.setAttribute('tabindex', '0');
          catEl.addEventListener('click', () => { if (catEl.isContentEditable) return; catEl.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); catEl.focus(); });
          catEl.addEventListener('blur', () => {
            catEl.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = catEl.textContent.trim();
            if (v !== String(p.cat || '')) mutate(a => { a[idx].cat = v; });
          });
        }
        const dateEl = mk('span', 'mj-art-date' + (editing ? ' mj-editable' : ''), p.date || (editing ? '日期' : ''));
        if (editing) {
          dateEl.setAttribute('tabindex', '0');
          dateEl.addEventListener('click', () => { if (dateEl.isContentEditable) return; dateEl.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); dateEl.focus(); });
          dateEl.addEventListener('blur', () => {
            dateEl.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = dateEl.textContent.trim();
            if (v !== String(p.date || '')) mutate(a => { a[idx].date = v; });
          });
        }
        const tagsEl = mk('span', 'mj-art-tags' + (editing ? ' mj-editable' : ''), (p.tags || []).map(t => '#' + t).join(' '));
        if (editing) {
          tagsEl.setAttribute('tabindex', '0');
          tagsEl.title = '空格分隔，可以随便改';
          tagsEl.addEventListener('click', () => { if (tagsEl.isContentEditable) return; tagsEl.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); tagsEl.focus(); });
          tagsEl.addEventListener('blur', () => {
            tagsEl.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = tagsEl.textContent.split(/[\s,，]+/).map(s => s.replace(/^#/, '').trim()).filter(Boolean);
            if (v.join(',') !== (p.tags || []).join(',')) mutate(a => { a[idx].tags = v; });
          });
        }
        meta.append(catEl, dateEl, tagsEl);

        const sum = mk('p', 'mj-art-sum' + (editing ? ' mj-editable' : ''), p.summary || (editing ? '（写一句摘要）' : ''));
        if (editing) {
          sum.setAttribute('tabindex', '0');
          sum.addEventListener('click', () => { if (sum.isContentEditable) return; sum.contentEditable = 'true'; document.dispatchEvent(new Event('mj-editing-start')); sum.focus(); });
          sum.addEventListener('blur', () => {
            sum.contentEditable = 'false';
            document.dispatchEvent(new Event('mj-editing-end'));
            const v = sum.innerText.trim();
            if (v !== String(p.summary || '')) mutate(a => { a[idx].summary = v; });
          });
        }

        const body = mk('div', 'mj-art-body');
        (p.blocks || []).forEach((b, i) => body.appendChild(blockNode(b, i)));

        art.append(cover, title, meta, sum, body);
        if (editing) {
          const addRow = mk('div', 'mj-art-add');
          [['text', '＋ 文字'], ['image', '＋ 图片'], ['video', '＋ 视频']].forEach(([t, label]) => {
            const b = mk('button', 'ed-add', label);
            b.type = 'button';
            b.addEventListener('click', () => mutate(a => {
              const nb = t === 'text' ? { t, v: '' } : (t === 'image' ? { t, src: '', cap: '' } : { t, src: '', cap: '' });
              a[idx].blocks.push(nb);
            }));
            addRow.appendChild(b);
          });
          const delProj = mk('button', 'ed-add', '删除这个项目');
          delProj.type = 'button';
          delProj.style.marginLeft = 'auto';
          delProj.addEventListener('click', () => {
            if (!confirm('删除「' + (p.title || '未命名项目') + '」？')) return;
            mutate(a => { a.splice(idx, 1); });
            mode = 'list'; editing = false; render();
          });
          addRow.appendChild(delProj);
          art.appendChild(addRow);
        }
        host2.textContent = '';
        host2.append(back, art);
      }

      function render() { if (mode === 'article') renderArticle(); else renderList(); }
      render();
      return { host, destroy() { host.remove(); } };
    },

    about() {
      /* 关于页改成"列表数据 + 渲染"，条目数量本身也是数据：
         每一行都有 ＋（在后面插一条）和 ×（删除），文字点一下就地改。
         默认值只作为种子，用户改动后完全以 State.lists.about 为准。 */
      const host = el('div', 'mj-view');
      host.dataset.view = 'about';
      const seed = () => ({
        profile: [['称呼', '元素手帐 · 记录日常的人'], ['坐标', '中文互联网'], ['在做什么', '把每天的小事写下来：读过的书、做过的饭、走过的路'], ['座右铭', '慢慢来，比较快']],
        tech: [['2020', '开始用本子记事情，后来换成了电子手帐'], ['2022', '学会拍照，也学会删照片'], ['2024', '开始认真做饭，并把菜谱写下来'], ['2025', '把喜欢的书整理成了一份书单'], ['2026', '把这个站搭起来，继续写下去']],
        xp: [['阅读', '睡前读半小时'], ['摄影', '喜欢阴天和清晨'], ['料理', '一周做三次饭'], ['音乐', '写东西的时候听'], ['散步', '走过就记一笔'], ['手作', '拼装与纸模']],
        games: ['塞尔达传说', '星露谷物语', '动物森友会', '双人成行', '女神异闻录', '艾尔登法环'],
        todo: ['把今年的照片整理成一本相册', '补完那本读到一半的书', '学会三道新菜', '把去过的地方标在地图上', '给明年的自己写一封信']
      });
      const D = EdList.get('about', seed);
      const sec = name => EdList.get('about', seed, name);
      EdList.register('about', seed);

      const tools = (name, i) => EdList.tools('about', i, name);
      /* 兼容早期数据：xp 一开始是纯字符串数组，现在升级成 [分类, 内容]。
         老数据把原文放到第二格（内容），分类留空等用户自己填。 */
      const pairs = list => list.map(x => Array.isArray(x) ? [x[0] || '', x[1] || ''] : ['', String(x || '')]);
      const rows = (name, list) => list.map((it, i) => {
        const k = Array.isArray(it) ? (it[0] || '') : '';
        const v = Array.isArray(it) ? (it[1] || '') : String(it || '');
        return `<div class="mj-tick">
          <span class="yr" data-ab="${name}:${i}:0">${k || '标签'}</span>
          <span data-ab="${name}:${i}:1">${v || '（点一下写点什么）'}</span>
          ${tools(name, i)}
        </div>`;
      }).join('');

      const chipRows = (name, list) => list.map((it, i) => `
        <span class="chip ed-chip"><span data-ab="${name}:${i}">${it || '新条目'}</span>${tools(name, i)}</span>`).join('');

      const savedFrame = (State.read().aboutImg) || '';
      host.innerHTML = `
        <div class="sheet list-bar"><h2 class="lb-title">一份可以慢慢补完的自我介绍</h2><span class="mj-stat">每行都能改，也能增删</span>
          <button class="mj2-btn" id="mjEdReset" type="button" style="margin-left:auto">恢复默认</button></div>
        <div class="mj-about">
          <div class="mj-about-side">
            <div class="mj-frame" id="mjFrame" title="点击更换这张图片">
              <div class="ph" id="mjFrameImg" style="${savedFrame ? `background-image:url('${savedFrame}');background-size:cover;background-position:center` : ph('hydro', 1)}"></div>
              <span class="frame-pen" aria-hidden="true">✎</span>
            </div>
            <div style="text-align:center;font-size:.74rem;color:var(--ink-meta);margin-top:.5rem">
              <span data-ed="about.frame.cap" data-ed-default="记录日常的人 · 写字 / 拍照">记录日常的人 · 写字 / 拍照</span>
            </div>
            <div class="ed-bar" style="justify-content:center">
              <button class="ed-add" type="button" id="mjFramePick">更换图片</button>
              <button class="ed-add" type="button" id="mjFrameClear">用回默认</button>
            </div>
          </div>
          <div>
            <div class="mj-sec"><h3>身份档案</h3><div class="mj-ticks">${rows('profile', sec('profile'))}</div></div>
            <div class="mj-sec"><h3>时间线</h3><div class="mj-ticks">${rows('tech', sec('tech'))}</div></div>
            <div class="mj-sec"><h3>兴趣</h3>
              <div class="mj-xps">${pairs(sec('xp')).map(([cat, txt], i) => {
                const saved = (State.read().xpImgs || {})[i];
                return `<div class="mj-xp">
                  <div class="xp-frame">
                    <div class="ph xp-ph" data-xpimg="${i}" title="点击更换这张图"
                      style="${saved ? `background-image:url('${saved}');background-size:cover;background-position:center` : ph(ELEMENTS[i % 7].id, i)}"></div>
                    <span class="xp-pen" aria-hidden="true">✎</span>
                  </div>
                  <span class="xp-cat" data-ab="xp:${i}:0">${cat || '分类'}</span>
                  <span class="xp-txt" data-ab="xp:${i}:1">${txt || '新条目'}</span>${tools('xp', i)}</div>`;
              }).join('')}</div>
              <p class="mj-stat" style="margin:.7rem 0 0">每张都能换图、改分类和内容，也能整条增删。</p></div>
            <div class="mj-sec"><h3>在玩的游戏</h3><div class="mj-chips">${chipRows('games', sec('games'))}</div></div>
            <div class="mj-sec"><h3>近况 · 可以慢慢补完</h3>
              <div class="mj-check" id="mjTodo">${sec('todo').map((t, i) => `<label><input type="checkbox" data-td="${i}"><span data-ab="todo:${i}">${t || '新条目'}</span>${tools('todo', i)}</label>`).join('')}</div>
              <p class="mj-stat" style="margin:.6rem 0 0">勾选会保存在本地，随时回来继续。</p>
            </div>
          </div>
        </div>`;

      // data-ab 形如 "profile:0:1"（区块:下标:字段）或 "xp:2"（区块:下标）
      $$('[data-ab]', host).forEach(el => {
        const p = el.dataset.ab.split(':');
        const name = p[0], idx = +p[1], slot = p.length === 3 ? +p[2] : -1;
        EdList.bindItem(el, 'about', seed, name, idx, (arr, v) => {
          if (slot < 0) { arr[idx] = v; return; }
          // 老数据可能还是纯字符串，升级成 [分类, 内容] 时先把原文留在内容格，别丢
          const cur = arr[idx];
          const pair = Array.isArray(cur) ? cur.slice() : ['', String(cur || '')];
          pair[slot] = v;
          arr[idx] = pair;
        });
      });

      const saved = new Set(State.read().todo || []);
      $$('#mjTodo input', host).forEach(cb => { if (saved.has(+cb.dataset.td)) cb.checked = true; });

      const onClick = e => {
        if (e.target.closest('#mjEdReset')) {
          if (confirm('把「关于」的自定义内容恢复成默认？')) {
            EdList.reset('about'); State.write({ edits: {}, aboutImg: undefined });
            Router.go(); return;
          }
        }
        if (e.target.closest('#mjFramePick')) { pickFrame(); return; }
        if (e.target.closest('#mjFrameClear')) {
          State.write({ aboutImg: undefined });
          const im = $('#mjFrameImg', host); if (im) im.style.backgroundImage = '';
          if (im) im.setAttribute('style', ph('hydro', 1));
          return;
        }
        if (e.target.closest('#mjFrame')) { pickFrame(); return; }
        // 兴趣卡片的图片：点击就换（和头像框同一套压缩逻辑）
        const xpImg = e.target.closest('[data-xpimg]');
        if (xpImg) {
          const idx = +xpImg.dataset.xpimg;
          pickImage({ maxSide: 640, quality: .82, label: '选择一张图片' }, (url, cancelled) => {
            if (cancelled) return;
            if (!url) { alert('这张图读不出来，换一张试试。'); return; }
            const m = Object.assign({}, State.read().xpImgs || {});
            m[idx] = url;
            State.write({ xpImgs: m });
            xpImg.style.cssText = `background-image:url('${url}');background-size:cover;background-position:center`;
            Achievements.toast('★', '已放入相框', '第 ' + (idx + 1) + ' 张兴趣卡片');
          });
          return;
        }
        // 增删条目：重建整个视图最简单也最不容易出状态错乱
        if (EdList.handle(e, () => Router.go())) return;
      };
      function pickFrame() {
        pickImage({ maxSide: 1280, quality: 0.8, label: '选择一张图片' }, (url, cancelled) => {
          if (cancelled || !url) return;
          State.write({ aboutImg: url });
          const im = $('#mjFrameImg', host);
          if (im) { im.style.cssText = `background-image:url('${url}');background-size:cover;background-position:center`; }
          Achievements.toast('★', '图片已更换', '想换回来点"用回默认"');
        });
      }
      const onChange = e => {
        const cb = e.target.closest('[data-td]'); if (!cb) return;
        const i = +cb.dataset.td;
        if (cb.checked) saved.add(i); else saved.delete(i);
        State.write({ todo: [...saved] });
        if (saved.size === sec('todo').length) { Achievements.findClue('E', '近况全部补完'); Achievements.unlock('collector'); }
      };
      host.addEventListener('change', onChange);
      host.addEventListener('click', onClick);
      return { host, destroy() { host.removeEventListener('change', onChange); host.removeEventListener('click', onClick); host.remove(); } };
    },

    schedule() {
      const host = el('div', 'mj-view');
      host.dataset.view = 'schedule';
      host.innerHTML = `
        <div class="sheet list-bar"><h2 class="lb-title">课表</h2><span class="mj-stat">增删查改 · 支持 ICS 导入</span></div>
        <div class="sheet" style="padding:1rem"><div id="mj2ScheduleBody"></div></div>`;
      const inner = host.querySelector('#mj2ScheduleBody');
      if (window.MJ2 && window.MJ2.Sched) window.MJ2.Sched.attach(inner);
      return { host, destroy() { if (window.MJ2 && window.MJ2.Sched) window.MJ2.Sched.detach(); host.remove(); } };
    },

    friends() {
      /* 友链改成可自由增删改：每条是 [名称, 简介, 链接]，链接点得动、
         文字就地改、悬停浮出 ＋/×，另有"新增友链"与"恢复默认"。 */
      /* 每条友链是 [名称, 简介, 链接, 头像]。
         ★ 第 4 格（头像）是后加的：以前头像只是个色块 + 首字母，**没有任何办法换**。
         老数据只有 3 格，读出来是 undefined，照样显示色块，不会出错。 */
      const seed = () => [
        ['随手记', '写日常的小站', ''],
        ['午后书房', '读书与摘抄', ''],
        ['厨房实验', '做饭记录', ''],
        ['在路上', '旅行与照片', ''],
        ['深夜电台', '音乐与随笔', ''],
        ['拼装间', '手作与模型', '']
      ];
      EdList.register('friends', seed);
      const host = el('div', 'mj-view');
      host.dataset.view = 'friends';

      /* 选一张图当友链头像：和别处一样压到 256px 再存，别把 localStorage 撑爆 */
      function pickFav(i) {
        pickImage({ maxSide: 256, quality: .85, label: '选择这张友链的头像' }, (url, cancelled) => {
          if (cancelled) return;
          if (!url) { alert('这张图读不出来，换一张试试。'); return; }
          const arr = EdList.get('friends', seed).map(x => Array.isArray(x) ? x.slice() : [String(x || ''), '', '']);
          const cur = arr[i] || ['', '', ''];
          cur[3] = url;
          arr[i] = cur;
          EdList.setSec('friends', seed, null, arr);
          draw();
          Achievements.toast('★', '换好头像', '「' + (cur[0] || '友链') + '」');
        });
      }
      const clearFav = i => {
        const arr = EdList.get('friends', seed).map(x => Array.isArray(x) ? x.slice() : [String(x || ''), '', '']);
        if (arr[i]) arr[i][3] = '';
        EdList.setSec('friends', seed, null, arr);
        draw();
      };

      const draw = () => {
        const arr = EdList.get('friends', seed);
        host.innerHTML = `
          <div class="sheet list-bar"><h2 class="lb-title">友链坐标</h2><span class="mj-stat">一起写字的人 · 头像 / 名称 / 简介 / 链接都能改，条目可增删</span>
            <button class="mj2-btn" id="mjFriReset" type="button" style="margin-left:auto">恢复默认</button></div>
          <div class="mj-friends" id="mjFriList">${arr.map((f, i) => {
            const [n, d, url, favRaw] = Array.isArray(f) ? f : [String(f || ''), '', '', ''];
            const initial = (n || '?').trim().charAt(0).toUpperCase();
            const safeUrl = /^https?:\/\/[^\s"'<>]+$/i.test(url || '') ? url : '';
            /* 头像只认 data:image/*（shrink() 的产物）。存坏的值就当没设置，
               免得它被拼进 style="background-image:url('...')" 里把样式撑坏 */
            const fav = /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/i.test(favRaw || '') ? favRaw : '';
            // 名字要进 aria-label 属性，引号会把这一行的标签截断，去掉
            const label = String(n || '新友链').replace(/["<>]/g, '');
            return `<div class="mj-friend">
              <span class="fav${fav ? ' has-img' : ''}" data-fav="${i}" role="button" tabindex="0"
                title="点击更换头像" aria-label="更换「${label}」的头像"
                style="${fav ? `background-image:url('${fav}');background-size:cover;background-position:center` : ph(ELEMENTS[i % 7].id, i)}">
                <i${fav ? ' hidden' : ''}>${initial}</i>
                <em class="fav-pen" aria-hidden="true">✎</em>
              </span>
              <span class="fj-body">
                <b data-fr="${i}:0">${n || '新友链'}</b>
                <span data-fr="${i}:1">${d || '（点一下写简介）'}</span>
                <span class="fj-url">${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl.replace(/^https?:\/\//, '').slice(0, 30)}</a>` : '<em data-fr="' + i + ':2">（点一下填链接）</em>'}</span>
              </span>
              ${EdList.tools('friends', i, null, fav
                ? `<button class="ed-mini" type="button" data-favclear="${i}" title="换回色块头像" aria-label="换回色块头像">↺</button>`
                : '')}
            </div>`;
          }).join('')}</div>
          <div class="ed-bar" style="margin-top:.8rem">
            <button class="ed-add" type="button" data-ed-add="friends" data-i="${arr.length - 1}" title="新增友链">＋ 新增友链</button>
          </div>`;
        $$('[data-fr]', host).forEach(el => {
          const p = el.dataset.fr.split(':');
          const i = +p[0], slot = +p[1];
          EdList.bindItem(el, 'friends', seed, null, i, (a, v) => {
            const cur = Array.isArray(a[i]) ? a[i].slice() : ['', '', ''];
            cur[slot] = v;
            a[i] = cur;
          });
        });
      };
      const onClick = e => {
        if (e.target.closest('#mjFriReset')) {
          if (confirm('把友链恢复成默认？')) { EdList.reset('friends'); draw(); }
          return;
        }
        // 头像上的"用回色块"要排在"点头像换图"前面，否则会被后者吃掉
        const clr = e.target.closest('[data-favclear]');
        if (clr) { e.preventDefault(); e.stopPropagation(); clearFav(+clr.dataset.favclear); return; }
        const fav = e.target.closest('[data-fav]');
        if (fav) { e.preventDefault(); e.stopPropagation(); pickFav(+fav.dataset.fav); return; }
        if (EdList.handle(e, () => draw())) return;
      };
      /* 头像挂的是 role="button"，键盘回车/空格也得能开文件框，
         不然这就是个"看起来能点、键盘点不动"的假按钮 */
      const onKey = e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const fav = e.target.closest && e.target.closest('[data-fav]');
        if (!fav) return;
        e.preventDefault();
        pickFav(+fav.dataset.fav);
      };
      host.addEventListener('click', onClick);
      host.addEventListener('keydown', onKey);
      draw();
      return { host, destroy() { host.removeEventListener('click', onClick); host.removeEventListener('keydown', onKey); host.remove(); } };
    },

    /* 茶室：真正的实现在 chat.js 里（那边要处理两条传输通道和一大套状态），
       这里只负责把它挂成路由里的一个视图。没有 chat.js 时给一句人话，
       不要让整条路由炸掉。 */
    chat() {
      if (!window.MJ2Chat || typeof window.MJ2Chat.view !== 'function') {
        const host = el('div', 'mj-view');
        host.dataset.view = 'chat';
        const box = el('div', 'sheet list-bar');
        box.innerHTML = '<h2 class="lb-title">茶室</h2><span class="mj-stat">chat.js 没加载进来，刷新一下页面试试</span>';
        host.appendChild(box);
        return { host, destroy() { host.remove(); } };
      }
      return window.MJ2Chat.view();
    }
  };

  /* ============================================================
     9. 场景序列路由：可推进 / 可发现 / 可返回
     把既有 main#content 的子节点收进 home 视图，其余视图动态挂载
     ============================================================ */
  const Router = (() => {
    const content = $('#content');
    if (!content) return { start() {} };
    const CH = ['000', '001', '002', '003', '004'];

    // ① 既有子节点 → home 视图
    const home = el('div', 'mj-view');
    home.dataset.view = 'home';
    while (content.firstChild) home.appendChild(content.firstChild);
    content.appendChild(home);

    const KNOWN = ['home', 'blog', 'article', 'works', 'games', 'projects', 'schedule', 'about', 'friends', 'chat'];
    let live = null;

    function parse() {
      const h = location.hash.replace(/^#\/?/, '');
      const p = h.split('/').filter(Boolean);
      if (!p.length) return { view: 'home', ch: '001' };
      if (p[0] === 'blog') return p[1] ? { view: 'article', slug: p[1], ch: 'blog' } : { view: 'blog', ch: 'blog' };
      if (p[0] === 'chapter') return { view: 'home', ch: p[1] || '001', anchor: 'chapter-' + p[1] };
      if (p[0] === 'memory') return { view: 'home', ch: '000', scrollMemory: true };
      if (KNOWN.includes(p[0])) return { view: p[0], ch: p[0] };
      return { view: 'home', ch: '001' };
    }

    function setChrome(view) {
      // 记忆区只在 home 出现，否则 520vh 空舞台会顶在所有页面上
      if (Memory.host) Memory.host.style.display = view === 'home' ? '' : 'none';
      /* 和 index.html <head> 里那段"第一帧之前"的判断保持同步：
         进来时是深链接就先挂上 class，之后路由切回首页要记得摘掉，
         否则 CSS 的 html.mj-not-home #mj-memory{display:none} 会一直把它藏着。 */
      document.documentElement.classList.toggle('mj-not-home', view !== 'home');
      // 既有壁纸/Banner 在内页收起来，让内容成为主角
      const bw = $('#banner-wrapper');
      if (bw) bw.style.display = view === 'home' ? '' : 'none';
      const mo = $('#main-outer');
      if (mo) mo.style.marginTop = view === 'home' ? '' : '5.5rem';
    }

    function go() {
      const r = parse();
      setChrome(r.view);
      if (live && live.destroy) live.destroy();
      live = null;
      $$('.mj-view[data-view]', content).forEach(v => { if (v !== home) v.remove(); });
      home.hidden = r.view !== 'home';
      document.body.dataset.view = r.view;

      if (r.view !== 'home') {
        const v = Views[r.view] && Views[r.view](r.slug);
        if (v) { live = v; content.appendChild(v.host); }
      }

      // 高亮：直接复用既有 .nav-links a.on 样式（原有高亮 JS 查的是不存在的 .topnav，属死代码）
      $$('#navbar .nav-links a').forEach(a => a.classList.toggle('on', a.dataset.nav === (r.view === 'article' ? 'blog' : r.view)));
      $$('.mj-route-list a').forEach(a => a.classList.toggle('on', a.dataset.ch === r.ch));

      // 记忆区隐藏时 offsetHeight 为 0，回到 home 必须重新量一次
      if (r.view === 'home' && Memory.remeasure) Memory.remeasure();

      if (r.scrollMemory) { Memory.host.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); return; }
      if (r.anchor) { const t = document.getElementById(r.anchor); if (t) { t.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); return; } }
      scrollTo({ top: 0 });
      // 视图换掉之后重新挂"文案可编辑"（视图是每次新建的，绑定要跟着重建）
      requestAnimationFrame(() => Editable.applyAll());
    }

    addEventListener('hashchange', go);
    return { start: go, go };
  })();

  /* ============================================================
     10. 在既有外壳上挂载：导航、元素切换、场景导轨、卷标
     ============================================================ */
  const ROUTE_ITEMS = [
    ['#/memory', '000', 'Opening Memory', '滚动叙事的开场，看完揭示照片墙'],
    ['#/blog', '001', 'Blog 手记', '按时间归档，可按分类和标签检索'],
    ['#/works', '002', 'Works 作品集', '做过的事：照片、菜谱、书单、手作，封面与条目都能改'],
    ['#/projects', '003', 'Projects 项目', '图文模式：每个项目由文字、图片、视频组成'],
    ['#/games', '004', 'Games 游乐场', '贪吃蛇 / 俄罗斯方块 / 打砖块 / 记忆翻牌'],
    ['#/schedule', '005', 'Schedule 课表', '每天 11 节，可导入 ICS'],
    ['#/about', '006', 'About 自述', '可以慢慢补完的自我介绍，每行都能改'],
    ['#/friends', '005', 'Friends 友链', '一起写字的人，内容可自由增删改'],
    ['#/chat', '007', 'Chat 茶室', '局域网聊天室：同一 WiFi 的人扫码就能进来']
  ];
  /* 场景序列：只列出**真实存在**的视图，每条带一句"这里是干什么的"。
     之前列了 #/chapter/001..004 四个并不存在的路由，点进去什么都不显示 ——
     用户看到的"没有出现的内容"就是这个。现在改成由 State.lists.routes 驱动：
     可增删改条目、可搜索，并且会用 KNOWN 列表校验目标，防止再出现死链。 */
  const VIEW_LABELS = {
    '/': '首页', '/memory': 'Opening Memory', '/blog': '文章归档', '/works': '作品操作台',
    '/projects': '工程看板', '/games': '游乐场', '/schedule': '课表', '/about': '自述', '/friends': '友链',
    '/chat': '茶室'
  };
  function routeListHTML(idSuffix) {
    const seed = ROUTE_ITEMS.map(([href, no, name, desc]) => [href, no, name, desc]);
    const arr = (State.read().lists || {}).routes || seed;
    if (!routeListHTML._wired) {
      routeListHTML._wired = true;
      EdList.register('routes', () => seed);
    }
    const q = (routeListHTML._q || '').trim().toLowerCase();
    const list = q ? arr.filter(r => (r.join(' ') || '').toLowerCase().includes(q)) : arr;
    /* ★ 这个 HTML 会同时渲染到左栏和移动端菜单两处。
       两边都用 id="mjRouteQ" 的话 DOM 里就有两个同名 id（HTML 不允许，
       浏览器会报 "Duplicate form field id in the same form"），
       所以加后缀区分，平时用 class 定位。 */
    const sfx = idSuffix || '';
    return `
      <div class="route-search">
        <input type="search" class="mj-route-q" id="mjRouteQ${sfx}" placeholder="搜场景…" aria-label="搜索场景序列" value="${(routeListHTML._q || '').replace(/"/g, '&quot;')}" />
      </div>` + (list.length ? list.map(r => {
        const [href, no, name, desc] = r;
        const ok = !!VIEW_LABELS[String(href || '').replace(/^#/, '')];
        const i = arr.indexOf(r);
        return `<a href="${ok ? href : '#'}" data-ch="${no}" class="${ok ? '' : 'dead'}">
          <span class="no">${no || '—'}</span>
          <span class="lb"><b>${name || '新场景'}</b>${desc ? `<em>${desc}</em>` : ''}</span>
          <span class="st">◇</span>
          ${EdList.tools('routes', i)}
        </a>`;
      }).join('') : '<p class="mj-sub" style="padding:.4rem .2rem">没有匹配的场景</p>') +
      `<div class="ed-bar"><button class="ed-add" type="button" data-ed-add="routes" data-i="-1">＋ 新增场景</button></div>`;
  }
  /* 场景序列里的文字就地改：编号 / 名称 / 说明 / 目标 */
  function bindRouteItems(root) {
    const seed = () => ROUTE_ITEMS.map(([href, no, name, desc]) => [href, no, name, desc]);
    const arr = (State.read().lists || {}).routes || seed();
    $$('.mj-route-list a', root).forEach(a => {
      const ch = a.dataset.ch;
      const i = arr.findIndex(r => r[1] === ch);
      if (i < 0) return;
      const b = a.querySelector('.lb b'), em = a.querySelector('.lb em'), no = a.querySelector('.no');
      [[no, 1], [b, 2], [em, 3]].forEach(([el, slot]) => {
        if (!el) return;
        EdList.bindItem(el, 'routes', seed, null, i, (list, v) => {
          const cur = Array.isArray(list[i]) ? list[i].slice() : ['', '', '', ''];
          cur[slot] = v;
          list[i] = cur;
        });
      });
    });
  }

  function mountChrome() {    /* ---------- 合并全屏合成层 ----------
       归因实测：单个背景层各只占 ~0.5ms，但 9 层叠起来要 18ms（全隐藏后 4.27ms ≈ 空白页地板）。
       瓶颈是"叠了多少全屏合成层"，不是某一层贵。这里把可合并的都并掉。 */
    const atmo = $('#atmosphere'), wp = $('#wallpaper');
    if (atmo && wp) { while (atmo.firstChild) wp.appendChild(atmo.firstChild); atmo.remove(); }
    const tgh = $('.top-gradient-highlight'); if (tgh) tgh.remove();

    /* 呼吸渐变折进已有遮罩层。
       实测它是全页最贵的单项：116% 视口的独立图层每帧 transform 合成，独占 9.2–9.6ms
       （基线 26.27ms → 停掉动画 16.70ms）。折进 .bg-overlay 后零额外图层。 */
    const gb = wp && wp.querySelector('.gradient-breathe');
    const bo = wp && wp.querySelector('.bg-overlay');
    if (gb) {
      if (bo) {
        bo.style.background = 'linear-gradient(-45deg, rgba(161,140,209,.42), rgba(251,194,235,.42), rgba(161,196,253,.42), rgba(194,233,251,.42)), rgba(255,255,255,.26)';
      }
      gb.remove();
    }
    if (wp) {
      /* ★ 壁纸跟随横幅轮播，但**不能再改 src** —— src 不是可过渡属性，
         直接换等于硬切，这正是"背景图切换没有过渡"的原因。
         改成两层叠着：新图先加载到背面那层，两层透明度交叉淡过去。
         层数只留 2 层（原来 9 层叠着要 18ms，2 层的合成开销可以忽略），
         所以既拿到了过渡，也没把之前优化掉的性能吃回去。 */
      let wImgs = Array.from(wp.children).filter(n => n.tagName === 'IMG');
      wImgs.slice(2).forEach(n => n.remove());
      while (Array.from(wp.children).filter(n => n.tagName === 'IMG').length < 2) {
        const extra = document.createElement('img');
        extra.alt = '';
        extra.setAttribute('aria-hidden', 'true');
        wp.insertBefore(extra, wp.firstChild.nextSibling || null);
      }
      wImgs = Array.from(wp.children).filter(n => n.tagName === 'IMG');
      const first = wImgs[0];
      const firstSrc = first && first.getAttribute('src');
      if (first) { first.classList.add('on'); }
      if (wImgs[1]) {
        wImgs[1].classList.remove('on');
        // 先塞同一张，避免出现"空 src"的破损图标（它是隐藏的，不会绘制）
        if (firstSrc) wImgs[1].setAttribute('src', firstSrc);
      }
      let front = 0;
      let lastSrc = firstSrc || '';
      const setWallpaper = src => {
        if (!src || src === lastSrc) return;
        const cur = wImgs[front];
        const next = wImgs[1 - front];
        if (!cur || !next) return;
        lastSrc = src;
        next.setAttribute('src', src);
        next.classList.add('on');       // 淡入：visibility 立刻可见
        cur.classList.remove('on');     // 淡出：visibility 延迟到淡完才隐藏
        front = 1 - front;
      };

      /* 用 MutationObserver 盯着横幅那两张图的 class 变化来驱动，
         而不是每 700ms 轮询一次 —— 轮询会一直占着主线程做 DOM 查询，
         而且标签页切到后台、或者停留内页时它照样在跑。 */
      const bImgs = Array.from(document.querySelectorAll('#banner-wrapper > img'));
      if (bImgs.length) {
        const mo = new MutationObserver(() => {
          const active = bImgs.find(i => i.classList.contains('on'));
          if (!active) return;
          setWallpaper(active.getAttribute('src'));
        });
        bImgs.forEach(i => mo.observe(i, { attributes: true, attributeFilter: ['class'] }));
      }
    }

    const oldGrain = document.querySelector('.grain');
    if (oldGrain) oldGrain.remove();
    // 颗粒纸纹整层移除：它独占约 3.8ms 全屏合成，而手帐质感已由配色、胶带、拍立得与横格线承担

    /* 顶栏：改造既有导航为路由链接
       ★ 这份列表才是真正的导航 —— index.html 里那几行只是 JS 跑起来之前的占位，
       两者要对齐，否则"改了 HTML 却没生效"会很难查。 */
    const nav = $('#navbar .nav-links');
    if (nav) {
      nav.innerHTML = `
        <a href="#/" data-nav="home">首页</a>
        <a href="#/blog" data-nav="blog">文章</a>
        <a href="#/works" data-nav="works">作品</a>
        <a href="#/projects" data-nav="projects">项目</a>
        <a href="#/schedule" data-nav="schedule">课表</a>
        <a href="#/games" data-nav="games">游戏</a>
        <a href="#/chat" data-nav="chat">茶室</a>
        <a href="#/about" data-nav="about">关于</a>
        <a href="#/friends" data-nav="friends">友链</a>`;
    }

    // 顶栏右侧：元素切换
    const right = $('#navbar .nav-right');
    if (right) {
      const wrap = el('div', 'mj-els');
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', '切换元素');
      ELEMENTS.forEach(e => {
        const b = el('button'); b.type = 'button'; b.dataset.el = e.id;
        b.style.setProperty('--c', e.c); b.title = e.name + '元素';
        b.setAttribute('aria-label', e.name + '元素');
        b.addEventListener('click', () => setElement(e.id));
        wrap.appendChild(b);
      });
      right.insertBefore(wrap, right.firstChild);
    }

    // 左栏：场景序列导轨（只列真实视图 + 说明 + 可增删改 + 可搜）
    const left = $('.left-sidebar') || $('#sidebar');
    if (left) {
      const box = el('div', 'sheet');
      box.innerHTML = `
        <div class="widget-head"><span class="w-ico">▸</span><span class="ed-label">场景序列</span></div>
        <div class="widget-body"><div class="mj-route-list" id="mjRouteList">${routeListHTML()}</div></div>`;
      left.appendChild(box);
      const listHost = $('#mjRouteList', box);
      const redraw = () => {
        listHost.innerHTML = routeListHTML();
        markFound();
        bindRouteItems(listHost);
      };
      box.addEventListener('click', e => {
        if (EdList.handle(e, redraw)) return;
        const a = e.target.closest('a[data-ch]');
        if (!a) return;
        if (a.classList.contains('dead')) { Achievements.toast('◆', '这条目标不存在', '点右边的铅笔改成真实路径'); e.preventDefault(); return; }
        markChapter(a.dataset.ch);
      });
      box.addEventListener('input', e => {
        if (!e.target.classList.contains('mj-route-q')) return;
        routeListHTML._q = e.target.value;
        const focus = e.target;
        const pos = focus.value.length;
        redraw();
        const again = listHost.querySelector('.mj-route-q');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
      bindRouteItems(listHost);
    }

    // 移动端：顶部菜单入口（否则七个视图在手机上无路可达）
    const menuBtn = el('button', 'icon-btn');
    menuBtn.id = 'mjMenuBtn';
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', '打开页面菜单');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.textContent = '☰';
    const menu = el('div', 'closed');
    menu.id = 'mj-menu';
    menu.innerHTML = `<div class="mj-route-list">${routeListHTML('Menu')}</div>`;
    document.body.appendChild(menu);
    if (right) right.appendChild(menuBtn); else document.body.appendChild(menuBtn);
    const toggleMenu = () => {
      const closed = menu.classList.toggle('closed');
      menuBtn.setAttribute('aria-expanded', String(!closed));
    };
    menuBtn.addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
    menu.addEventListener('click', e => {
      const a = e.target.closest('a[data-ch]');
      if (a) { markChapter(a.dataset.ch); menu.classList.add('closed'); menuBtn.setAttribute('aria-expanded', 'false'); }
    });
    /* 移动端菜单里那份场景序列也要能搜 —— 它和左栏是两个独立的 DOM 副本
       （各有一份列表和增删按钮），共用一个查询词 routeListHTML._q，
       所以两边打字的结果是一致的，只是各自重画自己那份。 */
    menu.addEventListener('input', e => {
      if (!e.target.classList.contains('mj-route-q')) return;
      routeListHTML._q = e.target.value;
      const pos = e.target.value.length;
      const again = menu.querySelector('.mj-route-q');
      menu.innerHTML = `<div class="mj-route-list">${routeListHTML('Menu')}</div>`;
      const now = menu.querySelector('.mj-route-q');
      if (now) { now.focus(); now.setSelectionRange(pos, pos); }
      if (typeof bindRouteItems === 'function') bindRouteItems(menu);
    });
    menu.addEventListener('click', e => {
      if (EdList.handle(e, () => { menu.innerHTML = `<div class="mj-route-list">${routeListHTML('Menu')}</div>`; bindRouteItems(menu); })) return;
    });
    document.addEventListener('click', e => {
      if (menu.classList.contains('closed')) return;
      if (!menu.contains(e.target) && !menuBtn.contains(e.target)) { menu.classList.add('closed'); menuBtn.setAttribute('aria-expanded', 'false'); }
    });

    // 手帐胶带：给既有卡片加装饰（仅首页主栏，避免内页噪声）
    $$('#content .list-bar, #content #post-list .post-card').forEach((c, i) => {
      if (i % 2 === 0) c.appendChild(el('span', 'mj-tape' + (i % 4 === 2 ? ' r' : '')));
    });

    markFound();
    mountSearch();
    mountLists();
    Editable.applyAll();
  }

  /* ---------- 可增删的侧栏栏目：公告 / 标签 ----------
     两处都是"会变长的内容"，所以用 EdList 的数组模型而不是单条文案覆盖。 */
  function mountLists() {
    const annHost = document.getElementById('mjAnnounce');
    const tagHost = document.getElementById('mjTags');
    const catHost = document.getElementById('mjCats');
    const tocHost = document.getElementById('tocList');
    const socialHost = document.getElementById('mjSocial');
    if (!annHost && !tagHost && !catHost && !tocHost && !socialHost) return;

    const seedAnn = ['欢迎来我的手帐坐坐，这里记的都是一些小事。', '右下角可以换主题色、壁纸模式和氛围特效。'];
    const seedTags = [['随笔', 24], ['读书', 18], ['料理', 12], ['摄影', 9], ['旅行', 7], ['日常', 15]];
    const seedCats = [['生活随笔', 0], ['读书笔记', 0], ['厨房记录', 0], ['走走看看', 0], ['小工具', 0]];
    const seedToc = [['最新手记', 0], ['生活随笔', 1], ['读书笔记', 1], ['厨房记录', 0], ['走走看看', 0]];
    EdList.register('announce', seedAnn);
    EdList.register('tags', seedTags);
    EdList.register('cats', seedCats);
    EdList.register('toc', seedToc);
    /* 个人标签：简介下面那一排平台。（名称, 链接）两条，都能改、能增删。
       原来这排是写死在 HTML 里的 <a href="#">，既改不了也是死链。 */
    const seedSocial = [['哔哩哔哩', ''], ['Gitee', ''], ['GitHub', ''], ['Discord', '']];
    EdList.register('social', seedSocial);
    let curTag = -1;

    /* 平台名可改、链接可改、有链接时多一个 ↗ 直接打开。
       三条互不抢点击：名字点一下改名，链接点一下填链接，↗ 才负责跳转
       （把 <a> 套在可编辑的 span 里会打架：点链接想跳转，点文字想编辑）。 */
    function drawSocial() {
      if (!socialHost) return;
      const arr = EdList.get('social', seedSocial);
      const safeUrl = u => (/^https?:\/\/[^\s"'<>]+$/i.test(u || '') ? u : '');
      socialHost.innerHTML = arr.map((s, i) => {
        const nm = Array.isArray(s) ? (s[0] || '') : String(s || '');
        const url = Array.isArray(s) ? (s[1] || '') : '';
        const safe = safeUrl(url);
        return `<span class="social-item">
          <span class="btn-regular soc-name" data-socname="${i}" title="点击改名称">${nm || '新平台'}</span>
          <span class="soc-url" data-socurl="${i}" title="点击填链接">${safe ? safe.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 26) : '（填链接）'}</span>
          ${safe ? `<a class="soc-open" href="${safe}" target="_blank" rel="noopener noreferrer" aria-label="打开 ${nm || '这个平台'}" title="打开链接">↗</a>` : ''}
          ${EdList.tools('social', i)}
        </span>`;
      }).join('') + `<button class="ed-add" type="button" data-ed-add="social" data-i="-1" title="新增一个平台">＋ 平台</button>`;

      $$('[data-socname]', socialHost).forEach(el => {
        const i = +el.dataset.socname;
        EdList.bindItem(el, 'social', seedSocial, null, i, (a, v) => {
          const cur = a[i];
          const pair = Array.isArray(cur) ? cur.slice() : [String(cur || ''), ''];
          pair[0] = v; a[i] = pair;
        });
        // 改完立刻重画一次：链接会缩成域名、↗ 也会跟着出现，
        // 否则要等下一次整页刷新才看得到变化
        el.addEventListener('blur', () => setTimeout(() => { drawSocial(); applySocialHint(); }, 0));
      });
      $$('[data-socurl]', socialHost).forEach(el => {
        const i = +el.dataset.socurl;
        EdList.bindItem(el, 'social', seedSocial, null, i, (a, v) => {
          const cur = a[i];
          const pair = Array.isArray(cur) ? cur.slice() : ['', String(cur || '')];
          pair[1] = v.trim(); a[i] = pair;
        });
        el.addEventListener('blur', () => setTimeout(() => { drawSocial(); applySocialHint(); }, 0));
      });
    }
    function applySocialHint() {
      if (!socialHost) return;
      if (!socialHost.querySelector('.social-item')) {
        socialHost.innerHTML = '<p class="mj-stat" style="margin:.2rem 0">还没有平台，点下面的「＋ 平台」加一个。</p>';
      }
    }

    const drawAnn = () => {
      if (!annHost) return;
      const arr = EdList.get('announce', seedAnn);
      annHost.innerHTML = arr.map((t, i) => `
        <p class="ed-row"><span data-ann="${i}">${t || '（空公告，点一下写点东西）'}</span>${EdList.tools('announce', i)}</p>`).join('');
      $$('[data-ann]', annHost).forEach(el => EdList.bindItem(el, 'announce', seedAnn, null, +el.dataset.ann));
    };
    const pairName = (arr, i, v) => { const cur = arr[i]; arr[i] = Array.isArray(cur) ? [v, cur[1]] : v; };
    const drawTags = () => {
      if (!tagHost) return;
      const arr = EdList.get('tags', seedTags);
      tagHost.innerHTML = arr.map((t, i) => {
        const name = Array.isArray(t) ? t[0] : t;
        const n = Array.isArray(t) ? t[1] : 0;
        return `<span class="chip ed-chip${i === curTag ? ' on' : ''}" data-tag="${i}">
          <span data-tagname="${i}">${name || '新标签'}</span>${n ? `<span class="n">${n}</span>` : ''}
          ${EdList.tools('tags', i)}</span>`;
      }).join('');
      $$('[data-tagname]', tagHost).forEach(el => EdList.bindItem(el, 'tags', seedTags, null, +el.dataset.tagname,
        (a, v) => pairName(a, +el.dataset.tagname, v)));
    };
    /* 分类与标签同构（都是 名称 + 计数），共用一套渲染 */
    const drawPairs = (name, hostEl, seed, cls) => {
      if (!hostEl) return;
      const arr = EdList.get(name, seed);
      hostEl.innerHTML = arr.map((t, i) => {
        const nm = Array.isArray(t) ? t[0] : t;
        const n = Array.isArray(t) ? t[1] : 0;
        return `<span class="ed-pair"><span class="${cls}" data-pn="${name}.${i}">${nm || '新条目'}</span>${n ? `<span class="n">${n}</span>` : ''}${EdList.tools(name, i)}</span>`;
      }).join('');
      $$(`[data-pn^="${name}."]`, hostEl).forEach(el => {
        const i = +el.dataset.pn.split('.')[1];
        EdList.bindItem(el, name, seed, null, i, (a, v) => pairName(a, i, v));
      });
    };
    const rerender = name => {
      if (name === 'announce') drawAnn();
      if (name === 'tags') drawTags();
      if (name === 'cats') drawPairs('cats', catHost, seedCats, '');
      if (name === 'toc') drawPairs('toc', tocHost, seedToc, '');
      if (name === 'social') { drawSocial(); applySocialHint(); }
    };

    const onClick = e => {
      const chip = e.target.closest('[data-tag]');
      if (chip && !e.target.closest('.ed-tools')) {
        curTag = curTag === +chip.dataset.tag ? -1 : +chip.dataset.tag;
        drawTags(); return;
      }
      if (EdList.handle(e, rerender)) return;
    };
    const ls = document.querySelector('.left-sidebar'), rs = document.querySelector('.right-sidebar');
    if (ls) ls.addEventListener('click', onClick);
    if (rs) rs.addEventListener('click', onClick);
    drawAnn(); drawTags(); drawPairs('cats', catHost, seedCats, ''); drawPairs('toc', tocHost, seedToc, '');
    drawSocial(); applySocialHint();
    onPageGone(() => {
      if (ls) ls.removeEventListener('click', onClick);
      if (rs) rs.removeEventListener('click', onClick);
    });
  }

  /* ---------- 顶栏检索：接百度 ----------
     顶栏那个 ⌕ 原来只是个装饰按钮，点了没反应。
     现在点开一条就地输入框，回车走百度搜索：
     桌面版交给系统浏览器打开（Electron 里不抢窗口），网页版开新标签页。 */
  function mountSearch() {
    const btn = $('#searchBtn');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.setAttribute('aria-expanded', 'false');

    const box = el('div', 'mj-search');
    box.innerHTML = `
      <label class="mj-search-box">
        <span class="mj-search-ic" aria-hidden="true">⌕</span>
        <input id="mjSearchInput" type="search" autocomplete="off"
          placeholder="用百度搜索…" aria-label="用百度搜索" />
      </label>
      <div class="mj-search-tip">回车用百度搜索 · Esc 关闭</div>`;
    document.body.appendChild(box);

    const input = $('#mjSearchInput', box);
    const open = () => {
      box.classList.add('on');
      btn.setAttribute('aria-expanded', 'true');
      input.focus(); input.select();
    };
    const close = () => {
      box.classList.remove('on');
      btn.setAttribute('aria-expanded', 'false');
      if (document.activeElement === input) input.blur();
    };
    const submit = () => {
      const q = input.value.trim();
      if (!q) { input.focus(); return; }
      const url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(q);
      const D = window.mjDesktop;
      if (D && D.isDesktop && D.openExternal) D.openExternal(url).catch(() => {});
      else window.open(url, '_blank', 'noopener,noreferrer');
      close();
    };
    btn.addEventListener('click', e => { e.stopPropagation(); if (box.classList.contains('on')) close(); else open(); });
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    document.addEventListener('click', e => { if (box.classList.contains('on') && !box.contains(e.target) && !btn.contains(e.target)) close(); });
    addEventListener('keydown', e => {
      // Ctrl+K 直接调出检索（桌面应用的常规操作）
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); if (box.classList.contains('on')) close(); else open(); }
      if (e.key === 'Escape' && box.classList.contains('on')) close();
    });
    onPageGone(() => box.remove());
  }
  function markChapter(ch) {
    const found = new Set(State.read().chapters || []);
    found.add(ch); State.write({ chapters: [...found] });
    markFound();
  }
  function markFound() {
    const found = new Set(State.read().chapters || []);
    $$('.mj-route-list a').forEach(a => {
      a.classList.toggle('found', found.has(a.dataset.ch));
      const st = $('.st', a); if (st) st.textContent = found.has(a.dataset.ch) ? '◆' : '◇';
    });
  }

  /* ============================================================
     10.4 粒子层：Canvas 统一渲染
     归因测试结论：静态页面光栅 ~5ms，而 34 个 DOM 动画元素要 ~15ms
     （软件渲染下每个合成层 ≈0.4ms/帧）。搬到单张 Canvas 后只剩 1 个绘制目标。
     输入：主题 / 特效开关   输出：单 Canvas 帧   清理：摘除 rAF 与监听
     ============================================================ */
  const Particles = (() => {
    const canvas = el('canvas');
    canvas.id = 'mj-fx';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;contain:strict';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    // 接管后移除既有 DOM 粒子层与弹幕带：它们已是空元素，却仍是 position:fixed 全屏图层
    ['fxSakura', 'fxFireflies', 'danmaku-band'].forEach(id => {
      const n = document.getElementById(id);
      if (n) n.remove();
    });

    let W = 0, H = 0, dpr = 1;
    // 装饰性粒子不需要 1:1 像素：按 0.55 倍分辨率渲染再放大，光栅成本降到约 1/3
    const FX_SCALE = 0.38;
    function resize() {
      dpr = Math.min(devicePixelRatio || 1, 2) * FX_SCALE;
      W = innerWidth; H = innerHeight;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }

    const on = { sakura: true, fireflies: true, danmaku: true, ripple: true };
    function syncFromUI() {
      ['sakura', 'fireflies', 'danmaku', 'ripple'].forEach(k => {
        const b = document.querySelector(`#fxSwitch button[data-fx="${k}"]`);
        if (b) on[k] = !b.classList.contains('off');
      });
    }

    /* 涟漪队列：点一下压一个进去，画完自己出队 */
    const ripples = [];
    const spawnRipple = e => {
      if (!on.ripple) return;
      ripples.push({ x: e.clientX, y: e.clientY, age: 0, life: 900 });
      if (ripples.length > 8) ripples.shift();
    };
    addEventListener('pointerdown', spawnRipple, { passive: true });

    let petals = [], flies = [], danmaku = [];
    const DM = ['在干嘛呢？', '今天天气不错', '该喝水了', '刚睡醒', '在做饭', '这本书真好看',
      '今天走了很多路', '在听歌', '周末去哪儿', '记得早点睡', '又到周一了'];

    function build() {
      petals = []; flies = []; danmaku = [];
      const petalN = REDUCED ? 0 : (MOBILE ? 8 : 14);
      for (let i = 0; i < petalN; i++) {
        petals.push({
          x: Math.random() * W, y: Math.random() * H,
          s: 8 + Math.random() * 9, rot: Math.random() * 6.28,
          sp: .25 + Math.random() * .55, sway: .4 + Math.random() * 1.2,
          ph: Math.random() * 6.28, c: Math.random() < .4 ? '#ffb3d0' : (Math.random() < .5 ? '#ff9ec7' : '#e6d6ff')
        });
      }
      const flyN = REDUCED ? 0 : (MOBILE ? 8 : 16);
      for (let i = 0; i < flyN; i++) {
        flies.push({
          x: Math.random() * W, y: Math.random() * H,
          s: 3 + Math.random() * 4, ph: Math.random() * 6.28,
          bs: .35 + Math.random() * .5, a1: Math.random() * 6.28, a2: Math.random() * 6.28,
          sp1: .0004 + Math.random() * .0007, sp2: .0003 + Math.random() * .0006
        });
      }
      const dmN = REDUCED ? 0 : (MOBILE ? 4 : 8);
      for (let i = 0; i < dmN; i++) {
        danmaku.push({
          t: DM[Math.floor(Math.random() * DM.length)],
          x: Math.random() * W * 1.6, y: 120 + Math.random() * H * .26,
          sp: .35 + Math.random() * .5, fs: 13 + Math.random() * 4
        });
      }
    }

    function petalPath(s) {
      ctx.beginPath();
      ctx.moveTo(0, -s * .6);
      ctx.quadraticCurveTo(s * .55, -s * .1, 0, s * .6);
      ctx.quadraticCurveTo(-s * .55, -s * .1, 0, -s * .6);
      ctx.closePath();
    }

    let t = 0;
    function frame(now) {
      /* ★ 环境动效（樱花 / 萤火虫 / 弹幕）降到 ~30fps 绘制。
         它们都是缓慢飘落的东西，30 和 60 肉眼基本分不出来，但全屏 canvas 的
         清屏 + 绘制开销直接减半。这里用**时间门限**而不是"隔帧丢弃"：
         120Hz 屏上也能稳定 30fps，而不是变成 60。
         注意提前 return 时**不更新 _l**，这样下一帧的 dt 会把跳过的时间算进去，
         花瓣的移动速度不会被拖慢。 */
      if (frame._last && now - frame._last < 30) return;
      frame._last = now;
      const dt = Math.min(3, (now - (frame._l || now)) / 16.667); frame._l = now;
      t += dt;
      ctx.clearRect(0, 0, W, H);
      const dark = document.documentElement.classList.contains('dark');

      // 樱花：亮色下是粉色花瓣，暗色下换成偏冷的浅色花瓣（不然深底上几乎看不见）
      if (on.sakura && petals.length) {
        ctx.globalAlpha = dark ? .62 : .78;
        for (const p of petals) {
          p.y += p.sp * dt; p.rot += .012 * dt;
          if (p.y > H + 20) { p.y = -20; p.x = Math.random() * W; }
          const sx = Math.sin(t * .012 + p.ph) * p.sway * 12;
          ctx.save();
          ctx.translate(p.x + sx, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.c;
          petalPath(p.s);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      }

      /* 萤火虫：暗色下是绿色光点；亮色下换成暖橙色的光斑，
         否则浅底上"白点+绿光"跟背景几乎融在一起，点了像没反应。 */
      if (on.fireflies && flies.length) {
        for (const f of flies) {
          f.a1 += f.sp1 * dt * 16; f.a2 += f.sp2 * dt * 44;
          const x = f.x + Math.sin(f.a1) * 60, y = f.y + Math.cos(f.a2) * 44;
          const pulse = .5 + .5 * Math.sin(t * .03 * f.bs + f.ph);
          ctx.globalAlpha = dark ? pulse : pulse * .85;
          const g = ctx.createRadialGradient(x, y, 0, x, y, f.s * 4);
          if (dark) {
            g.addColorStop(0, 'rgba(255,255,255,.95)');
            g.addColorStop(.3, 'rgba(190,255,200,.75)');
            g.addColorStop(1, 'rgba(80,255,140,0)');
          } else {
            g.addColorStop(0, 'rgba(255,214,140,.95)');
            g.addColorStop(.32, 'rgba(255,180,90,.6)');
            g.addColorStop(1, 'rgba(255,150,40,0)');
          }
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(x, y, f.s * 4, 0, 6.284); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      /* 涟漪：点一下就在落点荡开一圈。
         原来这个开关在 UI 上有按钮、在 canvas 里却**完全没实现**
         （syncFromUI 只认 sakura/fireflies/danmaku），点了当然毫无反应。
         现在做成"点哪儿荡哪儿"，反馈直接、一眼能看出开关是开着的。 */
      if (on.ripple && ripples.length) {
        for (let i = ripples.length - 1; i >= 0; i--) {
          const r = ripples[i];
          r.age += dt * 16;
          if (r.age > r.life) { ripples.splice(i, 1); continue; }
          const k = r.age / r.life;
          const rad = 14 + k * 150;
          ctx.globalAlpha = (1 - k) * (dark ? .5 : .42);
          ctx.strokeStyle = dark ? 'rgba(255,255,255,.9)' : 'rgba(70,64,58,.85)';
          ctx.lineWidth = 2.4 * (1 - k) + .5;
          ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, 6.284); ctx.stroke();
          // 内圈再补一道，看起来更像水面
          if (k < .6) {
            ctx.globalAlpha = (1 - k) * (dark ? .3 : .24);
            ctx.beginPath(); ctx.arc(r.x, r.y, rad * .6, 0, 6.284); ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      // 背景弹幕只在首页出现：内页面对内容是阅读任务，再叠一层飘字就是纯噪声
      const onHome = document.body.dataset.view === 'home';
      if (on.danmaku && onHome && danmaku.length) {
        ctx.font = '700 14px "Noto Sans SC",sans-serif';
        ctx.globalAlpha = dark ? .12 : .2;
        ctx.fillStyle = dark ? '#ffffff' : '#3a3833';
        for (const d of danmaku) {
          d.x -= d.sp * dt;
          if (d.x < -ctx.measureText(d.t).width - 40) { d.x = W + Math.random() * 200; d.y = 120 + Math.random() * H * .26; }
          ctx.font = `700 ${d.fs}px "Noto Sans SC",sans-serif`;
          ctx.fillText(d.t, d.x, d.y);
        }
        ctx.globalAlpha = 1;
      }
    }

    resize();
    addEventListener('resize', resize);
    const unsub = REDUCED ? null : Raf.add(frame);
    const switchHost = document.getElementById('fxSwitch');
    if (switchHost) switchHost.addEventListener('click', () => setTimeout(syncFromUI, 0));
    syncFromUI();

    const destroy = () => { if (unsub) unsub(); removeEventListener('resize', resize); removeEventListener('pointerdown', spawnRipple); canvas.remove(); };
    onPageGone(destroy);
    return { canvas, syncFromUI, rebuild: build, setDensity(n) { petals = petals.slice(0, n); flies = flies.slice(0, n); }, destroy };
  })();

  /* ============================================================
     10.5 性能：帧率探针 + 自适应降级
     输入：采样窗口   输出：fps 统计 / 必要时自动降级   清理：无全局监听
     ============================================================ */
  const Perf = (() => {
    let hud = null, rafId = 0, last = 0, acc = 0, frames = 0, cur = 0;
    const history = [];
    let degraded = 0;

    function sample(ms = 1500) {
      return new Promise(res => {
        const s = []; let l = performance.now(); const t0 = l;
        (function f(now) {
          s.push(now - l); l = now;
          if (now - t0 < ms) requestAnimationFrame(f);
          else {
            s.shift();
            const sorted = [...s].sort((a, b) => a - b);
            const avg = s.reduce((a, b) => a + b, 0) / s.length;
            res({
              fps: +(1000 / avg).toFixed(1),
              frameMs: +avg.toFixed(2),
              p95: +sorted[Math.floor(sorted.length * .95)].toFixed(2),
              worst: +sorted[sorted.length - 1].toFixed(2),
              jank: s.filter(x => x > 20).length,
              frames: s.length
            });
          }
        })(l);
      });
    }

    /* 降级阶梯：先降粒子密度，再关颗粒纸纹，最后停呼吸渐变 */
    function degrade() {
      degraded++;
      if (degraded === 1) {
        Particles.setDensity(10);
        console.info('[perf] 降级 1：粒子密度降到 10');
      } else if (degraded === 2) {
        const g = document.querySelector('.mj-grain'); if (g) g.style.display = 'none';
        console.info('[perf] 降级 2：关闭颗粒纸纹');
      } else if (degraded === 3) {
        const b = document.querySelector('.gradient-breathe');
        if (b) b.style.animation = 'none';
        console.info('[perf] 降级 3：停止呼吸渐变');
      } else if (degraded === 4) {
        Particles.setDensity(0);
        console.info('[perf] 降级 4：停止粒子层');
      }
    }

    function show(on = true) {
      if (on && !hud) {
        hud = el('div');
        hud.style.cssText = 'position:fixed;left:.6rem;top:4.9rem;z-index:99999;font-family:var(--font-mono);font-size:11px;padding:.25rem .5rem;border-radius:.4rem;background:rgba(11,14,19,.85);color:#7ee787;pointer-events:none';
        document.body.appendChild(hud);
        last = 0; acc = 0; frames = 0;
        (function tick(now) {
          if (!last) last = now;
          acc += now - last; frames++; last = now;
          if (acc >= 500) { cur = +(1000 / (acc / frames)).toFixed(1); acc = 0; frames = 0; history.push(cur); if (history.length > 24) history.shift(); }
          const mn = history.length ? Math.min(...history) : cur;
          hud.textContent = `${cur.toFixed(1)} fps · min ${mn.toFixed(1)} · raf ${Raf.size}`;
          rafId = requestAnimationFrame(tick);
        })(performance.now());
      } else if (!on && hud) {
        cancelAnimationFrame(rafId); hud.remove(); hud = null;
      }
    }

    /* 载入后短采样：阈值按"环境天花板"折算，避免在无 GPU / 被限频的环境里误判降级。
       ★ 这里有个坑：桌面版的窗口是 show:false + ready-to-show 才显示的，
       如果采样发生在"窗口还没真正上屏"或"窗口被别的窗口遮住"的时候，
       Chromium 会把 rAF 限流到很低（实测能到 20fps 甚至 13fps）。
       拿这种读数当天花板，结论就是"这台机器很慢"，然后**永久**把特效降级掉
       —— 明明机器很快，用户看到的却是被削过的画面。
       所以：一，页面不可见就不采；二，采到的帧数少得离谱就判定为"被限流"，
       不降级，等页面真正可见了再重试。 */
    let ceiling = 60;
    let throttled = false;
    /* ★ 阈值：700ms 的样本里至少要有这么多帧，才认为"环境已经热起来了"。
       ≈43fps。定这么高是有原因的：桌面版启动后头几秒 GPU 进程还没回报，
       Chromium 是**软件光栅化**（app.getGPUFeatureStatus() 实测：
       刚就绪时 gpu_compositing=disabled_software，约 6 秒后才变成 enabled），
       那几秒里帧率会低到 20–46fps。如果拿这个读数当基准，
       结论就是"这机器很慢"，然后永久把特效降级掉。
       所以：样本帧数不够 → 判为"还没热"，**不降级**，过几秒重试。 */
    const MIN_FRAMES = 30;
    /* 天花板地板：低于这个值一律当作"环境还没就绪"。
       桌面版启动后约 6 秒内 GPU 进程还没回报，Chromium 走软件光栅化，
       实测那几秒只有 20–53fps；6 秒之后同一台机器同一页面是 80–200fps。
       所以地板放到 50，让软件渲染窗口里的读数一律被拒、过几秒重试。
       副作用：如果某台机器**真的**只能跑 40fps，标定会一直不成立，
       于是永远不降级 —— 这是有意的取舍：宁可保留完整特效，
       也不要凭一个可能是"启动期假象"的读数把画面永久削掉。 */
    const MIN_CEILING = 50;
    async function calibrate() {
      if (document.hidden) { throttled = true; return null; }
      const c = await sample(700);
      if (c.frames < MIN_FRAMES) {
        throttled = true;
        console.info('[perf] 采样帧数偏少（' + c.frames + '），判为窗口不可见或 GPU 未就绪，本次不做基准');
        return null;
      }
      if (c.fps < MIN_CEILING) {
        throttled = true;
        console.info('[perf] 环境帧率偏低（' + c.fps + 'fps），可能在软件渲染阶段，本次不做基准');
        return null;
      }
      throttled = false;
      ceiling = c.fps;
      console.info('[perf] 环境 rAF 天花板 ≈', ceiling.toFixed(1), 'fps');
      return ceiling;
    }
    async function auto() {
      const waitVisible = () => new Promise(r => {
        if (!document.hidden) return r();
        const h = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', h); r(); } };
        document.addEventListener('visibilitychange', h);
      });
      // 4.5 秒起测：桌面版的 GPU 进程大约 6 秒才就绪，早测只会测到软件渲染
      await new Promise(r => setTimeout(r, 4500));
      await waitVisible();
      /* 标定最多试 4 次（每次隔 3 秒），只要有一次拿到可信基准就继续；
         一次都没拿到就**什么都不降级** —— 宁可保留全部特效，
         也不要因为"启动那几秒恰好是软件渲染"把画面永久削掉。 */
      let c = null;
      for (let i = 0; i < 4 && c === null; i++) {
        if (i) await new Promise(r => setTimeout(r, 3000));
        if (document.hidden) { await waitVisible(); }
        c = await calibrate();
      }
      if (c === null) {
        console.info('[perf] 始终没拿到可信基准，跳过自动降级（特效保持全开）');
        window.__perf = { ceiling: null, threshold: null, result: null, degraded: 0, throttled: true };
        return null;
      }
      return autoMeasure();
    }
    /* 真正的测量+降级循环，和标定分开，便于不可见时跳过标定直接复测 */
    async function autoMeasure() {
      const threshold = Math.min(52, ceiling * .68);
      let r1 = await sample(1200);
      console.info('[perf] 采样', r1, '阈值', threshold.toFixed(1));
      let guard = 0;
      while (r1.fps < threshold && r1.frames >= MIN_FRAMES && guard++ < 3) {
        degrade();
        await new Promise(r => setTimeout(r, 400));
        r1 = await sample(1000);
        console.info('[perf] 降级后', r1);
      }
      window.__perf = { ceiling, threshold: +threshold.toFixed(1), result: r1, degraded, throttled };
      return r1;
    }

    return { sample, degrade, show, toggle: () => show(!hud), auto, calibrate, get degraded() { return degraded; }, get fps() { return cur; }, get ceiling() { return ceiling; }, get throttled() { return throttled; } };
  })();

  /* ============================================================
     11. 启动
     ============================================================ */
  function boot() {
    mountChrome();
    setElement(currentEl);
    Router.start();
    if (!REDUCED) Perf.auto();

    /* ★ 入场动画放完就把 .enter-rise 摘掉。
       这个类把元素的不透明度交给 CSS 动画去实现（keyframes 里 0% 是 opacity:0）。
       而 home 视图是靠 hidden 属性隐藏/显示的 —— 切走再切回来时，Chrome 会把
       这些动画重新起跑，并且可能卡在 currentTime 0（playState 却报 running），
       动画永远停在 0%，元素就被永久按在 opacity: 0：**从别的页面切回首页，
       大标题整段消失**。动画本来就只是入场效果，放完就该功成身退；
       摘掉类之后，之后再怎么切页面都不会重新起跑，元素靠自身样式恒为可见。 */
    setTimeout(() => {
      document.querySelectorAll('.enter-rise').forEach(n => n.classList.remove('enter-rise'));
    }, 1200);

    // 头像连点彩蛋 → 线索 D
    let clicks = 0, timer = 0;
    document.addEventListener('click', e => {
      if (!e.target.closest('#mjOpenCore')) return;
      clicks++; clearTimeout(timer); timer = setTimeout(() => { clicks = 0; }, 1800);
      if (clicks >= 5) { clicks = 0; Achievements.findClue('D', '开场彩蛋'); }
    });

    // 帧率表：Ctrl+Shift+F 切换
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); Perf.toggle(); }
    });
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
  else boot();

  window.MJX = { Achievements, Memory, setElement, ELEMENTS, POSTS, Router, Perf, Raf, ARTICLE_BODIES, deriveCat, readPostsFromDOM, MangaFX };
})();
