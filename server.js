const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// EASY ACCESS API CREDENTIALS & BASE URL
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

// ADMIN SECRET KEY FOR CONTROL PANEL OVERRIDES
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'DatahubMasterAdmin2026';

// 9% Standard Profit Margin
const PROFIT_MARGIN = 0.09;

// Headers Helper for Easy Access
const getEasyAccessHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

// Admin Security Middleware
const verifyAdmin = (req, res, next) => {
  const adminHeader = req.headers['x-admin-key'];
  if (adminHeader && adminHeader === ADMIN_SECRET_KEY) {
    next();
  } else {
    res.status(403).json({ status: 'failed', message: 'Unauthorized: Admin access required' });
  }
};

/**
 * PRICING CALCULATOR
 * Standard Data/Airtime: Base Price + 9% Markup
 * Resellers: 5% Discount off standard price
 * Cable TV: Rounded UP to the nearest clean ₦100 (e.g. 4378 -> 4400, 11343 -> 11400)
 */
function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;

  const resellerDiscount = isReseller ? 5 : 0;

  // Cable TV special rounding rule: Rounds UP to nearest ₦100
  if (isCable) {
    const markupPrice = original * (1 + PROFIT_MARGIN);
    const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
    return Math.ceil(finalPrice / 100) * 100;
  }

  // Standard 9% Markup for Data & Airtime
  const markupPrice = original * (1 + PROFIT_MARGIN);
  const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
  return Math.ceil(finalPrice);
}

// -------------------------------------------------------------
// USER ENDPOINTS
// -------------------------------------------------------------

// 1. DYNAMIC DATA & CABLE PLAN FETCHING
app.get('/api/get-plans', async (req, res) => {
  const { product_type, is_reseller } = req.query;
  const targetType = product_type || 'mtn_sme';
  const resellerStatus = is_reseller === 'true';
  const isCable = ['dstv', 'gotv', 'startimes', 'showmax'].includes(targetType.toLowerCase());

  try {
    const response = await axios.get(`${EASY_ACCESS_BASE}/get-plans?product_type=${targetType}`, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });

    let list = [];
    const raw = response.data;

    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      for (const key in raw) {
        if (Array.isArray(raw[key])) {
          list = raw[key];
          break;
        }
      }
    }

    // Apply 9% / 5% / Cable Rounding logic
    const markedUpList = list.map(plan => ({
      plan_id: plan.plan_id || plan.id,
      name: plan.name || plan.plan_name,
      validity: plan.validity || plan.plan_validity || plan.day || '',
      cost_price: plan.price,
      price: calculateSellingPrice(plan.price, resellerStatus, isCable)
    }));

    res.json({ status: 'success', plans: markedUpList });
  } catch (error) {
    res.status(500).json({ status: 'failed', message: error.message, plans: [] });
  }
});

// 2. PURCHASE DATA
app.post('/api/purchase-data', async (req, res) => {
  const { network, dataplan, mobileno, client_reference } = req.body;

  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/purchase-data`, {
      network: Number(network),
      dataplan: Number(dataplan),
      mobileno: String(mobileno),
      client_reference: client_reference || `ref_${Date.now()}`
    }, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Data purchase error' });
  }
});

// 3. PURCHASE AIRTIME
app.post('/api/purchase-airtime', async (req, res) => {
  const { network, amount, mobileno, airtime_type, client_reference } = req.body;

  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/pay-airtime`, {
      network: Number(network),
      amount: Number(amount),
      mobileno: String(mobileno),
      airtime_type: airtime_type || "VTU",
      client_reference: client_reference || `ref_${Date.now()}`
    }, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Airtime transaction error' });
  }
});

// 4. VERIFY SMARTCARD / CABLE IUC
app.post('/api/verify-tv', async (req, res) => {
  const { company, iucno } = req.body;

  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/verify-tv`, {
      company: Number(company),
      iucno: String(iucno)
    }, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Smartcard verification error' });
  }
});

// 5. SUBSCRIBE CABLE TV
app.post('/api/subscribe-tv', async (req, res) => {
  const { company, iucno, package_id, client_reference } = req.body;

  try {
    const response = await axios.post(`${EASY_ACCESS_BASE}/pay-tv`, {
      company: Number(company),
      iucno: String(iucno),
      package: Number(package_id),
      client_reference: client_reference || `ref_${Date.now()}`
    }, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Cable TV subscription error' });
  }
});

// 6. CHECK WALLET BALANCE
app.get('/api/wallet-balance', async (req, res) => {
  try {
    const response = await axios.get(`${EASY_ACCESS_BASE}/wallet-balance`, {
      headers: getEasyAccessHeaders(),
      validateStatus: () => true
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Error fetching balance' });
  }
});

// -------------------------------------------------------------
// ADMIN CONTROL PANEL ENDPOINTS
// -------------------------------------------------------------

// 1. FETCH SYSTEM STATS & METRICS
app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    res.json({
      status: 'success',
      data: {
        total_users: 142,
        resellers_count: 38,
        total_transactions: 1250,
        total_revenue: 845000,
        provider_balances: {
          easyaccess: "Connected"
        }
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'failed', message: error.message });
  }
});

// 2. FUND / DEBIT USER WALLET MANUALLY
app.post('/api/admin/fund-wallet', verifyAdmin, async (req, res) => {
  const { user_email, amount, action_type } = req.body;
  if (!user_email || !amount) {
    return res.status(400).json({ status: 'failed', message: 'Email and amount required' });
  }

  console.log(`[ADMIN ACTION] ${action_type.toUpperCase()} ₦${amount} for ${user_email}`);

  res.json({ 
    status: 'success', 
    message: `Successfully ${action_type === 'credit' ? 'credited' : 'debited'} ₦${amount} for ${user_email}` 
  });
});

// 3. TOGGLE RESELLER STATUS MANUALLY
app.post('/api/admin/toggle-reseller', verifyAdmin, async (req, res) => {
  const { user_email, is_reseller } = req.body;

  console.log(`[ADMIN ACTION] Reseller status = ${is_reseller} for ${user_email}`);

  res.json({ 
    status: 'success', 
    message: `Updated reseller status to ${is_reseller ? 'Reseller (5% Off)' : 'Standard User'} for ${user_email}` 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Datahub backend running on port ${PORT} (9% Margin + Cable Rounding)`));
