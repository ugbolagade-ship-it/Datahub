const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
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
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || 'pk_live_qMvFy8kc7XSFtzWAsSYrSGgCwSgPcchuttv2zNAL';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

const PROFIT_MARGIN = 0.09; 

// In-Memory Database Store
const db = {
  users: {},
  processedReferences: new Set()
};

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
  return Math.ceil(finalPrice);
}

// -------------------------------------------------------------
// USER DATABASE SYNCHRONIZATION ENDPOINTS
// -------------------------------------------------------------

app.post('/api/get-user-profile', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  if (!db.users[email]) {
    db.users[email] = { balance: 0, ref_balance: 0, is_reseller: false, transactions: [] };
  }

  return res.json({ status: true, profile: db.users[email] });
});

app.post('/api/update-user-data', (req, res) => {
  const { email, balance, ref_balance, is_reseller, transaction } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  if (!db.users[email]) {
    db.users[email] = { balance: 0, ref_balance: 0, is_reseller: false, transactions: [] };
  }

  if (balance !== undefined) db.users[email].balance = Number(balance);
  if (ref_balance !== undefined) db.users[email].ref_balance = Number(ref_balance);
  if (is_reseller !== undefined) db.users[email].is_reseller = Boolean(is_reseller);
  
  if (transaction) {
    db.users[email].transactions.unshift(transaction);
  }

  return res.json({ status: true, profile: db.users[email] });
});

// -------------------------------------------------------------
// VTU PLANS & PURCHASE WITH BALANCE DEDUCTION
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

  // Check sufficient balance
  if (db.users[email].balance < cost) {
    return res.status(400).json({ status: 'failed', message: 'Insufficient wallet balance. Please top up your wallet.' });
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
      // Deduct balance
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
      return res.json({ status: 'success', message: resData.message || 'Data purchase successful!', profile: db.users[email], transaction: newTx });
    } else {
      return res.status(400).json({ status: 'failed', message: resData.message || 'Data purchase failed at provider.' });
    }
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Network error processing purchase.' });
  }
});

app.post('/api/verify-tv', async (req, res) => {
  const { company, iucno } = req.body;
  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/verify-tv`, {
      company: Number(company),
      iucno: String(iucno)
    }, { headers: getEasyAccessHeaders(), validateStatus: () => true });

    return res.json(response.data);
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Verification failed' });
  }
});

// -------------------------------------------------------------
// LIVE KORAPAY VERIFICATION FOR "RESOLVE REF ID"
// -------------------------------------------------------------

app.post('/api/verify-korapay-payment', async (req, res) => {
  const { email, reference } = req.body;
  if (!email || !reference) {
    return res.status(400).json({ status: false, message: 'Email and Reference ID required.' });
  }

  try {
    const response = await axios.get(`${KORAPAY_BASE_URL}/charges/${reference}`, {
      headers: { Authorization: `Bearer ${KORAPAY_SECRET_KEY}` }
    });

    const txData = response.data?.data;

    if (response.data && response.data.status && txData?.status === 'success') {
      const amountPaid = Number(txData.amount);

      if (!db.users[email]) {
        db.users[email] = { balance: 0, ref_balance: 0, is_reseller: false, transactions: [] };
      }

      if (db.processedReferences.has(reference)) {
        return res.json({ 
          status: true, 
          already_credited: true, 
          message: 'Transaction verified! Payment was already credited.',
          profile: db.users[email]
        });
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

      return res.json({
        status: true,
        already_credited: false,
        message: `Success! ₦${amountPaid.toLocaleString('en-NG')} verified and added to balance.`,
        profile: db.users[email]
      });
    } else {
      return res.status(400).json({ status: false, message: 'Payment not marked as successful on Korapay.' });
    }
  } catch (err) {
    return res.status(400).json({ status: false, message: 'Could not locate transaction. Verify Reference ID.' });
  }
});

// WEBHOOK
app.post('/api/korapay-webhook', (req, res) => {
  try {
    const signature = req.headers['x-korapay-signature'];
    if (!signature) return res.status(401).send("Missing signature");

    const calculatedHash = crypto.createHmac('sha256', KORAPAY_SECRET_KEY).update(JSON.stringify(req.body)).digest('hex');
    if (calculatedHash !== signature) return res.status(400).send("Signature verification failed");

    const { event, data } = req.body;

    if ((event === 'charge.success' || event === 'transfer.success') && data?.status === 'success') {
      const reference = data.reference;
      if (db.processedReferences.has(reference)) return res.status(200).json({ status: true });

      db.processedReferences.add(reference);
      const userEmail = data.customer?.email;
      const amountPaid = Number(data.amount);

      if (userEmail && db.users[userEmail]) {
        db.users[userEmail].balance += amountPaid;
        db.users[userEmail].transactions.unshift({
          type: 'Transfer',
          title: 'Automated Wallet Funding',
          amount: amountPaid.toString(),
          ref: reference,
          date: new Date().toLocaleDateString('en-GB'),
          status: 'SUCCESS'
        });
      }
    }

    return res.status(200).json({ status: true });
  } catch (err) {
    return res.status(500).send("Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
