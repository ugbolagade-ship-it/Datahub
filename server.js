const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// PAYPOINT API CREDENTIALS
const PAYPOINT_KEY = process.env.PAYPOINT_KEY || '6940a4da5bbe4534ec0952fb597ff7ba9780336d';
const PAYPOINT_BASE = 'https://paypoint.com.ng/api';

// EASY ACCESS API CREDENTIALS (Fallback or Secondary)
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

// Headers helper for PayPoint
const getPaypointHeaders = () => ({
  'Authorization': `Token ${PAYPOINT_KEY}`,
  'Content-Type': 'application/json'
});

// Headers helper for Easy Access
const getEasyAccessHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Content-Type': 'application/json'
});

/**
 * PRICING CALCULATOR
 * Standard Users: Base Price + ₦200 Markup
 * Resellers: ₦80 off Standard Price (Base Price + ₦120 Markup)
 */
function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;

  let sellingPrice = original + 200; // Flat ₦200 markup for regular users

  if (isReseller) {
    sellingPrice -= 80; // ₦80 off for Resellers
  }

  // Round Cable TV prices up to the nearest ₦100
  if (isCable) {
    return Math.ceil(sellingPrice / 100) * 100;
  }

  return Math.ceil(sellingPrice);
}

// 1. DYNAMIC DATA & CABLE PLAN FETCHING
app.get('/api/get-plans', async (req, res) => {
  const { product_type, is_reseller } = req.query;
  const targetType = product_type || 'mtn_sme';
  const resellerStatus = is_reseller === 'true';
  const isCable = ['dstv', 'gotv', 'startimes', 'showmax'].includes(targetType.toLowerCase());

  try {
    // Primary: Fetch from PayPoint
    const response = await axios.get(`${PAYPOINT_BASE}/user/`, {
      headers: getPaypointHeaders(),
      validateStatus: () => true
    });

    let list = [];
    const raw = response.data;

    // Parse array response
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

    // Fallback to Easy Access if PayPoint plan list is empty
    if (list.length === 0) {
      const fallbackRes = await axios.get(`${EASY_ACCESS_BASE}/get-plans?product_type=${targetType}`, {
        headers: getEasyAccessHeaders(),
        validateStatus: () => true
      });
      const fbRaw = fallbackRes.data;
      if (Array.isArray(fbRaw)) list = fbRaw;
      else if (typeof fbRaw === 'object' && fbRaw !== null) {
        for (const key in fbRaw) {
          if (Array.isArray(fbRaw[key])) { list = fbRaw[key]; break; }
        }
      }
    }

    // Calculate final prices
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

// 2. VALIDATE SMARTCARD (PayPoint Integration)
app.post('/api/verify-tv', async (req, res) => {
  const { company, iucno } = req.body;
  const cableNames = { 1: 'dstv', 2: 'gotv', 3: 'startimes', 4: 'showmax' };

  try {
    const response = await axios.post(`${PAYPOINT_BASE}/validate/iuc/`, {
      cablename: cableNames[company] || String(company),
      iuc_number: String(iucno)
    }, {
      headers: getPaypointHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Verification error' });
  }
});

// 3. VALIDATE METER NUMBER (PayPoint Integration)
app.post('/api/verify-meter', async (req, res) => {
  const { disco_name, meter_number } = req.body;

  try {
    const response = await axios.post(`${PAYPOINT_BASE}/validate/meter/`, {
      disco_name: String(disco_name),
      meter_number: String(meter_number)
    }, {
      headers: getPaypointHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Meter verification error' });
  }
});

// 4. GENERATE EXAM PINS (PayPoint Integration)
app.post('/api/buy-exam-pin', async (req, res) => {
  const { exam_type, quantity, mobile_number } = req.body;

  try {
    const response = await axios.post(`${PAYPOINT_BASE}/exam/`, {
      exam_type: exam_type,
      quantity: String(quantity || "1"),
      mobile_number: String(mobile_number)
    }, {
      headers: getPaypointHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Exam PIN purchase failed' });
  }
});

// 5. PURCHASE DATA
app.post('/api/purchase-data', async (req, res) => {
  const { network, dataplan, mobileno, client_reference } = req.body;

  try {
    const response = await axios.post(`${PAYPOINT_BASE}/data/`, {
      network: Number(network),
      data_plan: Number(dataplan),
      mobile_number: String(mobileno),
      Ported_number: true
    }, {
      headers: getPaypointHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Transaction error' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running with PayPoint API integration on port ${PORT}`));
