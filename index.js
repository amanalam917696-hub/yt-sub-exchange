const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: 'https://ytsubexchange.online', credentials: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: 'ytsubexchange_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', maxAge: 24 * 60 * 60 * 1000 }
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

// Schemas
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  googleId: { type: String, default: '' },
  name: { type: String, default: '' },
  photo: { type: String, default: '' },
  youtubeLink: { type: String, default: '' },
  plan: { type: String, default: 'free', enum: ['free', 'starter', 'growth', 'pro', 'premium', 'vip', 'top'] },
  adsWatched: { type: Number, default: 0 },
  subsGiven: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  totalViews: { type: Number, default: 0 },
  totalClicks: { type: Number, default: 0 },
  referralCode: { type: String, default: '' },
  referredBy: { type: String, default: '' },
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
  free: { ads: 3, subs: 4, priority: 0 },
  starter: { ads: 2, subs: 4, priority: 1 },
  growth: { ads: 3, subs: 6, priority: 2 },
  pro: { ads: 5, subs: 10, priority: 3 },
  premium: { ads: 2, subs: 3, priority: 4, price: 5 },
  vip: { ads: 2, subs: 2, priority: 5, price: 20 },
  top: { ads: 1, subs: 1, priority: 6, price: 50 }
};

function generateReferralCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
      .sort({ 'plan': -1, joinedAt: 1 }).limit(needed * 3);
    let activated = 0;
    for (const u of waiting) {
      if (activated >= needed) break;
      const plan = PLANS[u.plan] || PLANS.free;
      if (u.adsWatched >= plan.ads && u.subsGiven >= Math.min(plan.subs, await User.countDocuments({ isActive: true }))) {
        u.isActive = true;
        u.startTime = new Date();
        await u.save();
        activated++;
      }
    }
  }
}

// Google OAuth
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://ytsubexchange.online/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await User.findOne({ googleId: profile.id });
    if (!user) {
      user = await User.findOne({ email: profile.emails[0].value });
      if (user) {
        user.googleId = profile.id;
        user.name = profile.displayName;
        user.photo = profile.photos[0]?.value || '';
        await user.save();
      } else {
        user = new User({
          email: profile.emails[0].value,
          googleId: profile.id,
          name: profile.displayName,
          photo: profile.photos[0]?.value || '',
          referralCode: generateReferralCode()
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

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=login_failed' }),
  async (req, res) => {
    const user = req.user;
    res.redirect(`/?userId=${user._id}&email=${encodeURIComponent(user.email)}&name=${encodeURIComponent(user.name)}&photo=${encodeURIComponent(user.photo)}&ytLink=${encodeURIComponent(user.youtubeLink||'')}&isActive=${user.isActive}&adsWatched=${user.adsWatched}&plan=${user.plan}`);
  }
);

// Ad watched
app.post('/api/ad-watched', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  const plan = PLANS[user.plan] || PLANS.free;
  if (user.adsWatched < plan.ads) { user.adsWatched += 1; await user.save(); }
  res.json({ adsWatched: user.adsWatched, required: plan.ads });
});

// Get channels
app.get('/api/get-channels/:userId', async (req, res) => {
  await updateSlots();
  const user = await User.findById(req.params.userId);
  const plan = PLANS[user?.plan || 'free'];
  const activeUsers = await User.find({ _id: { $ne: req.params.userId }, isActive: true }).limit(plan.subs);
  res.json({ channels: activeUsers, totalActive: activeUsers.length, required: plan.subs });
});

// Sub done
app.post('/api/sub-done', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  const plan = PLANS[user.plan] || PLANS.free;
  const activeCount = await User.countDocuments({ isActive: true });
  const requiredSubs = Math.min(plan.subs, activeCount);
  if (user.adsWatched >= plan.ads && user.subsGiven >= requiredSubs) {
    user.isActive = true;
    user.startTime = new Date();
  }
  await user.save();
  res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive, requiredSubs });
});

// Can activate
app.get('/api/can-activate/:userId', async (req, res) => {
  const activeCount = await User.countDocuments({ isActive: true });
  const user = await User.findById(req.params.userId);
  if (!user) return res.json({ canActivate: false });
  const plan = PLANS[user.plan] || PLANS.free;
  if (activeCount === 0 && user.adsWatched >= plan.ads) {
    user.isActive = true;
    user.startTime = new Date();
    await user.save();
    return res.json({ canActivate: true, isActive: true });
  }
  res.json({ canActivate: false, activeCount });
});

// Update YouTube link
app.post('/api/update-youtube', async (req, res) => {
  const { userId, youtubeLink } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.json({ success: false });
  user.youtubeLink = youtubeLink;
  await user.save();
  res.json({ success: true });
});

// Status
app.get('/api/status/:userId', async (req, res) => {
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
  res.json({ found: true, isActive: user.isActive, message, youtubeLink: user.youtubeLink, adsWatched: user.adsWatched, subsGiven: user.subsGiven, email: user.email, name: user.name, photo: user.photo, plan: user.plan, totalViews: user.totalViews, totalClicks: user.totalClicks });
});

// Live stats
app.get('/api/stats', async (req, res) => {
  const totalUsers = await User.countDocuments();
  const activePromos = await User.countDocuments({ isActive: true });
  const premiumUsers = await User.countDocuments({ plan: { $in: ['premium', 'vip', 'top'] } });
  res.json({ totalUsers, activePromos, premiumUsers });
});

// Payment - PhonePe (Manual verify ke liye)
app.post('/api/payment/create', async (req, res) => {
  const { userId, plan } = req.body;
  const planData = PLANS[plan];
  if (!planData || !planData.price) return res.json({ success: false, msg: 'Invalid plan!' });
  const payment = new Payment({ userId, plan, amount: planData.price, transactionId: 'TXN' + Date.now() });
  await payment.save();
  res.json({ success: true, paymentId: payment._id, amount: planData.price, upiId: 'amanalam917696@okicici' });
});

app.post('/api/payment/verify', async (req, res) => {
  const { paymentId, transactionId } = req.body;
  const payment = await Payment.findById(paymentId);
  if (!payment) return res.json({ success: false });
  payment.transactionId = transactionId;
  payment.status = 'completed';
  await payment.save();
  const user = await User.findById(payment.userId);
  if (user) { user.plan = payment.plan; await user.save(); }
  res.json({ success: true, msg: 'Payment verified! Plan active ho gaya!' });
});

// Admin
app.get('/admin/activate/:email', async (req, res) => {
  const user = await User.findOne({ email: req.params.email });
  if (!user) return res.send('User nahi mila!');
  user.isActive = true;
  user.startTime = new Date();
  await user.save();
  res.send('User activate ho gaya: ' + req.params.email);
});

app.get('/admin/stats', async (req, res) => {
  const totalUsers = await User.countDocuments();
  const activeUsers = await User.countDocuments({ isActive: true });
  const premiumUsers = await User.countDocuments({ plan: { $in: ['premium', 'vip', 'top'] } });
  const payments = await Payment.find({ status: 'completed' });
  const revenue = payments.reduce((sum, p) => sum + p.amount, 0);
  res.json({ totalUsers, activeUsers, premiumUsers, revenue, payments });
});

app.get('/c/:userId', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.send('Link expired!');
  user.totalClicks += 1;
  await user.save();
  res.redirect(user.youtubeLink);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
