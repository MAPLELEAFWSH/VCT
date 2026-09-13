/* ============================================================
   modules.js · 第二轮新增模块
   ③ 日历日期差  ④ 天气（Open-Meteo，无需 API key）
   ⑤ 课表（增删查改 + ICS 导入）  ⑦ 头像/ID 自助修改  ⑧ 音乐导入 + ID3 封面
   约定：全部数据仅存本地（localStorage / IndexedDB），无任何外发
   ============================================================ */
(() => {
  'use strict';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const pad = n => String(n).padStart(2, '0');
  const DAY_MS = 86400000;

  const Store = {
    key: k => 'mj2_' + k,
    get(k, d) { try { const v = localStorage.getItem(this.key(k)); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(this.key(k), JSON.stringify(v)); return true; } catch (e) { return false; } }
  };

  /* ============================================================
     ⑧ 桌面版桥接（由 electron/preload.js 注入 window.mjDesktop）
     有桌面壳时：先把磁盘数据灌回 localStorage 再继续；之后每次写入镜像到磁盘
     ============================================================ */
  const Desktop = (() => {
    const D = window.mjDesktop;
    if (!D) return { isDesktop: false, destroy() {} };
    let info = null;
    let timer = 0;

    const dumpLocal = () => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('mj2_')) { try { out[k.slice(4)] = JSON.parse(localStorage.getItem(k)); } catch (e) {} }
      }
      return out;
    };
    const applyLocal = snap => {
      Object.keys(snap || {}).forEach(k => {
        if (snap[k] === undefined || snap[k] === null) return;
        try { localStorage.setItem('mj2_' + k, JSON.stringify(snap[k])); } catch (e) {}
      });
    };

    // 写入镜像到磁盘（合并去抖，避免频繁 IO）
    const origSet = Store.set.bind(Store);
    Store.set = function (k, v) {
      const ok = origSet(k, v);
      clearTimeout(timer);
      timer = setTimeout(() => { D.setData('store', dumpLocal()).catch(() => {}); }, 400);
      return ok;
    };

    (async () => {
      try {
        info = await D.info();
        const snap = await D.getData('store');
        const hydrated = sessionStorage.getItem('mj_hydrated') === '1';
        if (snap && !hydrated && Object.keys(dumpLocal()).length === 0) {
          // 首次带壳启动：磁盘优先，灌回后重载一次让各模块读到
          applyLocal(snap);
          sessionStorage.setItem('mj_hydrated', '1');
          location.reload();
          return;
        }
        sessionStorage.setItem('mj_hydrated', '1');
        if (!snap) await D.setData('store', dumpLocal());
        addChrome();
      } catch (e) { console.warn('[desktop]', e); }
    })();

    function addChrome() {
      const right = document.querySelector('#navbar .nav-right');
      if (right) {
        const b = el('span', 'mj2-desktop-badge', '桌面版');
        b.title = `Electron ${info.electron} · 数据目录 ${info.userData}`;
        right.appendChild(b);
      }
      const panel = document.getElementById('settingPanel');
      if (panel) {
        const row = el('div', 'fp-row');
        row.innerHTML = `<span>桌面数据</span>
          <span style="display:flex;gap:.3rem">
            <button class="mj2-btn" type="button" id="mj2Export">导出</button>
            <button class="mj2-btn" type="button" id="mj2Import">导入</button>
          </span>`;
        panel.appendChild(row);
        row.querySelector('#mj2Export').addEventListener('click', async () => {
          const r = await D.exportData({ exportedAt: new Date().toISOString(), store: dumpLocal() });
          if (r && r.ok) alert('已导出到：\n' + r.path);
        });
        row.querySelector('#mj2Import').addEventListener('click', async () => {
          const r = await D.importData();
          if (!r || !r.ok) return;
          applyLocal((r.data && r.data.store) || r.data || {});
          await D.setData('store', dumpLocal());
          alert('导入完成，即将重新载入。');
          location.reload();
        });
      }
      const stopE = D.onMenu('export', async () => {
        const r = await D.exportData({ exportedAt: new Date().toISOString(), store: dumpLocal() });
        if (r && r.ok) alert('已导出到：\n' + r.path);
      });
      const stopI = D.onMenu('import', async () => {
        const r = await D.importData();
        if (!r || !r.ok) return;
        applyLocal((r.data && r.data.store) || r.data || {});
        await D.setData('store', dumpLocal());
        location.reload();
      });
      return () => { stopE(); stopI(); };
    }

    return { isDesktop: true, info: () => info, destroy() { clearTimeout(timer); } };
  })();

  /* ============================================================
     ③ 日历：选中日期与今日相差天数
     接管既有日历渲染（既有实现只画格子不可选）
     ============================================================ */
  const Calendar = (() => {
    const grid = document.getElementById('calGrid');
    const label = document.getElementById('calLabel');
    if (!grid || !label) return { destroy() {} };

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let viewY = today.getFullYear(), viewM = today.getMonth();
    let selected = Store.get('calSel', null); // 'YYYY-MM-DD'

    // 加一个日期差读数区
    const diffBox = el('div', 'mj2-diff');
    diffBox.id = 'mj2Diff';
    grid.parentNode.insertBefore(diffBox, grid.nextSibling);

    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;

    function renderDiff() {
      const y = viewY, m = viewM;
      const sel = selected ? new Date(selected + 'T00:00:00') : new Date(today);
      const base = new Date(y, m, sel.getMonth() === m && sel.getFullYear() === y ? sel.getDate() : 1);
      void base;
      const diff = Math.round((sel - today) / DAY_MS);
      const dstr = `${sel.getMonth() + 1} 月 ${sel.getDate()} 日`;
      let txt;
      if (diff === 0) txt = `选中 <b>${dstr}</b> · 就是今天`;
      else if (diff > 0) txt = `选中 <b>${dstr}</b> · 距今天还有 <b>${diff}</b> 天`;
      else txt = `选中 <b>${dstr}</b> · <span class="past">已过去 ${-diff} 天</span>`;
      diffBox.innerHTML = txt + (selected ? `　<span class="mj2-sub">点日期可切换</span>` : '');
    }

    function render() {
      label.textContent = viewY + ' / ' + pad(viewM + 1);
      const first = new Date(viewY, viewM, 1).getDay();
      const days = new Date(viewY, viewM + 1, 0).getDate();
      const frag = document.createDocumentFragment();
      WD.forEach(w => frag.appendChild(el('span', 'wd', w)));
      for (let i = 0; i < first; i++) { const s = el('span', 'd blank', '·'); frag.appendChild(s); }
      for (let d = 1; d <= days; d++) {
        const key = iso(viewY, viewM, d);
        const isToday = viewY === today.getFullYear() && viewM === today.getMonth() && d === today.getDate();
        const b = el('button', 'd' + (isToday ? ' today' : '') + (selected === key ? ' sel' : ''), String(d));
        b.type = 'button';
        b.dataset.iso = key;
        b.setAttribute('aria-label', `${viewY}年${viewM + 1}月${d}日`);
        frag.appendChild(b);
      }
      grid.innerHTML = '';
      grid.appendChild(frag);
      renderDiff();
    }

    const onClick = e => {
      const b = e.target.closest('[data-iso]');
      if (!b) return;
      selected = b.dataset.iso;
      Store.set('calSel', selected);
      $$('.d.sel', grid).forEach(x => x.classList.remove('sel'));
      b.classList.add('sel');
      renderDiff();
    };
    grid.addEventListener('click', onClick);

    // 换成克隆节点以移除既有内联监听，避免两套渲染同时写
    ['calPrev', 'calNext'].forEach(id => {
      const old = document.getElementById(id);
      if (!old) return;
      const clone = old.cloneNode(true);
      old.parentNode.replaceChild(clone, old);
    });
    const onPrev = () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } render(); };
    const onNext = () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } render(); };
    document.getElementById('calPrev').addEventListener('click', onPrev);
    document.getElementById('calNext').addEventListener('click', onNext);

    render();
    return {
      destroy() {
        grid.removeEventListener('click', onClick);
        document.getElementById('calPrev').removeEventListener('click', onPrev);
        document.getElementById('calNext').removeEventListener('click', onNext);
        diffBox.remove();
      }
    };
  })();

  /* ============================================================
     ⑦ 头像 / ID 自助修改
     输入：文件选择 / 输入框   输出：DOM + localStorage
     ============================================================ */
  const Profile = (() => {
    const img = document.getElementById('mjAvatarImg');
    const nameEl = document.querySelector('.profile-name');
    if (!img || !nameEl) return { destroy() {} };

    const saved = Store.get('profile', {});
    if (saved.avatar) img.src = saved.avatar;
    if (saved.name) nameEl.textContent = saved.name;

    const file = el('input', 'mj2-hidden-input');
    file.type = 'file'; file.accept = 'image/*';
    file.setAttribute('aria-label', '选择头像图片');
    document.body.appendChild(file);

    const badge = el('span', 'mj2-edit-badge', '✎');
    badge.setAttribute('aria-hidden', 'true');
    const avatarLink = img.closest('.profile-avatar') || img.parentNode;
    avatarLink.appendChild(badge);

    const onPick = () => file.click();
    const onChange = () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > 3 * 1024 * 1024) { alert('图片请小于 3MB（当前 ' + (f.size / 1048576).toFixed(1) + 'MB）'); return; }
      const fr = new FileReader();
      fr.onload = () => {
        img.src = fr.result;
        const cur = Store.get('profile', {});
        cur.avatar = fr.result;
        Store.set('profile', cur);
      };
      fr.readAsDataURL(f);
      file.value = '';
    };
    avatarLink.addEventListener('click', onPick);
    file.addEventListener('change', onChange);

    // 名称就地编辑：交互状态全部走 class，交给 CSS 做过渡/动画（内联 outline 无法过渡）
    const pen = () => { const s = el('span', 'pen', '✎'); s.setAttribute('aria-hidden', 'true'); return s; };
    const wrap = el('span', 'mj2-name-edit');
    while (nameEl.firstChild) wrap.appendChild(nameEl.firstChild);
    wrap.appendChild(pen());
    nameEl.appendChild(wrap);
    nameEl.title = '点击修改显示名称';
    // 保存成功时闪一下，给"改动已生效"的反馈
    const flash = () => {
      wrap.classList.remove('just-saved');
      void wrap.offsetWidth;              // 重排一次，让动画能重播
      wrap.classList.add('just-saved');
      setTimeout(() => wrap.classList.remove('just-saved'), 700);
    };

    const commit = () => {
      const v = wrap.textContent.replace('✎', '').trim().slice(0, 24) || '未命名';
      const cur = Store.get('profile', {});
      const changed = cur.name !== v;
      cur.name = v; Store.set('profile', cur);
      wrap.textContent = v;
      wrap.appendChild(pen());
      if (changed) flash();
    };
    const onEdit = () => {
      if (wrap.isContentEditable) return;
      wrap.contentEditable = 'true';
      wrap.classList.add('editing');
      wrap.focus();
      const r = document.createRange(); r.selectNodeContents(wrap); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    };
    const onKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); wrap.blur(); }
      if (e.key === 'Escape') { wrap.textContent = (Store.get('profile', {}).name || 'まつざか ゆき'); wrap.appendChild(pen()); wrap.blur(); }
    };
    const onBlur = () => {
      if (!wrap.isContentEditable) return;
      wrap.contentEditable = 'false';
      wrap.classList.remove('editing');
      commit();
    };
    wrap.addEventListener('click', onEdit);
    wrap.addEventListener('keydown', onKey);
    wrap.addEventListener('blur', onBlur);

    /* ⑤ 签名（bio）同样可编辑。打字机写的是 #typed，这里整体替换掉该容器，
       旧节点被摘除后打字机继续写它也看不见，不会与新内容打架。 */
    const bioHost = document.querySelector('.profile-bio');
    let bioWrap = null, bioPen = null;
    const DEFAULT_BIO = '把日常、心情和随手记下的小事留在这里。写字、拍照、做饭、散步，都算。';
    if (bioHost) {
      const savedBio = (saved.bio || DEFAULT_BIO);
      bioHost.innerHTML = '';
      bioWrap = el('span', 'mj2-name-edit');
      bioWrap.textContent = savedBio;
      bioWrap.title = '点击修改签名';
      bioPen = pen();
      bioWrap.appendChild(bioPen);
      bioHost.appendChild(bioWrap);
    }
    const flashBio = () => {
      if (!bioWrap) return;
      bioWrap.classList.remove('just-saved');
      void bioWrap.offsetWidth;
      bioWrap.classList.add('just-saved');
      setTimeout(() => bioWrap.classList.remove('just-saved'), 700);
    };
    const commitBio = () => {
      if (!bioWrap) return;
      const v = bioWrap.textContent.replace('✎', '').trim().slice(0, 48) || DEFAULT_BIO;
      const cur = Store.get('profile', {});
      const changed = cur.bio !== v;
      cur.bio = v; Store.set('profile', cur);
      bioWrap.textContent = v;
      bioWrap.appendChild(pen());
      if (changed) flashBio();
    };
    const onBioEdit = () => {
      if (!bioWrap || bioWrap.isContentEditable) return;
      bioWrap.contentEditable = 'true';
      bioWrap.classList.add('editing');
      bioWrap.focus();
      const r = document.createRange(); r.selectNodeContents(bioWrap); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    };
    const onBioKey = e => {
      if (e.key === 'Enter') { e.preventDefault(); bioWrap.blur(); }
      if (e.key === 'Escape') { bioWrap.textContent = (Store.get('profile', {}).bio || DEFAULT_BIO); bioWrap.appendChild(pen()); bioWrap.blur(); }
    };
    const onBioBlur = () => {
      if (!bioWrap || !bioWrap.isContentEditable) return;
      bioWrap.contentEditable = 'false';
      bioWrap.classList.remove('editing');
      commitBio();
    };
    if (bioWrap) {
      bioWrap.addEventListener('click', onBioEdit);
      bioWrap.addEventListener('keydown', onBioKey);
      bioWrap.addEventListener('blur', onBioBlur);
    }

    return {
      destroy() {
        avatarLink.removeEventListener('click', onPick);
        file.removeEventListener('change', onChange);
        wrap.removeEventListener('click', onEdit);
        wrap.removeEventListener('keydown', onKey);
        wrap.removeEventListener('blur', onBlur);
        if (bioWrap) {
          bioWrap.removeEventListener('click', onBioEdit);
          bioWrap.removeEventListener('keydown', onBioKey);
          bioWrap.removeEventListener('blur', onBioBlur);
        }
        badge.remove(); file.remove();
      }
    };
  })();

  /* ============================================================
     ④ 天气：Open-Meteo（免费、无需 API key）
     输入：定位或默认城市   输出：实时 + 3 天预报   缓存 30 分钟
     ============================================================ */
  const WMO = {
    0: ['晴', '☀'], 1: ['少云', '🌤'], 2: ['多云', '⛅'], 3: ['阴', '☁'],
    45: ['雾', '🌫'], 48: ['雾凇', '🌫'],
    51: ['毛毛雨', '🌦'], 53: ['小雨', '🌦'], 55: ['中雨', '🌦'],
    61: ['小雨', '🌧'], 63: ['中雨', '🌧'], 65: ['大雨', '🌧'],
    66: ['冻雨', '🌧'], 67: ['强冻雨', '🌧'],
    71: ['小雪', '🌨'], 73: ['中雪', '🌨'], 75: ['大雪', '❄'], 77: ['霰', '🌨'],
    80: ['阵雨', '🌦'], 81: ['强阵雨', '🌧'], 82: ['暴雨', '⛈'],
    85: ['阵雪', '🌨'], 86: ['强阵雪', '❄'],
    95: ['雷暴', '⛈'], 96: ['雷暴伴冰雹', '⛈'], 99: ['强雷暴冰雹', '⛈']
  };
  const Weather = (() => {
    const host = document.getElementById('mj2WeatherBody');
    if (!host) return { destroy() {} };
    let dead = false, ctl = null;

    const CACHE_MS = 30 * 60 * 1000;
    const DEFAULT = { name: '厦门市', lat: 24.47979, lon: 118.08187 };

    function paint(state) {
      if (dead) return;
      if (state.loading) { host.innerHTML = `<div class="mj2-loading">正在获取天气…</div>`; return; }
      if (state.error) {
        host.innerHTML = `<div class="mj2-loading">天气暂不可用（${state.error}）<br><button class="mj2-btn" id="mj2WRetry" type="button">重试</button></div>`;
        const b = document.getElementById('mj2WRetry');
        if (b) b.addEventListener('click', () => load(true));
        return;
      }
      const c = state.current, d = state.daily, place = state.place;
      const w = WMO[c.weather_code] || ['—', '❓'];
      const days = d.time.slice(0, 3).map((t, i) => {
        const wd = ['日', '一', '二', '三', '四', '五', '六'][new Date(t + 'T00:00:00').getDay()];
        const ww = WMO[d.weather_code[i]] || ['—', '❓'];
        return `<div class="mj2-fday"><div class="d">${i === 0 ? '今天' : '周' + wd}</div><div class="i">${ww[1]}</div>
          <div class="t">${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°</div></div>`;
      }).join('');
      host.innerHTML = `
        <div class="mj2-weather-now">
          <div class="mj2-wicon" aria-hidden="true">${w[1]}</div>
          <div>
            <div class="mj2-wtemp">${Math.round(c.temperature_2m)}<sup>°C</sup></div>
            <div class="mj2-wdesc">${place} · ${w[0]}</div>
          </div>
        </div>
        <div class="mj2-wmeta">
          <span>湿度 ${c.relative_humidity_2m}%</span>
          <span>风速 ${c.wind_speed_10m} km/h</span>
        </div>
        <div class="mj2-forecast">${days}</div>
        <div class="mj2-sub" style="margin-top:.4rem;text-align:right">数据 Open-Meteo · ${state.at}</div>`;
    }

    async function load(force) {
      if (dead) return;
      const cached = Store.get('weather', null);
      if (!force && cached && Date.now() - cached.ts < CACHE_MS) { paint(cached.state); return; }
      paint({ loading: true });
      ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        // 定位最长等 2.5s：权限提示未响应时 getCurrentPosition 既不成功也不失败，必须竞速兜底
        const pos = await Promise.race([
          new Promise(res => {
            if (!navigator.geolocation) return res(null);
            navigator.geolocation.getCurrentPosition(
              p => res({ lat: p.coords.latitude, lon: p.coords.longitude, name: '当前位置' }),
              () => res(null), { timeout: 2000, maximumAge: 600000 });
          }),
          new Promise(res => setTimeout(() => res(null), 2500))
        ]);
        const loc = pos || DEFAULT;
        const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
          + `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`
          + `&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=3`;
        const r = await fetch(u, { signal: ctl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        clearTimeout(timer);
        if (dead) return;
        const state = {
          current: j.current, daily: j.daily, place: loc.name,
          at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        };
        paint(state);
        Store.set('weather', { ts: Date.now(), state });
      } catch (e) {
        clearTimeout(timer);
        paint({ error: e.name === 'AbortError' ? '超时' : '网络不可达' });
      }
    }
    load(false);
    // 每 30 分钟自动刷新（页面隐藏时不跑）
    const tick = setInterval(() => { if (!document.hidden) load(false); }, CACHE_MS);
    return { destroy() { dead = true; clearInterval(tick); if (ctl) ctl.abort(); } };
  })();

  /* ============================================================
     ⑤ 课表：增删查改 + ICS 导入
     ============================================================ */
  const Sched = (() => {
    let host = null, bound = false;
    const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const COLORS = ['#4cc2f1', '#74c2a8', '#fab72e', '#af8ec1', '#a5c83b', '#ef7938', '#9fd6e3'];

    /* —— 固定节次表 ——
       每天 11 节，两节为一个"大节"（最后一节单独）。课程不再手填分钟数，
       而是选"第几节 + 连堂几节"，起止时间由这张表推导，避免同一天的课
       时间对不齐。ICS 导入也会吸附到最接近的节次。 */
    const P = (h, m) => h * 60 + m;
    const PERIODS = [
      { p: 1,  s: P(8, 0),   e: P(8, 45),  block: '一二节',   part: '上午' },
      { p: 2,  s: P(8, 50),  e: P(9, 35),  block: '一二节',   part: '上午' },
      { p: 3,  s: P(10, 5),  e: P(10, 50), block: '三四节',   part: '上午' },
      { p: 4,  s: P(10, 55), e: P(11, 40), block: '三四节',   part: '上午' },
      { p: 5,  s: P(14, 0),  e: P(14, 45), block: '五六节',   part: '下午' },
      { p: 6,  s: P(14, 50), e: P(15, 35), block: '五六节',   part: '下午' },
      { p: 7,  s: P(15, 55), e: P(16, 40), block: '七八节',   part: '下午' },
      { p: 8,  s: P(16, 45), e: P(17, 30), block: '七八节',   part: '下午' },
      { p: 9,  s: P(19, 0),  e: P(19, 45), block: '九十节',   part: '晚上' },
      { p: 10, s: P(19, 50), e: P(20, 35), block: '九十节',   part: '晚上' },
      { p: 11, s: P(20, 40), e: P(21, 25), block: '第十一节', part: '晚上' }
    ];
    const periodOf = n => PERIODS[Math.max(0, Math.min(PERIODS.length - 1, (n | 0) - 1))];
    const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一'];

    let courses = Store.get('courses', []);
    let editingId = null;

    const save = () => Store.set('courses', courses);
    const uid = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    /* 把课程规整成 {p, n}：
       - 新记录直接用 p / n；
       - ICS 导入的记录只有 start/end 分钟，按"与哪些节次的时间区间相交"来吸附，
         而不是简单除以 45 分钟（除以 45 会把 10:10–12:00 这种算歪）。 */
    function span(c) {
      if (c.p) return { p: Math.max(1, Math.min(11, c.p | 0)), n: Math.max(1, Math.min(12 - (c.p | 0), c.n | 0 || 1)) };
      const s0 = c.start | 0, e0 = (c.end || s0 + 45) | 0;
      let p = (PERIODS.find(x => s0 >= x.s && s0 < x.e) || null);
      if (!p) p = PERIODS.reduce((a, b) => Math.abs(b.s - s0) < Math.abs(a.s - s0) ? b : a, PERIODS[0]);
      let n = 0;
      for (let k = p.p; k <= 11; k++) {
        const x = periodOf(k);
        if (x.e <= s0 || x.s >= e0) break;   // 与本节无交集就到此为止
        n++;
      }
      return { p: p.p, n: Math.max(1, n) };
    }
    const startOf = c => periodOf(span(c).p).s;
    const endOf = c => periodOf(span(c).p + span(c).n - 1).e;
    const sig = c => { const s = span(c); return [c.day, c.name, s.p, s.n, c.location || ''].join('|'); };

    /* 导入的 ICS 常把同一门课按周次展开成多条，内容完全相同的会叠在同一格。
       精确同签名只保留一条，并把缺 p/n 的旧记录补齐。 */
    function normalize(list) {
      const seen = new Set(), out = [];
      let dropped = 0;
      list.forEach(c => {
        if (!c || !c.name) return;
        const s = span(c), k = sig(c);
        if (seen.has(k)) { dropped++; return; }
        seen.add(k);
        out.push(Object.assign({}, c, {
          p: s.p, n: s.n,
          start: periodOf(s.p).s, end: periodOf(s.p + s.n - 1).e
        }));
      });
      return { list: out, dropped };
    }

    /* —— ICS 解析：支持 VEVENT + DTSTART/DTEND/SUMMARY/LOCATION + WEEKLY RRULE —— */
    function parseICS(text) {
      const out = [];
      // 先展开折行（RFC5545：续行以空格或 tab 开头）
      const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
      let cur = null, inEvent = false;
      const unescape = s => String(s || '').replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
      const parseDT = v => {
        const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/.exec(v || '');
        if (!m) return null;
        return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0 };
      };
      for (const raw of lines) {
        const line = raw.trim();
        if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
        if (line === 'END:VEVENT') {
          inEvent = false;
          if (cur && cur.summary) {
            const st = parseDT(cur.dtstart), en = parseDT(cur.dtend) || st;
            if (st) {
              const jsDay = new Date(st.y, st.mo - 1, st.d).getDay(); // 0=周日
              const wd = (jsDay + 6) % 7; // 转成 0=周一
              const startMin = st.h * 60 + st.mi;
              const endMin = en && (en.h || en.mi) ? en.h * 60 + en.mi : startMin + 90;
              out.push({
                id: uid(), name: unescape(cur.summary).slice(0, 40),
                location: unescape(cur.location).slice(0, 30), teacher: '',
                day: wd, start: startMin, end: endMin,
                weeks: cur.rrule ? '每周' : '单次',
                uidRaw: cur.uid || ''
              });
            }
          }
          cur = null; continue;
        }
        if (!inEvent || !cur) continue;
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const key = line.slice(0, idx).split(';')[0].toUpperCase();
        const val = line.slice(idx + 1);
        if (key === 'SUMMARY') cur.summary = val;
        else if (key === 'LOCATION') cur.location = val;
        else if (key === 'DTSTART') cur.dtstart = val;
        else if (key === 'DTEND') cur.dtend = val;
        else if (key === 'RRULE') cur.rrule = val;
        else if (key === 'UID') cur.uid = val;
      }
      return out;
    }

    const fmt = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
    const dayName = d => WD[d] || '—';
    const todayWd = () => (new Date().getDay() + 6) % 7;
    const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
    /* 正在上的那一节：今天且当前时间落在某节区间内（含课间 5 分钟余量） */
    const liveP = () => {
      const n = nowMin();
      const x = PERIODS.find(y => n >= y.s && n <= y.e);
      return x ? x.p : 0;
    };

    /* 每天的排布：把课程放到 1..11 的节次轨道上。
       同一格出现多门课时并排展示而不是互相覆盖（ICS 里同一时段多门课是常事），
       实在排不下的进 overflow，在表下单独列出 —— 任何一条数据都不会被静默丢掉。 */
    function layout() {
      const days = [], overflow = [];
      for (let d = 0; d < 7; d++) {
        const list = courses.filter(c => c.day === d).map(c => ({ c, s: span(c) }))
          .sort((a, b) => a.s.p - b.s.p || a.c.name.localeCompare(b.c.name, 'zh'));
        const occ = new Set(), groups = new Map();
        list.forEach(it => {
          let p0 = it.s.p;
          while (p0 <= 11 && occ.has(p0)) p0++;
          if (p0 > 11) { overflow.push(it.c); return; }
          let n = Math.min(it.s.n, 12 - p0);
          while (n > 1 && Array.from({ length: n }, (_, i) => p0 + i).some(k => occ.has(k))) n--;
          for (let k = 0; k < n; k++) occ.add(p0 + k);
          const g = groups.get(p0) || { span: 1, items: [] };
          g.items.push({ c: it.c, p: p0, n });
          g.span = Math.max(g.span, n);
          groups.set(p0, g);
        });
        days.push(groups);
      }
      return { days, overflow };
    }

    function render() {
      if (!host) return;
      const t = todayWd(), live = liveP();
      const { days, overflow } = layout();

      host.innerHTML = `
        <div class="mj2-sched-tools">
          <button class="mj2-btn" id="mj2cAdd" type="button">＋ 添加课程</button>
          <button class="mj2-btn" id="mj2cImport" type="button">导入 ICS</button>
          <button class="mj2-btn" id="mj2cClear" type="button">清空</button>
          <span class="mj2-sub">共 ${courses.length} 门 · 每天 11 节</span>
        </div>
        <div id="mj2cForm"></div>
        <div class="mj2-sched-scroll">
        <table class="mj2-sched-table">
          <caption class="mj2-visually-hidden">一周课表，行为节次（含上课时间），列为周一到周日</caption>
          <thead>
            <tr>
              <th scope="col" class="mj2-th-p">节次</th>
              ${WD.map((w, i) => `<th scope="col"${i === t ? ' class="today"' : ''}>${w}${i === t ? '<span class="mj2-todaydot" aria-hidden="true"></span>' : ''}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${PERIODS.map(per => {
              const first = per.p === 1 || per.p === 3 || per.p === 5 || per.p === 7 || per.p === 9 || per.p === 11;
              const cells = WD.map((_, d) => {
                const g = days[d].get(per.p);
                if (!g) {
                  // 被上面某格的 rowspan 吃掉的节次：整格不输出
                  for (const [p0, gg] of days[d]) if (p0 < per.p && p0 + gg.span > per.p) return '';
                  return `<td class="mj2-td-empty${live === per.p ? ' live' : ''}"></td>`;
                }
                const isLive = g.items.some(it => live >= it.p && live < it.p + it.n);
                return `<td rowspan="${g.span}" class="mj2-td-course${isLive ? ' live' : ''}">
                  ${g.items.map(({ c, p, n }) => {
                    const sc = COLORS[d % 7];
                    const range = n > 1 ? `第${CN[p - 1]}–${CN[p + n - 2]}节` : `第${CN[p - 1]}节`;
                    return `<button class="mj2-slot" type="button" data-id="${c.id}" style="--sc:${sc}"
                      aria-label="${c.name}，${WD[d]}，${range}，${fmt(periodOf(p).s)}到${fmt(periodOf(p + n - 1).e)}">
                      <span class="n">${c.name}</span>
                      <span class="t">${range} ${fmt(periodOf(p).s)}–${fmt(periodOf(p + n - 1).e)}</span>
                      ${c.location ? `<span class="l">${c.location}</span>` : ''}
                      ${c.teacher ? `<span class="l">${c.teacher}</span>` : ''}
                    </button>`;
                  }).join('')}
                </td>`;
              }).join('');
              return `<tr class="${first ? 'block-start' : ''}${live === per.p ? ' live-row' : ''}">
                <th scope="row" class="mj2-th-p">
                  <span class="p">第${CN[per.p - 1]}节</span>
                  <span class="tm">${fmt(per.s)}–${fmt(per.e)}</span>
                  ${first ? `<span class="blk">${per.block}</span>` : ''}
                </th>
                ${cells}
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        </div>
        ${overflow.length ? `<details class="mj2-sched-extra"><summary>另有 ${overflow.length} 门课在本周节次里排不下（时间段冲突或超出第十一节）</summary>
          <ul>${overflow.map(c => `<li>${WD[c.day]} 第${CN[span(c).p - 1]}节起 · ${c.name}${c.location ? ' · ' + c.location : ''}</li>`).join('')}</ul>
        </details>` : ''}
        <p class="mj2-sub" style="margin:.6rem 0 0">点课程可编辑或删除；ICS 导入按时间自动吸附到节次，内容完全相同的重复条目会自动去重。</p>`;
    }

    function form(course) {
      const f = document.getElementById('mj2cForm');
      if (!f) return;
      const editing = !!course;
      const c = course || { name: '', location: '', teacher: '', day: todayWd(), p: 1, n: 2 };
      const sp = span(c);
      editingId = editing ? course.id : null;
      f.innerHTML = `
        <div class="mj2-form">
          <div class="full"><label for="mj2fName">课程名</label><input class="mj2-input" id="mj2fName" value="${(c.name || '').replace(/"/g, '&quot;')}" maxlength="40" /></div>
          <div><label for="mj2fDay">星期</label><select class="mj2-select" id="mj2fDay">${WD.map((w, i) => `<option value="${i}"${i === c.day ? ' selected' : ''}>${w}</option>`).join('')}</select></div>
          <div><label for="mj2fP">节次</label><select class="mj2-select" id="mj2fP">${PERIODS.map(x => `<option value="${x.p}"${x.p === sp.p ? ' selected' : ''}>第${CN[x.p - 1]}节 ${fmt(x.s)}–${fmt(x.e)}（${x.part}）</option>`).join('')}</select></div>
          <div><label for="mj2fN">连堂节数</label><select class="mj2-select" id="mj2fN">${[1, 2, 3, 4].map(k => `<option value="${k}"${k === sp.n ? ' selected' : ''}>${k} 节${k === 2 ? '（一大节）' : ''}</option>`).join('')}</select></div>
          <div><label for="mj2fRoom">地点</label><input class="mj2-input" id="mj2fRoom" value="${(c.location || '').replace(/"/g, '&quot;')}" maxlength="30" /></div>
          <div><label for="mj2fT">教师</label><input class="mj2-input" id="mj2fT" value="${(c.teacher || '').replace(/"/g, '&quot;')}" maxlength="20" /></div>
          <div class="full mj2-form-time" id="mj2fPreview">时间：${fmt(periodOf(sp.p).s)}–${fmt(periodOf(sp.p + sp.n - 1).e)}</div>
          <div style="display:flex;gap:.4rem;align-items:flex-end">
            <button class="mj2-btn solid" id="mj2fSave" type="button">保存</button>
            <button class="mj2-btn" id="mj2fCancel" type="button">取消</button>
            ${editing ? '<button class="mj2-btn" id="mj2fDel" type="button">删除</button>' : ''}
          </div>
        </div>`;
      const close = () => { editingId = null; f.innerHTML = ''; };
      // 节次 / 连堂数改动时实时回显真实起止时间，并把连堂上限收到当天最后一节
      const pSel = document.getElementById('mj2fP'), nSel = document.getElementById('mj2fN');
      const sync = () => {
        const p = +pSel.value, max = Math.max(1, 11 - p + 1);
        [...nSel.options].forEach(o => { o.disabled = +o.value > max; });
        if (+nSel.value > max) nSel.value = String(max);
        document.getElementById('mj2fPreview').textContent =
          `时间：${fmt(periodOf(p).s)}–${fmt(periodOf(p + (+nSel.value) - 1).e)}　·　${periodOf(p).part}`;
      };
      pSel.addEventListener('change', sync); nSel.addEventListener('change', sync);
      document.getElementById('mj2fCancel').addEventListener('click', close);
      document.getElementById('mj2fSave').addEventListener('click', () => {
        const name = document.getElementById('mj2fName').value.trim();
        if (!name) { document.getElementById('mj2fName').focus(); return; }
        const p = +pSel.value, n = Math.max(1, Math.min(11 - p + 1, +nSel.value || 1));
        const rec = {
          id: editingId || uid(), name,
          day: +document.getElementById('mj2fDay').value,
          location: document.getElementById('mj2fRoom').value.trim(),
          teacher: document.getElementById('mj2fT').value.trim(),
          p, n,
          start: periodOf(p).s, end: periodOf(p + n - 1).e,   // 冗余存一份，便于 ICS 互操作
          weeks: '每周'
        };
        if (editingId) courses = courses.map(x => x.id === editingId ? rec : x);
        else courses.push(rec);
        save(); close(); render();
      });
      const del = document.getElementById('mj2fDel');
      if (del) del.addEventListener('click', () => { courses = courses.filter(x => x.id !== editingId); save(); close(); render(); });
    }

    function importICS() {
      const inp = el('input', 'mj2-hidden-input');
      inp.type = 'file'; inp.accept = '.ics,text/calendar';
      inp.setAttribute('aria-label', '选择 ICS 课表文件');
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return;
        const fr = new FileReader();
        fr.onload = () => {
          try {
            const list = parseICS(String(fr.result));
            if (!list.length) { alert('没有解析到课程事件。请确认文件包含 VEVENT 且带 SUMMARY 与 DTSTART。'); return; }
            const before = courses.length;
            const merged = normalize(courses.concat(list));
            courses = merged.list;
            save(); render();
            alert(`已导入 ${list.length} 门课程` + (merged.dropped ? `，去掉 ${merged.dropped} 条重复` : '') + `。当前共 ${courses.length} 门。`);
          } catch (e) { alert('解析失败：' + e.message); }
        };
        fr.readAsText(f);
      });
      inp.click();
    }

    const onClick = e => {
      if (e.target.closest('#mj2cAdd')) { form(null); return; }
      if (e.target.closest('#mj2cImport')) { importICS(); return; }
      if (e.target.closest('#mj2cClear')) {
        if (!courses.length) return;
        if (confirm('清空全部 ' + courses.length + ' 门课程？')) { courses = []; save(); render(); }
        return;
      }
      const slot = e.target.closest('.mj2-slot');
      if (slot) { const c = courses.find(x => x.id === slot.dataset.id); if (c) form(c); }
    };
    return {
      /* 视图按需渲染，因此提供挂载/卸载而不是在启动时抓元素 */
      attach(h) {
        if (!h || bound) return;
        host = h; bound = true;
        host.addEventListener('click', onClick);
        // 首次挂载时把旧记录（只有 start/end、或 ICS 展开出的重复条目）补齐并去重
        const { list, dropped } = normalize(courses);
        if (dropped || list.some((c, i) => c !== courses[i])) { courses = list; save(); }
        if (dropped) console.info('[课表] 自动去掉 ' + dropped + ' 条完全重复的条目');
        render();
      },
      detach() {
        if (host && bound) host.removeEventListener('click', onClick);
        host = null; bound = false;
      },
      destroy() { this.detach(); }
    };
  })();

  /* ============================================================
     ⑨ 真实统计 + 应用状态栏
     原来的"站点统计"是写死的 128 / 46 / 12 / 3.2k，纯装饰。
     现在全部按站内真实数据算，同时输出到底部状态栏（桌面应用的常见形态）。
     ============================================================ */
  const Stats = (() => {
    const BUILD = new Date('2026-01-01T00:00:00');
    const fmtNum = n => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const countWords = list => {
      let n = 0;
      (list || []).forEach(p => (p.body || []).forEach(([, txt]) => { n += String(txt || '').replace(/\s/g, '').length; }));
      return n;
    };
    const collect = () => {
      let posts = [], music = 0, ach = 0, achTotal = 0;
      try { posts = window.MJ2 && MJ2.Posts ? MJ2.Posts.all() : (window.MJX ? MJX.POSTS : []); } catch (e) {}
      try {
        const s = JSON.parse(localStorage.getItem('mj_state') || '{}');
        ach = (s.ach || []).length + (s.clues || []).length;
        achTotal = 6 + 5;
      } catch (e) {}
      try { music = JSON.parse(localStorage.getItem('mj2_musicHistory') || '[]').length; } catch (e) {}
      let courses = 0;
      try { courses = JSON.parse(localStorage.getItem('mj2_courses') || '[]').length; } catch (e) {}
      const tags = new Set();
      posts.forEach(p => (p.tags || []).forEach(t => tags.add(t)));
      const words = countWords(posts) || countWords(window.MJX && MJX.ARTICLE_BODIES ? Object.values(MJX.ARTICLE_BODIES) : []);
      const photos = document.querySelectorAll('.mj-wall-photo').length || 6;
      const days = Math.max(1, Math.round((Date.now() - BUILD.getTime()) / 86400000));
      return { posts: posts.length, tags: tags.size, words, photos, music, ach, achTotal, courses, days };
    };
    const paint = () => {
      const d = collect();
      const map = {
        posts: d.posts, tags: d.tags, words: fmtNum(d.words), photos: d.photos,
        music: d.music, ach: d.ach + '/' + d.achTotal, courses: d.courses, days: d.days
      };
      document.querySelectorAll('#mjStats [data-st]').forEach(b => {
        const k = b.dataset.st, v = map[k];
        if (v !== undefined && b.textContent !== String(v)) b.textContent = String(v);
      });
      const line = document.getElementById('mjStatsLine');
      if (line) {
        line.textContent = `正文约 ${(d.words / 1000).toFixed(1)}k 字 · 本地数据 ${
          Object.keys(localStorage).filter(k => k.indexOf('mj') === 0).length} 项`;
      }
      // 底部状态栏
      const sb = document.getElementById('mjStatus');
      if (sb) {
        sb.querySelector('[data-s="posts"]').textContent = d.posts + ' 篇';
        sb.querySelector('[data-s="tags"]').textContent = d.tags + ' 标签';
        sb.querySelector('[data-s="words"]').textContent = (d.words / 1000).toFixed(1) + 'k 字';
        sb.querySelector('[data-s="ach"]').textContent = d.ach + '/' + d.achTotal + ' 成就';
        sb.querySelector('[data-s="view"]').textContent = (location.hash.replace(/^#\/?/, '') || 'home').split('/')[0];
      }
    };
    const mount = () => {
      if (document.getElementById('mjStatus')) return;
      const bar = el('div');
      bar.id = 'mjStatus';
      const isDesk = !!(window.mjDesktop && window.mjDesktop.isDesktop);
      bar.innerHTML = `
        <div class="sb-left">
          <span class="sb-app"><i class="sb-dot"></i>元素手帐</span>
          <span class="sb-tag">${isDesk ? '桌面版' : '网页版'}</span>
          <span class="sb-sep"></span>
          <span class="sb-view" data-s="view">home</span>
        </div>
        <div class="sb-mid">
          <span data-s="posts">–</span><span data-s="tags">–</span><span data-s="words">–</span><span data-s="ach">–</span>
        </div>
        <div class="sb-right">
          <span class="sb-fps" id="mjSbFps" title="每秒帧数">– fps</span>
          <button class="sb-btn" id="mjSbExport" type="button" title="导出本地数据">导出</button>
          <button class="sb-btn" id="mjSbImport" type="button" title="导入本地数据">导入</button>
          <button class="sb-btn" id="mjSbKeys" type="button" title="键盘快捷键">⌘</button>
        </div>`;
      document.body.appendChild(bar);
      paint();
      // 导出 / 导入：桌面版走主进程写盘，网页版退化成下载 / 选文件
      document.getElementById('mjSbExport').addEventListener('click', async () => {
        const out = {};
        Object.keys(localStorage).filter(k => k.indexOf('mj') === 0).forEach(k => {
          try { out[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { out[k] = localStorage.getItem(k); }
        });
        const D = window.mjDesktop;
        if (D && D.isDesktop) {
          const r = await D.exportData(out).catch(() => null);
          if (r && r.ok) { toast('已导出到 ' + (r.path || '文件'), '好'); return; }
        }
        const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'elemental-journal-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        toast('已导出为 JSON 文件', '好');
      });
      document.getElementById('mjSbImport').addEventListener('click', () => {
        const inp = el('input', 'mj2-hidden-input');
        inp.type = 'file'; inp.accept = 'application/json,.json';
        inp.setAttribute('aria-label', '选择要导入的数据文件');
        document.body.appendChild(inp);
        inp.addEventListener('change', () => {
          const f = inp.files && inp.files[0]; inp.remove();
          if (!f) return;
          const fr = new FileReader();
          fr.onload = () => {
            try {
              const obj = JSON.parse(String(fr.result));
              let n = 0;
              Object.keys(obj).forEach(k => {
                const key = k.indexOf('mj') === 0 ? k : 'mj2_' + k;
                localStorage.setItem(key, typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k]));
                n++;
              });
              toast(`已导入 ${n} 项数据，正在重载`, '好');
              setTimeout(() => location.reload(), 700);
            } catch (e) { alert('导入失败：' + e.message); }
          };
          fr.readAsText(f);
        });
        inp.click();
      });
      document.getElementById('mjSbKeys').addEventListener('click', () => {
        toast('Ctrl+1…9 切换页面 · Ctrl+Shift+F 帧率表', '⌘');
      });
      /* 状态栏帧率。
         ★ 原来这里是无条件 Raf.add，也就是"为了显示一个数字，让整页永远
         每帧都醒着" —— 页面因此永远进不了空闲状态，CPU 一直有活干。
         改成每隔几秒做一小段采样（约 30 帧 ≈ 0.5s），采完立刻摘掉订阅：
         数字照样在动，但绝大多数时间这条链路是静默的。 */
      const fpsEl = document.getElementById('mjSbFps');
      let burstOff = null, burstTimer = 0;
      function sampleFpsBurst() {
        if (burstOff) return;
        let acc = 0, n = 0, lastT = 0;
        burstOff = window.MJX.Raf.add(function (now) {
          if (lastT) { acc += now - lastT; n++; }
          lastT = now;
          if (n >= 30) {
            if (fpsEl) fpsEl.textContent = Math.round(1000 / (acc / n)) + ' fps';
            if (burstOff) { burstOff(); burstOff = null; }
          }
        });
      }
      sampleFpsBurst();
      burstTimer = setInterval(sampleFpsBurst, 3000);
      addEventListener('pagehide', () => { clearInterval(burstTimer); if (burstOff) burstOff(); });
      // Ctrl+1…9 直达页面（桌面应用的肌肉记忆）
      const ROUTES = ['#/', '#/blog', '#/works', '#/projects', '#/games', '#/schedule', '#/about', '#/friends', '#/memory'];
      addEventListener('keydown', e => {
        if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
        const i = parseInt(e.key, 10);
        if (i >= 1 && i <= 9) { e.preventDefault(); location.hash = ROUTES[i - 1]; }
      });
      addEventListener('hashchange', paint);
    };
    return {
      paint, mount,
      destroy() { const b = document.getElementById('mjStatus'); if (b) b.remove(); }
    };
  })();

  /* ============================================================
     ⑧ 音乐：导入本地音频 + ID3 封面，真实播放
     ============================================================ */
  const ID3 = {
    decode(frame) {
      const enc = frame[0];
      let s = 1;
      if (enc === 0) return new TextDecoder('iso-8859-1').decode(frame.subarray(1)).replace(/\0.*$/, '');
      if (enc === 1) { // UTF-16 with BOM
        const bom = (frame[1] << 8) | frame[2];
        s = 3;
        return new TextDecoder(bom === 0xFEFF ? 'utf-16be' : 'utf-16le').decode(frame.subarray(s)).replace(/\0.*$/, '');
      }
      if (enc === 2) return new TextDecoder('utf-16be').decode(frame.subarray(1)).replace(/\0.*$/, '');
      return new TextDecoder('utf-8').decode(frame.subarray(1)).replace(/\0.*$/, '');
    },
    parse(buf) {
      const out = { title: '', artist: '', album: '', cover: null };
      const dv = new DataView(buf);
      if (buf.byteLength < 10) return out;
      if (dv.getUint8(0) !== 0x49 || dv.getUint8(1) !== 0x44 || dv.getUint8(2) !== 0x33) return out; // 'ID3'
      const ver = dv.getUint8(3);
      const flags = dv.getUint8(5);
      const size = ((dv.getUint8(6) & 0x7f) << 21) | ((dv.getUint8(7) & 0x7f) << 14) | ((dv.getUint8(8) & 0x7f) << 7) | (dv.getUint8(9) & 0x7f);
      let off = 10;
      if (flags & 0x40) { // extended header
        const ext = ver === 4
          ? ((dv.getUint8(10) & 0x7f) << 21) | ((dv.getUint8(11) & 0x7f) << 14) | ((dv.getUint8(12) & 0x7f) << 7) | (dv.getUint8(13) & 0x7f)
          : dv.getUint32(10);
        off += 4 + ext;
      }
      const end = Math.min(buf.byteLength, 10 + size);
      const idLen = ver === 2 ? 3 : 4, headLen = ver === 2 ? 6 : 10;
      while (off + headLen <= end) {
        const id = String.fromCharCode.apply(null, new Uint8Array(buf, off, idLen));
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
        let fsize;
        if (ver === 2) fsize = (dv.getUint8(off + 3) << 16) | (dv.getUint8(off + 4) << 8) | dv.getUint8(off + 5);
        else if (ver === 4) fsize = ((dv.getUint8(off + 4) & 0x7f) << 21) | ((dv.getUint8(off + 5) & 0x7f) << 14) | ((dv.getUint8(off + 6) & 0x7f) << 7) | (dv.getUint8(off + 7) & 0x7f);
        else fsize = dv.getUint32(off + 4);
        const ds = off + headLen;
        if (fsize <= 0 || ds + fsize > end) break;
        const frame = new Uint8Array(buf, ds, fsize);
        if (id === 'TIT2' || id === 'TT2') out.title = this.decode(frame);
        else if (id === 'TPE1' || id === 'TP1') out.artist = this.decode(frame);
        else if (id === 'TALB' || id === 'TAL') out.album = this.decode(frame);
        else if (id === 'APIC' || id === 'PIC') out.cover = this.apic(frame, id === 'PIC');
        off = ds + fsize;
      }
      return out;
    },
    apic(frame, v2) {
      try {
        if (v2) return new Blob([frame.subarray(5)], { type: 'image/jpeg' });
        let p = 1;
        while (p < frame.length && frame[p] !== 0) p++;      // mime
        const mime = new TextDecoder('iso-8859-1').decode(frame.subarray(1, p)) || 'image/jpeg';
        p++; p++;                                             // picture type
        const enc = frame[0];
        if (enc === 1 || enc === 2) { while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2; p += 2; }
        else { while (p < frame.length && frame[p] !== 0) p++; p++; }
        if (p >= frame.length) return null;
        return new Blob([frame.subarray(p)], { type: mime });
      } catch (e) { return null; }
    }
  };

  const IDB = (() => {
    const NAME = 'mj2-music', STORE = 'tracks';
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const rq = indexedDB.open(NAME, 1);
      rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    }));
    const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(STORE, mode); const rq = fn(t.objectStore(STORE)); t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); }); };
    return {
      all: () => tx('readonly', s => s.getAll()),
      put: r => tx('readwrite', s => s.put(r)),
      del: id => tx('readwrite', s => s.delete(id))
    };
  })();

  const Music = (() => {
    const body = document.querySelector('.music-side');
    if (!body) return { destroy() {} };
    const cover = document.getElementById('mCover');
    const titleEl = document.getElementById('mTitle');
    const artistEl = document.getElementById('mArtist');
    // 静态示例曲的封面也可能加载失败（文件被删/改名），失败同样退到默认图标
    cover.addEventListener('error', () => {
      cover.removeAttribute('src');
      cover.classList.add('is-default');
      if (!cover.parentNode.querySelector('.cover-ph')) cover.insertAdjacentHTML('afterend', DEFAULT_COVER);
    });
    const bar = document.getElementById('mBar');
    const prog = document.getElementById('mProg');
    const nowEl = document.getElementById('mNow');
    const allEl = document.getElementById('mAll');
    const playBtn = document.getElementById('mPlay');

    const audio = new Audio();
    audio.preload = 'metadata';
    let imported = [];   // {id,title,artist,album,coverBlob,audioBlob,duration}
    let urls = [];
    let cur = null;

    const fmt = s => isFinite(s) ? pad(Math.floor(s / 60)) + ':' + pad(Math.floor(s % 60)) : '--:--';

    function rebuild() {
      urls.forEach(u => URL.revokeObjectURL(u));
      urls = [];
      imported.forEach(t => {
        if (t.audioBlob) t.url = URL.createObjectURL(t.audioBlob);
        if (t.coverBlob) t.coverUrl = URL.createObjectURL(t.coverBlob);
        if (t.url) urls.push(t.url);
        if (t.coverUrl) urls.push(t.coverUrl);
      });
    }

    /* 没有专辑封面时用"系统默认音乐文件"图标兜底。
       原来是拿 assets/paper/cover-01.svg 顶上（那是首示例曲的封面），换了歌就张冠李戴。
       这里画一个中性的图标：浅蓝渐变页 + 折角 + 白色音符，观感接近 Windows 的默认音频文件图标。 */
    const DEFAULT_COVER = `<svg class="cover-ph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <defs><linearGradient id="mjCovG" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#dfeaf7"/><stop offset="1" stop-color="#b9d2ea"/>
      </linearGradient></defs>
      <path d="M14 6h24l12 12v40a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z" fill="url(#mjCovG)"/>
      <path d="M38 6l12 12H40a2 2 0 0 1-2-2z" fill="#8fb4d6"/>
      <path d="M27 45V25l11-3v20" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="24.5" cy="45.5" r="4.2" fill="#fff"/><circle cx="35.5" cy="42.5" r="4.2" fill="#fff"/>
    </svg>`;

    function paintList() {
      const host = document.getElementById('mj2Tracks');
      if (!host) return;
      if (!imported.length) { host.innerHTML = `<div class="mj2-empty">还没有导入音乐</div>`; return; }
      host.innerHTML = imported.map(t => `
        <div class="mj2-track${cur && cur.id === t.id ? ' on' : ''}" data-id="${t.id}" role="button" tabindex="0">
          ${t.coverUrl ? `<img src="${t.coverUrl}" alt="" />` : DEFAULT_COVER}
          <span class="ti"><b>${(t.title || t.fileName).slice(0, 26)}</b><span>${t.artist || '未知艺术家'}</span></span>
          <span class="del" data-del="${t.id}" title="移除">✕</span>
        </div>`).join('');
    }

    function paintNow() {
      if (!cur) return;
      titleEl.textContent = cur.title || cur.fileName;
      artistEl.textContent = [cur.artist, cur.album].filter(Boolean).join(' · ') || '未知艺术家';
      // 有封面用封面，没有就把 <img> 换成默认图标（不再硬塞示例曲的封面）
      if (cur.coverUrl) {
        cover.src = cur.coverUrl;
        cover.classList.remove('is-default');
        cover.parentNode.querySelector('.cover-ph')?.remove();
      } else if (cover.tagName === 'IMG') {
        cover.removeAttribute('src');
        cover.classList.add('is-default');
        if (!cover.parentNode.querySelector('.cover-ph')) cover.insertAdjacentHTML('afterend', DEFAULT_COVER);
      }
      prog.style.width = '0%';
      nowEl.textContent = '00:00';
      allEl.textContent = fmt(cur.duration);
      paintList();
    }

    function setPlayIcon(on) {
      playBtn.innerHTML = on
        ? '<span class="bars"><i style="height:7px"></i><i style="height:13px"></i><i style="height:10px"></i></span>'
        : '<span class="tri"></span>';
    }

    function select(id, autoplay) {
      const t = imported.find(x => x.id === id);
      if (!t) return;
      cur = t;
      audio.src = t.url || '';
      paintNow();
      pushHistory(id);
      if (autoplay && t.url) audio.play().catch(() => {});
    }

    /* ---------- 播放模式：顺序 / 随机 / 单曲循环 / 列表循环 ---------- */
    const MODES = [
      { id: 'order', n: '顺序', icon: '→' },
      { id: 'shuffle', n: '随机', icon: '⤨' },
      { id: 'one', n: '单曲循环', icon: '↻¹' },
      { id: 'all', n: '列表循环', icon: '↻' }
    ];
    let mode = Store.get('musicMode', 'order');
    if (!MODES.some(m => m.id === mode)) mode = 'order';

    const pickNext = dir => {
      if (!imported.length) return null;
      if (mode === 'one') return cur;
      const i = imported.findIndex(x => x.id === (cur && cur.id));
      if (mode === 'shuffle') {
        if (imported.length === 1) return imported[0];
        let j = i;
        while (j === i) j = Math.floor(Math.random() * imported.length);
        return imported[j];
      }
      let j = i + dir;
      if (j >= imported.length) j = mode === 'all' ? 0 : imported.length - 1;
      if (j < 0) j = mode === 'all' ? imported.length - 1 : 0;
      return imported[j];
    };

    // 播放记录：最近 30 首，形成临时歌单
    let history = Store.get('musicHistory', []);
    const pushHistory = id => {
      history = [id].concat(history.filter(x => x !== id)).slice(0, 30);
      Store.set('musicHistory', history);
      paintHistory();
    };
    const paintMode = () => {
      const b = document.getElementById('mj2mMode');
      if (!b) return;
      const m = MODES.find(x => x.id === mode);
      b.textContent = m.icon + ' ' + m.n;
      b.title = '播放模式：' + m.n + '（点击切换）';
      b.dataset.mode = mode;
    };
    const cycleMode = () => {
      const i = MODES.findIndex(m => m.id === mode);
      mode = MODES[(i + 1) % MODES.length].id;
      Store.set('musicMode', mode);
      paintMode();
      toast('播放模式：' + MODES.find(m => m.id === mode).n);
    };
    function paintHistory() {
      const host = document.getElementById('mj2mHistory');
      if (!host) return;
      const names = history.map(id => imported.find(t => t.id === id)).filter(Boolean).map(t => t.title || t.fileName);
      host.innerHTML = names.length
        ? names.slice(0, 6).map(n => `<span class="mj2-hchip">${n.slice(0, 14)}</span>`).join('')
        : `<span class="mj2-sub">还没有播放记录</span>`;
    }

    const onTime = () => {
      if (!cur) return;
      const d = audio.duration || cur.duration || 0;
      nowEl.textContent = fmt(audio.currentTime);
      allEl.textContent = fmt(d);
      prog.style.width = d ? (audio.currentTime / d * 100).toFixed(1) + '%' : '0%';
    };
    const onPlay = () => setPlayIcon(true);
    const onPause = () => setPlayIcon(false);
    const onEnded = () => {
      if (mode === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
      // 顺序模式播到最后一首就停；列表循环才回到开头
      if (mode === 'order' && imported.findIndex(x => x.id === cur.id) === imported.length - 1) { setPlayIcon(false); return; }
      const nx = pickNext(1);
      if (nx) select(nx.id, true); else setPlayIcon(false);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('loadedmetadata', () => { if (cur) { cur.duration = audio.duration; allEl.textContent = fmt(audio.duration); } });

    const onClick = async e => {
      const delBtn = e.target.closest('[data-del]');
      if (delBtn) {
        e.stopPropagation();
        const id = delBtn.dataset.del;
        await IDB.del(id).catch(() => {});
        imported = imported.filter(x => x.id !== id);
        if (cur && cur.id === id) { audio.pause(); cur = null; setPlayIcon(false); }
        rebuild(); paintList();
        return;
      }
      const row = e.target.closest('.mj2-track');
      if (row) select(row.dataset.id, true);
    };
    const onKey = e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.mj2-track');
      if (row) { e.preventDefault(); select(row.dataset.id, true); }
    };

    // 接管播放控制：有导入曲目就走真实播放，否则交给既有模拟播放
    const onPlayBtn = e => {
      if (!cur || !cur.url) return; // 交给既有内联播放器
      e.stopPropagation();
      if (audio.paused) audio.play().catch(() => {}); else audio.pause();
    };
    playBtn.addEventListener('click', onPlayBtn, true);

    const onNext = e => {
      if (!imported.length) return;
      e.stopPropagation();
      const nx = pickNext(1);
      if (nx) select(nx.id, true);
    };
    const onPrev = e => {
      if (!imported.length) return;
      e.stopPropagation();
      const nx = pickNext(-1);
      if (nx) select(nx.id, true);
    };
    document.getElementById('mNext').addEventListener('click', onNext, true);
    document.getElementById('mPrev').addEventListener('click', onPrev, true);
    bar.addEventListener('click', e => {
      if (!cur || !cur.url) return;
      const r = bar.getBoundingClientRect();
      audio.currentTime = (e.clientX - r.left) / r.width * (audio.duration || 0);
    }, true);

    // 导入 UI：导入 / 播放模式 / 音量 / 临时歌单记录
    const tools = el('div', 'mj2-row');
    tools.innerHTML = `
      <button class="mj2-btn" id="mj2mImport" type="button">导入音乐</button>
      <button class="mj2-btn" id="mj2mMode" type="button" title="播放模式">→ 顺序</button>
      <span class="mj2-sub" id="mj2mCount">0 首</span>`;
    body.appendChild(tools);

    /* 音量：静音按钮 + 滑杆。值存在 Store 里，重启后保留。
       注意音频元素是 new Audio()（不在 DOM 里），直接写 audio.volume 即可。 */
    const volBox = el('div', 'mj2-vol');
    volBox.innerHTML = `
      <button class="mj2-vbtn" id="mj2mMute" type="button" aria-label="静音" aria-pressed="false">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path class="sp" d="M4 9h3l4-3.5v13L7 15H4z"/>
          <path class="w1" d="M15 9.2a4 4 0 0 1 0 5.6"/>
          <path class="w2" d="M17.6 6.4a7.6 7.6 0 0 1 0 11.2"/>
          <path class="cut" d="M4 4l16 16"/>
        </svg>
      </button>
      <input id="mj2mVol" type="range" min="0" max="100" step="1" value="100"
        aria-label="音量" title="音量" />
      <span class="mj2-sub" id="mj2mVolNum">100%</span>`;
    body.appendChild(volBox);

    const volEl = document.getElementById('mj2mVol');
    const volNum = document.getElementById('mj2mVolNum');
    const muteBtn = document.getElementById('mj2mMute');
    let vol = Math.max(0, Math.min(100, Number(Store.get('musicVol', 100)) || 0));
    let muted = Store.get('musicMute', false) === true;
    const paintVol = () => {
      volEl.value = String(vol);
      volEl.style.setProperty('--fill', vol + '%');
      volNum.textContent = muted ? '静音' : vol + '%';
      muteBtn.classList.toggle('on', muted || vol === 0);
      muteBtn.setAttribute('aria-pressed', String(muted));
      muteBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
    };
    const applyVol = () => { audio.volume = muted ? 0 : vol / 100; };
    volEl.addEventListener('input', () => {
      vol = Number(volEl.value) || 0;
      if (vol > 0) muted = false;
      Store.set('musicVol', vol); Store.set('musicMute', muted);
      applyVol(); paintVol();
    });
    muteBtn.addEventListener('click', () => {
      muted = !muted;
      Store.set('musicMute', muted);
      applyVol(); paintVol();
    });
    applyVol(); paintVol();
    const histBox = el('div', 'mj2-history');
    histBox.innerHTML = `<div class="mj2-sub" style="margin:.45rem 0 .2rem">临时歌单记录</div><div class="mj2-hchips" id="mj2mHistory"></div>`;
    body.appendChild(histBox);
    const list = el('div', 'mj2-tracklist');
    list.id = 'mj2Tracks';
    body.appendChild(list);

    const onImport = () => {
      const inp = el('input', 'mj2-hidden-input');
      inp.type = 'file'; inp.accept = 'audio/*'; inp.multiple = true;
      inp.setAttribute('aria-label', '选择音频文件');
      document.body.appendChild(inp);
      inp.addEventListener('change', async () => {
        const files = Array.from(inp.files || []);
        inp.remove();
        for (const f of files) {
          try {
            const buf = await f.arrayBuffer();
            const head = buf.slice(0, Math.min(buf.byteLength, 512 * 1024));
            const tags = ID3.parse(head);
            const rec = {
              id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              fileName: f.name.replace(/\.[^.]+$/, ''),
              title: tags.title || f.name.replace(/\.[^.]+$/, ''),
              artist: tags.artist || '', album: tags.album || '',
              coverBlob: tags.cover || null,
              audioBlob: f, size: f.size, addedAt: Date.now()
            };
            await IDB.put(rec).catch(() => {});
            imported.push(rec);
          } catch (err) { console.warn('[music]', f.name, err); }
        }
        rebuild(); paintList();
        document.getElementById('mj2mCount').textContent = imported.length + ' 首';
        if (!cur && imported.length) select(imported[0].id, false);
      });
      inp.click();
    };
    document.getElementById('mj2mImport').addEventListener('click', onImport);
    document.getElementById('mj2mMode').addEventListener('click', cycleMode);
    paintMode(); paintHistory();

    list.addEventListener('click', onClick);
    list.addEventListener('keydown', onKey);

    (async () => {
      try {
        const rows = await IDB.all();
        imported = (rows || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
      } catch (e) { imported = []; }
      rebuild(); paintList();
      const c = document.getElementById('mj2mCount');
      if (c) c.textContent = imported.length + ' 首';
      paintHistory();
      if (imported.length) select(imported[0].id, false);
    })();

    return {
      destroy() {
        audio.pause();
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('play', onPlay);
        audio.removeEventListener('pause', onPause);
        audio.removeEventListener('ended', onEnded);
        playBtn.removeEventListener('click', onPlayBtn, true);
        document.getElementById('mNext').removeEventListener('click', onNext, true);
        document.getElementById('mPrev').removeEventListener('click', onPrev, true);
        list.removeEventListener('click', onClick);
        list.removeEventListener('keydown', onKey);
        urls.forEach(u => URL.revokeObjectURL(u));
      }
    };
  })();

  /* ============================================================
     ④ 文章：可编辑数据层（首次从既有 DOM 播种，之后以本地存储为准）
     ============================================================ */
  const Posts = (() => {
    const KEY = 'posts';
    const FX = window.MJX || {};
    const deriveCat = FX.deriveCat || (() => 'tech');

    function seed() {
      const cards = $$('#post-list .post-card');
      const bodies = FX.ARTICLE_BODIES || {};
      return cards.map((c, i) => {
        const tags = $$('.post-tags .chip', c).map(t => t.textContent.trim());
        const desc = ($('.post-desc', c) || {}).textContent?.trim() || '';
        return {
          id: 'p' + i,
          slug: 'post-' + i,
          title: ($('.post-title', c) || {}).textContent?.trim() || ('文章 ' + (i + 1)),
          desc,
          cover: ($('.post-cover img', c) || {}).getAttribute?.('src') || 'assets/paper/bg-01.svg',
          tags, cat: deriveCat(tags),
          date: ($('.post-meta .m', c) || {}).textContent?.trim() || new Date().toISOString().slice(0, 10),
          pinned: !!$('.post-pinned', c),
          body: bodies[i] || [['p', desc || '正文待补充。']]
        };
      });
    }

    let list = Store.get(KEY, null);
    if (!Array.isArray(list) || !list.length) { list = seed(); Store.set(KEY, list); }

    const listeners = new Set();
    const emit = () => listeners.forEach(f => { try { f(list); } catch (e) {} });
    const persist = () => { Store.set(KEY, list); emit(); };

    return {
      all: () => list,
      find: slug => list.find(p => p.slug === slug),
      upsert(post) {
        const i = list.findIndex(p => p.slug === post.slug);
        if (i >= 0) list[i] = post; else list.unshift(post);
        persist(); return post;
      },
      remove(slug) { list = list.filter(p => p.slug !== slug); persist(); },
      reset() { list = seed(); persist(); },
      onChange(f) { listeners.add(f); return () => listeners.delete(f); },
      blank() {
        const t = Date.now().toString(36);
        return {
          id: 'p' + t, slug: 'post-' + t,
          title: '', desc: '', cover: 'assets/paper/bg-01.svg',
          tags: [], cat: 'tech',
          date: new Date().toISOString().slice(0, 10),
          pinned: false, body: [['p', '']]
        };
      }
    };
  })();

  /* 编辑器：段落用空行分隔；## 标题 / > 引用 / ``` 代码块 */
  const PostsUI = (() => {
    let modal = null;

    function blocksToText(body) {
      return (body || []).map(([k, v]) =>
        k === 'h2' ? '## ' + v :
        k === 'code' ? '```\n' + v + '\n```' :
        k === 'blockquote' ? '> ' + v : v).join('\n\n');
    }
    function textToBlocks(text) {
      const out = [];
      const chunks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
      for (const raw of chunks) {
        const s = raw.trim();
        if (!s) continue;
        if (s.startsWith('```')) out.push(['code', s.replace(/^```\n?/, '').replace(/\n?```$/, '')]);
        else if (s.startsWith('## ')) out.push(['h2', s.slice(3).trim()]);
        else if (s.startsWith('> ')) out.push(['blockquote', s.replace(/^> ?/gm, '').trim()]);
        else out.push(['p', s.replace(/\n/g, ' ')]);
      }
      return out.length ? out : [['p', '']];
    }

    function toast(text) {
      const host = document.getElementById('mj-toasts');
      if (!host) return;
      const t = el('div', 'mj-toast in', `<span class="ic">✓</span><span><b>${text}</b></span>`);
      host.appendChild(t);
      setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 500); }, 2600);
    }

    function close() {
      if (!modal) return;
      modal.remove(); modal = null;
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    function open(slug) {
      close();
      const isNew = !slug;
      const src = isNew ? Posts.blank() : Posts.find(slug);
      if (!src) return;
      const p = JSON.parse(JSON.stringify(src));

      modal = el('div', 'mj2-modal');
      modal.id = 'mj2PostModal';
      modal.innerHTML = `
        <div class="mj2-modal-card" role="dialog" aria-modal="true" aria-label="${isNew ? '新建文章' : '编辑文章'}">
          <div class="mj2-modal-head">
            <h3>${isNew ? '新建文章' : '编辑文章'}</h3>
            <button class="mj2-btn" type="button" data-x="close" aria-label="关闭">✕</button>
          </div>
          <div class="mj2-form">
            <div class="full"><label for="mj2pTitle">标题</label><input class="mj2-input" id="mj2pTitle" value="${(p.title || '').replace(/"/g, '&quot;')}" /></div>
            <div class="full"><label for="mj2pDesc">摘要</label><input class="mj2-input" id="mj2pDesc" value="${(p.desc || '').replace(/"/g, '&quot;')}" /></div>
            <div><label for="mj2pDate">日期</label><input class="mj2-input" id="mj2pDate" value="${p.date}" placeholder="YYYY-MM-DD" /></div>
            <div><label for="mj2pCat">分类</label><select class="mj2-select" id="mj2pCat">
              <option value="tech"${p.cat === 'tech' ? ' selected' : ''}>技术</option>
              <option value="anime"${p.cat === 'anime' ? ' selected' : ''}>二次元</option>
              <option value="life"${p.cat === 'life' ? ' selected' : ''}>生活</option>
            </select></div>
            <div class="full"><label for="mj2pTags">标签（逗号分隔）</label><input class="mj2-input" id="mj2pTags" value="${(p.tags || []).join(', ')}" /></div>
            <div class="full"><label for="mj2pCover">封面路径</label><input class="mj2-input" id="mj2pCover" value="${p.cover}" /></div>
            <div class="full"><label for="mj2pPin"><input type="checkbox" id="mj2pPin"${p.pinned ? ' checked' : ''} /> 置顶</label></div>
            <div class="full"><label for="mj2pBody">正文（空行分段；## 标题；&gt; 引用；\`\`\` 代码块）</label>
              <textarea class="mj2-input mj2-textarea" id="mj2pBody">${blocksToText(p.body).replace(/</g, '&lt;')}</textarea></div>
          </div>
          <div class="mj2-modal-foot">
            <span class="mj2-sub" id="mj2pMsg"></span>
            <button class="mj2-btn" type="button" data-x="cancel">取消</button>
            <button class="mj2-btn solid" type="button" data-x="save">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      document.addEventListener('keydown', onKey);

      const onModal = e => {
        const x = e.target.closest('[data-x]');
        if (x === null && !e.target.closest('.mj2-modal-card')) { close(); return; }
        if (!x) return;
        const act = x.dataset.x;
        if (act === 'close' || act === 'cancel') { close(); return; }
        if (act === 'save') {
          const title = document.getElementById('mj2pTitle').value.trim();
          if (!title) { document.getElementById('mj2pTitle').focus(); document.getElementById('mj2pMsg').textContent = '标题不能为空'; return; }
          p.title = title;
          p.desc = document.getElementById('mj2pDesc').value.trim();
          p.date = document.getElementById('mj2pDate').value.trim() || new Date().toISOString().slice(0, 10);
          p.cat = document.getElementById('mj2pCat').value;
          p.tags = document.getElementById('mj2pTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
          p.cover = document.getElementById('mj2pCover').value.trim() || 'assets/paper/bg-01.svg';
          p.pinned = document.getElementById('mj2pPin').checked;
          p.body = textToBlocks(document.getElementById('mj2pBody').value);
          Posts.upsert(p);
          close();
          toast(isNew ? '已保存新文章' : '已保存修改');
          if (location.hash.startsWith('#/blog')) location.hash = '#/blog';
          setTimeout(() => { location.hash = '#/blog'; }, 30);
        }
      };
      modal.addEventListener('click', onModal);
      const onTrap = e => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onTrap);
      setTimeout(() => { const t = document.getElementById('mj2pTitle'); if (t) t.focus(); }, 60);
      return () => { modal.removeEventListener('click', onModal); document.removeEventListener('keydown', onTrap); };
    }

    return { open, close, toast, blocksToText, textToBlocks };
  })();

  /* ============================================================
     启动 / 清理
     ============================================================ */
  Stats.mount();
  const mods = [Calendar, Profile, Weather, Sched, Music, Stats, Desktop];
  addEventListener('pagehide', () => mods.forEach(m => { try { m.destroy && m.destroy(); } catch (e) {} }));
  // 本地数据变动（导入音乐 / 加课 / 存文章）后刷新统计
  const origStoreSet = Store.set.bind(Store);
  Store.set = function (k, v) { const r = origStoreSet(k, v); try { Stats.paint(); } catch (e) {} return r; };
  window.MJ2 = { Calendar, Profile, Weather, Sched, Music, ID3, Store, IDB, Posts, PostsUI, Desktop, Stats };
})();
