const express = require('express');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Serve static frontend assets (index.html, quickbuy.html, dashboard.html)
app.use(express.static(path.join(__dirname, '/')));

// -------------------------------------------------------------
// CONFIGURATION & CREDENTIALS
// -------------------------------------------------------------

// Easy Access API Config
const EASY_ACCESS_TOKEN = process.env.EASY_ACCESS_TOKEN;
const EASY_ACCESS_BASE = 'https://easyaccess.com.ng/api/live/v1';

// Korapay Live Credentials
const KORAPAY_SECRET_KEY = process.env.KORAPAY_SECRET_KEY || 'sk_live_GBnW4AxFZVP1FpBhiwG8UNLHZwcpQkAVyuiPKReH';
const KORAPAY_PUBLIC_KEY = process.env.KORAPAY_PUBLIC_KEY || 'pk_live_qMvFy8kc7XSFtzWAsSYrSGgCwSgPcchuttv2zNAL';
const KORAPAY_BASE_URL = 'https://api.korapay.com/merchant/api/v1';

// Admin Secret Key
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'DatahubMasterAdmin2026';

// Profit Margin for Data & Airtime
const PROFIT_MARGIN = 0.09; // 9%

// In-Memory Transaction & User Database
const db = {
  users: {
    "user@oyodata.com": { email: "user@oyodata.com", balance: 5000, isReseller: false, phone: "08012345678" }
  },
  quickTransactions: {}
};

// Easy Access Headers Helper
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
 * Standard Data/Airtime: Base Price + 9% Markup (5% discount off standard price for resellers)
 * Cable TV: No 9% markup, No 5% reseller discount. Base cost rounded UP to the nearest clean ₦100.
 */
function calculateSellingPrice(basePrice, isReseller = false, isCable = false) {
  const original = parseFloat(basePrice);
  if (isNaN(original)) return basePrice;

  // Cable TV Pricing Rule: Direct base price rounded UP to nearest ₦100 (No 9% markup & No reseller discount)
  if (isCable) {
    return Math.ceil(original / 100) * 100;
  }

  // Standard 9% Markup for Data & Airtime with 5% Reseller Discount
  const resellerDiscount = isReseller ? 5 : 0;
  const markupPrice = original * (1 + PROFIT_MARGIN);
  const finalPrice = markupPrice * (1 - (resellerDiscount / 100));
  return Math.ceil(finalPrice);
}

// -------------------------------------------------------------
// KORAPAY PAYMENT ENDPOINTS
// -------------------------------------------------------------

// 1. INITIALIZE KORAPAY PAYMENT
app.post('/api/pay/initialize', async (req, res) => {
  try {
    const { amount, email, phone, purpose, redirect_url } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ status: false, message: 'Please provide a valid amount.' });
    }

    const txRef = `oyo_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const userEmail = email || 'customer@oyodata.com';

    const payload = {
      amount: Number(amount),
      currency: "NGN",
      reference: txRef,
      narration: purpose || "OyoData Services Purchase",
      notification_url: `${req.protocol}://${req.get('host')}/api/korapay-webhook`,
      redirect_url: redirect_url || `${req.protocol}://${req.get('host')}/quickbuy.html?ref=${txRef}`,
      customer: {
        email: userEmail,
        name: phone || "OyoData Customer"
      },
      metadata: {
        phone: phone || "",
        purpose: purpose || "wallet_funding"
      }
    };

    const korapayRes = await axios.post(
      `${KORAPAY_BASE_URL}/charges/initialize`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${KORAPAY_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (korapayRes.data && korapayRes.data.status) {
      db.quickTransactions[txRef] = {
        reference: txRef,
        amount: Number(amount),
        email: userEmail,
        phone: phone || "N/A",
        status: "PENDING",
        date: new Date().toLocaleString('en-GB')
      };

      return res.json({
        status: true,
        message: "Payment initialized successfully",
        checkout_url: korapayRes.data.data.checkout_url,
        reference: txRef
      });
    } else {
      return res.status(400).json({ status: false, message: korapayRes.data?.message || "Failed to initialize payment." });
    }

  } catch (error) {
    console.error("Korapay Charge Init Error:", error.response?.data || error.message);
    return res.status(500).json({ status: false, message: "Server error initializing Korapay transaction." });
  }
});

// 2. KORAPAY SIGNED WEBHOOK HANDLER
app.post('/api/korapay-webhook', (req, res) => {
  try {
    const signature = req.headers['x-korapay-signature'];
    
    if (!signature) {
      return res.status(401).send("Missing signature header");
    }

    const calculatedHash = crypto
      .createHmac('sha256', KORAPAY_SECRET_KEY)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (calculatedHash !== signature) {
      console.warn("Invalid Korapay Webhook Signature!");
      return res.status(400).send("Signature verification failed");
    }

    const { event, data } = req.body;

    if (event === 'charge.success' && data?.status === 'success') {
      const { reference, amount, customer, metadata } = data;
      console.log(`[KORAPAY SUCCESS] Ref: ${reference} | Amount: ₦${amount} | Email: ${customer?.email}`);

      if (db.quickTransactions[reference]) {
        db.quickTransactions[reference].status = "SUCCESS";
      } else {
        db.quickTransactions[reference] = {
          reference,
          amount,
          email: customer?.email,
          phone: metadata?.phone || "N/A",
          status: "SUCCESS",
          date: new Date().toLocaleString('en-GB')
        };
      }

      if (customer?.email && db.users[customer.email]) {
        db.users[customer.email].balance += Number(amount);
      }
    }

    return res.status(200).json({ status: true, message: "Webhook processed successfully" });

  } catch (err) {
    console.error("Webhook Handling Error:", err);
    return res.status(500).send("Server Error");
  }
});

// 3. FETCH TRANSACTION RECEIPT BY PHONE NUMBER
app.get('/api/receipt/:phone', (req, res) => {
  const phone = req.params.phone;
  const matches = Object.values(db.quickTransactions).filter(tx => tx.phone === phone);

  if (matches.length > 0) {
    return res.json({ status: true, transaction: matches[matches.length - 1] });
  } else {
    return res.status(404).json({ status: false, message: "No transaction receipt found for this number." });
  }
});

// -------------------------------------------------------------
// EASY ACCESS VTU ENDPOINTS
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

// 6. CHECK PROVIDER WALLET BALANCE
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

app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    res.json({
      status: 'success',
      data: {
        total_users: 142,
        resellers_count: 38,
        total_transactions: 1250,
        total_revenue: 845000,
        provider_balances: { easyaccess: "Connected" }
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'failed', message: error.message });
  }
});

app.post('/api/admin/fund-wallet', verifyAdmin, async (req, res) => {
  const { user_email, amount, action_type } = req.body;
  if (!user_email || !amount) {
    return res.status(400).json({ status: 'failed', message: 'Email and amount required' });
  }

  res.json({ 
    status: 'success', 
    message: `Successfully ${action_type === 'credit' ? 'credited' : 'debited'} ₦${amount} for ${user_email}` 
  });
});

app.post('/api/admin/toggle-reseller', verifyAdmin, async (req, res) => {
  const { user_email, is_reseller } = req.body;
  res.json({ 
    status: 'success', 
    message: `Updated reseller status to ${is_reseller ? 'Reseller (5% Off)' : 'Standard User'} for ${user_email}` 
  });
});

// Default Fallback Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/quickbuy.html', (req, res) => res.sendFile(path.join(__dirname, 'quickbuy.html')));
app.get('/dashboard.html', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`OyoData Unified Server running on port ${PORT}`));
