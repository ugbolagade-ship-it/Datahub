const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

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

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://ugbolagade-ship-it.github.io')
  .split(',').map(s => s.trim());
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';
const PROFIT_MARGIN = 0.09;
const RESELLER_FEE = 2000;
const REFERRAL_BONUS = 1000;
const MAX_TX_KEPT = 200;

const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key']
}));
app.use(express.json({ limit: '100kb' }));

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

function adminOnly(req, res, next) {
  const h = s => crypto.createHash('sha256').update(String(s || '')).digest();
  if (!crypto.timingSafeEqual(h(req.headers['x-admin-key']), h(ADMIN_SECRET_KEY))) {
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
  const finalPrice = original * (1 + PROFIT_MARGIN) * (1 - resellerDiscount / 100);
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
    const { u } = await finishTx(uid, txRef, 'FAILED', cost);
    return res.status(400).json({ status: 'failed', message: d.message || 'Provider purchase failed. You were not charged.', profile: u });
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
    await creditByReference(d.reference, Number(d.amount)); // an error here returns 500 so Korapay retries
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

app.get('/api/admin/stats', adminOnly, wrap(async (req, res) => {
  const total = (await usersCol.count().get()).data().count;
  const resellers = (await usersCol.where('is_reseller', '==', true).count().get()).data().count;
  res.json({ status: 'success', total_users: total, resellers });
}));

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
    addTx(u, { type: 'Admin Adjustment', title: `Admin ${action_type === 'credit' ? 'Credit' : 'Debit'}`, amount: String(val), status: 'SUCCESS' });
    t.set(ref, u);
    return u.balance;
  });
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

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
