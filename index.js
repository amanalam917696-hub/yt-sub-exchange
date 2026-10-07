const express = require('express');
const https = require('https');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-admin-password');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// ============================================================
// TELEGRAM
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8279929634:AAEZ7R9VoABhZcBXi2hx2cvWkaYcomHlwbc';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5945121043';

async function sendTelegram(message) {
  try {
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${text}&parse_mode=HTML`;
    return new Promise((resolve) => {
      https.get(url, (res) => { let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve(true)); }).on('error',()=>resolve(false));
    });
  } catch(e) { return false; }
}

// ============================================================
// SCHEMAS
// ============================================================
const fpUserSchema = new mongoose.Schema({
  fingerprint: { type: String, unique: true },
  memberExpiry: { type: Date, default: null },
  days: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now }
});
const FpUser = mongoose.model('FpUser', fpUserSchema);

const fpPaymentSchema = new mongoose.Schema({
  fingerprint: String,
  orderId: { type: String, unique: true },
  days: Number,
  amount: Number,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});
const FpPayment = mongoose.model('FpPayment', fpPaymentSchema);

const serviceLinkSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  name: String,
  url: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const ServiceLink = mongoose.model('ServiceLink', serviceLinkSchema);

const announcementSchema = new mongoose.Schema({
  message: { type: String, default: '' },
  active: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});
const Announcement = mongoose.model('Announcement', announcementSchema);

const schemeSchema = new mongoose.Schema({
  name: String,
  icon: { type: String, default: '🏛️' },
  description: String,
  url: String,
  category: { type: String, default: 'sarkari' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const Scheme = mongoose.model('Scheme', schemeSchema);

const planConfigSchema = new mongoose.Schema({
  plans: { type: Array, default: [
    { days: 10, amount: 20, label: '10 दिन' },
    { days: 20, amount: 40, label: '20 दिन' },
    { days: 30, amount: 49, label: '30 दिन' },
    { days: 60, amount: 99, label: '60 दिन' }
  ]},
  updatedAt: { type: Date, default: Date.now }
});
const PlanConfig = mongoose.model('PlanConfig', planConfigSchema);

// User support messages
const supportMsgSchema = new mongoose.Schema({
  fingerprint: String,
  name: { type: String, default: 'Anonymous' },
  message: String,
  orderId: { type: String, default: '' },
  status: { type: String, default: 'unread' },
  createdAt: { type: Date, default: Date.now }
});
const SupportMsg = mongoose.model('SupportMsg', supportMsgSchema);

// ============================================================
// ADMIN AUTH
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@aman@769691@';
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.body?.adminPassword || req.query?.adminPassword;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized!' });
  next();
}

// ============================================================
// CASHFREE
// ============================================================
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || '130852352d444e60dc40942f72c3258031';
const CASHFREE_SECRET = process.env.CASHFREE_SECRET || 'cfsk_ma_prod_926fdf10f3594b66757d3122b0239f99_6d87159e';
const CASHFREE_BASE = 'api.cashfree.com';
const SITE_URL = process.env.SITE_URL || 'https://biharseva.online';
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://yt-sub-exchange.onrender.com';

function makeRequest(method, host, path, data, headers) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = { hostname: host, path, method, headers: { ...headers, ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}) } };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(new Error('Invalid JSON: ' + body)); } });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// ============================================================
// PUBLIC APIs
// ============================================================
app.get('/api/fp-status', async (req, res) => res.json({ success: false }));

app.post('/api/fp-status', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) return res.json({ active: false });
    const user = await FpUser.findOne({ fingerprint });
    if (!user) return res.json({ active: false });
    user.lastSeen = new Date(); await user.save();
    const active = user.memberExpiry && new Date(user.memberExpiry) > new Date();
    res.json({ active: !!active, expiryDate: user.memberExpiry || null });
  } catch(e) { res.json({ active: false }); }
});

app.get('/api/service-links', async (req, res) => {
  try {
    const links = await ServiceLink.find({});
    const obj = {};
    links.forEach(l => { obj[l.key] = l.url; });
    res.json({ success: true, links: obj });
  } catch(e) { res.json({ success: true, links: {} }); }
});

app.get('/api/announcement', async (req, res) => {
  try {
    const a = await Announcement.findOne({ active: true });
    res.json({ success: true, message: a ? a.message : '' });
  } catch(e) { res.json({ success: true, message: '' }); }
});

app.get('/api/plans', async (req, res) => {
  try {
    let config = await PlanConfig.findOne({});
    if (!config) { config = new PlanConfig({}); await config.save(); }
    res.json({ success: true, plans: config.plans });
  } catch(e) {
    res.json({ success: true, plans: [
      { days: 10, amount: 20 }, { days: 20, amount: 40 },
      { days: 30, amount: 49 }, { days: 60, amount: 99 }
    ]});
  }
});

app.get('/api/schemes', async (req, res) => {
  try {
    const schemes = await Scheme.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, schemes });
  } catch(e) { res.json({ success: true, schemes: [] }); }
});

// User sends support message
app.post('/api/support', async (req, res) => {
  try {
    const { fingerprint, name, message, orderId } = req.body;
    if (!message) return res.json({ success: false, message: 'Message likho!' });
    const msg = new SupportMsg({ fingerprint: fingerprint || 'unknown', name: name || 'Anonymous', message, orderId: orderId || '' });
    await msg.save();
    await sendTelegram(`📩 NEW SUPPORT MESSAGE!\n\n👤 Name: ${name||'Anonymous'}\n🔑 FP: ${(fingerprint||'').substring(0,12)}...\n🔖 Order: ${orderId||'N/A'}\n💬 Message: ${message}\n🕐 ${new Date().toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})}`);
    res.json({ success: true, message: 'Message bhej diya! Jald jawab milega.' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ============================================================
// PAYMENT APIs
// ============================================================
app.post('/api/fp-payment/create', async (req, res) => {
  try {
    const { fingerprint, days, amount } = req.body;
    if (!fingerprint || !days || !amount) return res.json({ success: false, message: 'Data missing' });

    let config = await PlanConfig.findOne({});
    const plans = config ? config.plans : [{ days: 10, amount: 20 }, { days: 20, amount: 40 }, { days: 30, amount: 49 }, { days: 60, amount: 99 }];
    const validPlan = plans.some(p => Number(p.days) === Number(days) && Number(p.amount) === Number(amount));
    if (!validPlan) return res.json({ success: false, message: 'Invalid plan' });

    let user = await FpUser.findOne({ fingerprint });
    if (!user) {
      user = new FpUser({ fingerprint });
      await user.save();
      await sendTelegram(`🆕 NEW USER!\n🔑 FP: ${fingerprint.substring(0,12)}...\n💎 Plan: ${days} din / ₹${amount}`);
    }

    const orderId = 'BS_' + fingerprint.substring(0, 8) + '_' + Date.now();
    const orderData = {
      order_id: orderId, order_amount: amount, order_currency: 'INR',
      customer_details: { customer_id: fingerprint.substring(0, 20), customer_name: 'User', customer_email: 'user@biharseva.online', customer_phone: '9999999999' },
      order_meta: { return_url: `${SITE_URL}/?paid=1&order_id={order_id}`, notify_url: `${RENDER_URL}/api/fp-cashfree/webhook` }
    };

    const response = await makeRequest('POST', CASHFREE_BASE, '/pg/orders', orderData, {
      'x-api-version': '2023-08-01', 'x-client-id': CASHFREE_APP_ID, 'x-client-secret': CASHFREE_SECRET, 'Content-Type': 'application/json'
    });

    if (response.payment_session_id) {
      const payment = new FpPayment({ fingerprint, orderId, days, amount, status: 'pending' });
      await payment.save();
      await sendTelegram(`💳 PAYMENT STARTED!\n🔑 FP: ${fingerprint.substring(0,12)}...\n💎 ${days} din / ₹${amount}\n🔖 Order: ${orderId}`);
      return res.json({ success: true, paymentSessionId: response.payment_session_id, orderId });
    } else {
      return res.json({ success: false, message: response.message || 'Cashfree order nahi bana' });
    }
  } catch(e) { console.error('fp-payment/create error:', e.message); res.json({ success: false, message: e.message }); }
});

app.post('/api/fp-payment/verify', async (req, res) => {
  try {
    const { orderId, fingerprint } = req.body;
    if (!orderId) return res.json({ success: false, message: 'Order ID nahi mila' });
    const payment = await FpPayment.findOne({ orderId });
    if (!payment) return res.json({ success: false, message: 'Order nahi mila' });
    if (payment.status === 'completed') return res.json({ success: true, message: 'Membership pehle se active hai!' });

    const response = await makeRequest('GET', CASHFREE_BASE, '/pg/orders/' + orderId, null, {
      'x-api-version': '2023-08-01', 'x-client-id': CASHFREE_APP_ID, 'x-client-secret': CASHFREE_SECRET
    });

    if (response.order_status === 'PAID') {
      const user = await FpUser.findOne({ fingerprint });
      if (!user) return res.json({ success: false, message: 'User nahi mila' });
      const days = payment.days;
      const now = new Date();
      const currentExpiry = user.memberExpiry && new Date(user.memberExpiry) > now ? new Date(user.memberExpiry) : now;
      user.memberExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);
      user.days = days;
      await user.save();
      payment.status = 'completed';
      await payment.save();
      await sendTelegram(`💎 MEMBERSHIP ACTIVATED! ✅\n🔑 FP: ${fingerprint.substring(0,12)}...\n💰 ₹${payment.amount} / ${days} din\n🔖 Order: ${orderId}`);
      res.json({ success: true, message: `Membership ${days} din ke liye activate ho gayi!`, expiryDate: user.memberExpiry });
    } else if (response.order_status === 'ACTIVE') {
      res.json({ success: false, message: 'Payment processing mein hai, thodi der baad try karo!' });
    } else {
      res.json({ success: false, message: 'Payment status: ' + response.order_status });
    }
  } catch(e) { console.error('fp-payment/verify error:', e.message); res.json({ success: false, message: e.message }); }
});

app.post('/api/fp-cashfree/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    if (!signature || !timestamp || !req.rawBody) return res.status(401).json({ success: false });
    const expectedSignature = crypto.createHmac('sha256', CASHFREE_SECRET).update(timestamp + req.rawBody.toString()).digest('base64');
    if (expectedSignature !== signature) return res.status(401).json({ success: false });
    const data = req.body.data;
    if (!data) return res.json({ success: false });
    const orderId = data.order?.order_id;
    const paymentStatus = data.payment?.payment_status;
    if (paymentStatus === 'SUCCESS') {
      const payment = await FpPayment.findOne({ orderId });
      if (!payment || payment.status === 'completed') return res.json({ success: true });
      const user = await FpUser.findOne({ fingerprint: payment.fingerprint });
      if (user) {
        const days = payment.days;
        const now = new Date();
        const currentExpiry = user.memberExpiry && new Date(user.memberExpiry) > now ? new Date(user.memberExpiry) : now;
        user.memberExpiry = new Date(currentExpiry.getTime() + days * 24 * 60 * 60 * 1000);
        await user.save();
        payment.status = 'completed';
        await payment.save();
        await sendTelegram(`💎 MEMBERSHIP (webhook)! ✅\n🔑 FP: ${payment.fingerprint.substring(0,12)}...\n💰 ₹${payment.amount} / ${days} din`);
      }
    }
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// ============================================================
// ADMIN APIs
// ============================================================
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  res.json({ success: password === ADMIN_PASSWORD });
});

app.get('/api/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await FpUser.countDocuments();
    const now = new Date();
    const activeMembers = await FpUser.countDocuments({ memberExpiry: { $gt: now } });
    const totalPayments = await FpPayment.countDocuments({ status: 'completed' });
    const revenueData = await FpPayment.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const totalRevenue = revenueData[0]?.total || 0;
    res.json({ success: true, totalUsers, activeMembers, totalPayments, totalRevenue });
  } catch(err) { res.json({ success: false, totalUsers: 0, activeMembers: 0, totalPayments: 0, totalRevenue: 0 }); }
});

app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await FpUser.find().sort({ joinedAt: -1 }).limit(50);
    res.json({ success: true, users });
  } catch(e) { res.json({ success: false, users: [] }); }
});

app.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const payments = await FpPayment.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, payments });
  } catch(e) { res.json({ success: false, payments: [] }); }
});

app.get('/admin/payment-breakdown', adminAuth, async (req, res) => {
  try {
    const completed = await FpPayment.countDocuments({ status: 'completed' });
    const pending = await FpPayment.countDocuments({ status: 'pending' });
    res.json({ success: true, completed, pending });
  } catch(e) { res.json({ success: false, completed: 0, pending: 0 }); }
});

app.post('/admin/activate-fp', adminAuth, async (req, res) => {
  try {
    const { fingerprint, days } = req.body;
    let user = await FpUser.findOne({ fingerprint });
    if (!user) {
      user = new FpUser({ fingerprint });
      await user.save();
    }
    const now = new Date();
    const currentExpiry = user.memberExpiry && new Date(user.memberExpiry) > now ? new Date(user.memberExpiry) : now;
    user.memberExpiry = new Date(currentExpiry.getTime() + (days || 30) * 24 * 60 * 60 * 1000);
    await user.save();
    res.json({ success: true, message: `${days || 30} din ke liye activate kiya!`, expiryDate: user.memberExpiry });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// Service links - SAVE
app.post('/admin/service-link', adminAuth, async (req, res) => {
  try {
    const { key, name, url } = req.body;
    await ServiceLink.findOneAndUpdate({ key }, { name: name || key, url: url || '', updatedAt: new Date() }, { upsert: true, new: true });
    res.json({ success: true });
  } catch(e) { console.error('service-link error:', e.message); res.json({ success: false, message: e.message }); }
});

// Service links - DELETE (set url to empty)
app.post('/admin/service-link/delete', adminAuth, async (req, res) => {
  try {
    const { key } = req.body;
    await ServiceLink.findOneAndUpdate({ key }, { url: '', updatedAt: new Date() }, { upsert: true });
    res.json({ success: true });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.get('/admin/service-links', adminAuth, async (req, res) => {
  try {
    const links = await ServiceLink.find({});
    res.json({ success: true, links });
  } catch(e) { res.json({ success: false, links: [] }); }
});

app.post('/admin/announcement', adminAuth, async (req, res) => {
  try {
    const { message, active } = req.body;
    await Announcement.findOneAndUpdate({}, { message: message || '', active: !!active, updatedAt: new Date() }, { upsert: true });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/plans/update', adminAuth, async (req, res) => {
  try {
    const { plans } = req.body;
    if (!plans || !Array.isArray(plans)) return res.json({ success: false, message: 'Plans array chahiye' });
    await PlanConfig.findOneAndUpdate({}, { plans, updatedAt: new Date() }, { upsert: true });
    res.json({ success: true, message: 'Plans update ho gaye!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/scheme/add', adminAuth, async (req, res) => {
  try {
    const { name, icon, description, url, category } = req.body;
    if (!name || !url) return res.json({ success: false, message: 'Name aur URL zaroori hai' });
    const scheme = new Scheme({ name, icon: icon || '🏛️', description: description || '', url, category: category || 'sarkari' });
    await scheme.save();
    res.json({ success: true, message: 'Scheme add ho gayi!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/scheme/delete', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    await Scheme.findByIdAndUpdate(id, { active: false });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.get('/admin/schemes', adminAuth, async (req, res) => {
  try {
    const schemes = await Scheme.find({ active: true }).sort({ createdAt: -1 });
    res.json({ success: true, schemes });
  } catch(e) { res.json({ success: true, schemes: [] }); }
});

// Support messages
app.get('/admin/support-messages', adminAuth, async (req, res) => {
  try {
    const messages = await SupportMsg.find().sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, messages });
  } catch(e) { res.json({ success: false, messages: [] }); }
});

app.post('/admin/support/read', adminAuth, async (req, res) => {
  try {
    const { id } = req.body;
    await SupportMsg.findByIdAndUpdate(id, { status: 'read' });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// ============================================================
// AUTO PING
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://yt-sub-exchange.onrender.com';
setInterval(() => {
  try {
    https.get(SELF_URL + '/api/announcement', () => {
      console.log('✅ Auto-ping:', new Date().toLocaleTimeString());
    }).on('error', (e) => console.log('⚠️ Ping failed:', e.message));
  } catch(e) {}
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  await sendTelegram(`🚀 BIHAR SEVA SERVER STARTED!\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
});
