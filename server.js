const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'AuthorizationToken']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || '';
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || 'sk_live_GBnW4AxFZVP1FpBhiwG8UNLHZwcpQkAVyuiPKReH';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'oyodata_admin_secure_99';

const PROFIT_MARGIN = 0.09; 
const DB_FILE = path.join(__dirname, 'db.json');

// Persistent Database Handler
let db = { users: {}, processedReferences: [] };
if (fs.existsSync(DB_FILE)) {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(data);
    db.users = parsed.users || {};
    db.processedReferences = new Set(parsed.processedReferences || []);
  } catch (e) {
    console.error("Error reading db.json, initializing fresh store.");
  }
}

function saveDatabase() {
  try {
    const dataToSave = {
      users: db.users,
      processedReferences: Array.from(db.processedReferences)
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(dataToSave, null, 2));
  } catch (e) {
    console.error("Error saving to db.json:", e);
  }
}

const getEasyAccessHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  if (isCable) return Math.ceil(original / 100) * 100;
  const resellerDiscount = isReseller ? 5 : 0;
  const markupPrice = original * (1 + PROFIT_MARGIN);
  const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
  // Add automatic 1.5% charge markup
  const withGatewayFee = finalPrice * 1.015;
  return Math.ceil(withGatewayFee);
}

// -------------------------------------------------------------
// USER PROFILE & REFERRAL ENDPOINTS
// -------------------------------------------------------------

app.post('/api/get-user-profile', (req, res) => {
  const { email, referredBy } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  if (!db.users[email]) {
    db.users[email] = { 
      balance: 0, 
      ref_balance: 0, 
      is_reseller: false, 
      transactions: [],
      referred_by: referredBy || null,
      referred_users: []
    };
    
    // Link to referrer if code provided
    if (referredBy) {
      for (const uEmail in db.users) {
        if (uEmail !== email && uEmail.slice(0, 6) === referredBy) {
          db.users[uEmail].referred_users.push({ email, status: 'Active', date: new Date().toLocaleDateString('en-GB') });
          break;
        }
      }
    }
    saveDatabase();
  }

  return res.json({ status: true, profile: db.users[email] });
});

app.post('/api/update-user-data', (req, res) => {
  const { email, balance, ref_balance, is_reseller, transaction } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  if (!db.users[email]) {
    db.users[email] = { balance: 0, ref_balance: 0, is_reseller: false, transactions: [], referred_users: [] };
  }

  const wasReseller = db.users[email].is_reseller;

  if (balance !== undefined) db.users[email].balance = Number(balance);
  if (ref_balance !== undefined) db.users[email].ref_balance = Number(ref_balance);
  if (is_reseller !== undefined) db.users[email].is_reseller = Boolean(is_reseller);
  
  if (transaction) {
    db.users[email].transactions.unshift(transaction);
  }

  // If user just upgraded to reseller, check if they were referred and reward ₦1,000 to referrer
  if (!wasReseller && db.users[email].is_reseller && db.users[email].referred_by) {
    const refCode = db.users[email].referred_by;
    for (const uEmail in db.users) {
      if (uEmail.slice(0, 6) === refCode) {
        db.users[uEmail].ref_balance += 1000;
        db.users[uEmail].transactions.unshift({
          type: 'Transfer',
          title: `Referral Commission from ${email}`,
          amount: '1000',
          ref: `ref_com_${Date.now()}`,
          date: new Date().toLocaleDateString('en-GB'),
          status: 'SUCCESS'
        });
        break;
      }
    }
  }

  saveDatabase();
  return res.json({ status: true, profile: db.users[email] });
});

// -------------------------------------------------------------
// VTU PLANS & PURCHASES WITH REAL DATA
// -------------------------------------------------------------

app.get('/api/get-plans', async (req, res) => {
  const targetType = (req.query.product_type || 'mtn_sme').toLowerCase();
  const resellerStatus = req.query.is_reseller === 'true';
  const isCable = ['dstv', 'gotv', 'startimes', 'showmax'].includes(targetType);

  try {
    const response = await axios.get(`${EASY_ACCESS_BASE}/get-plans?product_type=${targetType}`, {
      headers: getEasyAccessHeaders(),
      timeout: 12000,
      validateStatus: () => true
    });

    let raw = response.data;
    let list = [];

    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'object' && raw !== null) {
      if (Array.isArray(raw.plans)) list = raw.plans;
      else if (Array.isArray(raw.data)) list = raw.data;
      else if (Array.isArray(raw.packages)) list = raw.packages;
      else {
        for (const key in raw) {
          if (Array.isArray(raw[key])) { list = raw[key]; break; }
        }
      }
    }

    const markedUpList = list.map(plan => {
      const originalPrice = plan.price || plan.plan_price || plan.amount || plan.package_amount || 0;
      return {
        plan_id: plan.plan_id || plan.id || plan.package_id,
        name: plan.name || plan.plan_name || plan.package_name || 'VTU Plan',
        validity: plan.validity || plan.plan_validity || plan.day || '30 Days',
        cost_price: originalPrice,
        price: calculateSellingPrice(originalPrice, resellerStatus, isCable)
      };
    });

    return res.json({ status: 'success', plans: markedUpList });
  } catch (error) {
    return res.status(200).json({ status: 'failed', message: error.message, plans: [] });
  }
});

app.post('/api/purchase-data', async (req, res) => {
  const { email, network, dataplan, mobileno, price, client_reference } = req.body;
  if (!email || !db.users[email]) return res.status(400).json({ status: 'failed', message: 'User not authenticated' });

  const cost = Number(price || 0);

  if (db.users[email].balance < cost) {
    return res.status(400).json({ status: 'failed', message: 'Insufficient wallet balance.' });
  }

  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/purchase-data`, {
      network: Number(network),
      dataplan: Number(dataplan),
      mobileno: String(mobileno),
      client_reference: client_reference || `ref_${Date.now()}`
    }, { headers: getEasyAccessHeaders(), validateStatus: () => true });

    const resData = response.data;
    const isSuccess = resData.code === 200 || (resData.status && resData.status.toLowerCase() === 'success');

    if (isSuccess) {
      db.users[email].balance -= cost;
      const newTx = {
        type: 'Data',
        title: `Data Purchase — ${mobileno}`,
        amount: cost.toString(),
        ref: client_reference,
        date: new Date().toLocaleDateString('en-GB'),
        status: 'SUCCESS'
      };
      db.users[email].transactions.unshift(newTx);
      saveDatabase();

      return res.json({ status: 'success', message: resData.message || 'Data purchase successful!', profile: db.users[email], transaction: newTx });
    } else {
      return res.status(400).json({ status: 'failed', message: resData.message || 'Data purchase failed at provider.' });
    }
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Network error processing purchase.' });
  }
});

// -------------------------------------------------------------
// ADMIN CONTROLS (Real Portal Management)
// -------------------------------------------------------------

app.get('/api/admin/get-all-users', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: false, message: 'Unauthorized' });
  return res.json({ status: true, users: db.users });
});

app.post('/api/admin/modify-user', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: false, message: 'Unauthorized' });

  const { email, balance, ref_balance, is_reseller } = req.body;
  if (!db.users[email]) return res.status(404).json({ status: false, message: 'User not found' });

  if (balance !== undefined) db.users[email].balance = Number(balance);
  if (ref_balance !== undefined) db.users[email].ref_balance = Number(ref_balance);
  if (is_reseller !== undefined) db.users[email].is_reseller = Boolean(is_reseller);

  saveDatabase();
  return res.json({ status: true, message: 'User updated successfully', profile: db.users[email] });
});

// -------------------------------------------------------------
// PAYMENT VERIFICATION & WEBHOOKS
// -------------------------------------------------------------

app.post('/api/verify-korapay-payment', async (req, res) => {
  const { email, reference } = req.body;
  if (!email || !reference) return res.status(400).json({ status: false, message: 'Email and Reference ID required.' });

  try {
    const response = await axios.get(`${KORAPAY_BASE_URL}/charges/${reference}`, {
      headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` }
    });

    const txData = response.data?.data;
    if (response.data && response.data.status && txData?.status === 'success') {
      const amountPaid = Number(txData.amount);

      if (!db.users[email]) {
        db.users[email] = { balance: 0, ref_balance: 0, is_reseller: false, transactions: [], referred_users: [] };
      }

      if (db.processedReferences.has(reference)) {
        return res.json({ status: true, message: 'Payment already credited.', profile: db.users[email] });
      }

      db.processedReferences.add(reference);
      db.users[email].balance += amountPaid;

      const newTx = {
        type: 'Transfer',
        title: 'Korapay Wallet Top Up',
        amount: amountPaid.toString(),
        ref: reference,
        date: new Date().toLocaleDateString('en-GB'),
        status: 'SUCCESS'
      };
      db.users[email].transactions.unshift(newTx);
      saveDatabase();

      return res.json({ status: true, message: `Success! ₦${amountPaid.toLocaleString('en-NG')} added to balance.`, profile: db.users[email] });
    } else {
      return res.status(400).json({ status: false, message: 'Payment not successful on Korapay.' });
    }
  } catch (err) {
    return res.status(400).json({ status: false, message: 'Could not locate transaction on Korapay.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
