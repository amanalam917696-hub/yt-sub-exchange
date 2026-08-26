const express = require('express');
const https = require('https');
const mongoose = require('mongoose');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const bcrypt = require('bcryptjs');

const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', req.headers.origin || '*'); res.header('Access-Control-Allow-Credentials', 'true'); res.header('Access-Control-Allow-Headers', 'Content-Type,admin-password'); res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE'); if(req.method==='OPTIONS') return res.sendStatus(200); next(); });
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.use(session({
  secret: process.env.SESSION_SECRET || 'ytsubexchange_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'none', maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 din
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected!'))
  .catch(err => console.log('❌ MongoDB error:', err));

// ============================================================
// TELEGRAM NOTIFICATION SETUP
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8279929634:AAEZ7R9VoABhZcBXi2hx2cvWkaYcomHlwbc';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '5945121043';

async function sendTelegram(message) {
  try {
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${text}&parse_mode=HTML`;
    return new Promise((resolve) => {
      https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log('📨 Telegram sent:', message.substring(0, 50));
          resolve(true);
        });
      }).on('error', (e) => {
        console.log('⚠️ Telegram error:', e.message);
        resolve(false);
      });
    });
  } catch(e) {
    console.log('Telegram exception:', e.message);
  }
}

// ============================================================
// SCHEMAS
// ============================================================
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true },
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
  joinedAt: { type: Date, default: Date.now },
  // ===== MEMBERSHIP =====
  memberExpiry: { type: Date, default: null },
  // ===== REFERRAL SYSTEM =====
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String, default: null },        // referrer ka referralCode
  walletBalance: { type: Number, default: 0 },          // withdraw-able commission
  totalEarned: { type: Number, default: 0 },            // lifetime earning
  totalReferrals: { type: Number, default: 0 },          // kitne logo ko refer kiya
  // ===== BONUS SYSTEM =====
  bonusWallet: { type: Number, default: 120 },           // ₹120 locked bonus (naye user ko)
  bonusUnlocked: { type: Boolean, default: false },      // withdrawal unlock hua?
  bonusPaidPlan: { type: Boolean, default: false },      // ₹35 plan kharida?
  paidReferrals: { type: Number, default: 0 },           // kitne referred users ne paid kiya
  // ===== SUBSCRIBE & EARN =====
  earnWallet: { type: Number, default: 0 },              // subscribe karke kamaya
  totalEarnedSubs: { type: Number, default: 0 }          // lifetime subscribe earnings
});

const paymentSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  email: String,
  userEmail: String,
  userName: String,
  plan: String,
  amount: Number,
  transactionId: String,
  screenshot: String,
  status: { type: String, default: 'pending' },
  activatedAt: Date,
  expiresAt: Date,
  subscribeDoneAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const settingsSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  value: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

const withdrawalSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  userName: String,
  userEmail: String,
  amount: Number,
  gst: { type: Number, default: 0 },
  amtAfterGst: { type: Number, default: 0 },
  upiId: String,
  status: { type: String, default: 'pending' }, // pending | paid | rejected
  requestedAt: { type: Date, default: Date.now },
  paidAt: Date
});

// ===== SUBSCRIBE & EARN SCHEMAS =====
const earnChannelSchema = new mongoose.Schema({
  channelUrl: String,
  channelName: { type: String, default: '' },
  addedByAdmin: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  maxSubscribes: { type: Number, default: 350 }, // limit
  totalSubscribes: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const earnHistorySchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  channelId: mongoose.Schema.Types.ObjectId,
  channelUrl: String,
  earning: { type: Number, default: 0.17 },
  earnedAt: { type: Date, default: Date.now },
  paid: { type: Boolean, default: false },
  paidAt: Date
});

const User = mongoose.model('User', userSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
const EarnChannel = mongoose.model('EarnChannel', earnChannelSchema);
const EarnHistory = mongoose.model('EarnHistory', earnHistorySchema);

// ============================================================
// PLAN CONFIG
// ============================================================
const PLAN_HOURS = {
  free:      0,
  starter:   12,  // ₹35
  basic:     24,  // ₹200
  silver:    36,  // ₹500
  gold:      48,  // ₹1000
  diamond:   60,  // ₹1500
  platinum:  72   // ₹2500
};

const PLAN_AMOUNTS = {
  starter:  35,
  basic:    200,
  silver:   500,
  gold:     1000,
  diamond:  1500,
  platinum: 2500
};

const PLAN_SUBSCRIBERS = {
  starter:  70,
  basic:    350,
  silver:   750,
  gold:     1400,
  diamond:  2500,
  platinum: 4000
};

const PLANS = {
  free:     { ads: 0, subs: 0,  priority: 0, price: 0  },
  basic:    { ads: 0, subs: 10, priority: 1, price: 10, subscribers: 500  },
  silver:   { ads: 0, subs: 10, priority: 2, price: 20, subscribers: 1000 },
  gold:     { ads: 0, subs: 10, priority: 3, price: 30, subscribers: 1500 },
  platinum: { ads: 0, subs: 10, priority: 4, price: 50, subscribers: 3000 }
};

const SLOT_LIMIT = 10;
const ACTIVE_DURATION = 24 * 60 * 60 * 1000;

// ===== REFERRAL COMMISSION SLABS =====
const COMMISSION_SLABS = {
  starter:  10,   // ₹35 plan -> ₹10 commission
  basic:    90,   // ₹200 plan -> ₹90 commission
  silver:   125,  // ₹500 plan -> ₹125 commission
  gold:     250,  // ₹1000 plan -> ₹250 commission
  diamond:  375,  // ₹1500 plan -> ₹375 commission
  platinum: 600   // ₹2500 plan -> ₹600 commission
};
const MIN_WITHDRAWAL = 200;
const MAX_WITHDRAWAL = Infinity;

function generateReferralCode(name, id) {
  const namePart = (name || 'YT').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase() || 'YTS';
  const idPart = id.toString().slice(-5).toUpperCase();
  return namePart + idPart;
}

async function ensureReferralCode(user) {
  if (!user.referralCode) {
    let code = generateReferralCode(user.name || user.email, user._id);
    // Ensure uniqueness
    let exists = await User.findOne({ referralCode: code });
    let attempt = 0;
    while (exists && attempt < 5) {
      code = generateReferralCode(user.name || user.email, user._id) + Math.floor(Math.random()*9);
      exists = await User.findOne({ referralCode: code });
      attempt++;
    }
    user.referralCode = code;
    await user.save();
  }
  return user.referralCode;
}

// ✅ Referred user ne payment kiya — referrer ko commission do
async function creditReferralCommission(paidUser, plan) {
  try {
    if (!paidUser.referredBy) return;
    const referrer = await User.findOne({ referralCode: paidUser.referredBy });
    if (!referrer) return;

    const commission = COMMISSION_SLABS[plan] || 0;
    if (commission <= 0) return;

    referrer.walletBalance = (referrer.walletBalance || 0) + commission;
    referrer.totalEarned = (referrer.totalEarned || 0) + commission;

    // ===== BONUS SYSTEM =====
    // Paid referral count badhao
    referrer.paidReferrals = (referrer.paidReferrals || 0) + 1;

    // Bonus unlock check — ₹35 plan kharida + 5 paid referrals
    if (!referrer.bonusUnlocked && referrer.bonusPaidPlan && referrer.paidReferrals >= 5) {
      referrer.bonusUnlocked = true;
      referrer.walletBalance = (referrer.walletBalance || 0) + (referrer.bonusWallet || 120);

      await sendTelegram(
        `🎉 BONUS UNLOCK!\n\n` +
        `👤 ${referrer.name || referrer.email}\n` +
        `📧 ${referrer.email}\n` +
        `💰 ₹120 bonus wallet mein add ho gaya!\n` +
        `👥 5 paid referrals complete!\n` +
        `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
      );
    }

    await referrer.save();

    await sendTelegram(
      `💸 REFERRAL COMMISSION!\n\n` +
      `👤 Referrer: ${referrer.name || referrer.email}\n` +
      `📧 ${referrer.email}\n` +
      `💰 Earned: ₹${commission}\n` +
      `🎯 From: ${paidUser.name || paidUser.email} (${plan.toUpperCase()} plan)\n` +
      `💼 Wallet Balance: ₹${referrer.walletBalance}\n` +
      `👥 Paid Referrals: ${referrer.paidReferrals}/5\n` +
      `🎁 Bonus: ${referrer.bonusUnlocked ? '✅ Unlocked!' : `${referrer.paidReferrals}/5 paid referrals done`}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );
  } catch(e) {
    console.error('Referral commission error:', e);
  }
}

// ₹35 Starter plan kharidne pe bonusPaidPlan set karo
async function checkBonusPaidPlan(user, plan) {
  try {
    if (plan === 'starter' && !user.bonusPaidPlan) {
      user.bonusPaidPlan = true;

      // Agar 5 paid referrals pehle se ho chuke hain to unlock karo
      if (!user.bonusUnlocked && (user.paidReferrals || 0) >= 5) {
        user.bonusUnlocked = true;
        user.walletBalance = (user.walletBalance || 0) + (user.bonusWallet || 120);
        await sendTelegram(
          `🎉 BONUS UNLOCK!\n\n` +
          `👤 ${user.name || user.email}\n` +
          `📧 ${user.email}\n` +
          `💰 ₹120 bonus unlock ho gaya!\n` +
          `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
        );
      }
      await user.save();
    }
  } catch(e) {
    console.error('Bonus plan check error:', e);
  }
}

// ============================================================
// SETTINGS HELPERS
// ============================================================
async function saveSetting(key, value) {
  await Settings.findOneAndUpdate(
    { key },
    { key, value, updatedAt: new Date() },
    { upsert: true, new: true }
  );
}

async function getSetting(key, defaultValue = null) {
  try {
    const s = await Settings.findOne({ key });
    return s ? s.value : defaultValue;
  } catch(e) { return defaultValue; }
}

// ============================================================
// SLOT MANAGEMENT
// ============================================================
async function updateSlots() {
  const now = new Date();
  await User.updateMany(
    { isActive: true, expiresAt: { $lt: now } },
    { $set: { isActive: false } }
  );
  const oldExpiry = new Date(now - ACTIVE_DURATION);
  await User.updateMany(
    { isActive: true, expiresAt: null, startTime: { $lt: oldExpiry } },
    { $set: { isActive: false } }
  );

  const plans = ['basic', 'silver', 'gold', 'platinum'];
  for (const plan of plans) {
    const activeCount = await User.countDocuments({ isActive: true, plan });
    if (activeCount < SLOT_LIMIT) {
      const slots = SLOT_LIMIT - activeCount;
      const nextUsers = await User.find({
        isActive: false,
        paymentVerified: true,
        plan,
        subsGiven: { $gte: 10 }
      }).sort({ joinedAt: 1 }).limit(slots);

      for (const u of nextUsers) {
        const hours = PLAN_HOURS[plan] || 12;
        u.isActive = true;
        u.startTime = new Date();
        u.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
        u.paymentVerified = false;
        await u.save();
        console.log(`✅ Queue activated: ${u.email} - ${plan}`);
      }
    }
  }
}

// ============================================================
// GOOGLE AUTH
// ============================================================
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://ytsubexchange.online/auth/google/callback',
  scope: ['profile', 'email'],
  passReqToCallback: true
}, async (req, accessToken, refreshToken, profile, done) => {
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
        // ✅ Referral code from query string (?ref=CODE) passed via state
        const refCode = req.query.state || null;
        user = new User({
          email: profile.emails[0].value,
          googleId: profile.id,
          name: profile.displayName || '',
          photo: profile.photos && profile.photos[0] ? profile.photos[0].value : '',
          referredBy: refCode || null
        });
        await user.save();
        await ensureReferralCode(user);

        // 🔔 NEW USER NOTIFICATION
        await sendTelegram(
          `🆕 NEW USER JOIN!\n\n` +
          `👤 Name: ${user.name || 'Unknown'}\n` +
          `📧 Email: ${user.email}\n` +
          (refCode ? `🔗 Referred by: ${refCode}\n` : '') +
          `🕐 Time: ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
        );
      }
    }
    if (!user.referralCode) await ensureReferralCode(user);
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

app.get('/auth/google', (req, res, next) => {
  const refCode = req.query.ref || '';
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    state: refCode
  })(req, res, next);
});

app.get('/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/?error=login_failed',
    session: false
  }),
  async (req, res) => {
    try {
      const user = req.user;
      await ensureReferralCode(user);
      const params = new URLSearchParams({
        userId: user._id.toString(),
        email: user.email,
        name: user.name || '',
        photo: user.photo || '',
        ytLink: user.youtubeLink || '',
        isActive: user.isActive.toString(),
        adsWatched: user.adsWatched.toString(),
        plan: user.plan || 'free',
        referralCode: user.referralCode || ''
      });
      res.redirect('/?' + params.toString());
    } catch(err) {
      res.redirect('/?error=callback_failed');
    }
  }
);

// ============================================================
// USER APIS
// ============================================================
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const now = new Date();
    const activeMembers = await User.countDocuments({ memberExpiry: { $gt: now } });
    const totalPayments = await Payment.countDocuments({ status: 'completed' });
    const revenueData = await Payment.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const totalRevenue = revenueData[0]?.total || 0;
    res.json({ success: true, totalUsers, activeMembers, totalPayments, totalRevenue });
  } catch(err) { res.json({ success: false, totalUsers: 0, activeMembers: 0, totalPayments: 0, totalRevenue: 0 }); }
});

// ===== USER INFO =====
app.get('/api/user-info', async (req, res) => {
  try {
    if (!req.user) return res.json({ success: false });
    const user = await User.findById(req.user._id);
    if (!user) return res.json({ success: false });
    res.json({
      success: true,
      user: {
        id: user._id,
        _id: user._id,
        name: user.name,
        email: user.email,
        photo: user.photo,
        memberActive: user.memberExpiry && new Date() < new Date(user.memberExpiry),
        memberExpiry: user.memberExpiry
      }
    });
  } catch(e) { res.json({ success: false }); }
});

// ===== MEMBER STATUS =====
app.get('/api/member-status/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ success: false });
    const now = new Date();
    const isActive = user.memberExpiry && new Date(user.memberExpiry) > now;
    res.json({ success: true, isActive, expiryDate: user.memberExpiry });
  } catch(e) { res.json({ success: false }); }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const users = await User.find({ youtubeLink: { $ne: '' } })
      .sort({ totalClicks: -1, totalViews: -1 })
      .limit(10)
      .select('name email photo youtubeLink plan totalViews totalClicks isActive');
    res.json({ users });
  } catch(err) { res.json({ users: [] }); }
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

    let isActive = user.isActive;
    if (isActive && user.expiresAt && new Date() > user.expiresAt) {
      user.isActive = false;
      isActive = false;
      await user.save();
    }

    let message = '';
    if (isActive && user.expiresAt) {
      const timeLeft = user.expiresAt - Date.now();
      const hoursLeft = Math.floor(timeLeft / 3600000);
      const minsLeft = Math.floor((timeLeft % 3600000) / 60000);
      message = `✅ Link active hai — ${hoursLeft}h ${minsLeft}m baaki!`;
    } else if (isActive) {
      message = '✅ Link active hai!';
    } else if (user.paymentVerified) {
      message = '⏳ 10 channels subscribe karo — link active hoga!';
    } else if (user.pendingPayment) {
      message = '⏳ Payment verify ho rahi hai...';
    } else {
      const userPlan = user.plan || 'basic';
      const activeSamePlan = await User.countDocuments({ isActive: true, plan: userPlan });
      const queuePos = await User.countDocuments({
        isActive: false, paymentVerified: true, plan: userPlan,
        joinedAt: { $lt: user.joinedAt }
      });
      if (activeSamePlan < SLOT_LIMIT) {
        message = '⏳ Jald active hoga!';
      } else if (queuePos === 0) {
        message = `⏳ Queue #1 — ${PLAN_HOURS[userPlan] || 12} ghante mein active!`;
      } else {
        const estHours = Math.ceil((queuePos + 1) / 10) * (PLAN_HOURS[userPlan] || 12);
        message = `⏳ Queue #${queuePos + 1} — ~${estHours} ghante mein active!`;
      }
    }

    res.json({
      found: true, isActive, message,
      youtubeLink: user.youtubeLink,
      subsGiven: user.subsGiven,
      email: user.email, name: user.name, photo: user.photo, plan: user.plan,
      totalViews: user.totalViews || 0, totalClicks: user.totalClicks || 0,
      expiresAt: user.expiresAt,
      paymentVerified: user.paymentVerified || false,
      pendingPayment: user.pendingPayment || false
    });
  } catch(err) {
    console.error('Status error:', err);
    res.json({ found: false });
  }
});

app.get('/api/check-active/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ isActive: false });
    if (user.isActive && user.expiresAt && new Date() > user.expiresAt) {
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

app.get('/api/can-activate/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ canActivate: false });
    res.json({ canActivate: false, isActive: user.isActive });
  } catch(err) { res.json({ canActivate: false }); }
});

// ============================================================
// CHANNEL / SUBSCRIBE APIS
// ============================================================
app.get('/api/get-channels/:userId', async (req, res) => {
  try {
    await updateSlots();
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ channels: [], totalActive: 0, required: 10 });

    if (!user.paymentVerified) {
      return res.json({ channels: [], totalActive: 0, required: 10, error: 'Payment verify nahi hui', needsPayment: true });
    }

    const userPlan = user.plan || 'basic';
    const planHours = PLAN_HOURS[userPlan] || 12;

    const activeSamePlan = await User.countDocuments({ _id: { $ne: user._id }, isActive: true, plan: userPlan });
    const queuePosition = await User.countDocuments({
      _id: { $ne: user._id }, isActive: false, paymentVerified: true,
      plan: userPlan, joinedAt: { $lt: user.joinedAt }
    });

    const poolFull = activeSamePlan >= SLOT_LIMIT;
    if (poolFull && queuePosition > 0) {
      const myQueuePos = queuePosition + 1;
      const estimatedHours = Math.ceil(myQueuePos / SLOT_LIMIT) * planHours;
      return res.json({ channels: [], totalActive: activeSamePlan, required: 10, queuePosition: myQueuePos, estimatedWait: estimatedHours, poolFull: true, plan: userPlan });
    }

    let channelsToSubscribe = await User.find({
      _id: { $ne: user._id }, isActive: true, plan: userPlan,
      youtubeLink: { $exists: true, $ne: '' }
    }).limit(10);

    if (channelsToSubscribe.length === 0) {
      channelsToSubscribe = await User.find({
        _id: { $ne: user._id }, isActive: true,
        youtubeLink: { $exists: true, $ne: '' }
      }).limit(10);
    }

    // ✅ Koi channel nahi — auto-activate karo
    if (channelsToSubscribe.length === 0) {
      const hours = PLAN_HOURS[userPlan] || 12;
      const now = new Date();
      user.isActive = true;
      user.startTime = now;
      user.expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);
      user.paymentVerified = false;
      user.pendingPayment = false;
      await user.save();

      // 🔔 AUTO-ACTIVATE NOTIFICATION
      await sendTelegram(
        `⚡ AUTO-ACTIVATE!\n\n` +
        `👤 ${user.name || user.email}\n` +
        `📧 ${user.email}\n` +
        `💎 Plan: ${userPlan.toUpperCase()}\n` +
        `⏰ ${hours} ghante active\n` +
        `📺 ${user.youtubeLink || 'No link'}\n` +
        `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
      );

      console.log(`✅ Auto-activated: ${user.email} (${userPlan})`);
      return res.json({ channels: [], totalActive: 0, required: 0, autoActivated: true, expiresAt: user.expiresAt, hours });
    }

    res.json({
      channels: channelsToSubscribe,
      totalActive: activeSamePlan,
      required: Math.min(channelsToSubscribe.length, 10),
      queuePosition: 0, estimatedWait: 0, poolFull: false, plan: userPlan
    });
  } catch(err) {
    console.error('get-channels error:', err);
    res.json({ channels: [], totalActive: 0, required: 10 });
  }
});

app.post('/api/sub-done', async (req, res) => {
  try {
    const user = await User.findById(req.body.userId);
    if (!user) return res.json({ success: false });

    user.subsGiven += 1;

    const activeCount = await User.countDocuments({ _id: { $ne: user._id }, isActive: true, plan: user.plan });
    const totalActive = await User.countDocuments({ isActive: true });
    const requiredSubs = totalActive === 0 ? 0 : Math.min(10, activeCount);

    if (user.paymentVerified && (user.subsGiven >= 10 || activeCount === 0)) {
      const hours = PLAN_HOURS[user.plan] || 12;
      user.isActive = true;
      user.startTime = new Date();
      user.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
      user.paymentVerified = false;
      user.pendingPayment = false;

      // 🔔 ACTIVATED NOTIFICATION
      await sendTelegram(
        `✅ USER ACTIVATED!\n\n` +
        `👤 ${user.name || user.email}\n` +
        `📧 ${user.email}\n` +
        `💎 Plan: ${user.plan.toUpperCase()}\n` +
        `⏰ ${hours} ghante active\n` +
        `📺 ${user.youtubeLink || 'No link'}\n` +
        `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
      );

      console.log(`✅ Activated via sub-done: ${user.email}`);
    }

    await user.save();
    res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive, requiredSubs, expiresAt: user.expiresAt });
  } catch(err) {
    console.error('sub-done error:', err);
    res.json({ success: false });
  }
});

app.post('/api/auto-activate', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });
    if (!user.paymentVerified) return res.json({ success: false, message: 'Payment verify nahi hui' });

    const userPlan = plan || user.plan || 'basic';
    const hours = PLAN_HOURS[userPlan] || 12;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);

    user.isActive = true;
    user.startTime = now;
    user.expiresAt = expiresAt;
    user.paymentVerified = false;
    user.pendingPayment = false;
    await user.save();

    res.json({ success: true, message: 'Auto activated!', expiresAt, hours });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/api/ad-watched', async (req, res) => {
  try {
    const user = await User.findById(req.body.userId);
    if (!user) return res.json({ success: false });
    const plan = PLANS[user.plan] || PLANS.free;
    if (user.adsWatched < plan.ads) { user.adsWatched += 1; await user.save(); }
    res.json({ adsWatched: user.adsWatched, required: plan.ads });
  } catch(err) { res.json({ success: false }); }
});

// ============================================================
// SUBSCRIBE & EARN APIS
// ============================================================
const EARN_PER_SUB = 0.17;

// User ke liye channels list (jo subscribe karne hain)
app.get('/api/earn/channels/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    // Jo channels user ne already subscribe kiye hain unhe hatao
    const alreadyDone = await EarnHistory.find({ userId }).select('channelId');
    const doneIds = alreadyDone.map(h => h.channelId.toString());

    const channels = await EarnChannel.find({
      isActive: true,
      _id: { $nin: doneIds }
    }).limit(20);

    // User ka earn wallet balance bhi bhejo
    const user = await User.findById(userId).select('earnWallet totalEarnedSubs');

    res.json({
      success: true,
      channels,
      earnWallet: user?.earnWallet || 0,
      totalEarnedSubs: user?.totalEarnedSubs || 0,
      earnPerSub: EARN_PER_SUB
    });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// User ne subscribe kiya — earning credit karo
app.post('/api/earn/subscribe', async (req, res) => {
  try {
    const { userId, channelId } = req.body;
    if (!userId || !channelId) return res.json({ success: false, message: 'Invalid request' });

    // Already subscribe kiya hua check
    const exists = await EarnHistory.findOne({ userId, channelId });
    if (exists) return res.json({ success: false, message: 'Ye channel pehle se subscribe kar chuke ho!' });

    const channel = await EarnChannel.findById(channelId);
    if (!channel || !channel.isActive) return res.json({ success: false, message: 'Channel active nahi hai' });

    // Earning credit karo
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    user.earnWallet = parseFloat(((user.earnWallet || 0) + EARN_PER_SUB).toFixed(2));
    user.totalEarnedSubs = parseFloat(((user.totalEarnedSubs || 0) + EARN_PER_SUB).toFixed(2));
    await user.save();

    // History save karo
    await new EarnHistory({ userId, channelId, channelUrl: channel.channelUrl, earning: EARN_PER_SUB }).save();

    // Channel subscribe count badhao + auto-deactivate check
    const updatedChannel = await EarnChannel.findByIdAndUpdate(
      channelId,
      { $inc: { totalSubscribes: 1 } },
      { new: true }
    );

    // Auto-deactivate agar limit reach ho gayi
    if (updatedChannel.totalSubscribes >= updatedChannel.maxSubscribes) {
      await EarnChannel.findByIdAndUpdate(channelId, { isActive: false });
      console.log(`✅ Channel ${channel.channelName} auto-deactivated — ${updatedChannel.maxSubscribes} subscribes complete!`);
      await sendTelegram(
        `✅ CHANNEL LIMIT COMPLETE!\n\n` +
        `📺 ${channel.channelName || channel.channelUrl}\n` +
        `👥 ${updatedChannel.maxSubscribes} subscribes ho gaye!\n` +
        `🔴 Channel automatically deactivate ho gaya\n` +
        `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
      );
    }

    res.json({
      success: true,
      earned: EARN_PER_SUB,
      newEarnWallet: user.earnWallet,
      message: `+₹${EARN_PER_SUB} wallet mein add ho gaya!`
    });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// Earn wallet withdrawal request
app.post('/api/earn/withdraw', async (req, res) => {
  try {
    const { userId, amount, bankDetails } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    const amt = parseFloat(amount);
    if (!amt || amt < 50) return res.json({ success: false, message: 'Minimum ₹50 withdrawal hai!' });
    if ((user.earnWallet || 0) < amt) return res.json({ success: false, message: 'Wallet mein itna balance nahi!' });

    // Deduct karo
    user.earnWallet = parseFloat(((user.earnWallet || 0) - amt).toFixed(2));
    await user.save();

    // Withdrawal record banao
    const gst = Math.round(amt * 0.25);
    const netAmt = amt - gst;

    await new Withdrawal({
      userId: user._id,
      userName: user.name || user.email,
      userEmail: user.email,
      amount: amt,
      gst,
      amtAfterGst: netAmt,
      upiId: bankDetails || 'N/A',
      status: 'pending'
    }).save();

    await sendTelegram(
      `💰 EARN WALLET WITHDRAWAL!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `📧 ${user.email}\n` +
      `💵 Amount: ₹${amt}\n` +
      `🧾 GST: ₹${gst}\n` +
      `💳 Net: ₹${netAmt}\n` +
      `🏦 Bank: ${bankDetails}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `Withdrawal request bhej diya! ₹${amt} - GST ₹${gst} = ₹${netAmt} milega.`, newBalance: user.earnWallet });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

// ============================================================
// REFERRAL & WALLET APIS
// ============================================================
app.get('/api/referral/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.json({ success: false });
    await ensureReferralCode(user);

    const totalReferrals = await User.countDocuments({ referredBy: user.referralCode });

    res.json({
      success: true,
      referralCode: user.referralCode,
      referralLink: `https://ytsubexchange.online/?ref=${user.referralCode}`,
      walletBalance: user.walletBalance || 0,
      totalEarned: user.totalEarned || 0,
      totalReferrals,
      minWithdrawal: MIN_WITHDRAWAL,
      maxWithdrawal: MAX_WITHDRAWAL,
      // ===== BONUS INFO =====
      bonusWallet: user.bonusWallet || 120,
      bonusUnlocked: user.bonusUnlocked || false,
      bonusPaidPlan: user.bonusPaidPlan || false,
      paidReferrals: user.paidReferrals || 0
    });
  } catch(e) { res.json({ success: false }); }
});

app.post('/api/withdrawal/request', async (req, res) => {
  try {
    const { userId, amount, upiId } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    const amt = Number(amount);

    // Sirf valid withdrawal amounts allow karo
    const validAmounts = [200, 300, 400, 500, 600];
    if (!validAmounts.includes(amt)) {
      return res.json({ success: false, message: 'Sirf ₹200, ₹300, ₹400, ₹500, ya ₹600 withdraw kar sakte ho!' });
    }

    if (!upiId || upiId.trim().length < 3) {
      return res.json({ success: false, message: 'UPI ID daalo!' });
    }
    if ((user.walletBalance || 0) < amt) {
      return res.json({ success: false, message: 'Wallet mein itna balance nahi hai!' });
    }

    // GST 25% calculate karo
    const gst = Math.round(amt * 0.25);
    const amtAfterGst = amt - gst;

    // Deduct immediately (hold) — pending request bana do
    user.walletBalance -= amt;
    await user.save();

    const withdrawal = new Withdrawal({
      userId: user._id,
      userName: user.name || user.email,
      userEmail: user.email,
      amount: amt,
      amtAfterGst,
      gst,
      upiId: upiId.trim(),
      status: 'pending'
    });
    await withdrawal.save();

    // 🔔 WITHDRAWAL REQUEST NOTIFICATION
    await sendTelegram(
      `🏦 WITHDRAWAL REQUEST!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `📧 ${user.email}\n` +
      `💰 Amount: ₹${amt}\n` +
      `🧾 GST (25%): ₹${gst}\n` +
      `💵 Net Payable: ₹${amtAfterGst}\n` +
      `💳 UPI: ${upiId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
      `👉 Admin panel se ₹${amtAfterGst} bhejo (GST cut ke baad)!`
    );

    res.json({
      success: true,
      message: `Withdrawal request bhej diya! ₹${amt} mein se 25% GST (₹${gst}) katega — aapko ₹${amtAfterGst} milega.`,
      newBalance: user.walletBalance,
      gst, amtAfterGst
    });
  } catch(e) {
    console.error('Withdrawal request error:', e);
    res.json({ success: false, message: e.message });
  }
});

app.get('/api/withdrawal/history/:userId', async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ userId: req.params.userId }).sort({ requestedAt: -1 }).limit(20);
    res.json({ success: true, withdrawals });
  } catch(e) { res.json({ success: false }); }
});

// ============================================================
// PAYMENT APIS
// ============================================================
app.post('/api/payment/create', async (req, res) => {
  try {
    const { userId, plan, amount } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    // ===== MEMBERSHIP: Cashfree order banao =====
    if (plan === 'membership') {
      const orderId = 'MEM_' + userId + '_' + Date.now();
      const orderData = {
        order_id: orderId,
        order_amount: 10,
        order_currency: 'INR',
        customer_details: {
          customer_id: userId.toString(),
          customer_name: user.name || 'User',
          customer_email: user.email,
          customer_phone: '9999999999'
        },
        order_meta: {
          return_url: `https://ytsubexchange.online/api/payment/verify?userId=${userId}&plan=membership&order_id={order_id}`,
          notify_url: 'https://yt-sub-exchange.onrender.com/api/cashfree/webhook'
        }
      };

      const response = await makeRequest('POST', CASHFREE_BASE, '/pg/orders', orderData, {
        'x-api-version': '2023-08-01',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET,
        'Content-Type': 'application/json'
      });

      if (response.payment_session_id) {
        return res.json({ success: true, paymentSessionId: response.payment_session_id, orderId });
      } else {
        return res.json({ success: false, message: response.message || 'Cashfree order nahi bana' });
      }
    }

    // Normal plan payment
    const payment = new Payment({ userId, plan, amount, transactionId: 'TXN' + Date.now() });
    await payment.save();
    res.json({ success: true, paymentId: payment._id, amount });
  } catch(err) {
    console.error('payment/create error:', err.message);
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/payment/verify', async (req, res) => {
  try {
    const { paymentId, transactionId, userId, plan, screenshot } = req.body;
    let payment = null;
    if (paymentId && !paymentId.startsWith('MANUAL_')) {
      payment = await Payment.findById(paymentId);
    }
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    // ===== MEMBERSHIP PLAN =====
    if (plan === 'membership') {
      const now = new Date();
      const expiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
      user.memberExpiry = expiry;
      await user.save();

      const newPayment = new Payment({
        userId, plan: 'membership', amount: 10, transactionId,
        userName: user.name || user.email, userEmail: user.email,
        status: 'completed'
      });
      await newPayment.save();

      await sendTelegram(
        `💎 MEMBERSHIP ACTIVATED!\n\n` +
        `👤 ${user.name || user.email}\n` +
        `📧 ${user.email}\n` +
        `💰 ₹20\n` +
        `📅 Valid Till: ${expiry.toLocaleDateString('en-IN')}\n` +
        `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
      );

      return res.json({ success: true, message: 'Membership 30 din ke liye activate ho gayi!' });
    }

    const amount = PLAN_AMOUNTS[plan] || 0;

    if (payment) {
      payment.transactionId = transactionId;
      payment.screenshot = screenshot || null;
      payment.status = 'pending_admin';
      payment.userName = user.name || user.email;
      payment.userEmail = user.email;
      await payment.save();
    } else {
      const newPayment = new Payment({
        userId, plan, amount, transactionId,
        screenshot: screenshot || null,
        userName: user.name || user.email,
        userEmail: user.email,
        status: 'pending_admin'
      });
      await newPayment.save();
    }

    user.plan = plan;
    user.subsGiven = 0;
    user.adsWatched = 0;
    user.isActive = false;
    user.pendingPayment = true;
    user.paymentVerified = false;
    await user.save();

    res.json({ success: true, message: 'Payment details submit ho gaye!' });
  } catch(err) {
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/payment/subscribe-done', async (req, res) => {
  try {
    const { userId, paymentId, plan, amount, txnId, userName, userEmail, ytLink } = req.body;

    if (paymentId && !paymentId.startsWith('MANUAL_')) {
      await Payment.findByIdAndUpdate(paymentId, { status: 'subscribed_done', subscribeDoneAt: new Date() });
    } else {
      await Payment.findOneAndUpdate(
        { userId, status: 'pending_admin' },
        { status: 'subscribed_done', subscribeDoneAt: new Date() }
      );
    }

    console.log(`✅ Subscribe done: ${userName} (${userEmail})`);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false });
  }
});

// ============================================================
// CASHFREE PAYMENT GATEWAY
// ============================================================
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || '130852352d444e60dc40942f72c3258031';
const CASHFREE_SECRET = process.env.CASHFREE_SECRET || 'cfsk_ma_prod_926fdf10f3594b66757d3122b0239f99_6d87159e';
const CASHFREE_BASE = 'api.cashfree.com';

function makeRequest(method, host, path, data, headers) {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : null;
    const options = {
      hostname: host, path, method,
      headers: { ...headers, ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}) }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Invalid JSON: ' + body)); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

app.post('/api/cashfree/create-order', async (req, res) => {
  try {
    const { userId, plan, amount } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila' });

    const orderId = 'YTS_' + userId + '_' + Date.now();
    const orderData = {
      order_id: orderId,
      order_amount: amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: userId.toString(),
        customer_name: user.name || 'User',
        customer_email: user.email,
        customer_phone: '9999999999'
      },
      order_meta: {
        return_url: 'https://ytsubexchange.online/payment-success?order_id={order_id}&plan=' + plan,
        notify_url: 'https://yt-sub-exchange.onrender.com/api/cashfree/webhook'
      }
    };

    const response = await makeRequest('POST', CASHFREE_BASE, '/pg/orders', orderData, {
      'x-api-version': '2023-08-01',
      'x-client-id': CASHFREE_APP_ID,
      'x-client-secret': CASHFREE_SECRET,
      'Content-Type': 'application/json'
    });

    const payment = new Payment({
      userId, plan, amount, transactionId: orderId,
      status: 'pending', userName: user.name, userEmail: user.email
    });
    await payment.save();

    // 🔔 PAYMENT INITIATED NOTIFICATION
    await sendTelegram(
      `💳 PAYMENT STARTED!\n\n` +
      `👤 ${user.name || 'Unknown'}\n` +
      `📧 ${user.email}\n` +
      `💎 Plan: ${plan.toUpperCase()}\n` +
      `💰 Amount: ₹${amount}\n` +
      `🔖 Order: ${orderId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    if (response.payment_session_id) {
      res.json({ success: true, paymentSessionId: response.payment_session_id, orderId });
    } else {
      res.json({ success: false, message: response.message || JSON.stringify(response) });
    }
  } catch(e) {
    console.error('Cashfree create order error:', e.message);
    res.json({ success: false, message: e.message });
  }
});

// ✅ CASHFREE WEBHOOK — Payment success
app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    const data = req.body.data;
    if (!data) return res.json({ success: false });

    const orderId = data.order?.order_id;
    const paymentStatus = data.payment?.payment_status;
    const paymentAmount = data.payment?.payment_amount;

    console.log(`Webhook: orderId=${orderId}, status=${paymentStatus}`);

    if (paymentStatus === 'SUCCESS') {
      const payment = await Payment.findOne({ transactionId: orderId });
      if (!payment) return res.json({ success: false });

      payment.status = 'completed';
      await payment.save();

      const user = await User.findById(payment.userId);
      if (user) {
        user.plan = payment.plan;
        user.subsGiven = 0;
        user.adsWatched = 0;
        user.isActive = false;
        user.paymentVerified = true;
        user.pendingPayment = false;
        await user.save();

        // ✅ Referral commission credit karo
        await creditReferralCommission(user, payment.plan);
        // ✅ Bonus plan check karo
        await checkBonusPaidPlan(user, payment.plan);

        // 🔔 PAYMENT SUCCESS NOTIFICATION
        await sendTelegram(
          `💰 PAYMENT SUCCESS! ✅\n\n` +
          `👤 ${user.name || 'Unknown'}\n` +
          `📧 ${user.email}\n` +
          `💎 Plan: ${payment.plan.toUpperCase()}\n` +
          `💵 Amount: ₹${payment.amount}\n` +
          `🔖 Order: ${orderId}\n` +
          `📺 YT: ${user.youtubeLink || 'Not set'}\n` +
          `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
          `👆 Ab user subscribe karega — phir auto-active hoga!`
        );

        console.log(`✅ Webhook payment success: ${user.email} - ${payment.plan}`);
      }
    }

    res.json({ success: true });
  } catch(e) {
    console.error('Webhook error:', e);
    res.json({ success: false });
  }
});

// ✅ CASHFREE VERIFY
app.post('/api/cashfree/verify', async (req, res) => {
  try {
    const { orderId, userId, plan } = req.body;
    if (!orderId) return res.json({ success: false, message: 'Order ID nahi mila' });

    const response = await makeRequest('GET', CASHFREE_BASE, '/pg/orders/' + orderId, null, {
      'x-api-version': '2023-08-01',
      'x-client-id': CASHFREE_APP_ID,
      'x-client-secret': CASHFREE_SECRET
    });

    const orderStatus = response.order_status;
    console.log(`Verify: orderId=${orderId}, status=${orderStatus}`);

    if (orderStatus === 'PAID') {
      const user = await User.findById(userId);
      if (user) {
        user.plan = plan;
        user.subsGiven = 0;
        user.adsWatched = 0;
        user.isActive = false;
        user.paymentVerified = true;  // ✅ Sirf PAID pe true
        user.pendingPayment = false;
        await user.save();

        await Payment.findOneAndUpdate(
          { transactionId: orderId },
          { status: 'completed', plan, userId, userName: user.name, userEmail: user.email }
        );

        // ✅ Referral commission credit karo
        await creditReferralCommission(user, plan);
        // ✅ Bonus plan check karo
        await checkBonusPaidPlan(user, plan);

        // 🔔 PAYMENT VERIFIED NOTIFICATION
        await sendTelegram(
          `💰 PAYMENT VERIFIED! ✅\n\n` +
          `👤 ${user.name || 'Unknown'}\n` +
          `📧 ${user.email}\n` +
          `💎 Plan: ${plan.toUpperCase()}\n` +
          `🔖 Order: ${orderId}\n` +
          `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
          `👆 User ab subscribe karne ja raha hai!`
        );

        console.log(`✅ Payment verified: ${user.email} - ${plan}`);
      }
      res.json({ success: true, message: 'Payment successful!', plan, paymentVerified: true });
    } else if (orderStatus === 'ACTIVE') {
      // Payment abhi pending hai — user ko wait karao
      res.json({ success: false, message: 'Payment abhi processing mein hai, thodi der mein dobara try karo!', orderStatus });
    } else {
      res.json({ success: false, message: 'Payment status: ' + orderStatus, orderStatus });
    }
  } catch(e) {
    console.error('Cashfree verify error:', e.message);
    res.json({ success: false, message: e.message });
  }
});

// ============================================================
// ADMIN ROUTES
// ============================================================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@aman@769691@';

function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.body?.adminPassword || req.headers['x-admin-key'] || req.body?.adminKey || req.query?.adminPassword;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Unauthorized!' });
  next();
}

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_' + Date.now() });
  } else {
    res.json({ success: false, message: 'Wrong password!' });
  }
});

app.post('/admin/activate-user', adminAuth, async (req, res) => {
  try {
    const { userId, paymentId, plan } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false });

    user.plan = plan || user.plan;
    user.isActive = false;
    user.paymentVerified = true;
    user.pendingPayment = false;
    user.subsGiven = 0;
    await user.save();

    if (paymentId) {
      await Payment.findByIdAndUpdate(paymentId, { status: 'payment_verified', activatedAt: new Date() });
    }

    // ✅ Referral commission credit karo (manual verify ke liye bhi)
    await creditReferralCommission(user, user.plan);
    // ✅ Bonus plan check karo
    await checkBonusPaidPlan(user, user.plan);

    // 🔔 ADMIN VERIFIED NOTIFICATION
    await sendTelegram(
      `👑 ADMIN NE VERIFY KIYA!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `💎 Plan: ${user.plan.toUpperCase()}\n` +
      `📧 ${user.email}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
      `User ab subscribe karega!`
    );

    res.json({ success: true, message: 'User payment verified — ab subscribe karega!' });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.post('/admin/force-activate', adminAuth, async (req, res) => {
  try {
    const { userId, plan } = req.body;
    const hours = PLAN_HOURS[plan] || 12;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000);

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false });

    user.plan = plan || user.plan;
    user.isActive = true;
    user.startTime = now;
    user.expiresAt = expiresAt;
    user.pendingPayment = false;
    user.paymentVerified = false;
    await user.save();

    res.json({ success: true, message: `Force activated ${hours} ghante ke liye!`, expiresAt });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/reject-payment', adminAuth, async (req, res) => {
  try {
    const { paymentId } = req.body;
    await Payment.findByIdAndUpdate(paymentId, { status: 'rejected' });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.get('/admin/pending-payments', adminAuth, async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(100);
    res.json({ success: true, payments });
  } catch(e) { res.json({ success: false }); }
});

// ✅ Admin: Approve payment (membership activate)
app.post('/admin/approve-payment', adminAuth, async (req, res) => {
  try {
    const { paymentId, userId, plan } = req.body;
    const payment = await Payment.findById(paymentId);
    if(!payment) return res.json({ success: false, message: 'Payment nahi mili' });
    payment.status = 'completed';
    await payment.save();
    if(plan === 'membership' || true) {
      const user = await User.findById(userId || payment.userId);
      if(user) {
        const now = new Date();
        const currentExpiry = user.memberExpiry && new Date(user.memberExpiry) > now ? new Date(user.memberExpiry) : now;
        user.memberExpiry = new Date(currentExpiry.getTime() + 30 * 24 * 60 * 60 * 1000);
        await user.save();
        await sendTelegram(`✅ ADMIN APPROVED MEMBERSHIP!\n👤 ${user.name||user.email}\n💰 ₹${payment.amount}\n📅 Till: ${user.memberExpiry.toLocaleDateString('en-IN')}`);
      }
    }
    res.json({ success: true, message: 'Payment approved!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

// ✅ NEW: Sab payments dikhao — naam, email, status (success/pending/failed) sab clear
app.get('/admin/all-payments', adminAuth, async (req, res) => {
  try {
    const payments = await Payment.find().sort({ createdAt: -1 }).limit(200);

    // Har payment ke saath user ka latest naam/email bhi attach karo (agar missing ho)
    const enriched = await Promise.all(payments.map(async (p) => {
      let userName = p.userName;
      let userEmail = p.userEmail;
      if ((!userName || !userEmail) && p.userId) {
        const u = await User.findById(p.userId).select('name email');
        if (u) {
          userName = userName || u.name;
          userEmail = userEmail || u.email;
        }
      }
      return {
        _id: p._id,
        userId: p.userId,
        userName: userName || 'Unknown',
        userEmail: userEmail || '—',
        plan: p.plan,
        amount: p.amount,
        transactionId: p.transactionId,
        status: p.status,
        screenshot: p.screenshot,
        createdAt: p.createdAt,
        activatedAt: p.activatedAt
      };
    }));

    res.json({ success: true, payments: enriched });
  } catch(e) {
    res.json({ success: false, message: e.message });
  }
});

app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).select('name email photo memberExpiry createdAt').limit(200);
    res.json({ success: true, users });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/toggle-user', adminAuth, async (req, res) => {
  try {
    const { userId, isActive } = req.body;
    const user = await User.findById(userId);
    if (!user) return res.json({ success: false });
    user.isActive = isActive;
    if (isActive) user.startTime = new Date();
    await user.save();
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.get('/admin/full-stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['basic', 'silver', 'gold', 'platinum'] } });
    const payments = await Payment.find({ status: 'completed' });
    const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
    const plans = ['basic', 'silver', 'gold', 'platinum'];
    const planBreakdown = {};
    for (const plan of plans) {
      const count = await Payment.countDocuments({ status: 'completed', plan });
      planBreakdown[plan] = { count, revenue: count * (PLAN_AMOUNTS[plan] || 0) };
    }
    const activePlans = {};
    for (const plan of plans) {
      activePlans[plan] = await User.countDocuments({ isActive: true, plan });
    }
    res.json({ success: true, totalUsers, activeUsers, premiumUsers, revenue, totalPayments: payments.length, planBreakdown, activePlans });
  } catch(e) { res.json({ success: false }); }
});

// ============================================================
// ADMIN: REFERRAL & WITHDRAWAL MANAGEMENT
// ============================================================
app.get('/admin/withdrawals', adminAuth, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find().sort({ requestedAt: -1 }).limit(100);
    res.json({ success: true, withdrawals });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/withdrawal-mark-paid', adminAuth, async (req, res) => {
  try {
    const { withdrawalId } = req.body;
    const w = await Withdrawal.findById(withdrawalId);
    if (!w) return res.json({ success: false, message: 'Request nahi mili' });
    if (w.status === 'paid') return res.json({ success: false, message: 'Already paid hai!' });

    w.status = 'paid';
    w.paidAt = new Date();
    await w.save();

    res.json({ success: true, message: 'Marked as paid!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/withdrawal-reject', adminAuth, async (req, res) => {
  try {
    const { withdrawalId } = req.body;
    const w = await Withdrawal.findById(withdrawalId);
    if (!w) return res.json({ success: false, message: 'Request nahi mili' });
    if (w.status !== 'pending') return res.json({ success: false, message: 'Sirf pending reject ho sakti hai' });

    // Refund wallet
    const user = await User.findById(w.userId);
    if (user) {
      user.walletBalance = (user.walletBalance || 0) + w.amount;
      await user.save();
    }

    w.status = 'rejected';
    await w.save();

    res.json({ success: true, message: 'Reject ho gaya, balance refund ho gaya!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.get('/admin/referral-stats', adminAuth, async (req, res) => {
  try {
    const topReferrers = await User.find({ totalEarned: { $gt: 0 } })
      .sort({ totalEarned: -1 })
      .limit(50)
      .select('name email referralCode walletBalance totalEarned totalReferrals');

    const totalCommissionPaid = await Withdrawal.aggregate([
      { $match: { status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
    const pendingAmount = await Withdrawal.aggregate([
      { $match: { status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      success: true,
      topReferrers,
      totalCommissionPaid: totalCommissionPaid[0]?.total || 0,
      pendingWithdrawals,
      pendingAmount: pendingAmount[0]?.total || 0
    });
  } catch(e) { res.json({ success: false }); }
});

// ============================================================
// ADMIN: SUBSCRIBE & EARN CHANNEL MANAGEMENT
// ============================================================
app.get('/admin/earn-channels', adminAuth, async (req, res) => {
  try {
    const channels = await EarnChannel.find().sort({ createdAt: -1 });
    res.json({ success: true, channels });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/earn-channel/add', adminAuth, async (req, res) => {
  try {
    const { channelUrl, channelName, maxSubscribes } = req.body;
    if (!channelUrl) return res.json({ success: false, message: 'Channel URL daalo!' });
    const channel = new EarnChannel({
      channelUrl,
      channelName: channelName || '',
      maxSubscribes: parseInt(maxSubscribes) || 350,
      isActive: true
    });
    await channel.save();
    res.json({ success: true, channel, message: 'Channel add ho gaya!' });
  } catch(e) { res.json({ success: false, message: e.message }); }
});

app.post('/admin/earn-channel/toggle', adminAuth, async (req, res) => {
  try {
    const { channelId, isActive } = req.body;
    await EarnChannel.findByIdAndUpdate(channelId, { isActive });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.post('/admin/earn-channel/delete', adminAuth, async (req, res) => {
  try {
    const { channelId } = req.body;
    await EarnChannel.findByIdAndDelete(channelId);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

// Admin: Earn wallet withdrawals mark as paid
app.get('/admin/earn-stats', adminAuth, async (req, res) => {
  try {
    const totalEarned = await EarnHistory.aggregate([
      { $group: { _id: null, total: { $sum: '$earning' } } }
    ]);
    const totalSubscribes = await EarnHistory.countDocuments();
    const topEarners = await User.find({ totalEarnedSubs: { $gt: 0 } })
      .sort({ totalEarnedSubs: -1 }).limit(20)
      .select('name email earnWallet totalEarnedSubs');

    // Har channel ke subscribers ki details
    const channels = await EarnChannel.find().sort({ createdAt: -1 });
    const channelDetails = await Promise.all(channels.map(async (ch) => {
      const subscribers = await EarnHistory.find({ channelId: ch._id })
        .populate('userId', 'name email')
        .sort({ earnedAt: -1 });
      return {
        ...ch.toObject(),
        subscribers: subscribers.map(s => ({
          name: s.userId?.name || 'User',
          email: s.userId?.email || '',
          earnedAt: s.earnedAt
        }))
      };
    }));

    res.json({
      success: true,
      totalEarned: totalEarned[0]?.total || 0,
      totalSubscribes,
      topEarners,
      channelDetails
    });
  } catch(e) { res.json({ success: false }); }
});

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

app.post('/admin/update-plans', adminAuth, async (req, res) => {
  try { await saveSetting('plans', req.body.plans); res.json({ success: true }); }
  catch(e) { res.json({ success: false }); }
});

app.post('/admin/update-content', adminAuth, async (req, res) => {
  try { await saveSetting('content', req.body.content); res.json({ success: true }); }
  catch(e) { res.json({ success: false }); }
});

app.post('/admin/update-contact', adminAuth, async (req, res) => {
  try { await saveSetting('contact', req.body.contact); res.json({ success: true }); }
  catch(e) { res.json({ success: false }); }
});

app.post('/admin/update-qr', adminAuth, async (req, res) => {
  try { await saveSetting('qrImage', req.body.qrImage); res.json({ success: true }); }
  catch(e) { res.json({ success: false }); }
});

app.post('/admin/update-logo', adminAuth, async (req, res) => {
  try { await saveSetting('logo', req.body.logo); res.json({ success: true }); }
  catch(e) { res.json({ success: false }); }
});

app.post('/admin/change-password', adminAuth, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) return res.json({ success: false, message: 'Password bahut chhota!' });
    await saveSetting('adminPassword', newPassword);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.get('/c/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.send('Link expired!');
    user.totalClicks += 1;
    await user.save();

    // 🔔 Telegram notification
    await sendTelegram(
      `🔗 LINK CLICK!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `📧 ${user.email}\n` +
      `📺 ${user.youtubeLink}\n` +
      `💎 Plan: ${(user.plan||'free').toUpperCase()}\n` +
      `🖱️ Total Clicks: ${user.totalClicks}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.redirect(user.youtubeLink);
  } catch(err) { res.send('Error!'); }
});

// ============================================================
// RECHARGE & TRANSACTION SYSTEM
// ============================================================

// Schemas
const rechargeSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  userEmail: String,
  userName: String,
  type: { type: String, enum: ['mobile', 'dth'] },
  operator: String,
  number: String,
  amount: Number,
  status: { type: String, default: 'pending' }, // pending | success | failed
  transactionId: String,
  apiRef: String,
  createdAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
  senderId: mongoose.Schema.Types.ObjectId,
  senderEmail: String,
  senderName: String,
  receiverId: mongoose.Schema.Types.ObjectId,
  receiverEmail: String,
  receiverName: String,
  receiverMobile: String,
  type: { type: String, enum: ['send', 'receive', 'recharge', 'addmoney', 'withdraw'] },
  amount: Number,
  note: String,
  status: { type: String, default: 'pending' }, // pending | success | failed
  transactionId: String,
  createdAt: { type: Date, default: Date.now }
});

const Recharge = mongoose.model('Recharge', rechargeSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);

// ===== MOBILE RECHARGE =====
app.post('/api/recharge/mobile', async (req, res) => {
  try {
    const { userId, number, operator, amount } = req.body;
    if (!userId || !number || !operator || !amount) return res.json({ success: false, message: 'Sab fields bharo!' });

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila!' });

    if (user.walletBalance < amount) return res.json({ success: false, message: `Wallet mein sirf ₹${user.walletBalance} hai!` });

    // Deduct wallet
    user.walletBalance -= amount;
    await user.save();

    const txnId = 'RCH' + Date.now();

    // Save recharge record
    const recharge = new Recharge({
      userId, userEmail: user.email, userName: user.name,
      type: 'mobile', operator, number, amount,
      status: 'success', // Demo: always success — real API se status aayega
      transactionId: txnId
    });
    await recharge.save();

    // Save transaction
    const txn = new Transaction({
      senderId: userId, senderEmail: user.email, senderName: user.name,
      type: 'recharge', amount, status: 'success', transactionId: txnId,
      note: `${operator} Mobile Recharge - ${number}`
    });
    await txn.save();

    // Telegram notification
    await sendTelegram(
      `📱 MOBILE RECHARGE!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `📞 ${number} (${operator})\n` +
      `💰 ₹${amount}\n` +
      `🆔 ${txnId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `₹${amount} recharge successful!`, txnId });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== DTH RECHARGE =====
app.post('/api/recharge/dth', async (req, res) => {
  try {
    const { userId, customerId, provider, amount } = req.body;
    if (!userId || !customerId || !provider || !amount) return res.json({ success: false, message: 'Sab fields bharo!' });

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila!' });
    if (user.walletBalance < amount) return res.json({ success: false, message: `Wallet mein sirf ₹${user.walletBalance} hai!` });

    user.walletBalance -= amount;
    await user.save();

    const txnId = 'DTH' + Date.now();

    const recharge = new Recharge({
      userId, userEmail: user.email, userName: user.name,
      type: 'dth', operator: provider, number: customerId, amount,
      status: 'success', transactionId: txnId
    });
    await recharge.save();

    const txn = new Transaction({
      senderId: userId, senderEmail: user.email, senderName: user.name,
      type: 'recharge', amount, status: 'success', transactionId: txnId,
      note: `${provider} DTH Recharge - ${customerId}`
    });
    await txn.save();

    await sendTelegram(
      `📺 DTH RECHARGE!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `📺 ${provider} - ID: ${customerId}\n` +
      `💰 ₹${amount}\n` +
      `🆔 ${txnId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `₹${amount} DTH recharge successful!`, txnId });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== MONEY TRANSFER (Bank) =====
app.post('/api/transfer/bank', async (req, res) => {
  try {
    const { userId, bankName, accNo, ifsc, accName, amount, note } = req.body;
    if (!userId || !bankName || !accNo || !ifsc || !amount) return res.json({ success: false, message: 'Sab fields bharo!' });

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila!' });
    if (user.walletBalance < amount) return res.json({ success: false, message: `Wallet mein sirf ₹${user.walletBalance} hai!` });

    user.walletBalance -= amount;
    await user.save();

    const txnId = 'TXN' + Date.now();
    const txn = new Transaction({
      senderId: userId, senderEmail: user.email, senderName: user.name,
      type: 'send', amount, status: 'pending', transactionId: txnId,
      note: `Bank Transfer → ${bankName} | ${accNo} | ${ifsc} | ${accName}`
    });
    await txn.save();

    await sendTelegram(
      `💸 BANK TRANSFER REQUEST!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `🏦 ${bankName}\n` +
      `🔢 Account: ${accNo}\n` +
      `📋 IFSC: ${ifsc}\n` +
      `👤 A/C Name: ${accName}\n` +
      `💰 ₹${amount}\n` +
      `📝 Note: ${note || '-'}\n` +
      `🆔 ${txnId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `₹${amount} transfer request bhej diya!`, txnId });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== MOBILE TRANSFER =====
app.post('/api/transfer/mobile', async (req, res) => {
  try {
    const { userId, mobileNo, amount, note } = req.body;
    if (!userId || !mobileNo || !amount) return res.json({ success: false, message: 'Sab fields bharo!' });

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila!' });
    if (user.walletBalance < amount) return res.json({ success: false, message: `Wallet mein sirf ₹${user.walletBalance} hai!` });

    // Check if receiver exists in system
    const receiver = await User.findOne({ phone: mobileNo });

    user.walletBalance -= amount;
    await user.save();

    if (receiver) {
      receiver.walletBalance = (receiver.walletBalance || 0) + amount;
      await receiver.save();
    }

    const txnId = 'MOB' + Date.now();
    const txn = new Transaction({
      senderId: userId, senderEmail: user.email, senderName: user.name,
      receiverMobile: mobileNo,
      type: 'send', amount, status: 'success', transactionId: txnId,
      note: note || `Mobile Transfer → ${mobileNo}`
    });
    await txn.save();

    await sendTelegram(
      `📲 MOBILE TRANSFER!\n\n` +
      `👤 From: ${user.name || user.email}\n` +
      `📞 To: ${mobileNo}\n` +
      `💰 ₹${amount}\n` +
      `📝 Note: ${note || '-'}\n` +
      `🆔 ${txnId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `₹${amount} transfer ho gaya!`, txnId });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== ADD MONEY =====
app.post('/api/wallet/add', async (req, res) => {
  try {
    const { userId, amount } = req.body;
    if (!userId || !amount) return res.json({ success: false, message: 'Amount daalo!' });

    const user = await User.findById(userId);
    if (!user) return res.json({ success: false, message: 'User nahi mila!' });

    // Cashfree se payment verify karna hoga real mein
    // Abhi demo mode mein direct add karte hain
    user.walletBalance = (user.walletBalance || 0) + Number(amount);
    await user.save();

    const txnId = 'ADD' + Date.now();
    const txn = new Transaction({
      senderId: userId, senderEmail: user.email, senderName: user.name,
      type: 'addmoney', amount, status: 'success', transactionId: txnId,
      note: 'Wallet Add Money'
    });
    await txn.save();

    await sendTelegram(
      `💰 WALLET ADD MONEY!\n\n` +
      `👤 ${user.name || user.email}\n` +
      `💵 ₹${amount} add hua\n` +
      `💼 New Balance: ₹${user.walletBalance}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `₹${amount} wallet mein add ho gaya!`, balance: user.walletBalance });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== GET TRANSACTION HISTORY =====
app.get('/api/transactions/:userId', async (req, res) => {
  try {
    const transactions = await Transaction.find({
      $or: [{ senderId: req.params.userId }, { receiverId: req.params.userId }]
    }).sort({ createdAt: -1 }).limit(50);

    const recharges = await Recharge.find({ userId: req.params.userId })
      .sort({ createdAt: -1 }).limit(20);

    res.json({ success: true, transactions, recharges });
  } catch(e) { res.json({ success: false }); }
});

// ===== GET WALLET BALANCE =====
app.get('/api/wallet/:userId', async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('walletBalance name email');
    if (!user) return res.json({ success: false });
    res.json({ success: true, balance: user.walletBalance || 0, name: user.name, email: user.email });
  } catch(e) { res.json({ success: false }); }
});

// ===== DUKANDAR SYSTEM =====
const dukandarSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  shopName: String,
  address: String,
  password: String,
  walletBalance: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 },
  totalTransactions: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  isApproved: { type: Boolean, default: false },
  bankName: String,
  accNo: String,
  ifsc: String,
  accName: String,
  createdAt: { type: Date, default: Date.now }
});

const dukandarTxnSchema = new mongoose.Schema({
  dukandarId: mongoose.Schema.Types.ObjectId,
  dukandarName: String,
  type: String, // aeps, recharge, dth, bill
  customerAadhaar: String,
  customerMobile: String,
  amount: Number,
  commission: Number,
  dukandarShare: Number,  // 30%
  adminShare: Number,     // 70%
  status: { type: String, default: 'success' },
  transactionId: String,
  createdAt: { type: Date, default: Date.now }
});

const dukandarWithdrawSchema = new mongoose.Schema({
  dukandarId: mongoose.Schema.Types.ObjectId,
  dukandarName: String,
  amount: Number,
  bankName: String,
  accNo: String,
  ifsc: String,
  accName: String,
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now }
});

const Dukandar = mongoose.model('Dukandar', dukandarSchema);
const DukandarTxn = mongoose.model('DukandarTxn', dukandarTxnSchema);
const DukandarWithdraw = mongoose.model('DukandarWithdraw', dukandarWithdrawSchema);

const ADMIN_SHARE = 0.70; // 70%
const DUKANDAR_SHARE = 0.30; // 30%

// ===== DUKANDAR REGISTER =====
app.post('/api/dukandar/register', async (req, res) => {
  try {
    const { name, email, phone, shopName, address, password } = req.body;
    if (!name || !email || !phone || !password) return res.json({ success: false, message: 'Sab fields bharo!' });

    const exists = await Dukandar.findOne({ $or: [{ email }, { phone }] });
    if (exists) return res.json({ success: false, message: 'Email ya phone already registered hai!' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const dukandar = new Dukandar({ name, email, phone, shopName, address, password: hashedPassword });
    await dukandar.save();

    await sendTelegram(
      `🏪 NAYA DUKANDAR REGISTER!\n\n` +
      `👤 ${name}\n` +
      `📧 ${email}\n` +
      `📞 ${phone}\n` +
      `🏪 Shop: ${shopName || '-'}\n` +
      `📍 Address: ${address || '-'}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
      `⚠️ Approve karo admin panel se!`
    );

    res.json({ success: true, message: 'Registration ho gaya! Admin approve karega 24 ghante mein.' });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== DUKANDAR LOGIN =====
app.post('/api/dukandar/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const dukandar = await Dukandar.findOne({ phone });
    if (!dukandar) return res.json({ success: false, message: 'Phone ya password galat hai!' });
    const passMatch = await bcrypt.compare(password, dukandar.password);
    if (!passMatch) return res.json({ success: false, message: 'Phone ya password galat hai!' });
    if (!dukandar.isApproved) return res.json({ success: false, message: 'Account approve nahi hua abhi tak!' });
    if (!dukandar.isActive) return res.json({ success: false, message: 'Account band hai!' });

    res.json({ success: true, dukandar: {
      id: dukandar._id,
      name: dukandar.name,
      phone: dukandar.phone,
      shopName: dukandar.shopName,
      walletBalance: dukandar.walletBalance,
      totalEarned: dukandar.totalEarned,
      totalTransactions: dukandar.totalTransactions
    }});
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== DUKANDAR WALLET =====
app.get('/api/dukandar/wallet/:id', async (req, res) => {
  try {
    const d = await Dukandar.findById(req.params.id);
    if (!d) return res.json({ success: false });
    res.json({ success: true, balance: d.walletBalance, totalEarned: d.totalEarned, totalTransactions: d.totalTransactions });
  } catch(e) { res.json({ success: false }); }
});

// ===== AEPS TRANSACTION =====
app.post('/api/dukandar/aeps', async (req, res) => {
  try {
    const { dukandarId, customerAadhaar, amount } = req.body;
    if (!dukandarId || !customerAadhaar || !amount) return res.json({ success: false, message: 'Sab fields bharo!' });

    const dukandar = await Dukandar.findById(dukandarId);
    if (!dukandar) return res.json({ success: false, message: 'Dukandar nahi mila!' });

    const commission = Math.round(amount * 0.01); // 1% commission
    const dukandarEarning = Math.round(commission * DUKANDAR_SHARE); // 30%
    const adminEarning = Math.round(commission * ADMIN_SHARE); // 70%

    // Dukandar wallet mein amount + dukandar share add karo
    dukandar.walletBalance += amount + dukandarEarning;
    dukandar.totalEarned += dukandarEarning;
    dukandar.totalTransactions += 1;
    await dukandar.save();

    const txnId = 'AEPS' + Date.now();
    const txn = new DukandarTxn({
      dukandarId, dukandarName: dukandar.name,
      type: 'aeps', customerAadhaar,
      amount, commission,
      dukandarShare: dukandarEarning,
      adminShare: adminEarning,
      status: 'success', transactionId: txnId
    });
    await txn.save();

    await sendTelegram(
      `🏧 AEPS TRANSACTION!\n\n` +
      `🏪 Dukandar: ${dukandar.name}\n` +
      `📞 ${dukandar.phone}\n` +
      `💰 Amount: ₹${amount}\n` +
      `💸 Commission: ₹${commission}\n` +
      `👤 Admin: ₹${adminEarning} (70%)\n` +
      `🏪 Dukandar: ₹${dukandarEarning} (30%)\n` +
      `🆔 ${txnId}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
    );

    res.json({ success: true, message: `AEPS successful! ₹${amount} nikala gaya.`, txnId, dukandarEarning, adminEarning });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== DUKANDAR WITHDRAWAL REQUEST =====
app.post('/api/dukandar/withdraw', async (req, res) => {
  try {
    const { dukandarId, amount, bankName, accNo, ifsc, accName } = req.body;
    if (!dukandarId || !amount || !bankName || !accNo || !ifsc) return res.json({ success: false, message: 'Sab fields bharo!' });

    const dukandar = await Dukandar.findById(dukandarId);
    if (!dukandar) return res.json({ success: false, message: 'Dukandar nahi mila!' });
    if (dukandar.walletBalance < amount) return res.json({ success: false, message: `Wallet mein sirf ₹${dukandar.walletBalance} hai!` });

    dukandar.walletBalance -= amount;
    await dukandar.save();

    const withdraw = new DukandarWithdraw({ dukandarId, dukandarName: dukandar.name, amount, bankName, accNo, ifsc, accName });
    await withdraw.save();

    await sendTelegram(
      `💸 DUKANDAR WITHDRAWAL REQUEST!\n\n` +
      `🏪 ${dukandar.name}\n` +
      `📞 ${dukandar.phone}\n` +
      `💰 Amount: ₹${amount}\n` +
      `🏦 Bank: ${bankName}\n` +
      `🔢 Account: ${accNo}\n` +
      `📋 IFSC: ${ifsc}\n` +
      `👤 Name: ${accName}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}\n\n` +
      `⚠️ Jaldi bhej do!`
    );

    res.json({ success: true, message: `₹${amount} withdrawal request bhej diya! 24 ghante mein bank mein aayega.` });
  } catch(e) { res.json({ success: false, message: 'Server error!' }); }
});

// ===== DUKANDAR TRANSACTION HISTORY =====
app.get('/api/dukandar/history/:id', async (req, res) => {
  try {
    const txns = await DukandarTxn.find({ dukandarId: req.params.id }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, transactions: txns });
  } catch(e) { res.json({ success: false }); }
});

// ===== ADMIN - ALL DUKANDARS =====
app.get('/admin/dukandars', adminAuth, async (req, res) => {
  try {
    const dukandars = await Dukandar.find().sort({ createdAt: -1 });
    res.json({ success: true, dukandars });
  } catch(e) { res.json({ success: false }); }
});

// ===== ADMIN - APPROVE DUKANDAR =====
app.post('/admin/dukandar/approve/:id', adminAuth, async (req, res) => {
  try {
    const dukandar = await Dukandar.findByIdAndUpdate(req.params.id, { isApproved: true }, { new: true });
    if (!dukandar) return res.json({ success: false });

    await sendTelegram(
      `✅ DUKANDAR APPROVED!\n\n` +
      `🏪 ${dukandar.name}\n` +
      `📞 ${dukandar.phone}\n` +
      `🏪 Shop: ${dukandar.shopName}`
    );

    res.json({ success: true, message: 'Dukandar approved!' });
  } catch(e) { res.json({ success: false }); }
});

// ===== ADMIN - DUKANDAR WITHDRAWALS =====
app.get('/admin/dukandar/withdrawals', adminAuth, async (req, res) => {
  try {
    const withdrawals = await DukandarWithdraw.find({ status: 'pending' }).sort({ createdAt: -1 });
    res.json({ success: true, withdrawals });
  } catch(e) { res.json({ success: false }); }
});

// ===== ADMIN - MARK WITHDRAWAL PAID =====
app.post('/admin/dukandar/withdraw/paid/:id', adminAuth, async (req, res) => {
  try {
    await DukandarWithdraw.findByIdAndUpdate(req.params.id, { status: 'paid' });
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://yt-sub-exchange.onrender.com';
setInterval(() => {
  try {
    https.get(SELF_URL + '/api/stats', (res) => {
      console.log('✅ Auto-ping:', new Date().toLocaleTimeString());
    }).on('error', (e) => console.log('⚠️ Ping failed:', e.message));
  } catch(e) {}
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // Server start notification
  await sendTelegram(
    `🚀 SERVER STARTED!\n` +
    `YT Sub Exchange online hai\n` +
    `🕐 ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`
  );
});
