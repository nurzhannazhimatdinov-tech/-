(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const canvas = $('#game');
  const ctx = canvas.getContext('2d');

  const COLORS = ['#4caf50', '#e53935', '#1e88e5', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#d81b60'];
  const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, BUSH = 4;
  const INTERP_MS = 90;
  const PU = {
    hp: { icon: '✚', color: '#ef5350', name: 'Ремонт' },
    shield: { icon: '◈', color: '#4fc3f7', name: 'Щит' },
    rapid: { icon: '✦', color: '#ffca28', name: 'Скорострельность' },
    speed: { icon: '➤', color: '#66bb6a', name: 'Ускорение' },
  };
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  };

  // ---------------------------------------------------------------------------
  // Состояние клиента
  // ---------------------------------------------------------------------------
  let ws = null;
  let myId = 0;
  let cfg = null;
  let TILE = 32, MW = 0, MH = 0, WORLD_W = 0, WORLD_H = 0;
  let tiles = null;
  let mapLayer = null, mapCtx = null, bushLayer = null, miniLayer = null, miniDirty = true;
  const players = new Map();
  const snaps = [];
  let timeOffset = null;
  const queued = [];
  const particles = [];
  const treadPhase = new Map();
  const cam = { x: 0, y: 0, ready: false };
  let shake = 0;
  let lastMe = null;
  let deathInfo = null;
  let ping = 0;
  let dpr = 1, zoom = 1;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 ||
    (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (isTouch) document.body.classList.add('touch-device');
  let prevHp = -1;
  let chosenColor = store.get('tanks.color') || COLORS[0];
  let muted = store.get('tanks.muted') === '1';

  // ---------------------------------------------------------------------------
  // Меню
  // ---------------------------------------------------------------------------
  const nameInput = $('#name');
  nameInput.value = store.get('tanks.name') || '';

  const colorsBox = $('#colors');
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.setProperty('--c', c);
    b.setAttribute('aria-label', 'Цвет ' + c);
    if (c === chosenColor) b.classList.add('active');
    b.onclick = () => {
      chosenColor = c;
      for (const x of colorsBox.children) x.classList.toggle('active', x === b);
    };
    colorsBox.appendChild(b);
  }
  if (!COLORS.includes(chosenColor)) { chosenColor = COLORS[0]; colorsBox.firstChild.classList.add('active'); }

  fetch('/api/stats')
    .then((r) => r.json())
    .then((s) => {
      $('#online').innerHTML = s.players > 0
        ? `Сейчас в бою: <b>${s.players}</b> ${plural(s.players, 'игрок', 'игрока', 'игроков')}`
        : 'Сервер свободен — начни первым!';
    })
    .catch(() => {});

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  $('#play').onclick = start;
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });

  function start() {
    const name = nameInput.value.trim() || 'Танкист';
    store.set('tanks.name', name);
    store.set('tanks.color', chosenColor);
    initAudio();
    if (isTouch) enterFullscreen();
    const btn = $('#play');
    btn.disabled = true;
    btn.textContent = 'ПОДКЛЮЧЕНИЕ…';

    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    ws.onopen = () => send({ t: 'join', name, color: chosenColor });
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (myId) { $('#lost').hidden = false; return; }
      btn.disabled = false;
      btn.textContent = 'В БОЙ!';
      const o = $('#online');
      o.classList.add('error');
      o.textContent = 'Не удалось подключиться к серверу';
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // ---------------------------------------------------------------------------
  // Сообщения сервера
  // ---------------------------------------------------------------------------
  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        myId = m.id;
        cfg = m;
        TILE = m.tile; MW = m.mw; MH = m.mh;
        WORLD_W = MW * TILE; WORLD_H = MH * TILE;
        tiles = Uint8Array.from(m.map, (c) => c.charCodeAt(0) - 48);
        buildLayers();
        $('#menu').hidden = true;
        $('#hud').hidden = false;
        setupTouch();
        setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);
        break;
      case 's': onSnapshot(m); break;
      case 'i':
        players.clear();
        for (const p of m.pl) players.set(p[0], { id: p[0], name: p[1], color: p[2], score: p[3], deaths: p[4], bot: !!p[5] });
        renderBoard();
        break;
      case 'c': addChat(m.n, m.c, m.m); break;
      case 'pong': ping = Math.round(performance.now() - m.c); break;
      case 'full': alert('Сервер заполнен, попробуйте позже.'); break;
    }
  }

  function onSnapshot(m) {
    const now = performance.now();
    const st = m.tm * 1000;
    const off = st - now;
    if (timeOffset === null || Math.abs(off - timeOffset) > 500) timeOffset = off;
    else timeOffset += (off - timeOffset) * 0.05;

    const tanks = new Map();
    for (const k of m.k) tanks.set(k[0], { id: k[0], x: k[1], y: k[2], d: k[3], hp: k[4], f: k[5] });
    const bullets = new Map();
    for (const b of m.b) bullets.set(b[0], { x: b[1], y: b[2] });
    snaps.push({ t: st, tanks, bullets, pu: m.p });
    if (snaps.length > 60) snaps.shift();
    for (const e of m.e) queued.push([st, e]);
  }

  // ---------------------------------------------------------------------------
  // Интерполяция снапшотов
  // ---------------------------------------------------------------------------
  function buildView(rt) {
    if (!snaps.length) return null;
    while (snaps.length >= 3 && snaps[1].t <= rt) snaps.shift();
    const a = snaps[0];
    const b = snaps[1] || a;
    const k = b === a ? 1 : Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));

    const tanks = [];
    for (const tb of b.tanks.values()) {
      const ta = a.tanks.get(tb.id);
      if (ta && (ta.f & 1) && (tb.f & 1) && Math.abs(ta.x - tb.x) + Math.abs(ta.y - tb.y) < 60) {
        tanks.push({
          id: tb.id, x: ta.x + (tb.x - ta.x) * k, y: ta.y + (tb.y - ta.y) * k,
          d: k < 0.5 ? ta.d : tb.d, hp: tb.hp, f: tb.f,
        });
      } else {
        tanks.push(k < 0.5 && ta ? ta : tb);
      }
    }
    const bullets = [];
    for (const [id, bb] of b.bullets) {
      const ba = a.bullets.get(id);
      bullets.push(ba ? { x: ba.x + (bb.x - ba.x) * k, y: ba.y + (bb.y - ba.y) * k } : bb);
    }
    return { tanks, bullets, pu: b.pu };
  }

  function processEvents(rt) {
    while (queued.length && queued[0][0] <= rt) handleEvent(queued.shift()[1]);
    // не даём очереди разрастись, если вкладка была неактивна
    if (queued.length > 400) { for (const q of queued.splice(0)) if (q[1][0] === 't') handleEvent(q[1]); }
  }

  function handleEvent(e) {
    switch (e[0]) {
      case 'sh': { // выстрел
        const [dx, dy] = DIRS[e[3]];
        particles.push({ type: 'flash', x: e[1], y: e[2], life: 0.08, max: 0.08, size: 9 });
        for (let i = 0; i < 3; i++) {
          particles.push({ type: 'smoke', x: e[1], y: e[2], vx: dx * 30 + rnd(-15, 15), vy: dy * 30 + rnd(-15, 15), life: 0.4, max: 0.4, size: 3 });
        }
        sfx('shot', e[1], e[2]);
        break;
      }
      case 'w': // попадание в стену
        sparks(e[1], e[2], e[3] === STEEL ? '#cfd8dc' : '#ff8a50', 6);
        if (e[3] === BRICK) for (let i = 0; i < 5; i++) particles.push({ type: 'debris', x: e[1], y: e[2], vx: rnd(-80, 80), vy: rnd(-80, 80), life: 0.5, max: 0.5, size: 3, color: '#b5532a', rot: rnd(0, 6) });
        sfx(e[3] === STEEL ? 'clink' : 'hit', e[1], e[2]);
        break;
      case 't': setTile(e[1], e[2]); break;
      case 'h': // попадание в танк
        sparks(e[1], e[2], e[3] ? '#4fc3f7' : '#ffd54f', 10);
        sfx(e[3] ? 'clink' : 'hit', e[1], e[2]);
        break;
      case 'bb':
        sparks(e[1], e[2], '#fff59d', 8);
        sfx('clink', e[1], e[2]);
        break;
      case 'bm':
        explode(e[1], e[2]);
        sfx('boom', e[1], e[2]);
        if (cam.ready) shake = Math.max(shake, Math.max(0, 12 - Math.hypot(e[1] - cam.x, e[2] - cam.y) / 40));
        break;
      case 'k':
        addKill(e[1], e[2], e[3], e[4]);
        if (e[6] === myId) {
          deathInfo = { by: e[5] === myId ? null : e[1], color: e[2], at: performance.now() };
          vibrate([80, 40, 160]);
        } else if (e[5] === myId) {
          toast('+1 УНИЧТОЖЕН ' + e[3]);
          vibrate(30);
        }
        break;
      case 'pk':
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2;
          particles.push({ type: 'spark', x: e[1], y: e[2], vx: Math.cos(a) * 90, vy: Math.sin(a) * 90, life: 0.45, max: 0.45, size: 2.5, color: PU[e[3]].color });
        }
        sfx('pick', e[1], e[2]);
        if (e[4] === myId) toast(PU[e[3]].name);
        break;
      case 'sp':
        particles.push({ type: 'ring', x: e[1], y: e[2], life: 0.5, max: 0.5, size: 30, color: '#ffffff' });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Карта
  // ---------------------------------------------------------------------------
  function hash(x, y, s = 0) {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function buildLayers() {
    mapLayer = document.createElement('canvas');
    mapLayer.width = WORLD_W; mapLayer.height = WORLD_H;
    mapCtx = mapLayer.getContext('2d');
    bushLayer = document.createElement('canvas');
    bushLayer.width = WORLD_W; bushLayer.height = WORLD_H;
    const bctx = bushLayer.getContext('2d');
    for (let ty = 0; ty < MH; ty++) {
      for (let tx = 0; tx < MW; tx++) {
        const v = tiles[ty * MW + tx];
        drawTile(mapCtx, tx, ty, v);
        if (v === BUSH) drawBush(bctx, tx, ty);
      }
    }
    miniLayer = document.createElement('canvas');
    miniDirty = true;
  }

  function setTile(idx, v) {
    tiles[idx] = v;
    drawTile(mapCtx, idx % MW, Math.floor(idx / MW), v);
    miniDirty = true;
  }

  function drawTile(c, tx, ty, v) {
    const x = tx * TILE, y = ty * TILE;
    // земля
    const g = hash(tx, ty);
    c.fillStyle = g < 0.5 ? '#232a1c' : '#20271a';
    c.fillRect(x, y, TILE, TILE);
    for (let i = 0; i < 4; i++) {
      c.fillStyle = hash(tx, ty, i + 1) < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
      c.fillRect(x + Math.floor(hash(tx, ty, i + 10) * 30), y + Math.floor(hash(tx, ty, i + 20) * 30), 2, 2);
    }

    if (v === BRICK) {
      c.fillStyle = '#5a2412';
      c.fillRect(x, y, TILE, TILE);
      for (let r = 0; r < 4; r++) {
        const off = r % 2 ? 8 : 0;
        for (let bx = -off; bx < TILE; bx += 16) {
          const x0 = Math.max(0, bx + 1), x1 = Math.min(TILE, bx + 15);
          if (x1 <= x0) continue;
          c.fillStyle = hash(tx * 7 + bx, ty * 5 + r) < 0.5 ? '#b24f27' : '#a5461f';
          c.fillRect(x + x0, y + r * 8 + 1, x1 - x0, 6);
          c.fillStyle = 'rgba(255,190,140,0.25)';
          c.fillRect(x + x0, y + r * 8 + 1, x1 - x0, 1);
        }
      }
    } else if (v === STEEL) {
      c.fillStyle = '#3e4449';
      c.fillRect(x, y, TILE, TILE);
      for (let q = 0; q < 4; q++) {
        const px = x + (q % 2) * 16, py = y + Math.floor(q / 2) * 16;
        c.fillStyle = '#8c959c'; c.fillRect(px + 1, py + 1, 14, 14);
        c.fillStyle = '#c3cbd1'; c.fillRect(px + 1, py + 1, 14, 2); c.fillRect(px + 1, py + 1, 2, 14);
        c.fillStyle = '#5b6368'; c.fillRect(px + 1, py + 13, 14, 2); c.fillRect(px + 13, py + 1, 2, 14);
        c.fillStyle = '#a9b2b8'; c.fillRect(px + 6, py + 6, 4, 4);
      }
    } else if (v === WATER) {
      c.fillStyle = '#1a4a73';
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = '#1f5684';
      c.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
    }
  }

  function drawBush(c, tx, ty) {
    const x = tx * TILE, y = ty * TILE;
    const shades = ['#1f5e2b', '#2b7a37', '#3a9444', '#256b30'];
    for (let i = 0; i < 9; i++) {
      c.fillStyle = shades[Math.floor(hash(tx, ty, i + 40) * shades.length)];
      c.beginPath();
      c.arc(x + 5 + hash(tx, ty, i + 50) * 22, y + 5 + hash(tx, ty, i + 60) * 22, 7 + hash(tx, ty, i + 70) * 5, 0, Math.PI * 2);
      c.fill();
    }
    for (let i = 0; i < 5; i++) {
      c.fillStyle = 'rgba(160,230,140,0.35)';
      c.fillRect(x + 3 + hash(tx, ty, i + 80) * 26, y + 3 + hash(tx, ty, i + 90) * 26, 2, 2);
    }
  }

  function scorch(x, y) {
    const g = mapCtx.createRadialGradient(x, y, 0, x, y, 26);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    mapCtx.fillStyle = g;
    mapCtx.fillRect(x - 26, y - 26, 52, 52);
  }

  function tileAtPx(x, y) {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return STEEL;
    return tiles[ty * MW + tx];
  }

  // ---------------------------------------------------------------------------
  // Эффекты
  // ---------------------------------------------------------------------------
  const rnd = (a, b) => a + Math.random() * (b - a);

  function sparks(x, y, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = rnd(40, 160);
      particles.push({ type: 'spark', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.15, 0.35), max: 0.35, size: rnd(1.5, 2.5), color });
    }
  }

  function explode(x, y) {
    scorch(x, y);
    particles.push({ type: 'flash', x, y, life: 0.2, max: 0.2, size: 50 });
    particles.push({ type: 'ring', x, y, life: 0.45, max: 0.45, size: 60, color: '#ffcc80' });
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * Math.PI * 2, s = rnd(20, 140);
      particles.push({ type: 'fire', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.3, 0.7), max: 0.7, size: rnd(3, 7) });
    }
    for (let i = 0; i < 12; i++) {
      particles.push({ type: 'smoke', x: x + rnd(-10, 10), y: y + rnd(-10, 10), vx: rnd(-20, 20), vy: rnd(-30, 5), life: rnd(0.8, 1.6), max: 1.6, size: rnd(6, 12) });
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, s = rnd(60, 200);
      particles.push({ type: 'debris', x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rnd(0.4, 0.9), max: 0.9, size: rnd(2, 4), color: '#2a2a2a', rot: rnd(0, 6) });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      if (p.vx !== undefined) {
        p.x += p.vx * dt; p.y += p.vy * dt;
        const drag = p.type === 'smoke' ? 0.97 : 0.92;
        p.vx *= drag; p.vy *= drag;
      }
      if (p.rot !== undefined) p.rot += dt * 8;
    }
    if (particles.length > 800) particles.splice(0, particles.length - 800);
  }

  function drawParticles() {
    for (const p of particles) {
      const k = p.life / p.max;
      switch (p.type) {
        case 'spark':
          ctx.globalAlpha = Math.min(1, k * 1.5);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
          break;
        case 'fire':
          ctx.globalAlpha = Math.min(1, k * 1.4);
          ctx.fillStyle = k > 0.6 ? '#fff3b0' : k > 0.35 ? '#ffb74d' : '#e65100';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.6), 0, Math.PI * 2); ctx.fill();
          break;
        case 'smoke':
          ctx.globalAlpha = k * 0.35;
          ctx.fillStyle = '#555';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.8 - k), 0, Math.PI * 2); ctx.fill();
          break;
        case 'flash':
          ctx.globalAlpha = k;
          ctx.fillStyle = '#fffde7';
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1.2 - k * 0.4), 0, Math.PI * 2); ctx.fill();
          break;
        case 'ring':
          ctx.globalAlpha = k * 0.8;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = 3 * k + 0.5;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (1 - k) + 4, 0, Math.PI * 2); ctx.stroke();
          break;
        case 'debris':
          ctx.globalAlpha = Math.min(1, k * 2);
          ctx.fillStyle = p.color;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
          ctx.restore();
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------
  // Отрисовка
  // ---------------------------------------------------------------------------
  const shadeCache = new Map();
  function shade(hex, p) {
    const key = hex + p;
    let v = shadeCache.get(key);
    if (v) return v;
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    const t = p < 0 ? 0 : 255, a = Math.abs(p);
    r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
    v = `rgb(${r},${g},${b})`;
    shadeCache.set(key, v);
    return v;
  }

  function drawTank(t, color, phase) {
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate((t.d * Math.PI) / 2);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(-11, -10, 27, 27);

    // гусеницы
    ctx.fillStyle = '#161616';
    ctx.fillRect(-13, -13, 8, 26);
    ctx.fillRect(5, -13, 8, 26);
    ctx.fillStyle = '#4b4b4b';
    const off = (phase * 40) % 5;
    for (let yy = -13 - 5 + off; yy < 13; yy += 5) {
      const y0 = Math.max(-13, yy), y1 = Math.min(13, yy + 2);
      if (y1 <= y0) continue;
      ctx.fillRect(-12, y0, 6, y1 - y0);
      ctx.fillRect(6, y0, 6, y1 - y0);
    }

    // корпус
    ctx.fillStyle = shade(color, -0.45);
    ctx.fillRect(-7, -11, 14, 23);
    ctx.fillStyle = color;
    ctx.fillRect(-6, -10, 12, 21);
    ctx.fillStyle = shade(color, 0.3);
    ctx.fillRect(-6, -10, 12, 2);

    // ствол
    ctx.fillStyle = shade(color, -0.55);
    ctx.fillRect(-2, -19, 4, 16);
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(-2.5, -20, 5, 3);

    // башня
    ctx.fillStyle = shade(color, -0.35);
    ctx.beginPath(); ctx.arc(0, 1, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade(color, 0.15);
    ctx.beginPath(); ctx.arc(-1, 0, 4, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function drawPowerup(p, now) {
    const [, x, y, type] = p;
    const info = PU[type];
    const bob = Math.sin(now / 250 + p[0]) * 2;
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(now / 200);
    ctx.fillStyle = info.color;
    ctx.beginPath(); ctx.arc(0, 0, 15, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#12160f';
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 2;
    roundRect(-11, -11, 22, 22, 5);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = info.color;
    ctx.font = '14px "Segoe UI Symbol", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(info.icon, 0, 1);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawWater(x0, y0, x1, y1, now) {
    ctx.strokeStyle = 'rgba(140,200,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (tiles[ty * MW + tx] !== WATER) continue;
        const px = tx * TILE, py = ty * TILE;
        for (let r = 0; r < 2; r++) {
          const yy = py + 10 + r * 12;
          const ph = now / 400 + tx * 0.8 + r * 2;
          const xs = px + 5 + (Math.sin(ph) + 1) * 4;
          ctx.moveTo(xs, yy);
          ctx.quadraticCurveTo(xs + 4, yy - 3, xs + 8, yy);
          ctx.quadraticCurveTo(xs + 12, yy + 3, xs + 16, yy);
        }
      }
    }
    ctx.stroke();
  }

  function drawMinimap(view, vx, vy, vw, vh) {
    const S = isTouch || innerWidth < 640 ? 2 : 3;
    if (miniDirty || miniLayer.width !== MW * S) {
      miniDirty = false;
      miniLayer.width = MW * S; miniLayer.height = MH * S;
      const m = miniLayer.getContext('2d');
      m.fillStyle = '#1b2016';
      m.fillRect(0, 0, miniLayer.width, miniLayer.height);
      const col = { [BRICK]: '#9a4422', [STEEL]: '#8c959c', [WATER]: '#1f5684', [BUSH]: '#2b6a33' };
      for (let i = 0; i < tiles.length; i++) {
        const v = tiles[i];
        if (!v) continue;
        m.fillStyle = col[v];
        m.fillRect((i % MW) * S, Math.floor(i / MW) * S, S, S);
      }
    }
    const ox = 12, oy = 12;
    const k = S / TILE;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(ox - 3, oy - 3, miniLayer.width + 6, miniLayer.height + 6);
    ctx.drawImage(miniLayer, ox, oy);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + Math.max(0, vx * k), oy + Math.max(0, vy * k), Math.min(vw * k, MW * S), Math.min(vh * k, MH * S));
    if (!view) return;
    for (const t of view.tanks) {
      if (!(t.f & 1)) continue;
      const me = t.id === myId;
      if (!me && tileAtPx(t.x, t.y) === BUSH) continue;
      const p = players.get(t.id);
      ctx.fillStyle = me ? '#ffffff' : p ? p.color : '#aaa';
      const s = me ? 5 : 4;
      ctx.fillRect(ox + t.x * k - s / 2, oy + t.y * k - s / 2, s, s);
    }
    for (const p of view.pu) {
      ctx.fillStyle = PU[p[3]].color;
      ctx.fillRect(ox + p[1] * k - 1.5, oy + p[2] * k - 1.5, 3, 3);
    }
  }

  function draw(view, me, now, dt) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d09';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const sc = dpr * zoom;
    const vw = canvas.width / sc, vh = canvas.height / sc;
    const target = me && (me.f & 1) ? me : lastMe;
    if (target) {
      if (!cam.ready) { cam.x = target.x; cam.y = target.y; cam.ready = true; }
      const f = Math.min(1, dt * 8);
      cam.x += (target.x - cam.x) * f;
      cam.y += (target.y - cam.y) * f;
    }
    const clampAxis = (c, world, view) => (view >= world ? (world - view) / 2 : Math.max(0, Math.min(world - view, c - view / 2)));
    const vx = clampAxis(cam.x, WORLD_W, vw);
    const vy = clampAxis(cam.y, WORLD_H, vh);

    let sx = 0, sy = 0;
    if (shake > 0.1) {
      sx = rnd(-shake, shake); sy = rnd(-shake, shake);
      shake *= Math.pow(0.02, dt);
    } else shake = 0;

    ctx.setTransform(sc, 0, 0, sc, Math.round((-vx + sx) * sc), Math.round((-vy + sy) * sc));
    ctx.drawImage(mapLayer, 0, 0);

    const tx0 = Math.max(0, Math.floor(vx / TILE)), ty0 = Math.max(0, Math.floor(vy / TILE));
    const tx1 = Math.min(MW - 1, Math.floor((vx + vw) / TILE)), ty1 = Math.min(MH - 1, Math.floor((vy + vh) / TILE));
    drawWater(tx0, ty0, tx1, ty1, now);

    if (view) {
      for (const p of view.pu) drawPowerup(p, now);

      for (const t of view.tanks) {
        if (!(t.f & 1)) continue;
        const p = players.get(t.id);
        const phase = (treadPhase.get(t.id) || 0) + (t.f & 4 ? dt : 0);
        treadPhase.set(t.id, phase);
        drawTank(t, p ? p.color : '#9e9e9e', phase);
        if (t.f & 2) {
          ctx.strokeStyle = `rgba(79,195,247,${0.55 + 0.3 * Math.sin(now / 90)})`;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(t.x, t.y, 21, 0, Math.PI * 2); ctx.stroke();
        }
        if (t.f & 16 && t.f & 4) {
          const [dx, dy] = DIRS[t.d];
          if (Math.random() < 0.5) particles.push({ type: 'smoke', x: t.x - dx * 14, y: t.y - dy * 14, vx: rnd(-10, 10), vy: rnd(-10, 10), life: 0.4, max: 0.4, size: 3 });
        }
      }

      for (const b of view.bullets) {
        ctx.fillStyle = 'rgba(255,220,120,0.35)';
        ctx.beginPath(); ctx.arc(b.x, b.y, 6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff8e1';
        ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }

    drawParticles();
    ctx.drawImage(bushLayer, 0, 0);

    // имена и здоровье
    if (view) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '10px "Russo One", sans-serif';
      ctx.lineJoin = 'round';
      for (const t of view.tanks) {
        if (!(t.f & 1)) continue;
        const mine = t.id === myId;
        if (!mine && tileAtPx(t.x, t.y) === BUSH) continue;
        const p = players.get(t.id);
        const name = p ? p.name : '';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(name, t.x, t.y - 26);
        ctx.fillStyle = mine ? '#f5c542' : '#ffffff';
        ctx.fillText(name, t.x, t.y - 26);
        const max = cfg.maxHp;
        for (let i = 0; i < max; i++) {
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(t.x - 15 + i * 10.3, t.y - 22, 9.3, 4);
          if (i < t.hp) {
            ctx.fillStyle = t.hp === 1 ? '#ef5350' : t.hp === 2 ? '#ffca28' : '#66bb6a';
            ctx.fillRect(t.x - 14 + i * 10.3, t.y - 21, 7.3, 2);
          }
        }
      }
    }

    drawMinimap(view, vx, vy, vw, vh);
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const hud = { hearts: '', score: '', buffs: '', ping: '' };

  function setHtml(id, key, html) {
    if (hud[key] === html) return;
    hud[key] = html;
    $(id).innerHTML = html;
  }

  function updateHud(me, now) {
    const pl = players.get(myId);
    const hp = me && (me.f & 1) ? me.hp : 0;
    if (hp > 0 && prevHp > hp) vibrate(60);
    prevHp = hp;
    let hearts = '';
    for (let i = 0; i < (cfg.maxHp || 3); i++) hearts += i < hp ? '♥' : '<span class="off">♥</span>';
    setHtml('#hearts', 'hearts', hearts);
    if (pl) setHtml('#score', 'score', `Фраги: ${pl.score} · Смерти: ${pl.deaths}`);
    let buffs = '';
    if (me && (me.f & 1)) {
      if (me.f & 2) buffs += `<span style="--c:${PU.shield.color}">Щит</span>`;
      if (me.f & 8) buffs += `<span style="--c:${PU.rapid.color}">Огонь+</span>`;
      if (me.f & 16) buffs += `<span style="--c:${PU.speed.color}">Скорость+</span>`;
    }
    setHtml('#buffs', 'buffs', buffs);
    setHtml('#ping', 'ping', `${ping} мс${muted ? ' · 🔇' : ''}`);

    const dead = me && !(me.f & 1);
    $('#dead').hidden = !dead;
    if (dead) {
      const left = deathInfo ? Math.max(0, cfg.respawn - (now - deathInfo.at) / 1000) : cfg.respawn;
      $('#respawn').textContent = `Возрождение через ${left.toFixed(1)} с`;
      const by = $('#deadBy');
      if (deathInfo && deathInfo.by) {
        if (by.dataset.by !== deathInfo.by) {
          by.dataset.by = deathInfo.by;
          by.textContent = '';
          const s = document.createElement('span');
          s.style.color = deathInfo.color;
          s.textContent = deathInfo.by;
          by.append('Вас подбил ', s);
        }
      } else if (by.dataset.by !== '') { by.dataset.by = ''; by.textContent = ''; }
    }
  }

  function renderBoard() {
    const list = [...players.values()].sort((a, b) => b.score - a.score || a.deaths - b.deaths);
    const ol = $('#boardList');
    ol.textContent = '';
    const limit = isTouch ? 5 : 8;
    list.forEach((p, i) => {
      if (i >= limit && p.id !== myId) return;
      const li = document.createElement('li');
      if (p.id === myId) li.className = 'me';
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
      const nm = document.createElement('span'); nm.className = 'nm' + (p.bot ? ' bot' : ''); nm.textContent = p.name;
      const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = p.score;
      li.append(rank, dot, nm, sc);
      ol.appendChild(li);
    });
    const humans = list.filter((p) => !p.bot).length;
    $('#boardCount').textContent = `👤 ${humans}`;
  }

  function addKill(kn, kc, vn, vc) {
    const box = $('#killfeed');
    const d = document.createElement('div');
    const a = document.createElement('span'); a.style.color = kc; a.textContent = kn;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '💥';
    const b = document.createElement('span'); b.style.color = vc; b.textContent = vn;
    d.append(a, x, b);
    box.appendChild(d);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => d.remove(), 6000);
  }

  function addChat(name, color, msg) {
    const log = $('#chatlog');
    const d = document.createElement('div');
    if (!name) {
      d.className = 'sys';
      d.textContent = msg;
    } else {
      const n = document.createElement('span');
      n.style.color = color;
      n.textContent = name + ': ';
      d.append(n, msg);
    }
    log.appendChild(d);
    while (log.children.length > 6) log.firstChild.remove();
    setTimeout(() => d.remove(), 13000);
  }

  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1700);
  }

  // ---------------------------------------------------------------------------
  // Звук (синтез через WebAudio)
  // ---------------------------------------------------------------------------
  let actx = null, master = null, noiseBuf = null;

  function initAudio() {
    if (actx) return;
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      master = actx.createGain();
      master.gain.value = 0.3;
      master.connect(actx.destination);
      noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch { actx = null; }
  }

  function sfx(type, x, y) {
    if (!actx || muted) return;
    let vol = 1;
    if (x !== undefined && cam.ready) {
      vol = 1 - Math.hypot(x - cam.x, y - cam.y) / 800;
      if (vol <= 0.03) return;
    }
    const t = actx.currentTime;
    const g = actx.createGain();
    g.connect(master);

    const noise = (dur, filterType, freq, gain) => {
      const s = actx.createBufferSource();
      s.buffer = noiseBuf;
      const f = actx.createBiquadFilter();
      f.type = filterType; f.frequency.value = freq;
      g.gain.setValueAtTime(gain * vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f); f.connect(g);
      s.start(t, Math.random() * 0.5); s.stop(t + dur);
      return f;
    };
    const tone = (wave, f0, f1, dur, gain, delay = 0) => {
      const o = actx.createOscillator();
      const og = actx.createGain();
      o.type = wave;
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.setValueAtTime(gain * vol, t + delay);
      og.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      o.connect(og); og.connect(master);
      o.start(t + delay); o.stop(t + delay + dur + 0.02);
    };

    switch (type) {
      case 'shot':
        tone('square', 380, 70, 0.12, 0.18);
        noise(0.08, 'highpass', 1500, 0.25);
        break;
      case 'hit': noise(0.12, 'bandpass', 900, 0.5); break;
      case 'clink': tone('triangle', 1800, 900, 0.08, 0.2); break;
      case 'boom': {
        const f = noise(0.9, 'lowpass', 900, 1.1);
        f.frequency.setValueAtTime(900, t);
        f.frequency.exponentialRampToValueAtTime(50, t + 0.9);
        tone('sine', 110, 30, 0.5, 0.5);
        break;
      }
      case 'pick':
        tone('sine', 523, 523, 0.1, 0.25);
        tone('sine', 659, 659, 0.1, 0.25, 0.08);
        tone('sine', 988, 988, 0.18, 0.25, 0.16);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Управление
  // ---------------------------------------------------------------------------
  const KEY_DIR = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
  const dirStack = [];
  let fireKey = false, touchDir = -1, touchFire = false;
  let lastInput = '';
  const chatInput = $('#chatInput');

  function toggleMute() {
    muted = !muted;
    store.set('tanks.muted', muted ? '1' : '0');
    toast(muted ? 'Звук выключен' : 'Звук включён');
  }

  function releaseKeys() { dirStack.length = 0; fireKey = false; }

  window.addEventListener('keydown', (e) => {
    if (!cfg || e.target === chatInput) return;
    if (e.code in KEY_DIR) {
      if (!dirStack.includes(e.code)) dirStack.push(e.code);
      e.preventDefault();
    } else if (e.code === 'Space' || e.code === 'KeyJ') {
      fireKey = true;
      e.preventDefault();
    } else if (e.code === 'Enter') {
      openChat();
      e.preventDefault();
    } else if (e.code === 'KeyM') {
      toggleMute();
    }
  });
  window.addEventListener('keyup', (e) => {
    const i = dirStack.indexOf(e.code);
    if (i >= 0) dirStack.splice(i, 1);
    if (e.code === 'Space' || e.code === 'KeyJ') fireKey = false;
  });
  window.addEventListener('blur', releaseKeys);

  function openChat() {
    releaseKeys();
    chatInput.hidden = false;
    chatInput.focus();
  }
  function closeChat() {
    chatInput.value = '';
    chatInput.hidden = true;
    chatInput.blur();
  }
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const m = chatInput.value.trim();
      if (m) send({ t: 'chat', m });
      closeChat();
    } else if (e.key === 'Escape') closeChat();
  });
  chatInput.addEventListener('blur', () => { if (isTouch && !chatInput.value) chatInput.hidden = true; });

  function sendInput() {
    if (!myId) return;
    const d = dirStack.length ? KEY_DIR[dirStack[dirStack.length - 1]] : touchDir;
    const f = fireKey || touchFire ? 1 : 0;
    const key = d + ':' + f;
    if (key === lastInput) return;
    lastInput = key;
    send({ t: 'in', d, f });
  }

  function vibrate(ms) {
    if (isTouch && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* не поддерживается */ }
  }

  function isFullscreen() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  function enterFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req || isFullscreen()) return;
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      if (p && p.then) {
        p.then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape').catch(() => {}))
          .catch(() => {});
      }
    } catch { /* например, iPhone без поддержки */ }
  }

  function toggleFullscreen() {
    if (isFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else enterFullscreen();
  }

  function setupTouch() {
    if (!isTouch) return;
    document.body.classList.add('touch');
    $('#touch').hidden = false;
    renderBoard();

    // ---- джойстик: появляется там, где коснулись левой половины экрана
    const zone = $('#stickZone'), stick = $('#stick'), knob = $('#knob');
    const arrows = [];
    for (let d = 0; d < 4; d++) {
      const a = document.createElement('div');
      a.className = 'arrow a' + d;
      stick.appendChild(a);
      arrows.push(a);
    }
    let stickId = null, cx = 0, cy = 0;

    const showDir = () => arrows.forEach((a, d) => a.classList.toggle('on', d === touchDir));

    const moveStick = (e) => {
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy), max = stick.offsetWidth / 2 - 8;
      if (len > max) {
        // палец ушёл далеко — джойстик «едет» за ним
        cx += (dx / len) * (len - max);
        cy += (dy / len) * (len - max);
        stick.style.left = cx - stick.offsetWidth / 2 + 'px';
        stick.style.top = cy - stick.offsetHeight / 2 + 'px';
        dx = (dx / len) * max; dy = (dy / len) * max;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;

      let dir = -1;
      if (len >= 16) {
        const ax = Math.abs(dx), ay = Math.abs(dy);
        dir = ax > ay ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        // гистерезис у диагонали, чтобы танк не дёргался между направлениями
        if (touchDir >= 0 && Math.abs(ax - ay) < len * 0.3) {
          const keepX = touchDir % 2 === 1;
          if (keepX && Math.sign(dx) === (touchDir === 1 ? 1 : -1)) dir = touchDir;
          if (!keepX && Math.sign(dy) === (touchDir === 2 ? 1 : -1)) dir = touchDir;
        }
      }
      if (dir !== touchDir) {
        touchDir = dir;
        showDir();
        if (dir >= 0) vibrate(8);
      }
    };

    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      touchDir = -1;
      showDir();
      knob.style.transform = '';
      stick.classList.remove('active');
      stick.style.left = stick.style.top = '';
    };

    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      cx = e.clientX; cy = e.clientY;
      stick.style.left = cx - stick.offsetWidth / 2 + 'px';
      stick.style.top = cy - stick.offsetHeight / 2 + 'px';
      stick.classList.add('active');
      moveStick(e);
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    // ---- стрельба
    const fire = $('#fireBtn'), auto = $('#autoBtn');
    let fireHeld = false, autoFire = false;
    const syncFire = () => {
      touchFire = fireHeld || autoFire;
      fire.classList.toggle('on', fireHeld);
    };
    fire.addEventListener('pointerdown', (e) => {
      fireHeld = true;
      fire.setPointerCapture(e.pointerId);
      syncFire();
      vibrate(12);
      e.preventDefault();
    });
    const fireOff = () => { fireHeld = false; syncFire(); };
    fire.addEventListener('pointerup', fireOff);
    fire.addEventListener('pointercancel', fireOff);

    auto.addEventListener('pointerdown', (e) => {
      autoFire = !autoFire;
      auto.classList.toggle('on', autoFire);
      syncFire();
      toast(autoFire ? 'Автоогонь включён' : 'Автоогонь выключен');
      vibrate(15);
      e.preventDefault();
    });

    // ---- кнопки
    const soundBtn = $('#soundBtn');
    const syncSound = () => { soundBtn.textContent = muted ? '🔇' : '🔊'; };
    syncSound();
    soundBtn.addEventListener('click', () => { toggleMute(); syncSound(); });
    $('#chatBtn').addEventListener('click', openChat);
    $('#fsBtn').addEventListener('click', toggleFullscreen);

    document.addEventListener('contextmenu', (e) => e.preventDefault());
    // блокируем зум двойным тапом и жестами (iOS Safari)
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());

    if (innerHeight > innerWidth) setTimeout(() => toast('Поверните телефон горизонтально'), 600);
  }

  // ---------------------------------------------------------------------------
  // Главный цикл
  // ---------------------------------------------------------------------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    zoom = Math.max(0.55, Math.min(1.5, Math.min(innerWidth / 1000, innerHeight / 680)));
  }
  window.addEventListener('resize', resize);
  resize();

  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!cfg) return;

    sendInput();
    const rt = timeOffset === null ? 0 : now + timeOffset - INTERP_MS;
    processEvents(rt);
    const view = buildView(rt);
    const me = view ? view.tanks.find((t) => t.id === myId) : null;
    if (me && (me.f & 1)) lastMe = me;
    updateParticles(dt);
    draw(view, me, now, dt);
    updateHud(me, now);
  }
  requestAnimationFrame(frame);
})();
