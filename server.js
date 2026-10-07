const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const BASE_URL = 'https://easyaccess.com.ng/api/live/v1';

// Your profit margin percentage
const PROFIT_MARGIN = 0.12; // 12%

const getHeaders = () => ({
  'Authorization': `Bearer ${EASY_ACCESS_TOKEN}`,
  'Cache-Control': 'no-cache',
  'Content-Type': 'application/json'
});

// Helper function to calculate selling price
function addMarkup(basePrice) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;
  // Adds 12% markup and rounds up to nearest whole Naira
  return Math.ceil(original * (1 + PROFIT_MARGIN));
}

// 1. GET DATA & CABLE TV PLANS WITH 12% MARKUP
app.get('/api/get-plans', async (req, res) => {
  const { product_type } = req.query;
  try {
    const response = await axios.get(`${BASE_URL}/get-plans?product_type=${product_type || 'mtn_sme'}`, {
      headers: getHeaders()
    });

    const rawData = response.data;

    // Apply 12% markup to all plan prices in the response
    for (let key in rawData) {
      if (Array.isArray(rawData[key])) {
        rawData[key] = rawData[key].map(plan => ({
          ...plan,
          cost_price: plan.price, // Original Easy Access cost price
          price: addMarkup(plan.price) // Final price displayed to user (Base + 12%)
        }));
      }
    }

    res.json(rawData);
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
    res.status(400).json({ status: 'failed', message: 'Transaction failed' });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running with 12% profit markup on port ${PORT}`));
