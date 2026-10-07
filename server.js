const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = 'https://easyaccess.com.ng/api/live/v1';

const PROFIT_MARGIN = 0.12; // 12% Markup

const getHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

function addMarkup(basePrice) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  return Math.ceil(original * (1 + PROFIT_MARGIN));
}

// 1. GET DATA & CABLE TV PLANS WITH 12% MARKUP
app.get('/api/get-plans', async (req, res) => {
  const { product_type } = req.query;
  const targetType = product_type || 'mtn_sme';

  console.log(`[API CALL] Fetching plans for product_type: ${targetType}`);

  try {
    const response = await axios.get(`${BASE_URL}/get-plans?product_type=${targetType}`, {
      headers: getHeaders(),
      validateStatus: () => true // Prevent axios from throwing on non-200 status codes
    });

    console.log(`[EASY ACCESS RESPONSE]`, JSON.stringify(response.data));

    const raw = response.data;
    let list = [];

    if (Array.isArray(raw)) {
      list = raw;
    } else if (typeof raw === 'object' && raw !== null) {
      // Look for any property in the JSON object that contains an array
      for (const key in raw) {
        if (Array.isArray(raw[key])) {
          list = raw[key];
          break;
        }
      }
    }

    // Add 12% markup
    const markedUpList = list.map(plan => ({
      ...plan,
      cost_price: plan.price,
      price: addMarkup(plan.price)
    }));

    res.json({ status: 'success', plans: markedUpList, rawResponse: raw });
  } catch (error) {
    console.error(`[ERROR fetching plans]`, error.message);
    res.status(500).json({ status: 'failed', message: error.message, plans: [] });
  }
});

// 2. PURCHASE DATA
app.post('/api/purchase-data', async (req, res) => {
  const { network, dataplan, mobileno, client_reference } = req.body;
  try {
    const response = await axios.post(`${BASE_URL}/purchase-data`, {
      network: Number(network),
      dataplan: Number(dataplan),
      mobileno: String(mobileno),
      client_reference: client_reference || `ref_${Date.now()}`
    }, {
      headers: getHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Transaction error' });
  }
});

// 3. VERIFY TV SMARTCARD
app.post('/api/verify-tv', async (req, res) => {
  const { company, iucno } = req.body;
  try {
    const response = await axios.post(`${BASE_URL}/verify-tv`, {
      company: Number(company),
      iucno: String(iucno)
    }, { 
      headers: getHeaders(),
      validateStatus: () => true
    });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Verification failed' });
  }
});

// 4. CHECK WALLET BALANCE
app.get('/api/wallet-balance', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/wallet-balance`, {
      headers: getHeaders(),
      validateStatus: () => true
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Error fetching balance' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
