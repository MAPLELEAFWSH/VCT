/* ============================================================
   qr.js · 极简二维码生成器（字节模式 / 纠错等级 L / 版本 1–10）
   ------------------------------------------------------------
   为什么自己写：茶室的邀请要给出「扫一下就能进」的二维码，而 Electron
   打包后的页面不能依赖 CDN（离线就废了），引入一个 qrcode 库又会把
   站点从"零依赖静态页"变成"要构建的项目"。字节模式 + L 级 + 版本 1–10
   足够装下 http://192.168.x.x:5210/#/chat 这类地址（v10-L 可放 271 字节），
   代码量也还能看懂。

   实现遵循 ISO/IEC 18004：
     · 数据 → 模式指示符 0100 + 8 位长度 + 字节 + 终止符 + 补齐
     · 按版本分块 → 每块算 Reed-Solomon 纠错码 → 交错排列
     · 排矩阵（定位图形/分隔符/定时图形/校正图形/暗模块）
     · 8 种掩码逐个试，按 4 条罚分规则选最优
   ============================================================ */
window.MJ2QR = (() => {
  'use strict';

  /* ---------- GF(256)，本原多项式 0x11D ---------- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[(LOG[a] + LOG[b]) % 255];

  function genPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];                       // 乘 x
        next[j + 1] ^= mul(poly[j], EXP[i]);      // 乘 α^i
      }
      poly = next;
    }
    return poly;
  }
  function rsEcc(data, deg) {
    const gen = genPoly(deg);
    const buf = new Uint8Array(data.length + deg);
    buf.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const c = buf[i];
      if (!c) continue;
      for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], c);
    }
    return buf.slice(data.length);
  }

  /* ---------- 版本表（纠错等级 L）----------
     groups: [块数, 每块数据码字数]；ec = 每块纠错码字数 */
  const RS = [
    null,
    { ec: 7, groups: [[1, 19]] },
    { ec: 10, groups: [[1, 34]] },
    { ec: 15, groups: [[1, 55]] },
    { ec: 20, groups: [[1, 80]] },
    { ec: 26, groups: [[1, 108]] },
    { ec: 18, groups: [[2, 68]] },
    { ec: 20, groups: [[2, 78]] },
    { ec: 24, groups: [[2, 97]] },
    { ec: 30, groups: [[2, 116]] },
    { ec: 18, groups: [[2, 68], [2, 69]] }
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const VERSION_BITS = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
  /* 格式信息：纠错等级 L(01) + 掩码 0..7 的 15 位 BCH 码 */
  const FORMAT_L = [0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976];

  const dataCapacity = v => RS[v].groups.reduce((s, [n, k]) => s + n * k, 0);

  function pickVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      // 4 位模式 + 长度位 + 数据 + 最多 4 位终止符
      // 长度位：版本 1–9 是 8 位，版本 10 起是 16 位（这条很容易写错）
      const lenBits = v >= 10 ? 16 : 8;
      const need = Math.ceil((4 + lenBits + byteLen * 8) / 8);
      if (need <= dataCapacity(v)) return v;
    }
    return 0;
  }

  /* ---------- 数据码字 ---------- */
  function buildCodewords(bytes, version) {
    const cap = dataCapacity(version);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);                                    // 字节模式
    push(bytes.length, version >= 10 ? 16 : 8);         // 字符计数指示符
    for (const b of bytes) push(b, 8);
    // 终止符：最多 4 个 0，然后补到字节边界
    const maxBits = cap * 8;
    for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      out.push(b);
    }
    // 交替填充 0xEC / 0x11
    const PAD = [0xEC, 0x11];
    for (let i = 0; out.length < cap; i++) out.push(PAD[i % 2]);
    return out;
  }

  function interleave(codewords, version) {
    const { ec, groups } = RS[version];
    const blocks = [];
    let p = 0;
    for (const [count, k] of groups) {
      for (let i = 0; i < count; i++) {
        const d = codewords.slice(p, p + k); p += k;
        blocks.push({ d, e: rsEcc(d, ec) });
      }
    }
    const out = [];
    const maxD = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.e[i]);
    return out;
  }

  /* ---------- 矩阵 ---------- */
  function makeMatrix(version) {
    const size = 17 + version * 4;
    const mod = Array.from({ length: size }, () => new Uint8Array(size));
    const fn = Array.from({ length: size }, () => new Uint8Array(size));

    const setFn = (r, c, v) => { if (r >= 0 && c >= 0 && r < size && c < size) { mod[r][c] = v; fn[r][c] = 1; } };

    // 定位图形 + 分隔符
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        if (r0 + r < 0 || c0 + c < 0 || r0 + r >= size || c0 + c >= size) continue;
        const inner = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setFn(r0 + r, c0 + c, inner ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // 定时图形
    for (let i = 8; i < size - 8; i++) { setFn(6, i, i % 2 === 0 ? 1 : 0); setFn(i, 6, i % 2 === 0 ? 1 : 0); }

    // 校正图形（跳过与定位图形重叠的位置）
    const centres = ALIGN[version] || [];
    for (const r of centres) for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        setFn(r + dr, c + dc, on ? 1 : 0);
      }
    }

    // 格式信息预留区 + 固定的暗模块
    for (let i = 0; i < 9; i++) { if (!fn[8][i]) setFn(8, i, 0); if (!fn[i][8]) setFn(i, 8, 0); }
    /* 第二份格式信息：右上是一条**横的**（row 8, cols size-1..size-8），
       左下是一条**竖的**（col 8, rows size-8..size-1），两边各 8 格。
       这一对很容易写反 —— 写反了数据区不受影响，但暗模块会顶掉 bit 7，
       于是掩码信息读不对，只有扫描器才知道错。 */
    for (let i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, 0);
      if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, 0);
    }
    setFn(size - 8, 8, 1);
    // 版本信息预留区（v≥7）
    if (version >= 7) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { setFn(size - 11 + j, i, 0); setFn(i, size - 11 + j, 0); }
    }
    return { size, mod, fn, setFn };
  }

  function placeData(m, codewords) {
    const { size, mod, fn } = m;
    let bit = 0;
    const total = codewords.length * 8;
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;                   // 跳过定时图形那一列
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (fn[row][c]) continue;
          let v = 0;
          if (bit < total) v = (codewords[bit >> 3] >> (7 - (bit & 7))) & 1;
          bit++;
          mod[row][c] = v;
        }
      }
      up = !up;
    }
  }

  const maskFn = (k, r, c) => {
    switch (k) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  function applyMask(m, k) {
    const { size, mod, fn } = m;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!fn[r][c] && maskFn(k, r, c)) mod[r][c] ^= 1;
    }
  }

  function placeFormat(m, mask) {
    const { size, setFn } = m;
    const bits = FORMAT_L[mask];
    const bit = i => (bits >> i) & 1;
    /* 标准里的两份格式信息布局（bit 0 是最低位）：
         第一份围着左上定位图形：col 8 的 rows 0..5 / 7 / 8，
                                  row 8 的 cols 7 / 8 / 5..0
         第二份：row 8 的 cols size-1..size-8（右上，横）
                 col 8 的 rows size-8..size-1（左下，竖）
       第 6 行/第 6 列是定时图形，必须跳过去 —— 之前写错过这里，
       结果 (row 8, col 6) 被格式位覆盖，扫码器读不到正确的掩码。 */
    for (let i = 0; i <= 5; i++) setFn(i, 8, bit(i));
    setFn(7, 8, bit(6));
    setFn(8, 8, bit(7));
    setFn(8, 7, bit(8));
    for (let i = 9; i < 15; i++) setFn(8, 14 - i, bit(i));
    for (let i = 0; i < 8; i++) setFn(8, size - 1 - i, bit(i));
    for (let i = 8; i < 15; i++) setFn(size - 15 + i, 8, bit(i));
    setFn(size - 8, 8, 1);   // 暗模块必须始终为 1
  }
  function placeVersion(m, version) {
    if (version < 7) return;
    const { size, setFn } = m;
    const bits = VERSION_BITS[version];
    for (let i = 0; i < 18; i++) {
      const b = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      setFn(size - 11 + c, r, b);
      setFn(r, size - 11 + c, b);
    }
  }

  /* ---------- 罚分 ---------- */
  function penalty(m) {
    const { size, mod } = m;
    let score = 0;
    // 规则 1：同色连续 5 个以上
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (mod[r][c] === mod[r][c - 1]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (mod[r][c] === mod[r - 1][c]) run++;
        else { if (run >= 5) score += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // 规则 2：2×2 同色
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = mod[r][c];
      if (v === mod[r][c + 1] && v === mod[r + 1][c] && v === mod[r + 1][c + 1]) score += 3;
    }
    // 规则 3：类似定位图形的 1011101 0000 序列
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const match = (get, n) => {
      let hits = 0;
      for (let i = 0; i + 11 <= n; i++) {
        let a = true, b = true;
        for (let j = 0; j < 11; j++) { const v = get(i + j); if (v !== P1[j]) a = false; if (v !== P2[j]) b = false; if (!a && !b) break; }
        if (a) hits++; if (b) hits++;
      }
      return hits;
    };
    for (let r = 0; r < size; r++) score += 40 * match(i => mod[r][i], size);
    for (let c = 0; c < size; c++) score += 40 * match(i => mod[i][c], size);
    // 规则 4：黑白比例偏离 50%
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mod[r][c];
    const pct = dark * 100 / (size * size);
    score += 10 * Math.floor(Math.abs(pct - 50) / 5);
    return score;
  }

  /* ---------- 对外：拿矩阵 ---------- */
  function matrix(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    const version = pickVersion(bytes.length);
    if (!version) return null;                       // 太长，装不下（>271 字节）
    const cw = interleave(buildCodewords(bytes, version), version);
    let best = null;
    for (let k = 0; k < 8; k++) {
      const m = makeMatrix(version);
      placeData(m, cw);
      applyMask(m, k);
      placeFormat(m, k);
      placeVersion(m, version);
      const p = penalty(m);
      if (!best || p < best.p) best = { p, m, k };
    }
    return { size: best.m.size, mod: best.m.mod, version, mask: best.k };
  }

  /* ---------- 对外：画到 canvas ---------- */
  function canvas(text, scale, quiet) {
    const q = quiet == null ? 4 : quiet;
    const mk = () => {
      const g = matrix(text);
      if (!g) return null;
      const s = scale || 4;
      const px = (g.size + q * 2) * s;
      const cv = document.createElement('canvas');
      cv.width = px; cv.height = px;
      cv.className = 'ch-qr-cv';
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', '茶室邀请二维码：' + text);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = '#0b0e13';
      for (let r = 0; r < g.size; r++) for (let c = 0; c < g.size; c++) {
        if (g.mod[r][c]) ctx.fillRect((c + q) * s, (r + q) * s, s, s);
      }
      return cv;
    };
    return mk();
  }

  /* ---------- 对外：SVG 字符串（打印/复制用） ---------- */
  function svg(text, scale) {
    const g = matrix(text);
    if (!g) return '';
    const q = 4, s = scale || 4, n = g.size, px = (n + q * 2) * s;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (g.mod[r][c]) d += 'M' + ((c + q) * s) + ' ' + ((r + q) * s) + 'h' + s + 'v' + s + 'h-' + s + 'z';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + px + '" height="' + px + '" viewBox="0 0 ' + px + ' ' + px + '">' +
      '<rect width="' + px + '" height="' + px + '" fill="#fff"/><path d="' + d + '" fill="#0b0e13"/></svg>';
  }

  return { matrix, canvas, svg };
})();
