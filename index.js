const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: ['https://ytsubexchange.online', 'https://www.ytsubexchange.online', 'https://yt-sub-exchange.onrender.com'], credentials: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ytsubexchange_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  googleId: { type: String, default: '' },
  name: { type: String, default: '' },
  photo: { type: String, default: '' },
  youtubeLink: { type: String, default: '' },
  plan: { type: String, default: 'free' },
  adsWatched: { type: Number, default: 0 },
  expiresAt: Date,
  pendingPayment: { type: Boolean, default: false },
  paymentVerified: { type: Boolean, default: false },
  subsGiven: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  totalViews: { type: Number, default: 0 },
  totalClicks: { type: Number, default: 0 },
  joinedAt: { type: Date, default: Date.now }
});

const paymentSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  email: String,
  plan: String,
  amount: Number,
  transactionId: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Payment = mongoose.model('Payment', paymentSchema);

const SLOT_LIMIT = 4;
const ACTIVE_DURATION = 24 * 60 * 60 * 1000;

const PLANS = {
  free:     { ads: 0, subs: 0,  priority: 0, price: 0  },
  basic:    { ads: 0, subs: 10, priority: 1, price: 10, subscribers: 500  },
  silver:   { ads: 0, subs: 10, priority: 2, price: 20, subscribers: 1000 },
  gold:     { ads: 0, subs: 10, priority: 3, price: 30, subscribers: 1500 },
  platinum: { ads: 0, subs: 10, priority: 4, price: 50, subscribers: 3000 }
};

async function updateSlots() {
  const now = new Date();
  const expired = await User.find({ isActive: true, startTime: { $lt: new Date(now - ACTIVE_DURATION) } });
  for (const u of expired) {
    u.isActive = false;
    u.adsWatched = 0;
    u.subsGiven = 0;
    await u.save();
  }
  const activeCount = await User.countDocuments({ isActive: true });
  const needed = SLOT_LIMIT - activeCount;
  if (needed > 0) {
    const waiting = await User.find({ isActive: false, youtubeLink: { $ne: '' }, adsWatched: { $gte: 1 } })
      .sort({ joinedAt: 1 }).limit(needed * 3);
    let activated = 0;
    for (const u of waiting) {
      if (activated >= needed) break;
      const plan = PLANS[u.plan] || PLANS.free;
      const activeNow = await User.countDocuments({ isActive: true });
      if (u.subsGiven >= Math.min(plan.subs, activeNow)) {
        u.isActive = true;
        u.startTime = new Date();
        await u.save();
        activated++;
      }
    }
  }
}

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://ytsubexchange.online/auth/google/callback',
  scope: ['profile', 'email']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.findOne({ email: profile.emails[0].value });
      if (user) {
        user.googleId = profile.id;
        user.name = profile.displayName || '';
        user.photo = profile.photos && profile.photos[0] ? profile.photos[0].value : '';
        await user.save();
      } else {
        user = new User({
          email: profile.emails[0].value,
          googleId: profile.id,
          name: profile.displayName || '',
          photo: profile.photos && profile.photos[0] ? profile.photos[0].value : ''
        });
        await user.save();
      }
    }
    return done(null, user);
  } catch (err) {
    return done(err, null);
  }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch(err) { done(err, null); }
});

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account'
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { 
    failureRedirect: '/?error=login_failed',
    session: false
  }),
  async (req, res) => {
    try {
      const user = req.user;
      const params = new URLSearchParams({
        userId: user._id.toString(),
        email: user.email,
        name: user.name || '',
        photo: user.photo || '',
        ytLink: user.youtubeLink || '',
        isActive: user.isActive.toString(),
        adsWatched: user.adsWatched.toString(),
        plan: user.plan || 'free'
      });
      res.redirect('/?' + params.toString());
    } catch(err) {
      console.log('Callback error:', err);
      res.redirect('/?error=callback_failed');
    }
  }
);

app.post('/api/ad-watched', async (req, res) => {
  try {
    const user = await User.findById(req.body.userId);
    if (!user) return res.json({ success: false });
    const plan = PLANS[user.plan] || PLANS.free;
    if (user.adsWatched < plan.ads) { user.adsWatched += 1; await user.save(); }
    res.json({ adsWatched: user.adsWatched, required: plan.ads });
  } catch(err) { res.json({ success: false }); }
});

app.get('/api/get-channels/:userId', async (req, res) => {
  try {
    await updateSlots();
    const user = await User.findById(req.params.userId);
    const plan = PLANS[user?.plan || 'free'];
    const activeUsers = await User.find({ _id: { $ne: req.params.userId }, isActive: true }).limit(plan.subs);
    res.json({ channels: activeUsers, totalActive: activeUsers.length, required: plan.subs });
  } catch(err) { res.json({ channels: [], totalActive: 0, required: 4 }); }
});

app.post('/api/sub-done', async (req, res) => {
  try {
    const user = await User.findById(req.body.userId);
    if (!user) return res.json({ success: false });
    user.subsGiven += 1;
    const plan = PLANS[user.plan] || PLANS.free;
    const activeCount = await User.countDocuments({ isActive: true });
    const requiredSubs = Math.min(plan.subs, activeCount);
    if (user.subsGiven >= requiredSubs) {
      user.isActive = true;
      user.startTime = new Date();
      // If payment was verified, keep expiresAt (already set by admin)
      if(!user.expiresAt) {
        const PLAN_HOURS = {basic:12,silver:15,gold:20,platinum:25};
        const hours = PLAN_HOURS[user.plan] || 12;
        user.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      }
      user.paymentVerified = false;
    }
    await user.save();
    res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive, requiredSubs });
  } catch(err) { res.json({ success: false }); }
});

app.get('/api/can-activate/:userId', async (req, res) => {
  try {
    const activeCount = await User.countDocuments({ isActive: true });
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ canActivate: false });
    const plan = PLANS[user.plan] || PLANS.free;
    if (activeCount === 0) {
      user.isActive = true;
      user.startTime = new Date();
      await user.save();
      return res.json({ canActivate: true, isActive: true });
    }
    res.json({ canActivate: false, activeCount });
  } catch(err) { res.json({ canActivate: false }); }
});

app.post('/api/update-youtube', async (req, res) => {
  try {
    const { userId, youtubeLink } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false });
    user.youtubeLink = youtubeLink;
    await user.save();
    res.json({ success: true });
  } catch(err) { res.json({ success: false }); }
});

app.get('/api/status/:userId', async (req, res) => {
  try {
    await updateSlots();
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ found: false });
    let message = '';
    if (user.isActive && user.startTime) {
      const timeLeft = ACTIVE_DURATION - (Date.now() - user.startTime);
      const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
      message = `✅ Link active hai — ${hoursLeft} ghante baaki!`;
    } else {
      const aheadInQueue = await User.countDocuments({ isActive: false, adsWatched: { $gte: 1 }, joinedAt: { $lt: user.joinedAt } });
      const activeCount = await User.countDocuments({ isActive: true });
      if (activeCount < SLOT_LIMIT) message = '⏳ Jald active hoga!';
      else if (aheadInQueue === 0) message = '📅 Kal active hoga!';
      else if (aheadInQueue <= SLOT_LIMIT) message = '📅 Parson active hoga!';
      else message = `📅 ${Math.ceil(aheadInQueue / SLOT_LIMIT)} din baad active hoga!`;
    }
    res.json({
      found: true, isActive: user.isActive, message,
      youtubeLink: user.youtubeLink, adsWatched: user.adsWatched,
      subsGiven: user.subsGiven, email: user.email, name: user.name,
      photo: user.photo, plan: user.plan,
      totalViews: user.totalViews, totalClicks: user.totalClicks
    });
  } catch(err) { res.json({ found: false }); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activePromos = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['premium', 'vip', 'top'] } });
    res.json({ totalUsers, activePromos, premiumUsers });
  } catch(err) { res.json({ totalUsers: 0, activePromos: 0, premiumUsers: 0 }); }
});

// Leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await User.find({ youtubeLink: { $ne: '' } })
      .sort({ totalClicks: -1, totalViews: -1 })
      .limit(10)
      .select('name email photo youtubeLink plan totalViews totalClicks isActive');
    res.json({ users });
  } catch(err) { res.json({ users: [] }); }
});

app.post('/api/payment/create', async (req, res) => {
  try {
    const { userId, plan, amount } = req.body;
    const payment = new Payment({ userId, plan, amount, transactionId: 'TXN' + Date.now() });
    await payment.save();
    res.json({ success: true, paymentId: payment._id, amount, upiId: 'amanalam917696@okicici' });
  } catch(err) { res.json({ success: false }); }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { paymentId, transactionId, userId, plan, screenshot } = req.body;
    
    let payment = null;
    if(paymentId && !paymentId.startsWith('MANUAL_')) {
      payment = await Payment.findById(paymentId);
    }
    
    const user = await User.findById(userId);
    if(!user) return res.json({ success: false, message: 'User nahi mila' });
    
    const amount = PLAN_AMOUNTS[plan] || 0;
    
    if(payment) {
      payment.transactionId = transactionId;
      payment.screenshot = screenshot || null;
      payment.status = 'pending_admin';
      payment.userName = user.name || user.email;
      payment.userEmail = user.email;
      await payment.save();
    } else {
      const newPayment = new Payment({
        userId, plan, amount,
        transactionId, screenshot: screenshot || null,
        userName: user.name || user.email,
        userEmail: user.email,
        status: 'pending_admin'
      });
      await newPayment.save();
    }
    
    // User ko pending state mein rakho - admin activate karega
    user.plan = plan;
    user.subsGiven = 0;
    user.adsWatched = 0;
    user.isActive = false;
    user.pendingPayment = true;
    await user.save();
    
    res.json({ success: true, message: 'Payment details submit ho gaye! Admin verify karega aur aapka link active ho jayega.' });
  } catch(err) { 
    console.error('Verify error:', err);
    res.json({ success: false, message: err.message }); 
  }
});

// Admin activate user with time limit
app.post('/admin/activate-user', async (req, res) => {
  try {
    const { userId, paymentId, plan } = req.body;
    const hours = PLAN_HOURS[plan] || 12;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
    
    const user = await User.findById(userId);
    if(!user) return res.json({ success: false });
    
    user.isActive = false;  // Still false - needs to subscribe first
    user.startTime = now;
    user.expiresAt = expiresAt;
    user.pendingPayment = false;
    user.paymentVerified = true;  // Payment done - can now subscribe
    user.subsGiven = 0;
    await user.save();
    
    if(paymentId) {
      await Payment.findByIdAndUpdate(paymentId, { 
        status: 'completed', 
        activatedAt: now,
        expiresAt 
      });
    }
    
    res.json({ success: true, message: `User ${hours} ghante ke liye active ho gaya!`, expiresAt });
  } catch(e) { res.json({ success: false }); }
});


// Reject payment
app.post('/admin/reject-payment', async (req, res) => {
  try {
    const { paymentId } = req.body;
    await Payment.findByIdAndUpdate(paymentId, { status: 'rejected' });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});


// Subscribe done - update payment status and notify admin
app.post('/api/payment/subscribe-done', async (req, res) => {
  try {
    const { userId, paymentId, plan, amount, txnId, userName, userEmail, ytLink } = req.body;
    
    // Update payment to show subscribe is done
    if(paymentId && !paymentId.startsWith('MANUAL_')) {
      await Payment.findByIdAndUpdate(paymentId, { 
        status: 'subscribed_done',
        subscribeDoneAt: new Date()
      });
    } else {
      // Find latest payment for this user
      await Payment.findOneAndUpdate(
        { userId, status: 'pending_admin' },
        { status: 'subscribed_done', subscribeDoneAt: new Date() }
      );
    }
    
    console.log(`✅ Subscribe done notification: ${userName} (${userEmail}) - Plan: ${plan} - ₹${amount} - UTR: ${txnId}`);
    
    res.json({ success: true });
  } catch(e) { 
    console.error(e);
    res.json({ success: false }); 
  }
});

// Get pending payments for admin
app.get('/admin/pending-payments', async (req, res) => {
  try {
    const payments = await Payment.find({ status: { $in: ['pending_admin', 'subscribed_done'] } }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, payments });
  } catch(e) { res.json({ success: false }); }
});

// Check if user link is still active (time based)
app.get('/api/check-active/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if(!user) return res.json({ isActive: false });
    
    // Check if time expired
    if(user.isActive && user.expiresAt && new Date() > user.expiresAt) {
      user.isActive = false;
      user.pendingPayment = false;
      await user.save();
      return res.json({ isActive: false, expired: true });
    }
    
    const timeLeft = user.expiresAt ? Math.max(0, user.expiresAt - new Date()) : 0;
    const hoursLeft = Math.floor(timeLeft / 3600000);
    const minsLeft = Math.floor((timeLeft % 3600000) / 60000);
    
    res.json({ 
      isActive: user.isActive, 
      pendingPayment: user.pendingPayment || false,
      paymentVerified: user.paymentVerified || false,
      expiresAt: user.expiresAt,
      timeLeft: `${hoursLeft}h ${minsLeft}m`
    });
  } catch(e) { res.json({ isActive: false }); }
});

app.get('/admin/activate/:email', async (req, res) => {
  try {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.send('User nahi mila!');
    user.isActive = true;
    user.startTime = new Date();
    await user.save();
    res.send('User activate ho gaya: ' + req.params.email);
  } catch(err) { res.send('Error: ' + err.message); }
});

app.get('/admin/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['premium', 'vip', 'top'] } });
    const payments = await Payment.find({ status: 'completed' });
    const revenue = payments.reduce((sum, p) => sum + p.amount, 0);
    res.json({ totalUsers, activeUsers, premiumUsers, revenue });
  } catch(err) { res.json({}); }
});

app.get('/c/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.send('Link expired!');
    user.totalClicks += 1;
    await user.save();
    res.redirect(user.youtubeLink);
  } catch(err) { res.send('Error!'); }
});

const PORT = process.env.PORT || 3000;


// ============================================================
// ADMIN API ROUTES — Password protected
// ============================================================
const ADMIN_SECRET = '@aman@769691@';

function adminAuth(req, res, next) {
  const auth = req.headers['x-admin-key'] || req.body?.adminKey;
  if (auth !== ADMIN_SECRET) return res.json({ success: false, message: 'Unauthorized' });
  next();
}

// Admin settings schema
const adminSettingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed
});
const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

async function getSetting(key, defaultVal) {
  try {
    const s = await AdminSettings.findOne({ key });
    return s ? s.value : defaultVal;
  } catch(e) { return defaultVal; }
}

async function setSetting(key, value) {
  await AdminSettings.findOneAndUpdate({ key }, { key, value }, { upsert: true });
}

// Get all admin settings
app.get('/api/admin/settings', async (req, res) => {
  const auth = req.headers['x-admin-key'];
  if (auth !== ADMIN_SECRET) return res.json({ success: false });
  try {
    const plans = await getSetting('plans', {
      basic:    { price: 10, subscribers: 500  },
      silver:   { price: 20, subscribers: 1000 },
      gold:     { price: 30, subscribers: 1500 },
      platinum: { price: 50, subscribers: 3000 }
    });
    const content = await getSetting('content', {
      siteName: 'YT Sub Exchange',
      heroTitle: 'Real YouTube Subscribers Paao!',
      heroSub: 'Plan lein, subscribe karo, grow karo!',
      whatsapp: '',
      upiId: 'amanalam917696@okicici'
    });
    const qrImage = await getSetting('qrImage', '');
    res.json({ success: true, plans, content, qrImage });
  } catch(e) { res.json({ success: false }); }
});

// Update plans
app.post('/api/admin/plans', adminAuth, async (req, res) => {
  try {
    await setSetting('plans', req.body.plans);
    res.json({ success: true, message: 'Plans update ho gaye!' });
  } catch(e) { res.json({ success: false }); }
});

// Update content
app.post('/api/admin/content', adminAuth, async (req, res) => {
  try {
    await setSetting('content', req.body.content);
    res.json({ success: true, message: 'Content update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Update QR image
app.post('/api/admin/qr', adminAuth, async (req, res) => {
  try {
    await setSetting('qrImage', req.body.qrImage);
    res.json({ success: true, message: 'QR update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Get public settings (for website)
app.get('/api/settings', async (req, res) => {
  try {
    const plans = await getSetting('plans', {
      basic:    { price: 10, subscribers: 500  },
      silver:   { price: 20, subscribers: 1000 },
      gold:     { price: 30, subscribers: 1500 },
      platinum: { price: 50, subscribers: 3000 }
    });
    const content = await getSetting('content', {
      siteName: 'YT Sub Exchange',
      heroTitle: 'Real YouTube Subscribers Paao!',
      heroSub: 'Plan lein, subscribe karo, grow karo!',
      upiId: 'amanalam917696@okicici'
    });
    const qrImage = await getSetting('qrImage', '/phonepe-qr.png');
    res.json({ success: true, plans, content, qrImage });
  } catch(e) { res.json({ success: false }); }
});

// Admin stats
app.get('/api/admin/full-stats', async (req, res) => {
  const auth = req.headers['x-admin-key'];
  if (auth !== ADMIN_SECRET) return res.json({ success: false });
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['basic','silver','gold','platinum'] } });
    const payments = await Payment.find({ status: 'completed' });
    const revenue = payments.reduce((sum, p) => sum + p.amount, 0);
    const recentUsers = await User.find().sort({ _id: -1 }).limit(10).select('name email plan isActive');
    res.json({ success: true, totalUsers, activeUsers, premiumUsers, revenue, recentUsers });
  } catch(e) { res.json({ success: false }); }
});


// ============================================================
// ADMIN API ROUTES — Password protected
// ============================================================
const ADMIN_PASSWORD = '@aman@769691@';

// Admin login verify
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if(password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.json({ success: false, message: 'Wrong password!' });
  }
});

// Settings schema
const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});
const Settings = mongoose.model('Settings', settingsSchema);

// Save any setting
async function saveSetting(key, value) {
  await Settings.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

// Get any setting
async function getSetting(key, defaultValue = null) {
  const s = await Settings.findOne({ key });
  return s ? s.value : defaultValue;
}

// Admin middleware - check password
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.body?.adminPassword;
  if(pass !== ADMIN_PASSWORD) {
    return res.json({ success: false, message: 'Unauthorized!' });
  }
  next();
}

// Update plans
app.post('/admin/update-plans', adminAuth, async (req, res) => {
  try {
    const { plans } = req.body;
    await saveSetting('plans', plans);
    res.json({ success: true, message: 'Plans update ho gaye!' });
  } catch(e) { res.json({ success: false }); }
});

// Update content (text)
app.post('/admin/update-content', adminAuth, async (req, res) => {
  try {
    const { content } = req.body;
    await saveSetting('content', content);
    res.json({ success: true, message: 'Content update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Update contact info
app.post('/admin/update-contact', adminAuth, async (req, res) => {
  try {
    const { contact } = req.body;
    await saveSetting('contact', contact);
    res.json({ success: true, message: 'Contact update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Update QR image
app.post('/admin/update-qr', adminAuth, async (req, res) => {
  try {
    const { qrImage } = req.body;
    await saveSetting('qrImage', qrImage);
    res.json({ success: true, message: 'QR update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Update logo
app.post('/admin/update-logo', adminAuth, async (req, res) => {
  try {
    const { logo } = req.body;
    await saveSetting('logo', logo);
    res.json({ success: true, message: 'Logo update ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});

// Get all settings (for website to load)
app.get('/admin/get-settings', async (req, res) => {
  try {
    const plans = await getSetting('plans');
    const content = await getSetting('content');
    const contact = await getSetting('contact');
    const qrImage = await getSetting('qrImage');
    const logo = await getSetting('logo');
    res.json({ success: true, plans, content, contact, qrImage, logo });
  } catch(e) { res.json({ success: false }); }
});

// Get all users for admin
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find().select('name email plan isActive createdAt subsGiven').limit(100);
    res.json({ success: true, users });
  } catch(e) { res.json({ success: false }); }
});

// Activate/deactivate user
app.post('/admin/toggle-user', adminAuth, async (req, res) => {
  try {
    const { userId, isActive } = req.body;
    const user = await User.findById(userId);
    if(!user) return res.json({ success: false });
    user.isActive = isActive;
    if(isActive) user.startTime = new Date();
    await user.save();
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// Admin stats
app.get('/admin/full-stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['basic','silver','gold','platinum'] } });
    const payments = await Payment.find({ status: 'completed' });
    const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    res.json({ success: true, totalUsers, activeUsers, premiumUsers, revenue, totalPayments: payments.length });
  } catch(e) { res.json({ success: false }); }
});

// Change admin password
app.post('/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if(!newPassword || newPassword.length < 6) return res.json({ success: false, message: 'Password bahut chhota hai!' });
    await saveSetting('adminPassword', newPassword);
    res.json({ success: true, message: 'Password change ho gaya!' });
  } catch(e) { res.json({ success: false }); }
});


// ============================================================
// AUTO PING — Server ko jaaga rakhega (free fix)
// ============================================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://yt-sub-exchange.onrender.com';

setInterval(async () => {
  try {
    const http = require('https');
    http.get(SELF_URL + '/api/stats', (res) => {
      console.log('✅ Auto-ping successful:', new Date().toLocaleTimeString());
    }).on('error', (e) => {
      console.log('⚠️ Auto-ping failed:', e.message);
    });
  } catch(e) {}
}, 14 * 60 * 1000); // Har 14 minute mein ping

console.log('🚀 Auto-ping started — server jaaga rahega!');

app.listen(PORT, () => console.log('Server running on port ' + PORT));
