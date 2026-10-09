const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = 'https://easyaccess.com.ng/api/live/v1';

// Profit Margin Set to 9%
const PROFIT_MARGIN = 0.09;

const getHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'AuthorizationToken': EASY_ACCESS_TOKEN,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

// Helper function to calculate selling price (Base + 9%)
function addMarkup(basePrice, discountPercent = 0) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  const markupPrice = original * (1 + PROFIT_MARGIN);
  // Apply reseller discount if applicable (e.g., 5% off)
  const finalPrice = markupPrice * (1 - (discountPercent / 100));
  return Math.ceil(finalPrice);
}

// 1. GET DATA & CABLE TV PLANS WITH 9% MARKUP
app.get('/api/get-plans', async (req, res) => {
  const { product_type, is_reseller } = req.query;
  const targetType = product_type || 'mtn_sme';
  const discount = is_reseller === 'true' ? 5 : 0; // 5% discount for Reseller tier

  try {
    const response = await axios.get(`${BASE_URL}/get-plans?product_type=${targetType}`, {
      headers: getHeaders(),
      validateStatus: () => true
    });

    const raw = response.data;
    let list = [];

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

    const markedUpList = list.map(plan => ({
      ...plan,
      cost_price: plan.price,
      price: addMarkup(plan.price, discount)
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
app.listen(PORT, () => console.log(`Server running with 9% markup on port ${PORT}`));
