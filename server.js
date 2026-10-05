// 007 Signals backend: Express + SQLite. Run: npm i && node server.js
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const { ADMIN_TOKEN, POSTBACK_SECRET, TWELVE_DATA_KEY, PORT = 3000 } = process.env;
if (!ADMIN_TOKEN || !POSTBACK_SECRET) { console.error('Set ADMIN_TOKEN and POSTBACK_SECRET'); process.exit(1); }

const db = new Database('data.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS postbacks(id INTEGER PRIMARY KEY AUTOINCREMENT, raw TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
const setStatus = (uid, status) => db.prepare(`INSERT INTO users(uid,status) VALUES(?,?)
  ON CONFLICT(uid) DO UPDATE SET status=excluded.status, updated_at=CURRENT_TIMESTAMP`).run(uid, status);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const validUid = u => /^\d{4,12}$/.test(String(u || ''));

// --- Pocket Option postback. Configure in your partner dashboard, e.g.:
// https://YOURDOMAIN/api/postback/pocketoption?secret=XXX&uid={trader_id}&event={event}
// Parameter names depend on your partner panel: adjust the aliases below to match.
app.all('/api/postback/pocketoption', (req, res) => {
  const q = { ...req.query, ...req.body };
  db.prepare('INSERT INTO postbacks(raw) VALUES(?)').run(JSON.stringify(q));
  if (q.secret !== POSTBACK_SECRET) return res.status(403).send('forbidden');
  const uid = String(q.uid || q.trader_id || '');
  const ev = String(q.event || q.status || '').toLowerCase();
  if (!validUid(uid)) return res.status(400).send('bad uid');
  const existing = db.prepare('SELECT status FROM users WHERE uid=?').get(uid);
  if (/dep|ftd|approved|paid/.test(ev)) setStatus(uid, 'approved');
  else if (/reject|fraud|declin/.test(ev)) setStatus(uid, 'rejected');
  else if (!existing) setStatus(uid, 'pending'); // registration event
  res.send('ok');
});

const hits = new Map(); // naive rate limit: 20 requests/min/IP
app.use('/api', (req, res, next) => {
  const k = req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < 60000);
  h.push(now); hits.set(k, h);
  h.length > 20 * 6 ? res.status(429).json({ error: 'slow down' }) : next();
});

// Unknown UID => rejected (never came through the referral link).
app.post('/api/verify-uid', (req, res) => {
  const uid = String(req.body.uid || '').trim();
  if (!validUid(uid)) return res.status(400).json({ status: 'invalid' });
  const u = db.prepare('SELECT status FROM users WHERE uid=?').get(uid);
  res.json({ status: u ? u.status : 'rejected' });
});

// ---------- Signal engine: real indicators on real candles ----------
const ASSETS = [
  ...['BTC','ETH','LTC','XRP','SOL','DOGE'].map(s => ({ id: s+'USDT', name: s+'/USDT', cat: 'crypto', src: 'binance', vol: true })),
  ...['EUR/USD','GBP/USD','USD/JPY','AUD/CAD','EUR/GBP','USD/CHF','NZD/USD','EUR/JPY'].map(s => ({ id: s, name: s, cat: 'forex', src: 'twelve' })),
  ...['XAU/USD','XAG/USD'].map(s => ({ id: s, name: s, cat: 'commodity', src: 'twelve', vol: true })),
];
const ema = (a, p) => { const k = 2/(p+1); let e = a[0]; return a.map(v => (e = v*k + e*(1-k))); };
const rsi = (c, p = 14) => { let g = 0, l = 0;
  for (let i = c.length-p; i < c.length; i++) { const d = c[i]-c[i-1]; d > 0 ? g += d : l -= d; }
  return l === 0 ? 100 : 100 - 100/(1 + g/l); };
async function candles(a, tf) {
  if (a.src === 'binance') {
    const iv = { 1:'1m', 2:'1m', 3:'3m', 5:'5m' }[tf];
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${a.id}&interval=${iv}&limit=100`);
    return (await r.json()).map(k => +k[4]);
  }
  if (!TWELVE_DATA_KEY) throw new Error('no feed');
  const iv = { 1:'1min', 2:'1min', 3:'5min', 5:'5min' }[tf];
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${a.id}&interval=${iv}&outputsize=100&apikey=${TWELVE_DATA_KEY}`);
  const j = await r.json(); if (!j.values) throw new Error('no data');
  return j.values.map(v => +v.close).reverse();
}
const cache = new Map();
async function signal(a, tf) {
  const key = a.id + tf, hit = cache.get(key);
  if (hit && Date.now() - hit.t < 15000) return hit.v;
  const c = await candles(a, tf);
  const r = rsi(c), e9 = ema(c, 9).at(-1), e21 = ema(c, 21).at(-1);
  const m = ema(c,12).map((v,i) => v - ema(c,26)[i]), hist = m.at(-1) - ema(m, 9).at(-1);
  const votes = [r < 45 ? 1 : r > 55 ? -1 : 0, hist > 0 ? 1 : -1, e9 > e21 ? 1 : -1];
  const net = votes.reduce((x, y) => x + y, 0);
  const v = { id: a.id, name: a.name, cat: a.cat, vol: !!a.vol, tf, price: c.at(-1),
    action: net >= 2 ? 'CALL' : net <= -2 ? 'PUT' : 'WAIT',
    agreement: Math.round(Math.abs(net) / 3 * 100), // % of indicators agreeing. NOT a win rate.
    rsi: +r.toFixed(1), macd: hist > 0 ? 'Bullish' : 'Bearish', ma: e9 > e21 ? 'EMA9 > EMA21' : 'EMA9 < EMA21' };
  cache.set(key, { t: Date.now(), v }); return v;
}
const approved = uid => db.prepare("SELECT 1 FROM users WHERE uid=? AND status='approved'").get(uid);
app.get('/api/assets', (req, res) => approved(req.query.uid) ? res.json(ASSETS) : res.sendStatus(403));
app.get('/api/signal', async (req, res) => {
  if (!approved(req.query.uid)) return res.sendStatus(403);
  const a = ASSETS.find(x => x.id === req.query.asset), tf = +req.query.tf || 1;
  if (!a || ![1,2,3,5].includes(tf)) return res.sendStatus(400);
  try { res.json(await signal(a, tf)); } catch { res.status(503).json({ error: 'No data feed for this asset' }); }
});

// ---------- Admin ----------
const admin = (req, res, next) => req.get('x-admin-token') === ADMIN_TOKEN ? next() : res.sendStatus(401);
app.get('/admin/api/users', admin, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
  const n = s => users.filter(u => u.status === s).length;
  res.json({ stats: { total: users.length, approved: n('approved'), pending: n('pending') }, users });
});
app.post('/admin/api/users/:uid/status', admin, (req, res) => {
  const { status } = req.body;
  if (!['approved','pending','rejected'].includes(status) || !validUid(req.params.uid)) return res.sendStatus(400);
  setStatus(req.params.uid, status); res.json({ ok: true });
});
app.get('/admin/api/postbacks', admin, (req, res) =>
  res.json(db.prepare('SELECT * FROM postbacks ORDER BY id DESC LIMIT 100').all()));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('007 Signals on :' + PORT));
