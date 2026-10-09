const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();

// Explicit CORS Policy to allow GitHub Pages & local testing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'AuthorizationToken']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets fallback
app.use(express.static(path.join(__dirname, '/')));

// -------------------------------------------------------------
// CONFIGURATION & CREDENTIALS
// -------------------------------------------------------------

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || '';
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || 'sk_live_GBnW4AxFZVP1FpBhiwG8UNLHZwcpQkAVyuiPKReH';
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || 'pk_live_qMvFy8kc7XSFtzWAsSYrSGgCwSgPcchuttv2zNAL';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'DatahubMasterAdmin2026';
const PROFIT_MARGIN = 0.09; // 9% markup for data/airtime

const db = {
  users: {
    "user@oyodata.com": { email: "user@oyodata.com", balance: 5000, isReseller: false }
  },
  quickTransactions: {}
};

const getEasyAccessHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

/**
 * PRICING CALCULATOR
 * Standard Data/Airtime: Base Price + 9% Markup (5% discount off standard price for resellers)
 * Cable TV: Base price rounded UP to nearest ₦100 (No 9% markup & No reseller discount)
 */
function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;

  if (isCable) {
    return Math.ceil(original / 100) * 100;
  }

  const resellerDiscount = isReseller ? 5 : 0;
  const markupPrice = original * (1 + PROFIT_MARGIN);
  const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
  return Math.ceil(finalPrice);
}

// -------------------------------------------------------------
// EASY ACCESS VTU ENDPOINTS
// -------------------------------------------------------------

// DYNAMIC PLAN FETCHING WITH FALLBACK & ERROR HANDLERS
app.get('/api/get-plans', async (req, res) => {
  const { product_type, is_reseller } = req.query;
  const targetType = (product_type || 'mtn_sme').toLowerCase();
  const resellerStatus = is_reseller === 'true';
  const isCable = ['dstv', 'gotv', 'startimes', 'showmax'].includes(targetType);

  try {
    const response = await axios.get(`${EASY_ACCESS_BASE}/get-plans?product_type=${targetType}`, {
      headers: getEasyAccessHeaders(),
      timeout: 10000,
      validateStatus: () => true
    });

    let raw = response.data;
    let list = [];

    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      if (Array.isArray(raw.plans)) list = raw.plans;
      else if (Array.isArray(raw.data)) list = raw.data;
      else {
        for (const key in raw) {
          if (Array.isArray(raw[key])) {
            list = raw[key];
            break;
          }
        }
      }
    }

    const markedUpList = list.map(plan => {
      const originalPrice = plan.price || plan.plan_price || plan.amount || 0;
      return {
        plan_id: plan.plan_id || plan.id || plan.package_id,
        name: plan.name || plan.plan_name || plan.package_name || 'Data Plan',
        validity: plan.validity || plan.plan_validity || plan.day || '30 Days',
        cost_price: originalPrice,
        price: calculateSellingPrice(originalPrice, resellerStatus, isCable)
      };
    });

    return res.json({ status: 'success', plans: markedUpList });
  } catch (error) {
    console.error("Get Plans Exception:", error.message);
    return res.status(200).json({ status: 'failed', message: error.message, plans: [] });
  }
});

// PURCHASE DATA
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

    return res.json(response.data);
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Data purchase failed on provider' });
  }
});

// VERIFY SMARTCARD / CABLE IUC
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

    return res.json(response.data);
  } catch (error) {
    return res.status(400).json({ status: 'failed', message: 'Verification failed' });
  }
});

// KORAPAY WEBHOOK
app.post('/api/korapay-webhook', (req, res) => {
  try {
    const signature = req.headers['x-korapay-signature'];
    if (!signature) return res.status(401).send("Missing signature");

    const calculatedHash = crypto
      .createHmac('sha256', KORAPAY_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (calculatedHash !== signature) {
      return res.status(400).send("Signature verification failed");
    }

    const { event, data } = req.body;
    if (event === 'charge.success' && data?.status === 'success') {
      const { reference, amount, customer } = data;
      if (db.quickTransactions[reference]) {
        db.quickTransactions[reference].status = "SUCCESS";
      }
    }
    return res.status(200).json({ status: true });
  } catch (err) {
    return res.status(500).send("Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server listening on port ${PORT}`));
