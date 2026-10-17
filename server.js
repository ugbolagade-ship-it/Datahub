const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();

// Enhanced CORS & Preflight Handling
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key, AuthorizationToken');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------------------------------------------
// MONGODB ATLAS CLOUD DATABASE SETUP
// -------------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB Atlas successfully.'))
    .catch(err => console.error('MongoDB Connection Error:', err));
} else {
  console.warn('Warning: MONGODB_URI environment variable is not defined.');
}

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  ref_balance: { type: Number, default: 0 },
  is_reseller: { type: Boolean, default: false },
  referred_by: { type: String, default: null },
  referred_users: { type: Array, default: [] },
  transactions: { type: Array, default: [] }
});
const User = mongoose.model('User', userSchema);

// System Announcement Schema
const settingSchema = new mongoose.Schema({
  key: { type: String, default: 'announcement' },
  value: { type: String, default: '' }
});
const Setting = mongoose.model('Setting', settingSchema);

// Processed Payment Reference Schema
const txRefSchema = new mongoose.Schema({
  reference: { type: String, unique: true }
});
const TxRef = mongoose.model('TxRef', txRefSchema);

// -------------------------------------------------------------
// API KEYS & CONSTANTS
// -------------------------------------------------------------
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || '';
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || 'sk_live_GBnW4AxFZVP1FpBhiwG8UNLHZwcpQkAVyuiPKReH';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'oyodata_admin_secure_99';

const PROFIT_MARGIN = 0.09;

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
  const withGatewayFee = finalPrice * 1.015; // Automatic 1.5% checkout fee
  return Math.ceil(withGatewayFee);
}

// -------------------------------------------------------------
// USER PROFILE & REFERRAL ENDPOINTS
// -------------------------------------------------------------

app.post('/api/get-user-profile', async (req, res) => {
  const { email, referredBy } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  try {
    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        email,
        balance: 0,
        ref_balance: 0,
        is_reseller: false,
        referred_by: referredBy || null,
        referred_users: [],
        transactions: []
      });

      if (referredBy) {
        const allUsers = await User.find({});
        for (const u of allUsers) {
          if (u.email.slice(0, 6) === referredBy) {
            u.referred_users.push({ email, status: 'Active', date: new Date().toLocaleDateString('en-GB') });
            await u.save();
            break;
          }
        }
      }
      await user.save();
    }

    const announceDoc = await Setting.findOne({ key: 'announcement' });
    return res.json({ status: true, profile: user, announcement: announceDoc ? announceDoc.value : '' });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Database query failed' });
  }
});

app.post('/api/update-user-data', async (req, res) => {
  const { email, balance, ref_balance, is_reseller, transaction } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email required' });

  try {
    let user = await User.findOne({ email });
    if (!user) {
      user = new User({ email });
    }

    const wasReseller = user.is_reseller;

    if (balance !== undefined) user.balance = Number(balance);
    if (ref_balance !== undefined) user.ref_balance = Number(ref_balance);
    if (is_reseller !== undefined) user.is_reseller = Boolean(is_reseller);

    if (transaction) {
      user.transactions.unshift(transaction);
    }

    // Credit referrer ₦1,000 on reseller upgrade
    if (!wasReseller && user.is_reseller && user.referred_by) {
      const allUsers = await User.find({});
      for (const u of allUsers) {
        if (u.email.slice(0, 6) === user.referred_by) {
          u.ref_balance += 1000;
          u.transactions.unshift({
            type: 'Transfer',
            title: `Referral Bonus (${email})`,
            amount: '1000',
            ref: `ref_com_${Date.now()}`,
            date: new Date().toLocaleDateString('en-GB'),
            status: 'SUCCESS'
          });
          await u.save();
          break;
        }
      }
    }

    await user.save();
    return res.json({ status: true, profile: user });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Error updating user profile' });
  }
});

// -------------------------------------------------------------
// REAL VTU PLAN FETCHING
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
  
  const user = await User.findOne({ email });
  if (!email || !user) return res.status(400).json({ status: 'failed', message: 'User not found' });

  const cost = Number(price || 0);

  if (user.balance < cost) {
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
      user.balance -= cost;
      const newTx = {
        type: 'Data',
        title: `Data Purchase — ${mobileno}`,
        amount: cost.toString(),
        ref: client_reference,
        date: new Date().toLocaleDateString('en-GB'),
        status: 'SUCCESS'
      };
      user.transactions.unshift(newTx);
      await user.save();

      return res.json({ status: 'success', message: resData.message || 'Data purchase successful!', profile: user, transaction: newTx });
    } else {
      return res.status(400).json({ status: 'failed', message: resData.message || 'Provider purchase failed.' });
    }
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Network error during purchase.' });
  }
});

// -------------------------------------------------------------
// MASTER ADMIN ENDPOINTS
// -------------------------------------------------------------

app.get('/api/admin/stats', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized key.' });

  try {
    const totalUsers = await User.countDocuments({});
    const resellers = await User.countDocuments({ is_reseller: true });

    return res.json({
      status: 'success',
      total_users: totalUsers,
      resellers: resellers
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'Database query error.' });
  }
});

app.get('/api/wallet-balance', async (req, res) => {
  try {
    const response = await axios.get(`${EASY_ACCESS_BASE}/wallet-balance`, {
      headers: getEasyAccessHeaders(),
      timeout: 10000
    });
    return res.json({ balance: response.data?.balance || response.data?.amount || "0.00" });
  } catch (e) {
    return res.json({ balance: "Available" });
  }
});

app.post('/api/admin/fund-wallet', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized key.' });

  const { user_email, action_type, amount } = req.body;
  const user = await User.findOne({ email: user_email });

  if (!user) {
    return res.status(404).json({ status: 'error', message: 'Target email not registered on platform.' });
  }

  const val = Number(amount);
  if (action_type === 'credit') {
    user.balance += val;
  } else if (action_type === 'debit') {
    user.balance = Math.max(0, user.balance - val);
  }

  user.transactions.unshift({
    type: 'Admin Adjustment',
    title: `Admin ${action_type === 'credit' ? 'Credit' : 'Debit'}`,
    amount: val.toString(),
    ref: `adm_${Date.now()}`,
    date: new Date().toLocaleDateString('en-GB'),
    status: 'SUCCESS'
  });

  await user.save();
  return res.json({ status: 'success', message: `User balance ${action_type}ed by ₦${val.toLocaleString('en-NG')}. New balance: ₦${user.balance.toLocaleString('en-NG')}` });
});

app.post('/api/admin/toggle-reseller', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized key.' });

  const { user_email, is_reseller } = req.body;
  const user = await User.findOne({ email: user_email });

  if (!user) {
    return res.status(404).json({ status: 'error', message: 'User not found.' });
  }

  user.is_reseller = Boolean(is_reseller);
  await user.save();

  return res.json({ status: 'success', message: `Reseller status set to ${is_reseller} for ${user_email}.` });
});

app.post('/api/admin/announcement', async (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== ADMIN_SECRET_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized key.' });

  await Setting.findOneAndUpdate({ key: 'announcement' }, { value: req.body.message || '' }, { upsert: true });

  return res.json({ status: 'success', message: 'Announcement published successfully.' });
});

// -------------------------------------------------------------
// KORAPAY RESOLVE PAYMENT & WEBHOOK
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

      let user = await User.findOne({ email });
      if (!user) {
        user = new User({ email });
      }

      const existingTx = await TxRef.findOne({ reference });
      if (existingTx) {
        return res.json({ status: true, message: 'Payment already credited.', profile: user });
      }

      await TxRef.create({ reference });
      user.balance += amountPaid;

      user.transactions.unshift({
        type: 'Transfer',
        title: 'Korapay Wallet Top Up',
        amount: amountPaid.toString(),
        ref: reference,
        date: new Date().toLocaleDateString('en-GB'),
        status: 'SUCCESS'
      });

      await user.save();

      return res.json({ status: true, message: `Success! ₦${amountPaid.toLocaleString('en-NG')} verified and added to balance.`, profile: user });
    } else {
      return res.status(400).json({ status: false, message: 'Payment not successful on Korapay.' });
    }
  } catch (err) {
    return res.status(400).json({ status: false, message: 'Could not locate transaction on Korapay.' });
  }
});

// Korapay Automatic Webhook Endpoint
app.post('/api/korapay-webhook', async (req, res) => {
  try {
    const data = req.body;
    if (data && data.event === 'charge.success' && data.data) {
      const txData = data.data;
      const userEmail = txData.customer?.email;
      const reference = txData.reference;
      const amountPaid = Number(txData.amount);

      if (userEmail && reference) {
        const existingTx = await TxRef.findOne({ reference });
        if (!existingTx) {
          await TxRef.create({ reference });

          let user = await User.findOne({ email: userEmail });
          if (!user) {
            user = new User({ email: userEmail });
          }

          user.balance += amountPaid;
          user.transactions.unshift({
            type: 'Transfer',
            title: 'Korapay Automatic Top Up',
            amount: amountPaid.toString(),
            ref: reference,
            date: new Date().toLocaleDateString('en-GB'),
            status: 'SUCCESS'
          });

          await user.save();
          console.log(`[Webhook] Automatically credited ₦${amountPaid} to ${userEmail}`);
        }
      }
    }
    return res.status(200).send('Webhook Received');
  } catch (err) {
    console.error('Webhook Error:', err);
    return res.status(200).send('Webhook Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
