'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Настройки игры
// ---------------------------------------------------------------------------
const TILE = 32;
const MW = 50, MH = 38;
const WORLD_W = MW * TILE, WORLD_H = MH * TILE;
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, BUSH = 4;

const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const SEND_EVERY = 2;            // 30 снапшотов в секунду
const HALF = 13;                 // половина размера танка
const TANK_SPEED = 115;
const BULLET_SPEED = 400;
const BULLET_R = 3;
const RELOAD = 0.5;
const MAX_HP = 3;
const RESPAWN_TIME = 3;
const SPAWN_SHIELD = 2.5;
const BRICK_REGEN = 40;
const MIN_TANKS = 6;             // боты добавляются, пока танков меньше
const MAX_PLAYERS = 24;
const POWERUP_MAX = 5, POWERUP_EVERY = 7, POWERUP_LIFE = 25;
const POWERUPS = ['hp', 'shield', 'rapid', 'speed'];
const BUFF_TIME = 10, SHIELD_TIME = 6;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const COLORS = ['#4caf50', '#e53935', '#1e88e5', '#fdd835', '#8e24aa', '#fb8c00', '#00acc1', '#d81b60'];
const BOT_NAMES = ['Бот Вася', 'Бот Петя', 'Бот Гриша', 'Бот Толя', 'Бот Зина', 'Бот Федя',
  'Бот Маша', 'Бот Жора', 'Бот Лёва', 'Бот Нина'];

const rand = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rand(arr.length)];

// ---------------------------------------------------------------------------
// Карта
// ---------------------------------------------------------------------------
const tiles = new Uint8Array(MW * MH);
const brickRegen = new Map(); // индекс клетки -> время восстановления

function genMap() {
  tiles.fill(EMPTY);
  brickRegen.clear();
  for (let x = 0; x < MW; x++) { tiles[x] = STEEL; tiles[(MH - 1) * MW + x] = STEEL; }
  for (let y = 0; y < MH; y++) { tiles[y * MW] = STEEL; tiles[y * MW + MW - 1] = STEEL; }

  // Зеркально-симметричная карта: левая половина копируется вправо
  const put = (x, y, v) => {
    if (x < 1 || y < 1 || x >= MW - 1 || y >= MH - 1) return;
    tiles[y * MW + x] = v;
    tiles[y * MW + (MW - 1 - x)] = v;
  };
  const shapes = {
    block: () => true,
    hline: (x, y) => y === 1,
    vline: (x) => x === 1,
    cross: (x, y) => x === 1 || y === 1,
    corner: (x, y) => x === 0 || y === 0,
    ring: (x, y) => !(x === 1 && y === 1),
    dots: (x, y) => (x + y) % 2 === 0,
  };
  const names = Object.keys(shapes);

  // Блоки 3x3 с проходами в 2 клетки между ними — карта всегда проходима
  for (let by = 2; by < MH - 4; by += 5) {
    for (let bx = 2; bx < MW / 2; bx += 5) {
      const r = Math.random();
      let mat;
      if (r < 0.22) continue;
      else if (r < 0.68) mat = BRICK;
      else if (r < 0.77) mat = STEEL;
      else if (r < 0.86) mat = WATER;
      else mat = BUSH;
      let shape;
      if (mat === BRICK) shape = shapes[pick(names)];
      else if (mat === STEEL) shape = shapes[pick(['hline', 'vline', 'dots'])];
      else shape = shapes.block;
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) if (shape(x, y)) put(bx + x, by + y, mat);
      }
    }
  }
  // Немного кустов в проходах
  for (let i = 0; i < 14; i++) {
    const x = 1 + rand(MW / 2 - 1), y = 1 + rand(MH - 2);
    for (let k = 0; k < 3; k++) {
      const xx = x + rand(2), yy = y + rand(2);
      if (tiles[yy * MW + xx] === EMPTY) put(xx, yy, BUSH);
    }
  }
}

function tileAt(px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return STEEL;
  return tiles[ty * MW + tx];
}

const blocksTank = (v) => v === BRICK || v === STEEL || v === WATER;

function rectHitsMap(x, y) {
  const x0 = Math.floor((x - HALF) / TILE), x1 = Math.floor((x + HALF - 0.001) / TILE);
  const y0 = Math.floor((y - HALF) / TILE), y1 = Math.floor((y + HALF - 0.001) / TILE);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return true;
      if (blocksTank(tiles[ty * MW + tx])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Состояние
// ---------------------------------------------------------------------------
const tanks = new Map();
let bullets = [];
let powerups = [];
let events = [];
let nextId = 1;
let time = 0;
let tickCount = 0;
let powerupTimer = POWERUP_EVERY;
let infoDirty = true;

const ev = (...args) => events.push(args);
const r1 = (v) => Math.round(v);

function rectHitsTank(self, x, y) {
  for (const t of tanks.values()) {
    if (t === self || !t.alive) continue;
    if (Math.abs(t.x - x) < HALF * 2 && Math.abs(t.y - y) < HALF * 2) {
      // не блокируем, если уже пересекались (например, после респауна)
      if (Math.abs(t.x - self.x) < HALF * 2 && Math.abs(t.y - self.y) < HALF * 2) continue;
      return true;
    }
  }
  return false;
}

function findSpawn() {
  for (let i = 0; i < 300; i++) {
    const tx = 1 + rand(MW - 2), ty = 1 + rand(MH - 2);
    if (tiles[ty * MW + tx] !== EMPTY) continue;
    const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
    const minDist = i < 200 ? 220 : 60;
    let ok = true;
    for (const t of tanks.values()) {
      if (t.alive && Math.hypot(t.x - x, t.y - y) < minDist) { ok = false; break; }
    }
    if (ok && !powerups.some((p) => p.x === x && p.y === y)) return { x, y };
  }
  return { x: TILE * 1.5, y: TILE * 1.5 };
}

function createTank({ name, color, bot = false, ws = null }) {
  const t = {
    id: nextId++, name, color, bot, ws,
    x: 0, y: 0, dir: 0, hp: MAX_HP, alive: false, respawnAt: 0,
    shieldUntil: 0, rapidUntil: 0, speedUntil: 0, reload: 0,
    score: 0, deaths: 0,
    inDir: -1, inFire: false, moving: false, hold: false, stuck: 0,
    aiT: 0, alignT: 0,
  };
  tanks.set(t.id, t);
  spawnTank(t);
  infoDirty = true;
  return t;
}

function spawnTank(t) {
  const p = findSpawn();
  t.x = p.x; t.y = p.y;
  t.dir = rand(4);
  t.hp = MAX_HP;
  t.alive = true;
  t.shieldUntil = time + SPAWN_SHIELD;
  t.rapidUntil = 0; t.speedUntil = 0;
  t.reload = 0.3;
  t.stuck = 0;
  ev('sp', r1(t.x), r1(t.y));
}

function moveTank(t) {
  t.moving = false;
  if (t.inDir < 0) { t.stuck = 0; return; }
  const nd = t.inDir;
  if (nd !== t.dir) {
    // при повороте на 90° выравниваем по сетке в полклетки — легче проезжать в проходы
    if (nd % 2 !== t.dir % 2) {
      const G = TILE / 2;
      if (nd % 2 === 0) {
        const sx = Math.round(t.x / G) * G;
        if (!rectHitsMap(sx, t.y) && !rectHitsTank(t, sx, t.y)) t.x = sx;
      } else {
        const sy = Math.round(t.y / G) * G;
        if (!rectHitsMap(t.x, sy) && !rectHitsTank(t, t.x, sy)) t.y = sy;
      }
    }
    t.dir = nd;
  }
  if (t.hold) { t.stuck = 0; return; }

  const speed = TANK_SPEED * (t.speedUntil > time ? 1.45 : 1) * (t.bot ? 0.9 : 1);
  const dist = speed * DT;
  const steps = Math.ceil(dist);
  const step = dist / steps;
  const [dx, dy] = DIRS[nd];
  let moved = 0;
  for (let i = 0; i < steps; i++) {
    const nx = t.x + dx * step, ny = t.y + dy * step;
    if (rectHitsMap(nx, ny) || rectHitsTank(t, nx, ny)) break;
    t.x = nx; t.y = ny; moved++;
  }
  t.moving = moved > 0;
  t.stuck = moved > 0 ? 0 : t.stuck + DT;
}

function fire(t) {
  const rapid = t.rapidUntil > time;
  t.reload = (rapid ? 0.22 : RELOAD) * (t.bot ? 1.5 : 1);
  const [dx, dy] = DIRS[t.dir];
  const speed = BULLET_SPEED * (rapid ? 1.3 : 1);
  bullets.push({
    id: nextId++, owner: t.id, ownerName: t.name, ownerColor: t.color,
    x: t.x + dx * (HALF + 2), y: t.y + dy * (HALF + 2),
    vx: dx * speed, vy: dy * speed, life: 2.5, dead: false,
  });
  ev('sh', r1(t.x + dx * (HALF + 4)), r1(t.y + dy * (HALF + 4)), t.dir);
}

function setTile(idx, v) {
  tiles[idx] = v;
  ev('t', idx, v);
}

function bulletHitsMap(b) {
  const x0 = Math.floor((b.x - BULLET_R) / TILE), x1 = Math.floor((b.x + BULLET_R) / TILE);
  const y0 = Math.floor((b.y - BULLET_R) / TILE), y1 = Math.floor((b.y + BULLET_R) / TILE);
  let hit = 0;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) { hit = STEEL; continue; }
      const idx = ty * MW + tx;
      const v = tiles[idx];
      if (v === BRICK) {
        setTile(idx, EMPTY);
        brickRegen.set(idx, time + BRICK_REGEN);
        hit = hit || BRICK;
      } else if (v === STEEL) {
        hit = STEEL;
      }
    }
  }
  return hit;
}

function damage(t, b) {
  if (t.shieldUntil > time) { ev('h', r1(b.x), r1(b.y), 1); return; }
  t.hp--;
  if (t.hp <= 0) killTank(t, b);
  else ev('h', r1(b.x), r1(b.y), 0);
}

function killTank(victim, b) {
  victim.alive = false;
  victim.deaths++;
  victim.respawnAt = time + RESPAWN_TIME;
  const killer = tanks.get(b.owner);
  if (killer && killer !== victim) killer.score++;
  ev('bm', r1(victim.x), r1(victim.y));
  ev('k', b.ownerName, b.ownerColor, victim.name, victim.color, b.owner, victim.id);
  if (Math.random() < 0.3) addPowerup(victim.x, victim.y);
  infoDirty = true;
}

function updateBullets() {
  const SUB = 3;
  for (const b of bullets) {
    b.life -= DT;
    if (b.life <= 0) { b.dead = true; continue; }
    for (let s = 0; s < SUB && !b.dead; s++) {
      b.x += (b.vx * DT) / SUB;
      b.y += (b.vy * DT) / SUB;
      if (b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) { b.dead = true; break; }
      const hit = bulletHitsMap(b);
      if (hit) {
        b.dead = true;
        ev('w', r1(b.x), r1(b.y), hit);
        break;
      }
      for (const t of tanks.values()) {
        if (!t.alive || t.id === b.owner) continue;
        if (Math.abs(b.x - t.x) < HALF + BULLET_R && Math.abs(b.y - t.y) < HALF + BULLET_R) {
          b.dead = true;
          damage(t, b);
          break;
        }
      }
    }
  }
  // пуля о пулю
  for (let i = 0; i < bullets.length; i++) {
    const a = bullets[i];
    if (a.dead) continue;
    for (let j = i + 1; j < bullets.length; j++) {
      const c = bullets[j];
      if (c.dead || c.owner === a.owner) continue;
      if (Math.abs(a.x - c.x) < 8 && Math.abs(a.y - c.y) < 8) {
        a.dead = c.dead = true;
        ev('bb', r1((a.x + c.x) / 2), r1((a.y + c.y) / 2));
        break;
      }
    }
  }
  bullets = bullets.filter((b) => !b.dead);
}

function addPowerup(x, y, type = pick(POWERUPS)) {
  if (powerups.length >= POWERUP_MAX + 3) return;
  powerups.push({ id: nextId++, x: r1(x), y: r1(y), type, until: time + POWERUP_LIFE });
}

function updatePowerups() {
  powerupTimer -= DT;
  if (powerupTimer <= 0) {
    powerupTimer = POWERUP_EVERY;
    if (powerups.length < POWERUP_MAX) {
      const p = findSpawn();
      addPowerup(p.x, p.y);
    }
  }
  powerups = powerups.filter((p) => {
    if (p.until <= time) return false;
    for (const t of tanks.values()) {
      if (!t.alive) continue;
      if (Math.abs(t.x - p.x) < HALF + 9 && Math.abs(t.y - p.y) < HALF + 9) {
        if (p.type === 'hp') t.hp = MAX_HP;
        else if (p.type === 'shield') t.shieldUntil = Math.max(t.shieldUntil, time) + SHIELD_TIME;
        else if (p.type === 'rapid') t.rapidUntil = time + BUFF_TIME;
        else if (p.type === 'speed') t.speedUntil = time + BUFF_TIME;
        ev('pk', p.x, p.y, p.type, t.id);
        return false;
      }
    }
    return true;
  });
}

function regenBricks() {
  for (const [idx, at] of brickRegen) {
    if (at > time) continue;
    const tx = idx % MW, ty = Math.floor(idx / MW);
    const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
    let blocked = false;
    for (const t of tanks.values()) {
      if (t.alive && Math.abs(t.x - cx) < HALF + TILE / 2 && Math.abs(t.y - cy) < HALF + TILE / 2) { blocked = true; break; }
    }
    if (!blocked) blocked = powerups.some((p) => Math.abs(p.x - cx) < TILE && Math.abs(p.y - cy) < TILE);
    if (blocked) { brickRegen.set(idx, time + 3); continue; }
    brickRegen.delete(idx);
    setTile(idx, BRICK);
  }
}

// ---------------------------------------------------------------------------
// Боты
// ---------------------------------------------------------------------------
function clearShot(a, b) {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12);
  for (let i = 1; i < steps; i++) {
    if (tileAt(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps) === STEEL) return false;
  }
  return true;
}

function botThink(b) {
  b.aiT -= DT;
  b.inFire = false;

  let target = null, best = Infinity;
  for (const t of tanks.values()) {
    if (t === b || !t.alive) continue;
    const d = Math.abs(t.x - b.x) + Math.abs(t.y - b.y);
    if (d < best) { best = d; target = t; }
  }

  let aligned = false;
  if (target) {
    const dx = target.x - b.x, dy = target.y - b.y;
    let aim = -1;
    if (Math.abs(dx) < 12) aim = dy < 0 ? 0 : 2;
    else if (Math.abs(dy) < 12) aim = dx < 0 ? 3 : 1;
    if (aim >= 0 && best < 520 && clearShot(b, target)) {
      aligned = true;
      b.inDir = aim;
      b.hold = true;
      b.aiT = 0;
      b.alignT += DT;
      if (b.dir === aim && b.alignT > 0.3 && Math.random() < 0.3) b.inFire = true;
    }
  }
  if (!aligned) {
    b.alignT = 0;
    if (b.aiT <= 0 || b.stuck > 0.35) {
      b.hold = false;
      if (b.stuck > 0.35) {
        b.inDir = pick([0, 1, 2, 3].filter((d) => d !== b.dir));
      } else if (target && Math.random() < 0.75) {
        const dx = target.x - b.x, dy = target.y - b.y;
        b.inDir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
      } else {
        b.inDir = rand(4);
      }
      b.aiT = 0.8 + Math.random() * 1.8;
      b.stuck = 0;
    }
    // упёрся в кирпич — стреляем
    const [fx, fy] = DIRS[b.dir];
    if (tileAt(b.x + fx * (HALF + 6), b.y + fy * (HALF + 6)) === BRICK && Math.random() < 0.1) b.inFire = true;
    if (Math.random() < 0.003) b.inFire = true;
  }
}

function balanceBots() {
  const all = [...tanks.values()];
  const humans = all.filter((t) => !t.bot).length;
  const bots = all.filter((t) => t.bot);
  if (humans === 0) {
    // сервер опустел — чистим всё и генерируем новую карту для следующей игры
    for (const b of bots) tanks.delete(b.id);
    bullets = []; powerups = []; events = [];
    genMap();
    return;
  }
  const want = Math.max(0, MIN_TANKS - humans);
  while (bots.length < want) {
    const used = new Set(bots.map((b) => b.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || 'Бот';
    bots.push(createTank({ name, color: pick(COLORS), bot: true }));
  }
  while (bots.length > want) {
    bots.sort((a, b) => Number(a.alive) - Number(b.alive));
    tanks.delete(bots.shift().id);
  }
  infoDirty = true;
}

// ---------------------------------------------------------------------------
// Сеть
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { urlPath = '/'; }

  if (urlPath === '/api/stats') {
    const all = [...tanks.values()];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ players: all.filter((t) => !t.bot).length, bots: all.filter((t) => t.bot).length }));
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const t of tanks.values()) if (t.ws) send(t.ws, msg);
}

function cleanName(s) {
  const name = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
  return name || 'Танкист';
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.tank = null;
  ws.lastChat = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'join': {
        if (ws.tank) return;
        const humans = [...tanks.values()].filter((t) => !t.bot).length;
        if (humans >= MAX_PLAYERS) { send(ws, { t: 'full' }); ws.close(); return; }
        const color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : pick(COLORS);
        ws.tank = createTank({ name: cleanName(msg.name), color, ws });
        send(ws, {
          t: 'welcome', id: ws.tank.id, tile: TILE, mw: MW, mh: MH,
          map: Array.from(tiles).join(''), maxHp: MAX_HP, respawn: RESPAWN_TIME,
        });
        balanceBots();
        broadcast({ t: 'c', n: '', c: '', m: `${ws.tank.name} вступает в бой` });
        break;
      }
      case 'in': {
        if (!ws.tank) return;
        const d = Number(msg.d);
        ws.tank.inDir = Number.isInteger(d) && d >= 0 && d <= 3 ? d : -1;
        ws.tank.inFire = !!msg.f;
        break;
      }
      case 'chat': {
        if (!ws.tank) return;
        const now = Date.now();
        if (now - ws.lastChat < 700) return;
        ws.lastChat = now;
        const m = String(msg.m || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (m) broadcast({ t: 'c', n: ws.tank.name, c: ws.tank.color, m });
        break;
      }
      case 'ping':
        send(ws, { t: 'pong', c: msg.c });
        break;
    }
  });

  ws.on('close', () => {
    if (!ws.tank) return;
    const name = ws.tank.name;
    tanks.delete(ws.tank.id);
    ws.tank = null;
    balanceBots();
    broadcast({ t: 'c', n: '', c: '', m: `${name} покидает бой` });
  });
});

// отключаем «зависшие» соединения
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function broadcastState() {
  const k = [];
  for (const t of tanks.values()) {
    let f = 0;
    if (t.alive) f |= 1;
    if (t.shieldUntil > time) f |= 2;
    if (t.moving) f |= 4;
    if (t.rapidUntil > time) f |= 8;
    if (t.speedUntil > time) f |= 16;
    k.push([t.id, r1(t.x), r1(t.y), t.dir, t.hp, f]);
  }
  const msg = {
    t: 's', tm: Math.round(time * 1000) / 1000, k,
    b: bullets.map((b) => [b.id, r1(b.x), r1(b.y)]),
    p: powerups.map((p) => [p.id, p.x, p.y, p.type]),
    e: events,
  };
  events = [];
  broadcast(msg);
}

function broadcastInfo() {
  infoDirty = false;
  broadcast({
    t: 'i',
    pl: [...tanks.values()].map((t) => [t.id, t.name, t.color, t.score, t.deaths, t.bot ? 1 : 0]),
  });
}

function tick() {
  if (tanks.size === 0) return;
  time += DT;
  tickCount++;
  for (const t of tanks.values()) {
    if (!t.alive) {
      if (time >= t.respawnAt) spawnTank(t);
      continue;
    }
    if (t.bot) botThink(t);
    moveTank(t);
    t.reload -= DT;
    if (t.inFire && t.reload <= 0) fire(t);
  }
  updateBullets();
  updatePowerups();
  if (tickCount % 15 === 0) regenBricks();
  if (tickCount % SEND_EVERY === 0) broadcastState();
  if (infoDirty || tickCount % TICK_RATE === 0) broadcastInfo();
}

genMap();
setInterval(tick, 1000 / TICK_RATE);

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`Танчики онлайн запущены: http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  в локальной сети:  http://${ip}:${PORT}`);
});
