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
    const { paymentId, transactionId } = req.body;
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.json({ success: false });
    payment.transactionId = transactionId;
    payment.status = 'completed';
    await payment.save();
    const user = await User.findById(payment.userId);
    if (user) { 
      user.plan = payment.plan;
      user.subsGiven = 0;
      user.adsWatched = 0;
      user.isActive = false;
      await user.save(); 
    }
    res.json({ success: true, message: 'Payment verified! Ab 10 channels subscribe karo.' });
  } catch(err) { res.json({ success: false }); }
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
app.listen(PORT, () => console.log('Server running on port ' + PORT));
