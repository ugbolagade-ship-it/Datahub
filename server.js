const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { AggregateField } = require('firebase-admin/firestore');

// ---------- Required secrets (set these in Render > Environment, never in code) ----------
function need(name) {
  if (!process.env[name]) { console.error(`Missing environment variable: ${name}`); process.exit(1); }
  return process.env[name];
}
const EASY_ACCESS_TOKEN = need('EASY_ACCESS_TOKEN');
const KORAPAY_SECRET_KEY = need('KORAPAY_SECRET_KEY');
const ADMIN_SECRET_KEY = need('ADMIN_SECRET_KEY');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))) });
const fdb = admin.firestore();
const usersCol = fdb.collection('users');       // document id = Firebase uid
const paymentsCol = fdb.collection('payments'); // document id = Korapay reference (stops double credit)
const withdrawalsCol = fdb.collection('withdrawals');
const ordersCol = fdb.collection('orders');      // one record per purchase / top-up, for the admin panel

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://ugbolagade-ship-it.github.io')
  .split(',').map(s => s.trim());
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';
const PROFIT_MARGIN = 0.09;
const RESELLER_FEE = 2000;
const REFERRAL_BONUS = 1000;
const MAX_TX_KEPT = 200;

// Settings the admin can change from admin.html (stored in Firestore: meta/settings)
const settings = { profit_margin_percent: PROFIT_MARGIN * 100 };
fdb.doc('meta/settings').get().then(d => { if (d.exists) Object.assign(settings, d.data()); }).catch(e => console.error('Could not load settings:', e.message));

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } })); // rawBody is kept so webhook signatures can be checked

// ---------- Helpers ----------
class HttpError extends Error {
  constructor(code, message, status = false) { super(message); this.code = code; this.status = status; }
}
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
  if (e instanceof HttpError) return res.status(e.code).json({ status: e.status, message: e.message });
  console.error(e);
  res.status(500).json({ status: false, message: 'Server error. Please try again.' });
});

const today = () => new Date().toLocaleDateString('en-GB');
const maskEmail = e => e.slice(0, 3) + '***' + e.slice(e.indexOf('@'));

function addTx(u, tx) {
  const full = { date: today(), ref: `tx_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`, ...tx };
  u.transactions = u.transactions || [];
  u.transactions.unshift(full);
  u.transactions = u.transactions.slice(0, MAX_TX_KEPT);
  return full;
}

async function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ status: false, message: 'Please log in again.' });
  try {
    const d = await admin.auth().verifyIdToken(token);
    if (!d.email) throw new Error('no email');
    req.user = { email: d.email.toLowerCase(), uid: d.uid };
    next();
  } catch (e) {
    res.status(401).json({ status: false, message: 'Session expired. Please log in again.' });
  }
}

const adminFails = {};
function adminOnly(req, res, next) {
  const f = adminFails[req.ip] || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60 * 1000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return res.status(429).json({ status: 'error', message: 'Too many wrong attempts. Try again in 15 minutes.' });
  const h = x => crypto.createHash('sha256').update(String(x || '')).digest();
  if (!crypto.timingSafeEqual(h(req.headers['x-admin-key']), h(ADMIN_SECRET_KEY))) {
    f.n++; adminFails[req.ip] = f;
    return res.status(401).json({ status: 'error', message: 'Unauthorized key.' });
  }
  next();
}

// Read a user inside a transaction (they must have opened the dashboard once)
async function getUserTx(t, uid, status = false) {
  const ref = usersCol.doc(uid);
  const s = await t.get(ref);
  if (!s.exists) throw new HttpError(404, 'Account not found. Please reload the page.', status);
  const u = s.data();
  u.transactions = u.transactions || [];
  u.referred_users = u.referred_users || [];
  return { ref, u };
}

// ---------- Pricing ----------
function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  if (isCable) return Math.ceil(original / 100) * 100; // round up to the next ₦100
  const resellerDiscount = isReseller ? 5 : 0;
  const finalPrice = original * (1 + settings.profit_margin_percent / 100) * (1 - resellerDiscount / 100);
  return Math.ceil(finalPrice * 1.015); // 1.5% checkout fee
}
const rawPrice = p => Number(p.price || p.plan_price || p.amount || p.package_amount || 0);
const planIdOf = p => String(p.plan_id || p.id || p.package_id);

const getEasyAccessHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

const planCache = {};
async function fetchPlans(type) {
  const c = planCache[type];
  if (c && Date.now() - c.t < 60000) return c.list;
  const response = await axios.get(`${EASY_ACCESS_BASE}/get-plans?product_type=${encodeURIComponent(type)}`, {
    headers: getEasyAccessHeaders(), timeout: 12000, validateStatus: () => true
  });
  const raw = response.data;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && typeof raw === 'object') {
    const found = [raw.plans, raw.data, raw.packages].find(Array.isArray);
    if (found) list = found;
    else { for (const k in raw) if (Array.isArray(raw[k])) { list = raw[k]; break; } } // e.g. { code: 200, MTN: [ ... ] }
  }
  if (!list.length) {
    const detail = (raw && (raw.message || raw.error || raw.msg)) || (typeof raw === 'string' ? raw.slice(0, 120) : 'no message');
    console.error('EasyAccess returned no plans:', response.status, JSON.stringify(raw).slice(0, 300));
    throw new Error(`Provider returned no plans (HTTP ${response.status}): ${detail}`);
  }
  planCache[type] = { t: Date.now(), list };
  return list;
}

app.get('/', (req, res) => res.send('OyoData API online'));

// ---------- Profile ----------
app.post('/api/get-user-profile', requireAuth, wrap(async (req, res) => {
  const { uid, email } = req.user;
  const referredBy = req.body.referredBy;
  const u = await fdb.runTransaction(async t => {
    const ref = usersCol.doc(uid);
    const s = await t.get(ref);
    if (s.exists) {
      const existing = s.data();
      if (existing.email !== email) { existing.email = email; t.update(ref, { email }); }
      return existing;
    }
    const fresh = { uid, email, ref_code: uid.slice(0, 6), balance: 0, ref_balance: 0, is_reseller: false, transactions: [], referred_by: null, referred_users: [], created: Date.now() };
    let referrer = null;
    if (referredBy && typeof referredBy === 'string') {
      const q = await t.get(usersCol.where('ref_code', '==', referredBy.slice(0, 6)).limit(1));
      if (!q.empty && q.docs[0].id !== uid) referrer = q.docs[0];
    }
    if (referrer) {
      const r = referrer.data();
      fresh.referred_by = r.ref_code;
      const list = r.referred_users || [];
      list.push({ email: maskEmail(email), status: 'Joined', date: today() });
      t.update(referrer.ref, { referred_users: list });
    }
    t.set(ref, fresh);
    return fresh;
  });
  let announcement = '';
  try { const a = await fdb.doc('meta/announcement').get(); announcement = a.exists ? a.data().message || '' : ''; } catch (e) {}
  res.json({ status: true, profile: u, announcement });
}));

// ---------- Plans (public) ----------
app.get('/api/get-plans', wrap(async (req, res) => {
  const type = String(req.query.product_type || 'mtn_sme').toLowerCase();
  const reseller = req.query.is_reseller === 'true';
  const isCable = ['dstv', 'gotv', 'startimes', 'showmax'].includes(type);
  try {
    const list = await fetchPlans(type);
    const plans = list.map(p => ({
      plan_id: planIdOf(p),
      name: p.name || p.plan_name || p.package_name || 'VTU Plan',
      validity: p.validity || p.plan_validity || p.day || '30 Days',
      price: calculateSellingPrice(rawPrice(p), reseller, isCable)
    }));
    res.json({ status: 'success', plans });
  } catch (e) {
    res.json({ status: 'failed', message: e.message, plans: [] });
  }
}));

// ---------- Buy data (price is decided HERE, never by the browser) ----------
async function finishTx(uid, txRef, status, refund = 0, detail = '') {
  return fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, uid);
    const x = u.transactions.find(y => y.ref === txRef);
    if (x) { x.status = status; if (detail) x.detail = detail; }
    if (refund) u.balance += refund;
    t.set(ref, u);
    t.set(ordersCol.doc(txRef), { status }, { merge: true });
    return { u, x };
  });
}

app.post('/api/purchase-data', requireAuth, wrap(async (req, res) => {
  const { uid } = req.user;
  const { product_type, network, dataplan, mobileno } = req.body;
  if (!/^0\d{10}$/.test(String(mobileno))) throw new HttpError(400, 'Enter a valid 11-digit phone number.', 'failed');
  if (![1, 2, 3, 4].includes(Number(network))) throw new HttpError(400, 'Invalid network.', 'failed');

  let plan;
  try {
    const list = await fetchPlans(String(product_type || '').toLowerCase());
    plan = list.find(p => planIdOf(p) === String(dataplan));
  } catch (e) { /* handled below */ }
  if (!plan) throw new HttpError(400, 'Plan not found. Please reload and try again.', 'failed');

  // Take the money first (inside a transaction) so quick double taps cannot spend it twice
  const { cost, txRef } = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, uid, 'failed');
    const price = calculateSellingPrice(rawPrice(plan), u.is_reseller, false);
    if (u.balance < price) throw new HttpError(400, 'Insufficient wallet balance.', 'failed');
    u.balance -= price;
    const tx = addTx(u, { type: 'Data', title: `Data Purchase — ${mobileno}`, amount: String(price), ref: `ref_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, status: 'PENDING' });
    t.set(ref, u);
    t.set(ordersCol.doc(tx.ref), { ref: tx.ref, uid, email: u.email, type: 'Data', title: tx.title, amount: price, status: 'PENDING', date: today(), ts: Date.now() });
    return { cost: price, txRef: tx.ref };
  });

  try {
    const r = await axios.post(`${EASY_ACCESS_BASE}/purchase-data`, {
      network: Number(network), dataplan: Number(dataplan), mobileno: String(mobileno), client_reference: txRef
    }, { headers: getEasyAccessHeaders(), timeout: 30000, validateStatus: () => true });
    const d = r.data || {};
    const st = String(d.status || '').toLowerCase();
    if ([200, 201].includes(Number(d.code)) || ['success', 'successful'].includes(st)) {
      const { u, x } = await finishTx(uid, txRef, 'SUCCESS');
      return res.json({ status: 'success', message: d.message || 'Data purchase successful!', profile: u, transaction: x });
    }
    const failed = [400, 401].includes(Number(d.code)) || st === 'failed';
    if (!failed) {
      // Not clearly successful and not clearly failed: keep it PENDING, never refund on a guess
      const { u } = await finishTx(uid, txRef, 'PENDING');
      return res.status(202).json({ status: 'pending', message: 'Your order is processing. Check History shortly.', profile: u });
    }
    console.error('EasyAccess data purchase failed:', JSON.stringify(d).slice(0, 500));
    const { u } = await finishTx(uid, txRef, 'FAILED', cost);
    return res.status(400).json({ status: 'failed', message: `${d.true_response || d.message || 'Provider purchase failed.'} You were not charged.`, profile: u });
  } catch (e) {
    // Unknown result (timeout etc.): stays PENDING and is not refunded automatically
    const u = (await usersCol.doc(uid).get()).data();
    return res.status(202).json({ status: 'pending', message: 'Your order is processing. If data is not delivered in 15 minutes, contact support with your reference.', profile: u });
  }
}));

// ---------- Cable TV, Electricity, Exam PINs ----------
const CABLE_TYPES = ['dstv', 'gotv', 'startimes', 'showmax']; // company 1-4
const EXAM_TYPES = ['waec', 'neco', 'nabteb', 'nbais'];       // exam_board 1-4

async function providerPost(endpoint, payload, timeout = 30000) {
  const r = await axios.post(`${EASY_ACCESS_BASE}/${endpoint}`, payload, { headers: getEasyAccessHeaders(), timeout, validateStatus: () => true });
  return r.data || {};
}
const isOk = d => [200, 201].includes(Number(d.code)) || ['success', 'successful'].includes(String(d.status || '').toLowerCase());
const isFailed = d => [400, 401].includes(Number(d.code)) || String(d.status || '').toLowerCase() === 'failed';

async function verifyWithProvider(endpoint, payload, fallbackMsg) {
  let d;
  try { d = await providerPost(endpoint, payload, 20000); }
  catch (e) { throw new HttpError(502, 'Verification service is unavailable. Please try again.', 'failed'); }
  if (!isOk(d)) throw new HttpError(400, d.message || fallbackMsg, 'failed');
  return d;
}

async function isResellerUser(uid) {
  const s = await usersCol.doc(uid).get();
  if (!s.exists) throw new HttpError(404, 'Account not found. Please reload the page.', 'failed');
  return !!s.data().is_reseller;
}

// Takes the money first, calls EasyAccess, then confirms or refunds (same rules as data)
async function purchaseFlow(res, uid, o) {
  const txRef = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, uid, 'failed');
    if (u.balance < o.cost) throw new HttpError(400, 'Insufficient wallet balance.', 'failed');
    u.balance -= o.cost;
    const tx = addTx(u, { type: o.type, title: o.title, amount: String(o.cost), ref: `${o.type.toLowerCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, status: 'PENDING' });
    t.set(ref, u);
    t.set(ordersCol.doc(tx.ref), { ref: tx.ref, uid, email: u.email, type: o.type, title: o.title, amount: o.cost, status: 'PENDING', date: today(), ts: Date.now() });
    return tx.ref;
  });
  try {
    const d = await providerPost(o.endpoint, o.payload);
    if (isOk(d)) {
      const { u, x } = await finishTx(uid, txRef, 'SUCCESS', 0, o.detail ? o.detail(d) : '');
      return res.json({ status: 'success', message: d.message || 'Successful!', profile: u, transaction: x });
    }
    if (!isFailed(d)) {
      const { u } = await finishTx(uid, txRef, 'PENDING');
      return res.status(202).json({ status: 'pending', message: 'Your order is processing. Check History shortly.', profile: u });
    }
    const { u } = await finishTx(uid, txRef, 'FAILED', o.cost);
    return res.status(400).json({ status: 'failed', message: d.true_response || d.message || 'Provider failed. You were not charged.', profile: u });
  } catch (e) {
    const u = (await usersCol.doc(uid).get()).data();
    return res.status(202).json({ status: 'pending', message: 'Your order is processing. If it is not delivered in 15 minutes, contact support with your reference.', profile: u });
  }
}

app.post('/api/verify-tv', requireAuth, wrap(async (req, res) => {
  const company = Number(req.body.company);
  const iucno = String(req.body.iucno || '').trim();
  if (![1, 2, 3, 4].includes(company) || !/^\d{6,20}$/.test(iucno)) throw new HttpError(400, 'Enter a valid smartcard / IUC number.', 'failed');
  const d = await verifyWithProvider('verify-tv', { company, iucno }, 'Smartcard verification failed.');
  res.json({ status: 'success', customer_name: d.customer_name, current_package: d.current_package, customer_status: d.customer_status, due_date: d.due_date, renewal_amount: d.renewal_amount, current_balance: d.current_balance });
}));

app.post('/api/pay-tv', requireAuth, wrap(async (req, res) => {
  const company = Number(req.body.company);
  const pkg = String(req.body.package || '');
  const iucno = String(req.body.iucno || '').trim();
  if (![1, 2, 3, 4].includes(company) || !/^\d{6,20}$/.test(iucno) || !/^\d+$/.test(pkg)) throw new HttpError(400, 'Choose a package and enter a valid smartcard number.', 'failed');
  let plan;
  try { plan = (await fetchPlans(CABLE_TYPES[company - 1])).find(p => planIdOf(p) === pkg); } catch (e) { /* handled below */ }
  if (!plan) throw new HttpError(400, 'Package not found. Please reload and try again.', 'failed');
  await verifyWithProvider('verify-tv', { company, iucno }, 'Smartcard could not be verified.');
  const base = rawPrice(plan);
  const cost = calculateSellingPrice(base, await isResellerUser(req.user.uid), true);
  await purchaseFlow(res, req.user.uid, {
    cost, type: 'Cable', title: `${plan.name || plan.plan_name || 'Cable TV'} — ${iucno}`,
    endpoint: 'pay-tv', payload: { company, package: Number(pkg), iucno, max_amount_payable: Math.ceil(base * 1.05) }
  });
}));

function readMeter(body) {
  const company = Number(body.company);
  const metertype = Number(body.metertype);
  const meterno = String(body.meterno || '').trim();
  const amount = Number(body.amount);
  if (!Number.isInteger(company) || company < 1 || company > 12) throw new HttpError(400, 'Choose a valid electricity provider.', 'failed');
  if (![1, 2].includes(metertype)) throw new HttpError(400, 'Choose prepaid or postpaid.', 'failed');
  if (!/^\d{6,20}$/.test(meterno)) throw new HttpError(400, 'Enter a valid meter number.', 'failed');
  if (!Number.isInteger(amount) || amount < 1000 || amount > 200000) throw new HttpError(400, 'Amount must be between ₦1,000 and ₦200,000.', 'failed');
  return { company, metertype, meterno, amount };
}

app.post('/api/verify-electricity', requireAuth, wrap(async (req, res) => {
  const m = readMeter(req.body);
  const d = await verifyWithProvider('verify-electricity', m, 'Meter verification failed.');
  res.json({ status: 'success', customer_name: d.customer_name, customer_address: d.customer_address, customer_metertype: d.customer_metertype });
}));

app.post('/api/pay-electricity', requireAuth, wrap(async (req, res) => {
  const m = readMeter(req.body);
  await verifyWithProvider('verify-electricity', m, 'Meter could not be verified.');
  await purchaseFlow(res, req.user.uid, {
    cost: m.amount, type: 'Electricity', title: `Electricity — ${m.meterno}`,
    endpoint: 'pay-electricity',
    payload: { company: m.company, metertype: m.metertype, meterno: m.meterno, amount: String(m.amount), max_amount_payable: m.amount },
    detail: d => (d.token ? `Token: ${d.token}` : '')
  });
}));

app.post('/api/buy-exam-pin', requireAuth, wrap(async (req, res) => {
  const board = Number(req.body.exam_board);
  const pins = Number(req.body.no_of_pins);
  if (![1, 2, 3].includes(board) || !Number.isInteger(pins) || pins < 1 || pins > 10) throw new HttpError(400, 'Choose an exam body and 1 to 10 pins.', 'failed');
  let plan;
  try { plan = (await fetchPlans(EXAM_TYPES[board - 1]))[0]; } catch (e) { /* handled below */ }
  if (!plan) throw new HttpError(400, 'Exam pins are not available right now. Please try again later.', 'failed');
  const base = rawPrice(plan);
  const cost = calculateSellingPrice(base, await isResellerUser(req.user.uid), false) * pins;
  const name = ['WAEC', 'NECO', 'NABTEB'][board - 1];
  await purchaseFlow(res, req.user.uid, {
    cost, type: 'Exam', title: `${name} Result PIN x${pins}`,
    endpoint: 'exam-pins', payload: { exam_board: board, no_of_pins: pins, max_amount_payable: Math.ceil(base * pins * 1.05) },
    detail: d => (Array.isArray(d.pins) ? d.pins.join('\n') : '')
  });
}));

// ---------- Quick Buy (no account) ----------
// 1) /init saves the order and returns a reference + price  2) customer pays with Korapay
// 3) /complete (or the Korapay webhook) confirms the payment and delivers the data, exactly once
const intentsCol = fdb.collection('quickbuys');
const NETWORK_PRODUCTS = {
  1: ['mtn_sme', 'mtn_cg', 'mtn_awoof', 'mtn_gifting'],
  2: ['glo_cg', 'glo_awoof', 'glo_gifting'],
  3: ['airtel_cg', 'airtel_awoof', 'airtel_gifting'],
  4: ['9mobile_sme', '9mobile_gifting']
};
const QB_REF = /^qb_[a-f0-9]{12}_\d+$/;
const initHits = {};
function limitInit(ip) {
  const now = Date.now();
  const hits = (initHits[ip] || []).filter(t => now - t < 10 * 60 * 1000);
  if (hits.length >= 20) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  hits.push(now); initHits[ip] = hits;
}

function quickView(state) {
  if (state === 'SUCCESS') return { status: 'success', message: 'Data delivered successfully!' };
  if (state === 'FAILED') return { status: 'failed', message: 'Delivery failed. Your payment will be refunded. Keep your reference and contact support.' };
  return { status: 'pending', message: 'Your order is being processed. This page will update shortly.' };
}
async function quickSummary(reference) {
  const snap = await intentsCol.doc(reference).get();
  if (!snap.exists) throw new HttpError(404, 'Order not found.');
  const it = snap.data();
  return { ...quickView(it.state), state: it.state, reference, plan: it.plan_name, mobileno: it.mobileno, amount: it.price, date: it.date };
}

async function deliverQuickBuy(reference, paid) {
  const claim = await fdb.runTransaction(async t => {
    const iref = intentsCol.doc(reference);
    const is = await t.get(iref);
    if (!is.exists) return { err: 'Unknown reference.' };
    const it = is.data();
    if (it.state !== 'AWAITING') return { already: true };
    if (!(paid >= it.price)) return { err: `Payment of ₦${paid} is less than the price of ₦${it.price}.` };
    t.update(iref, { state: 'DELIVERING', paid });
    t.set(ordersCol.doc(reference), { ref: reference, uid: null, guest: true, email: it.email, mobile: it.mobileno, type: 'Quick Buy', title: `Quick Buy — ${it.plan_name} — ${it.mobileno}`, amount: it.price, status: 'PENDING', date: today(), ts: Date.now() });
    return { it };
  });
  if (claim.err) return { ok: false, message: claim.err };
  if (claim.already) return { ok: true };
  const it = claim.it;
  let state = 'PENDING';
  try {
    const d = await providerPost('purchase-data', { network: it.network, dataplan: Number(it.dataplan), mobileno: it.mobileno, client_reference: reference });
    if (isOk(d)) state = 'SUCCESS'; else if (isFailed(d)) state = 'FAILED';
  } catch (e) { state = 'PENDING'; }
  const note = state === 'FAILED' ? 'Provider failed. Refund the customer on Korapay, then tap Refund customer here.'
    : state === 'PENDING' ? 'Provider result unknown. Check EasyAccess, then mark delivered or refund.' : '';
  await intentsCol.doc(reference).update({ state });
  await ordersCol.doc(reference).set({ status: state === 'SUCCESS' ? 'SUCCESS' : 'PENDING', note }, { merge: true });
  return { ok: true };
}

app.post('/api/quick-buy/init', wrap(async (req, res) => {
  limitInit(req.ip);
  const network = Number(req.body.network);
  const pt = String(req.body.product_type || '').toLowerCase();
  const dataplan = String(req.body.dataplan || '');
  const mobileno = String(req.body.mobileno || '');
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!NETWORK_PRODUCTS[network] || !NETWORK_PRODUCTS[network].includes(pt)) throw new HttpError(400, 'Choose a valid network and data type.');
  if (!/^0\d{10}$/.test(mobileno)) throw new HttpError(400, 'Enter a valid 11-digit phone number.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) throw new HttpError(400, 'Enter a valid email address.');
  let plan;
  try { plan = (await fetchPlans(pt)).find(p => planIdOf(p) === dataplan); } catch (e) { /* handled below */ }
  if (!plan) throw new HttpError(400, 'Plan not found. Please reload and try again.');
  const price = calculateSellingPrice(rawPrice(plan), false, false);
  const reference = `qb_${crypto.randomBytes(6).toString('hex')}_${Date.now()}`;
  const planName = String(plan.name || plan.plan_name || 'Data').slice(0, 60);
  await intentsCol.doc(reference).set({ reference, network, product_type: pt, dataplan, plan_name: planName, mobileno, email, price, state: 'AWAITING', date: today(), ts: Date.now() });
  res.json({ status: true, reference, amount: price, plan_name: planName });
}));

app.post('/api/quick-buy/complete', wrap(async (req, res) => {
  const reference = String(req.body.reference || '');
  if (!QB_REF.test(reference)) throw new HttpError(400, 'Invalid reference.');
  let d;
  try {
    const r = await axios.get(`${KORAPAY_BASE_URL}/charges/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` } });
    d = r.data && r.data.status && r.data.data;
  } catch (e) { throw new HttpError(400, 'Could not confirm your payment yet. If you were charged, your data is delivered automatically.'); }
  if (!d || d.status !== 'success' || (d.currency || 'NGN') !== 'NGN') throw new HttpError(400, 'Payment was not completed.');
  const out = await deliverQuickBuy(reference, Number(d.amount));
  if (!out.ok) throw new HttpError(400, out.message);
  res.json(await quickSummary(reference));
}));

app.get('/api/quick-buy/status', wrap(async (req, res) => {
  const reference = String(req.query.reference || '');
  if (!QB_REF.test(reference)) throw new HttpError(400, 'Invalid reference.');
  res.json(await quickSummary(reference));
}));

// ---------- PaymentPoint: a personal bank account number for every user ----------
// Optional: set PAYMENTPOINT_SECRET, PAYMENTPOINT_API_KEY and PAYMENTPOINT_BUSINESS_ID on Render to switch it on.
const PP_BASE = 'https://api.paymentpoint.co';
const PP_SECRET = process.env.PAYMENTPOINT_SECRET || '';
const PP_KEY = process.env.PAYMENTPOINT_API_KEY || '';
const PP_BIZ = process.env.PAYMENTPOINT_BUSINESS_ID || '';
const PP_ON = !!(PP_SECRET && PP_KEY && PP_BIZ);
// Banks to open accounts with: 20946 = Palmpay, 20897 = Opay. If one is not enabled for your business, set PAYMENTPOINT_BANK_CODES on Render, e.g. 20897
// The ID (BVN/NIN) boxes stay hidden unless you set PAYMENTPOINT_ASK_ID=true on Render
const PP_ASK_ID = process.env.PAYMENTPOINT_ASK_ID === 'true';
const PP_BANKS = (process.env.PAYMENTPOINT_BANK_CODES || '20946,20897').split(',').map(x => x.trim()).filter(x => /^\d{5}$/.test(x));
// 'amount_paid' credits everything the customer sent (you absorb PaymentPoint's fee); 'settlement_amount' credits after the fee
const PP_CREDIT = process.env.PAYMENTPOINT_CREDIT === 'settlement_amount' ? 'settlement_amount' : 'amount_paid';

app.post('/api/virtual-account', requireAuth, wrap(async (req, res) => {
  if (!PP_ON) return res.json({ status: true, enabled: false, accounts: [] });
  const ref = usersCol.doc(req.user.uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpError(404, 'Account not found. Please reload the page.');
  const u = snap.data();
  if (u.pp && u.pp.accounts && u.pp.accounts.length) return res.json({ status: true, enabled: true, accounts: u.pp.accounts });
  if (req.body.action !== 'create') return res.json({ status: true, enabled: true, accounts: [], needsDetails: true, name: u.full_name || '', phone: u.phone || '' });

  const name = String(req.body.name || u.full_name || '').trim().replace(/\s+/g, ' ');
  const phone = String(req.body.phone || u.phone || '').trim();
  if (!/^[A-Za-z][A-Za-z .'-]{2,59}$/.test(name)) throw new HttpError(400, 'Enter your full name (letters only).');
  if (!/^0\d{10}$/.test(phone)) throw new HttpError(400, 'Enter a valid 11-digit phone number.');

  await ref.set({ full_name: name, phone }, { merge: true }); // remembered, so a retry (for example to add an ID) needs no re-typing
  const body = { email: req.user.email, name, phoneNumber: phone, bankCode: PP_BANKS.length ? PP_BANKS : ['20946', '20897'], businessId: PP_BIZ };
  const idType = String(req.body.idType || '').toLowerCase();
  const idNumber = String(req.body.idNumber || '').trim();
  if (idType || idNumber) { // only sent when the bank asks for it; passed straight through, never saved or logged
    if (!['bvn', 'nin'].includes(idType) || !/^\d{11}$/.test(idNumber)) throw new HttpError(400, 'Enter your 11-digit BVN or NIN.');
    body.idType = idType; body.idNumber = idNumber;
  }
  const r = await axios.post(`${PP_BASE}/api/v1/createVirtualAccount`, body, {
    headers: { Authorization: `Bearer ${PP_SECRET}`, 'api-key': PP_KEY, 'Content-Type': 'application/json' }, timeout: 30000, validateStatus: () => true
  });
  const d = r.data || {};
  // read the reply flexibly: the list may sit under a slightly different name, and fields may be snake_case
  const list = [d.bankAccounts, d.accounts, d.virtualAccounts, d.data && d.data.bankAccounts, d.data && d.data.accounts].find(Array.isArray) || [];
  const accounts = list.map(a => ({ bank: a.bankName || a.bank_name || a.bank, bankCode: a.bankCode || a.bank_code, accountNumber: String(a.accountNumber || a.account_number || ''), accountName: a.accountName || a.account_name })).filter(a => a.accountNumber);
  if (!accounts.length) {
    console.error('PaymentPoint reply had no bank accounts. keys:', Object.keys(d).join(','), '| banksRequested:', body.bankCode.join(','), '| bankAccounts:', JSON.stringify(d.bankAccounts), '| errors:', JSON.stringify(d.errors));
    const errs = (Array.isArray(d.errors) ? d.errors : []).map(e => (typeof e === 'string' ? e : (e && (e.message || e.error)) || JSON.stringify(e))).filter(Boolean);
    console.error('PaymentPoint create account failed:', r.status, JSON.stringify({ status: d.status, message: d.message, errors: d.errors }).slice(0, 600));
    const text = `${errs.join('; ')} ${d.message || ''}`;
    // a failed bank account very often means the bank wants an ID, so offer the ID boxes once (never again after an ID was already sent)
    if (PP_ASK_ID && !body.idType && /bvn|\bnin\b|kyc|identity|national id|id number|id type|reserved account/i.test(text)) {
      return res.status(400).json({ status: false, needsId: true, message: 'The bank may need your BVN or NIN to open your account number. You can add it below and try again.' });
    }
    let why = errs.join('; ').slice(0, 160);
    if (!why && d.status === 'success') why = 'your account is still being set up. Please try again in a minute';
    else if (!why) why = String(d.message || '').slice(0, 160);
    if (/key|token|auth|secret|bearer|business/i.test(why)) why = '';
    throw new HttpError(502, `Could not create your account number${why ? ': ' + why : ' right now'}. Please try again later or use card or USSD.`);
  }
  await ref.set({ pp: { customer_id: (d.customer && d.customer.customer_id) || null, accounts, phone } }, { merge: true });
  res.json({ status: true, enabled: true, accounts });
}));

// PaymentPoint calls this when money lands in a user's account number. Set it as the webhook URL in your PaymentPoint dashboard:
// https://<your-render-url>/api/paymentpoint-webhook
app.post('/api/paymentpoint-webhook', wrap(async (req, res) => {
  if (!PP_ON) return res.sendStatus(503);
  const sig = String(req.headers['paymentpoint-signature'] || '');
  const hmac = buf => crypto.createHmac('sha256', PP_SECRET).update(buf).digest('hex');
  const valid = sig.length === 64 && [req.rawBody, Buffer.from(JSON.stringify(req.body || {}))]
    .some(b => b && crypto.timingSafeEqual(Buffer.from(hmac(b)), Buffer.from(sig)));
  if (!valid) return res.sendStatus(401);

  const d = req.body || {};
  if (d.notification_status !== 'payment_successful' || d.transaction_status !== 'success') return res.sendStatus(200);
  const txId = String(d.transaction_id || '');
  const amount = Number(PP_CREDIT === 'settlement_amount' ? d.settlement_amount : d.amount_paid);
  if (!/^[\w-]{4,100}$/.test(txId) || !(amount > 0)) return res.sendStatus(400);

  const cust = d.customer || {};
  let userDoc = null;
  if (cust.customer_id) { const q = await usersCol.where('pp.customer_id', '==', String(cust.customer_id)).limit(1).get(); if (!q.empty) userDoc = q.docs[0]; }
  if (!userDoc && cust.email) { const q = await usersCol.where('email', '==', String(cust.email).toLowerCase()).limit(1).get(); if (!q.empty) userDoc = q.docs[0]; }
  const pref = paymentsCol.doc(`pp_${txId}`);
  if (!userDoc) {
    console.error('PaymentPoint payment with no matching user:', txId, JSON.stringify(cust));
    await pref.set({ unmatched: true, amount, customer: cust, date: Date.now() }, { merge: true });
    return res.sendStatus(200); // acknowledged; credit it by hand from the admin panel
  }
  await fdb.runTransaction(async t => {
    const uref = userDoc.ref;
    const [us, ps] = await Promise.all([t.get(uref), t.get(pref)]);
    if (ps.exists) return; // already credited
    const u = us.data();
    u.balance = (u.balance || 0) + amount;
    const tx = addTx(u, { type: 'Transfer', title: 'Bank Transfer Top Up', amount: String(amount), ref: `pp_${txId}`, status: 'SUCCESS' });
    t.set(uref, u);
    t.set(pref, { uid: userDoc.id, amount, date: Date.now() });
    t.set(ordersCol.doc(tx.ref), { ref: tx.ref, uid: userDoc.id, email: u.email, type: 'Top Up', title: 'Bank Transfer Top Up', amount, status: 'SUCCESS', date: today(), ts: Date.now() });
  });
  res.sendStatus(200);
}));

// ---------- Top-ups (Korapay) ----------
// Top-up references look like oyo_<firebase uid>_<time>, so each payment belongs to one user.
async function creditByReference(reference, amount) {
  const m = /^oyo_([A-Za-z0-9]+)_\d+$/.exec(String(reference));
  if (!m) return { ok: false, message: 'Unrecognised reference.' };
  if (!(amount > 0)) return { ok: false, message: 'Invalid amount.' };
  return fdb.runTransaction(async t => {
    const uref = usersCol.doc(m[1]);
    const pref = paymentsCol.doc(String(reference));
    const [us, ps] = await Promise.all([t.get(uref), t.get(pref)]);
    if (!us.exists) return { ok: false, message: 'Account not found for this reference.' };
    const u = us.data();
    if (ps.exists) return { ok: true, already: true, user: u };
    u.balance += amount;
    addTx(u, { type: 'Transfer', title: 'Korapay Wallet Top Up', amount: String(amount), ref: String(reference), status: 'SUCCESS' });
    t.set(uref, u);
    t.set(pref, { uid: m[1], amount, date: Date.now() });
    t.set(ordersCol.doc(String(reference)), { ref: String(reference), uid: m[1], email: u.email, type: 'Top Up', title: 'Korapay Wallet Top Up', amount, status: 'SUCCESS', date: today(), ts: Date.now() });
    return { ok: true, user: u, amount };
  });
}

app.post('/api/verify-korapay-payment', requireAuth, wrap(async (req, res) => {
  const reference = String(req.body.reference || '').trim();
  if (!reference.startsWith(`oyo_${req.user.uid}_`)) {
    throw new HttpError(400, 'This reference does not belong to your account.');
  }
  let d;
  try {
    const r = await axios.get(`${KORAPAY_BASE_URL}/charges/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` }
    });
    d = r.data && r.data.status && r.data.data;
  } catch (e) { throw new HttpError(400, 'Could not locate transaction on Korapay.'); }
  if (!d || d.status !== 'success' || (d.currency || 'NGN') !== 'NGN') {
    throw new HttpError(400, 'Payment not successful on Korapay.');
  }
  const out = await creditByReference(reference, Number(d.amount));
  if (!out.ok) throw new HttpError(400, out.message);
  res.json({ status: true, message: out.already ? 'Payment already credited.' : `Success! ₦${out.amount.toLocaleString('en-NG')} added to your wallet.`, profile: out.user });
}));

// Korapay calls this itself, so wallets are credited even if the user closes the tab.
// In the Korapay dashboard set the webhook URL to: https://<your-render-url>/api/korapay-webhook
app.post('/api/korapay-webhook', wrap(async (req, res) => {
  const body = req.body || {};
  const sig = String(req.headers['x-korapay-signature'] || '');
  const calc = crypto.createHmac('sha256', KORAPAY_SECRET_KEY).update(JSON.stringify(body.data || {})).digest('hex');
  if (sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc))) return res.sendStatus(401);
  const d = body.data || {};
  if (body.event === 'charge.success' && d.status === 'success' && (d.currency || 'NGN') === 'NGN') {
    // an error here returns 500 so Korapay retries
    if (QB_REF.test(String(d.reference))) await deliverQuickBuy(d.reference, Number(d.amount));
    else await creditByReference(d.reference, Number(d.amount));
  }
  res.sendStatus(200);
}));

// ---------- Reseller upgrade, referrals, withdrawals ----------
app.post('/api/upgrade-reseller', requireAuth, wrap(async (req, res) => {
  const u = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, req.user.uid);
    if (u.is_reseller) throw new HttpError(400, 'You are already a reseller.');
    if (u.balance < RESELLER_FEE) throw new HttpError(400, `Insufficient balance. Top up at least ₦${RESELLER_FEE.toLocaleString('en-NG')}.`);
    let referrer = null;
    if (u.referred_by) {
      const q = await t.get(usersCol.where('ref_code', '==', u.referred_by).limit(1));
      if (!q.empty) referrer = q.docs[0];
    }
    u.balance -= RESELLER_FEE;
    u.is_reseller = true;
    addTx(u, { type: 'Upgrade', title: 'Reseller Account Upgrade', amount: String(RESELLER_FEE), status: 'SUCCESS' });
    if (referrer) {
      const r = referrer.data();
      r.ref_balance = (r.ref_balance || 0) + REFERRAL_BONUS;
      addTx(r, { type: 'Transfer', title: `Referral Bonus (${maskEmail(req.user.email)})`, amount: String(REFERRAL_BONUS), status: 'SUCCESS' });
      const ru = (r.referred_users || []).find(x => x.email === maskEmail(req.user.email));
      if (ru) ru.status = 'Reseller';
      t.set(referrer.ref, r);
    }
    t.set(ref, u);
    return u;
  });
  res.json({ status: true, profile: u });
}));

app.post('/api/transfer-referral', requireAuth, wrap(async (req, res) => {
  const out = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, req.user.uid);
    if (!u.is_reseller) throw new HttpError(403, 'Only Reseller accounts can transfer referral earnings. Upgrade to Reseller to unlock them.');
    if (!(u.ref_balance > 0)) throw new HttpError(400, 'No referral balance available to transfer.');
    const amt = u.ref_balance;
    u.ref_balance = 0;
    u.balance += amt;
    addTx(u, { type: 'Transfer', title: 'Referral Bonus Transferred to Main', amount: String(amt), status: 'SUCCESS' });
    t.set(ref, u);
    return { u, amt };
  });
  res.json({ status: true, amount: out.amt, profile: out.u });
}));

app.post('/api/withdraw', requireAuth, wrap(async (req, res) => {
  const bank = String(req.body.bank || '').replace(/[^\w\s&.-]/g, '').slice(0, 40);
  const account = String(req.body.account || '');
  const amt = Number(req.body.amount);
  if (!bank || !/^\d{10}$/.test(account) || !Number.isFinite(amt) || amt < 1000) {
    throw new HttpError(400, 'Enter a bank, a 10-digit account number and at least ₦1,000.');
  }
  const u = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, req.user.uid);
    if (!u.is_reseller) throw new HttpError(403, 'Only Reseller accounts can withdraw referral earnings. Upgrade to Reseller to withdraw.');
    if ((u.ref_balance || 0) < amt) throw new HttpError(400, 'Insufficient referral balance.');
    u.ref_balance -= amt;
    const tx = addTx(u, { type: 'Withdrawal', title: `Withdrawal to ${bank} ${account}`, amount: String(amt), status: 'PENDING' });
    t.set(ref, u);
    t.set(withdrawalsCol.doc(tx.ref), { ref: tx.ref, uid: req.user.uid, email: req.user.email, bank, account, amount: amt, status: 'PENDING', date: today() });
    return u;
  });
  res.json({ status: true, message: 'Withdrawal request received. It will be paid after review.', profile: u });
}));

// ---------- Admin ----------
async function findUserByEmail(email) {
  const q = await usersCol.where('email', '==', String(email || '').toLowerCase()).limit(1).get();
  if (q.empty) throw new HttpError(404, 'Target email not registered on platform.', 'error');
  return q.docs[0];
}

app.get('/api/wallet-balance', adminOnly, wrap(async (req, res) => {
  try {
    const r = await axios.get(`${EASY_ACCESS_BASE}/wallet-balance`, { headers: getEasyAccessHeaders(), timeout: 10000 });
    res.json({ balance: r.data?.balance || r.data?.amount || '0.00' });
  } catch (e) { res.json({ balance: 'Unavailable' }); }
}));

app.post('/api/admin/fund-wallet', adminOnly, wrap(async (req, res) => {
  const { user_email, action_type } = req.body;
  const val = Number(req.body.amount);
  if (!(val > 0) || !['credit', 'debit'].includes(action_type)) throw new HttpError(400, 'Invalid amount or action.', 'error');
  const doc = await findUserByEmail(user_email);
  const bal = await fdb.runTransaction(async t => {
    const { ref, u } = await getUserTx(t, doc.id, 'error');
    u.balance = action_type === 'credit' ? u.balance + val : Math.max(0, u.balance - val);
    addTx(u, { type: 'Admin Adjustment', dir: action_type, title: `Admin ${action_type === 'credit' ? 'Credit' : 'Debit'}`, amount: String(val), status: 'SUCCESS' });
    t.set(ref, u);
    return u.balance;
  });
  walletCache.t = 0;
  res.json({ status: 'success', message: `Balance ${action_type}ed by ₦${val.toLocaleString('en-NG')}. New balance: ₦${bal.toLocaleString('en-NG')}` });
}));

app.post('/api/admin/toggle-reseller', adminOnly, wrap(async (req, res) => {
  const doc = await findUserByEmail(req.body.user_email);
  const flag = Boolean(req.body.is_reseller);
  await doc.ref.update({ is_reseller: flag });
  res.json({ status: 'success', message: `Reseller status set to ${flag} for ${doc.data().email}.` });
}));

app.post('/api/admin/announcement', adminOnly, wrap(async (req, res) => {
  await fdb.doc('meta/announcement').set({ message: String(req.body.message || '') });
  res.json({ status: 'success', message: 'Announcement published successfully.' });
}));

app.get('/api/admin/withdrawals', adminOnly, wrap(async (req, res) => {
  const q = await withdrawalsCol.where('status', '==', 'PENDING').get();
  res.json({ status: 'success', withdrawals: q.docs.map(d => d.data()) });
}));

// After you pay the person from your bank app, mark it done. success:false refunds their referral wallet.
app.post('/api/admin/withdrawal-done', adminOnly, wrap(async (req, res) => {
  const ok = Boolean(req.body.success);
  const status = await fdb.runTransaction(async t => {
    const wref = withdrawalsCol.doc(String(req.body.ref || 'none'));
    const ws = await t.get(wref);
    if (!ws.exists || ws.data().status !== 'PENDING') throw new HttpError(404, 'Pending withdrawal not found.', 'error');
    const w = ws.data();
    const { ref, u } = await getUserTx(t, w.uid, 'error');
    const x = u.transactions.find(y => y.ref === w.ref);
    if (x) x.status = ok ? 'SUCCESS' : 'FAILED';
    if (!ok) u.ref_balance = (u.ref_balance || 0) + w.amount;
    t.set(ref, u);
    t.update(wref, { status: ok ? 'SUCCESS' : 'FAILED' });
    return ok ? 'SUCCESS' : 'FAILED';
  });
  res.json({ status: 'success', message: `Withdrawal marked ${status}.` });
}));

// ---------- Admin panel routes (admin.html) ----------
// Wallet totals: use Firestore's sum if its index exists, otherwise add the balances up directly. Cached for 15 seconds.
let walletCache = { t: 0, v: null };
async function walletTotals() {
  if (walletCache.v && Date.now() - walletCache.t < 15 * 1000) return walletCache.v;
  let v;
  try {
    const d = (await usersCol.aggregate({ wallets: AggregateField.sum('balance'), refs: AggregateField.sum('ref_balance') }).get()).data();
    v = { wallets: d.wallets || 0, refs: d.refs || 0 };
  } catch (e) {
    v = { wallets: 0, refs: 0 };
    (await usersCol.select('balance', 'ref_balance').get()).forEach(doc => { const u = doc.data(); v.wallets += u.balance || 0; v.refs += u.ref_balance || 0; });
  }
  walletCache = { t: Date.now(), v };
  return v;
}

app.get('/api/admin/stats', adminOnly, wrap(async (req, res) => {
  const warnings = [];
  const safe = async (label, fn) => {
    try { return await fn(); }
    catch (e) { console.error(`Admin stats "${label}" failed:`, e); warnings.push(`${label}: ${e.message}`); return null; }
  };
  const count = async q => (await q.count().get()).data().count;
  const [total, resellers, pendingOrders, pendingWithdrawals, agg, announcement] = await Promise.all([
    safe('users count', () => count(usersCol)),
    safe('resellers count', () => count(usersCol.where('is_reseller', '==', true))),
    safe('pending orders', () => count(ordersCol.where('status', '==', 'PENDING'))),
    safe('pending withdrawals', () => count(withdrawalsCol.where('status', '==', 'PENDING'))),
    safe('wallet totals', walletTotals),
    safe('announcement', async () => { const a = await fdb.doc('meta/announcement').get(); return a.exists ? a.data().message || '' : ''; })
  ]);
  res.json({
    status: 'success', total_users: total, resellers, pending_orders: pendingOrders, pending_withdrawals: pendingWithdrawals,
    total_wallets: agg ? agg.wallets || 0 : null, total_referral: agg ? agg.refs || 0 : null, announcement: announcement || '', warnings
  });
}));

app.get('/api/admin/users', adminOnly, wrap(async (req, res) => {
  const q = String(req.query.search || '').trim().toLowerCase();
  const query = q
    ? usersCol.where('email', '>=', q).where('email', '<=', q + '\uf8ff').limit(50)
    : usersCol.orderBy('created', 'desc').limit(50);
  const snap = await query.get();
  res.json({ status: 'success', users: snap.docs.map(d => { const u = d.data(); return { uid: d.id, email: u.email, balance: u.balance || 0, ref_balance: u.ref_balance || 0, is_reseller: !!u.is_reseller, created: u.created || null }; }) });
}));

app.get('/api/admin/user', adminOnly, wrap(async (req, res) => {
  const doc = await findUserByEmail(req.query.email);
  const u = doc.data();
  res.json({ status: 'success', user: { uid: doc.id, email: u.email, balance: u.balance || 0, ref_balance: u.ref_balance || 0, is_reseller: !!u.is_reseller, created: u.created || null, referred_by: u.referred_by || null, referred_users: u.referred_users || [], transactions: (u.transactions || []).slice(0, 50) } });
}));

app.get('/api/admin/orders', adminOnly, wrap(async (req, res) => {
  let rows;
  if (req.query.status === 'PENDING') {
    rows = (await ordersCol.where('status', '==', 'PENDING').get()).docs.map(d => d.data()).sort((a, b) => b.ts - a.ts);
  } else {
    rows = (await ordersCol.orderBy('ts', 'desc').limit(100).get()).docs.map(d => d.data());
  }
  res.json({ status: 'success', orders: rows });
}));

// Pending order: success = it was delivered, false = refund the customer's wallet
app.post('/api/admin/resolve-order', adminOnly, wrap(async (req, res) => {
  const ok = Boolean(req.body.success);
  const out = await fdb.runTransaction(async t => {
    const os = await t.get(ordersCol.doc(String(req.body.ref || 'none')));
    if (!os.exists || os.data().status !== 'PENDING') throw new HttpError(404, 'Pending order not found.', 'error');
    const o = os.data();
    if (o.guest) { // Quick Buy customer: no wallet, so a refund is done on Korapay
      t.update(os.ref, { status: ok ? 'SUCCESS' : 'FAILED', note: '' });
      t.update(intentsCol.doc(o.ref), { state: ok ? 'SUCCESS' : 'FAILED' });
      return { guest: true };
    }
    const { ref, u } = await getUserTx(t, o.uid, 'error');
    const x = u.transactions.find(y => y.ref === o.ref);
    if (x) x.status = ok ? 'SUCCESS' : 'FAILED';
    if (!ok) u.balance += Number(o.amount);
    t.set(ref, u);
    t.update(os.ref, { status: ok ? 'SUCCESS' : 'FAILED' });
    return { guest: false };
  });
  const msg = ok ? 'Order marked as delivered.' : (out.guest ? 'Marked failed. Make sure you refunded the customer from your Korapay dashboard.' : 'Order failed and the customer was refunded.');
  res.json({ status: 'success', message: msg });
}));

app.get('/api/admin/settings', adminOnly, (req, res) => res.json({ status: 'success', settings }));

app.post('/api/admin/settings', adminOnly, wrap(async (req, res) => {
  const m = Number(req.body.profit_margin_percent);
  if (!Number.isFinite(m) || m < 0 || m > 100) throw new HttpError(400, 'Margin must be a number between 0 and 100.', 'error');
  settings.profit_margin_percent = m;
  await fdb.doc('meta/settings').set({ profit_margin_percent: m }, { merge: true });
  Object.keys(planCache).forEach(k => delete planCache[k]);
  res.json({ status: 'success', message: `Data/exam margin set to ${m}%.`, settings });
}));

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
