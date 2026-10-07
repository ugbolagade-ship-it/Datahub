const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors()); // Allows frontend on GitHub Pages to call this backend

// Secret Token loaded from Render Environment Variable
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = 'https://easyaccess.com.ng/api/live/v1';

// Your profit margin percentage (12%)
const PROFIT_MARGIN = 0.12;

// Request Headers helper
const getHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

// Helper function to calculate selling price (Base + 12%)
function addMarkup(basePrice) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  return Math.ceil(original * (1 + PROFIT_MARGIN));
}

// 1. GET DATA & CABLE TV PLANS WITH 12% MARKUP
app.get('/api/get-plans', async (req, res) => {
  const { product_type } = req.query;
  try {
    const response = await axios.get(`${BASE_URL}/get-plans?product_type=${product_type || 'mtn_sme'}`, {
      headers: getHeaders()
    });

    const raw = response.data;
    // Handles array returned directly or nested inside response objects
    let list = Array.isArray(raw) ? raw : (raw.data || raw[Object.keys(raw)[0]] || []);

    if (Array.isArray(list)) {
      list = list.map(plan => ({
        ...plan,
        cost_price: plan.price, // Original Easy Access cost
        price: addMarkup(plan.price) // Final retail price (Base + 12%)
      }));
    }

    res.json({ status: 'success', plans: list });
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Error fetching plans' });
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
      headers: getHeaders()
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
    }, { headers: getHeaders() });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'Verification failed' });
  }
});

// 4. PAY TV SUBSCRIPTION
app.post('/api/pay-tv', async (req, res) => {
  const { company, package_id, iucno } = req.body;
  try {
    const response = await axios.post(`${BASE_URL}/pay-tv`, {
      company: Number(company),
      package: Number(package_id),
      iucno: String(iucno)
    }, { headers: getHeaders() });

    res.json(response.data);
  } catch (error) {
    res.status(400).json({ status: 'failed', message: 'TV Payment failed' });
  }
});

// 5. CHECK WALLET BALANCE
app.get('/api/wallet-balance', async (req, res) => {
  try {
    const response = await axios.get(`${BASE_URL}/wallet-balance`, {
      headers: getHeaders()
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'failed', message: 'Error fetching balance' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running with 12% markup on port ${PORT}`));
