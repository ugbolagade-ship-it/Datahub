const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();

// Enable CORS for all incoming connections (GitHub Pages frontend)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-key', 'AuthorizationToken']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '/')));

// CONFIGURATION & CREDENTIALS
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN || '';
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || 'sk_live_GBnW4AxFZVP1FpBhiwG8UNLHZwcpQkAVyuiPKReH';
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || 'pk_live_qMvFy8kc7XSFtzWAsSYrSGgCwSgPcchuttv2zNAL';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

const PROFIT_MARGIN = 0.09; // 9% markup for standard users

// In-Memory Database Store
const db = {
  users: {},
  virtualAccounts: {},
  processedReferences: new Set() // Prevents duplicate webhooks
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

  if (isCable) {
    return Math.ceil(original / 100) * 100;
  }

  const resellerDiscount = isReseller ? 5 : 0;
  const markupPrice = original * (1 + PROFIT_MARGIN);
  const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
  return Math.ceil(finalPrice);
}

// -------------------------------------------------------------
// DEDICATED VIRTUAL ACCOUNT CREATION (KORAPAY API WITH BVN/NIN)
// -------------------------------------------------------------

app.post('/api/get-virtual-account', async (req, res) => {
  const { email, name, bvn, nin } = req.body;
  if (!email) return res.status(400).json({ status: false, message: 'Email is required' });

  // Return existing account if already generated for this user
  if (db.virtualAccounts[email]) {
    return res.json({ status: true, account: db.virtualAccounts[email] });
  }

  // Require BVN or NIN for new permanent account creation
  if (!bvn && !nin) {
    return res.status(200).json({ 
      status: false, 
      needs_kyc: true, 
      message: 'BVN or NIN is required to generate a permanent bank account.' 
    });
  }

  try {
    const payload = {
      account_name: name || "OyoData Customer",
      permanent: true,       // Required by Korapay Virtual Account API
      is_permanent: true,    // Supported flag for Korapay dedicated accounts
      customer: {
        email: email,
        name: name || "OyoData Customer"
      },
      kyc: {
        bvn: bvn || undefined,
        nin: nin || undefined
      },
      bank_code: "035", // Wema Bank
      currency: "NGN"
    };

    const response = await axios.post(`${KORAPAY_BASE_URL}/virtual-bank-account`, payload, {
      headers: {
        Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data && response.data.status) {
      const accData = {
        bank_name: response.data.data.bank_name || "Wema Bank",
        account_number: response.data.data.account_number,
        account_name: response.data.data.account_name
      };
      db.virtualAccounts[email] = accData;
      return res.json({ status: true, account: accData });
    } else {
      return res.status(400).json({ 
        status: false, 
        message: response.data?.message || 'Verification failed with Korapay. Please verify your BVN/NIN.' 
      });
    }
  } catch (err) {
    console.error("Korapay VA Creation Error:", err.response?.data || err.message);
    const errorMsg = err.response?.data?.message || 'Failed to generate bank account. Ensure your BVN/NIN details are valid.';
    return res.status(400).json({ status: false, message: errorMsg });
  }
});

// -------------------------------------------------------------
// EASY ACCESS DATA & VTU ENDPOINTS
// -------------------------------------------------------------

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
    return res.status(200).json({ status: 'failed', message: error.message, plans: [] });
  }
});

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
    return res.status(400).json({ status: 'failed', message: 'Provider data purchase failed' });
  }
});

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

// -------------------------------------------------------------
// KORAPAY SECURE WEBHOOK (AUTOMATED WALLET FUNDING)
// -------------------------------------------------------------

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

    if ((event === 'charge.success' || event === 'transfer.success') && data?.status === 'success') {
      const reference = data.reference;

      // Prevent processing duplicate webhooks
      if (db.processedReferences.has(reference)) {
        return res.status(200).json({ status: true, message: "Transaction already processed" });
      }

      db.processedReferences.add(reference);
      const userEmail = data.customer?.email;
      const amountPaid = Number(data.amount);

      console.log(`[SUCCESSFUL TOP-UP] User: ${userEmail} | Amount: ₦${amountPaid}`);

      if (userEmail && db.users[userEmail]) {
        db.users[userEmail].balance += amountPaid;
      }
    }

    return res.status(200).json({ status: true });
  } catch (err) {
    return res.status(500).send("Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Server online on port ${PORT}`));
