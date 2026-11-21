// TANK TURN TACTICS - server. State lives in memory and is saved to data/rooms.json,
// so rooms survive restarts and can run for days/weeks.
const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const FILE = path.join(DATA, 'rooms.json');
let rooms = {};
try { rooms = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const AFILE = path.join(DATA, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(AFILE, 'utf8')); } catch {}
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => { if (dirty) { dirty = false; fs.writeFileSync(FILE, JSON.stringify(rooms)); fs.writeFileSync(AFILE, JSON.stringify(accounts)); } }, 2000);

const H = 3600e3, D = 24 * H;
const rnd = n => Math.floor(Math.random() * n);
const dist = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); // square-grid range
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 16);
const wrap = f => (req, res) => {
  try { res.json(f(req)); }
  catch (e) { if (typeof e === 'string') res.status(400).json({ error: e }); else { console.error(e); res.status(500).json({ error: 'Server error' }); } }
};
const getRoom = c => { const r = rooms[String(c || '').toUpperCase()]; if (!r) throw 'Room not found'; return r; };
const auth = (room, token) => { const p = room.players.find(p => p.token === token); if (!p) throw 'You are not in this room'; return p; };
const log = (room, msg) => { room.log.push({ t: Date.now(), msg }); if (room.log.length > 150) room.log.shift(); };
const alive = room => room.players.filter(p => p.alive);
const taken = (room, x, y) => room.players.some(p => p.x === x && p.y === y);

// ---------- Accounts, points, cosmetics ----------
const CATALOG = {
  icon: [
    { id: 'cat', label: '🐱', cost: 20 }, { id: 'frog', label: '🐸', cost: 20 }, { id: 'fox', label: '🦊', cost: 30 },
    { id: 'shield', label: '🛡️', cost: 40 }, { id: 'fire', label: '🔥', cost: 50 }, { id: 'alien', label: '👽', cost: 50 },
    { id: 'shark', label: '🦈', cost: 60 }, { id: 'dragon', label: '🐉', cost: 60 }, { id: 'crown', label: '👑', cost: 100 }, { id: 'gem', label: '💎', cost: 120 }
  ],
  title: [
    { id: 'rookie', label: 'Rookie', cost: 10 }, { id: 'sharp', label: 'Sharpshooter', cost: 30 }, { id: 'backstab', label: 'Backstabber', cost: 40 },
    { id: 'diplomat', label: 'Diplomat', cost: 40 }, { id: 'heartbreak', label: 'Heartbreaker', cost: 60 }, { id: 'survivor', label: 'Survivor', cost: 60 },
    { id: 'haunted', label: 'The Haunted', cost: 80 }, { id: 'warlord', label: 'Warlord', cost: 100 }, { id: 'legend', label: 'Legend', cost: 200 }
  ]
};
const item = (k, id) => (Object.hasOwn(CATALOG, k) ? CATALOG[k] : []).find(i => i.id === id);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sessions = new Map();
for (const [k, a] of Object.entries(accounts)) (a.sessions || []).forEach(t => sessions.set(t, k));
function newSession(key) {
  const t = crypto.randomBytes(24).toString('hex'), a = accounts[key];
  a.sessions.push(t); sessions.set(t, key);
  if (a.sessions.length > 8) sessions.delete(a.sessions.shift());
  save(); return t;
}
function acct(session) {
  const k = sessions.get(String(session || '')); if (!k || !accounts[k]) throw 'Please log in'; return accounts[k];
}
const pubAcct = a => ({ username: a.username, points: a.points, owned: a.owned, equipped: a.equipped, stats: a.stats });
const cosm = (p, k) => {
  if (p.bot) return k === 'icon' ? '🤖' : null;
  const a = p.user && accounts[p.user], it = a && a.equipped[k] && item(k, a.equipped[k]);
  return it ? it.label : null;
};
// Points: 1st 60 | 2nd 40 | 3rd 30 | 4th 20 | everyone else 10 | First Blood +10 | +3 per kill. Bot matches pay in full.
const PTS = [60, 40, 30, 20], PARTICIPATION = 10, FIRST_BLOOD = 10, PER_KILL = 3;
function awardPoints(room) {
  room.result.points = {};
  room.result.ranking.forEach((id, i) => {
    const p = room.players.find(q => q.id === id), a = p && p.user && accounts[p.user]; if (!a) return;
    const pts = (PTS[i] ?? PARTICIPATION) + (room.firstBlood === id ? FIRST_BLOOD : 0) + p.kills * PER_KILL;
    a.points += pts; a.stats.games++; if (i === 0) a.stats.wins++; a.stats.kills += p.kills;
    room.result.points[id] = pts;
  });
  save();
}

function addPlayer(room, name, user) {
  if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) throw 'Name already taken in this room';
  const n = room.players.length;
  const p = { user, id: crypto.randomBytes(4).toString('hex'), token: crypto.randomBytes(16).toString('hex'), name,
    x: -1, y: -1, hearts: 3, ap: 0, range: 2, alive: true, kills: 0, diedAt: null, color: `hsl(${(n * 47) % 360} 70% 55%)` };
  room.players.push(p); return p;
}
function schedAp(room, from) {
  if (room.mode === 'fast') return from + room.fastMin * 60e3;
  let t = from + D + (Math.random() - .5) * 4 * H;       // ~24h, varies day to day
  while ([0, 6].includes(new Date(t).getUTCDay())) t += D; // work days only (UTC)
  return t;
}
const schedHeart = (room, from) => room.mode === 'fast'
  ? from + room.fastMin * 60e3 * (.3 + Math.random() * 1.4) : from + (.5 + Math.random()) * D;

function checkEnd(room) {
  const a = alive(room);
  let order = null;
  if (a.length <= 1) order = a.map(p => p.id);
  else if (a.length <= 4) {
    const props = a.map(p => room.proposals[p.id]);
    if (props.every(Boolean) && props.every(x => JSON.stringify(x) === JSON.stringify(props[0]))) order = props[0];
  }
  if (!order) return;
  const dead = room.players.filter(p => !order.includes(p.id)).sort((x, y) => (y.diedAt || 0) - (x.diedAt || 0));
  room.status = 'finished';
  room.result = { ranking: [...order, ...dead.map(p => p.id)] };
  awardPoints(room);
  log(room, 'The game is over! Final placings decided.');
}

function tick(room) {
  if (room.status !== 'playing') return;
  const now = Date.now();
  if (now >= room.nextAp) {
    const tally = {};
    for (const [voter, tid] of Object.entries(room.votes)) {
      const t = room.players.find(p => p.id === tid);
      if (t && t.alive) tally[tid] = (tally[tid] || 0) + 1;
    }
    const max = Math.max(0, ...Object.values(tally));
    const top = Object.keys(tally).filter(k => tally[k] === max);
    room.haunted = top.length ? top[rnd(top.length)] : null;
    for (const p of alive(room)) if (p.id !== room.haunted) p.ap++;
    const h = room.players.find(p => p.id === room.haunted);
    log(room, h ? `New day: everyone gets 1 AP... except ${h.name}, haunted by the jury!` : 'New day: everyone gets 1 AP.');
    room.votes = {}; room.nextAp = schedAp(room, now); save();
  }
  if (now >= room.nextHeart) {
    if (!room.heart) {
      for (let i = 0; i < 200; i++) {
        const x = rnd(room.size), y = rnd(room.size);
        if (!taken(room, x, y)) { room.heart = { x, y }; log(room, 'A heart has spawned on the field!'); break; }
      }
    }
    room.nextHeart = schedHeart(room, now); save();
  }
}
setInterval(() => Object.values(rooms).forEach(tick), 15000);

function act(room, p, b) {
  if (room.status !== 'playing') throw 'Game is not running';
  const t = b.type, tgt = room.players.find(q => q.id === b.target);
  const cost = n => { if (p.ap < n) throw `Not enough action points (need ${n})`; p.ap -= n; };
  if (t === 'vote') {
    if (p.alive) throw 'Only the dead can vote'; if (!tgt || !tgt.alive) throw 'Pick a living player';
    room.votes[p.id] = tgt.id; return `Voted to haunt ${tgt.name}`;
  }
  if (!p.alive) throw 'You are dead';
  if (t === 'propose') {
    const a = alive(room); if (a.length > 4) throw 'Placings open when 4 players remain';
    const o = b.order; if (!Array.isArray(o) || o.length !== a.length || !a.every(q => o.includes(q.id))) throw 'Invalid order';
    room.proposals[p.id] = o; checkEnd(room); return 'Proposal submitted';
  }
  if (t === 'move') {
    const dx = +b.dx, dy = +b.dy;
    if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dy) || (!dx && !dy)) throw 'Bad direction';
    const x = p.x + dx, y = p.y + dy;
    if (x < 0 || y < 0 || x >= room.size || y >= room.size) throw 'Off the board';
    if (taken(room, x, y)) throw 'Square is occupied';
    cost(1); p.x = x; p.y = y; log(room, `${p.name} moved.`);
    if (room.heart && room.heart.x === x && room.heart.y === y) { p.hearts++; room.heart = null; log(room, `${p.name} grabbed the spawned heart!`); }
    return 'Moved';
  }
  if (t === 'range') { cost(p.range - 1); p.range++; log(room, `${p.name} upgraded their range.`); return 'Range upgraded'; }
  if (!tgt || tgt.id === p.id) throw 'Pick another player';
  if (dist(p, tgt) > p.range) throw 'Target is out of range';
  if (t === 'shoot') {
    if (!tgt.alive) throw 'Target is already dead';
    cost(1); tgt.hearts--; log(room, `${p.name} shot ${tgt.name}!`);
    if (tgt.hearts <= 0) {
      tgt.alive = false; tgt.diedAt = ++room.deathSeq; p.ap += tgt.ap; tgt.ap = 0; p.kills++;
      room.proposals = {}; delete room.votes[tgt.id];
      log(room, `${p.name} KILLED ${tgt.name} and took their action points.`);
      if (!room.firstBlood) { room.firstBlood = p.id; log(room, `FIRST BLOOD: ${p.name}!`); }
      checkEnd(room);
    }
    return 'Shot';
  }
  if (t === 'gift') {
    if (b.what === 'heart') {
      if (p.hearts <= 1) throw 'You need more than 1 heart to give one away';
      p.hearts--;
      if (tgt.alive) { tgt.hearts++; log(room, `${p.name} gifted a heart to ${tgt.name}.`); }
      else { tgt.alive = true; tgt.hearts = 1; tgt.ap = 0; tgt.diedAt = null; room.proposals = {}; delete room.votes[tgt.id];
        log(room, `${p.name} REVIVED ${tgt.name}!`); }
      return 'Heart sent';
    }
    if (b.what === 'ap') {
      if (!tgt.alive) throw 'Cannot send AP to the dead';
      const n = Math.max(1, Math.floor(+b.amount || 1)); cost(n); tgt.ap += n;
      log(room, `${p.name} gifted action points to ${tgt.name}.`); return 'AP sent';
    }
  }
  throw 'Unknown action';
}

// ---------- Game start + bots ----------
function startGame(room) {
  room.size = Math.max(8, Math.ceil(Math.sqrt(room.players.length * 8)));
  for (const p of room.players) { do { p.x = rnd(room.size); p.y = rnd(room.size); } while (room.players.some(q => q !== p && q.x === p.x && q.y === p.y)); }
  room.status = 'playing'; room.nextAp = schedAp(room, Date.now()); room.nextHeart = schedHeart(room, Date.now());
  log(room, 'The game has begun! Everyone has 3 hearts, 0 AP, range 2.');
}
const BOT_NAMES = ['Bolt', 'Rusty', 'Turret', 'Sarge', 'Tanky', 'Blitz', 'Gizmo', 'Panzer', 'Cinder', 'Havoc', 'Rex', 'Moxie'];
function addBot(room) {
  const used = new Set(room.players.map(p => p.name));
  const p = addPlayer(room, BOT_NAMES.find(n => !used.has(n)) || 'Bot' + room.players.length);
  p.bot = true; return p;
}
function stepToward(room, p, goal) {
  let best = [], bd = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    const x = p.x + dx, y = p.y + dy;
    if (x < 0 || y < 0 || x >= room.size || y >= room.size || taken(room, x, y)) continue;
    const d = dist({ x, y }, goal);
    if (d < bd) { bd = d; best = [{ dx, dy }]; } else if (d === bd) best.push({ dx, dy });
  }
  return best.length && bd < dist(p, goal) ? best[rnd(best.length)] : null;
}
// Bots act on the server tick, with a random delay so they feel human.
function botTurn(room) {
  if (room.status !== 'playing') return;
  const a = alive(room), humans = a.filter(p => !p.bot);
  const go = (b, o) => { try { act(room, b, o); return true; } catch { return false; } };
  if (a.length > 1 && a.length <= 4) {            // bots agree to placings (copy a human's proposal)
    const ref = humans.find(h => room.proposals[h.id]);
    for (const b of a.filter(x => x.bot)) {
      const order = ref ? room.proposals[ref.id]
        : humans.length ? null : a.slice().sort((x, y) => y.hearts - x.hearts || x.id.localeCompare(y.id)).map(p => p.id);
      if (order && JSON.stringify(room.proposals[b.id]) !== JSON.stringify(order)) go(b, { type: 'propose', order });
      if (room.status !== 'playing') return;
    }
  }
  for (const b of room.players.filter(p => p.bot)) {
    if (room.status !== 'playing') return;
    if (!b.alive) {                                // dead bots sit on the jury
      if (!room.votes[b.id] && Math.random() < .2) { const pool = humans.length ? humans : a; if (pool.length) go(b, { type: 'vote', target: pool[rnd(pool.length)].id }); }
      continue;
    }
    if (b.ap < 1 || Math.random() > .12) continue;
    const foes = a.filter(x => x.id !== b.id), inR = foes.filter(x => dist(b, x) <= b.range);
    if (inR.length && Math.random() < .8) { inR.sort((x, y) => x.hearts - y.hearts || Math.random() - .5); go(b, { type: 'shoot', target: inR[0].id }); continue; }
    if (room.heart && Math.random() < .7) { const m = stepToward(room, b, room.heart); if (m && go(b, { type: 'move', ...m })) continue; }
    if (b.range < 5 && b.ap >= b.range - 1 && b.ap > 1 && Math.random() < .3) { go(b, { type: 'range' }); continue; }
    if (foes.length && Math.random() < .8) {
      foes.sort((x, y) => dist(b, x) - dist(b, y));
      const m = stepToward(room, b, foes[0]); if (m) go(b, { type: 'move', ...m });
    }
  }
  save();
}
setInterval(() => Object.values(rooms).forEach(botTurn), 15000);

app.post('/api/register', wrap(({ body: b }) => {
  const u = String(b.username || '').trim(), pw = String(b.password || '');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) throw 'Username: 3-16 letters, numbers or _';
  if (pw.length < 6 || pw.length > 100) throw 'Password must be at least 6 characters';
  const key = u.toLowerCase(); if (accounts[key]) throw 'Username already taken';
  const salt = crypto.randomBytes(16).toString('hex');
  accounts[key] = { username: u, salt, hash: hashPw(pw, salt), points: 0, owned: [], equipped: { icon: null, title: null },
    stats: { games: 0, wins: 0, kills: 0 }, sessions: [] };
  return { session: newSession(key) };
}));
app.post('/api/login', wrap(({ body: b }) => {
  const a = accounts[String(b.username || '').trim().toLowerCase()], pw = String(b.password || '');
  if (!a || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, a.salt)), Buffer.from(a.hash))) throw 'Wrong username or password';
  return { session: newSession(a.username.toLowerCase()) };
}));
app.get('/api/me', wrap(({ query: q }) => ({ account: pubAcct(acct(q.session)), catalog: CATALOG })));
app.post('/api/buy', wrap(({ body: b }) => {
  const a = acct(b.session), it = item(b.kind, b.id); if (!it) throw 'No such item';
  const k = b.kind + ':' + b.id;
  if (a.owned.includes(k)) throw 'You already own that'; if (a.points < it.cost) throw 'Not enough points';
  a.points -= it.cost; a.owned.push(k); save(); return { ok: true };
}));
app.post('/api/equip', wrap(({ body: b }) => {
  const a = acct(b.session); if (!['icon', 'title'].includes(b.kind)) throw 'Bad kind';
  if (b.id && !a.owned.includes(b.kind + ':' + b.id)) throw 'You do not own that';
  a.equipped[b.kind] = b.id || null; save(); return { ok: true };
}));
app.get('/api/myrooms', wrap(({ query: q }) => {
  const key = acct(q.session).username.toLowerCase();
  return { rooms: Object.values(rooms).map(r => { const p = r.players.find(x => x.user === key);
    return p && { code: r.code, status: r.status, players: r.players.length, mode: r.mode, token: p.token, alive: p.alive }; }).filter(Boolean) };
}));

app.post('/api/create', wrap(({ body: b }) => {
  const a = acct(b.session), name = clean(a.username);
  let code; do { code = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[rnd(24)]).join(''); } while (rooms[code]);
  const room = { code, mode: b.mode === 'fast' ? 'fast' : 'daily', fastMin: Math.min(Math.max(+b.fastMin || 10, 1), 1440),
    prize: String(b.prize || '').slice(0, 200), status: 'lobby', size: 0, players: [], heart: null, nextAp: 0, nextHeart: 0,
    log: [], deathSeq: 0, firstBlood: null, proposals: {}, votes: {}, haunted: null, result: null, created: Date.now() };
  rooms[code] = room; const p = addPlayer(room, name, a.username.toLowerCase()); room.host = p.id;
  log(room, `${name} created the room.`);
  const nb = Math.min(Math.max(Math.floor(+b.bots) || 0, 0), 12);
  for (let i = 0; i < nb; i++) addBot(room);
  if (nb) log(room, `${nb} bot${nb > 1 ? 's' : ''} joined.`);
  if (b.autostart && nb) startGame(room);
  save(); return { code, token: p.token };
}));
app.post('/api/join', wrap(({ body: b }) => {
  const a = acct(b.session), room = getRoom(b.code), name = clean(a.username), key = a.username.toLowerCase();
  if (room.players.some(p => p.user === key)) throw 'You are already in this room';
  if (room.status !== 'lobby') throw 'Game already started';
  if (room.players.length >= 30) throw 'Room is full';
  const p = addPlayer(room, name, key); log(room, `${name} joined.`); save(); return { code: room.code, token: p.token };
}));
app.post('/api/start', wrap(({ body: b }) => {
  const room = getRoom(b.code), me = auth(room, b.token);
  if (me.id !== room.host) throw 'Only the host can start'; if (room.status !== 'lobby') throw 'Already started';
  if (room.players.length < 2) throw 'Need at least 2 players';
  startGame(room); save(); return { ok: true };
}));
app.post('/api/addbot', wrap(({ body: b }) => {
  const room = getRoom(b.code), me = auth(room, b.token);
  if (me.id !== room.host) throw 'Only the host can add bots'; if (room.status !== 'lobby') throw 'Game already started';
  const n = Math.min(Math.max(Math.floor(+b.count) || 1, 1), 12);
  for (let i = 0; i < n && room.players.length < 30; i++) { const p = addBot(room); log(room, `${p.name} (bot) joined.`); }
  save(); return { ok: true };
}));
app.post('/api/act', wrap(({ body: b }) => {
  const room = getRoom(b.code), me = auth(room, b.token); tick(room);
  const msg = act(room, me, b); save(); return { msg };
}));
app.get('/api/state', wrap(({ query: q }) => {
  const room = getRoom(q.code), me = auth(room, q.token); tick(room);
  return { code: room.code, status: room.status, mode: room.mode, fastMin: room.fastMin, prize: room.prize, size: room.size,
    me: me.id, host: room.host, haunted: room.haunted, heart: room.heart, firstBlood: room.firstBlood, result: room.result,
    proposals: room.proposals, myVote: room.votes[me.id] || null, log: room.log.slice(-60).reverse(),
    players: room.players.map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, hearts: p.hearts, range: p.range,
      alive: p.alive, kills: p.kills, color: p.color, bot: !!p.bot, icon: cosm(p, 'icon'), title: cosm(p, 'title'), ap: p.id === me.id ? p.ap : null })) }; // AP is secret
}));

app.listen(process.env.PORT || 3000, () => console.log('Tank Turn Tactics running'));
