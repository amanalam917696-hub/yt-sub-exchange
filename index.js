const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// CORS: Multiple origins support
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['https://ytsubexchange.online', 'http://localhost:3000'];

app.use(cors({ 
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }, 
  credentials: true 
}));

app.use(express.json());
app.use(express.static('public'));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { success: false, message: 'Too many requests' }
});
app.use('/api/', limiter);
app.use('/auth/', limiter);

// Session
if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in environment variables');
}

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', 
    maxAge: 24 * 60 * 60 * 1000 
  }
}));

app.use(passport.initialize());
app.use(passport.session());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => {
    console.log('MongoDB error:', err);
    process.exit(1);
  });

// Schemas with validation
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  googleId: { type: String, default: '', index: true },
  name: { type: String, default: '', trim: true },
  photo: { type: String, default: '' },
  youtubeLink: { 
    type: String, 
    default: '',
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(v);
      },
      message: 'Invalid YouTube URL'
    }
  },
  plan: { type: String, enum: ['free', 'starter', 'growth', 'pro', 'premium', 'vip', 'top'], default: 'free' },
  adsWatched: { type: Number, default: 0, min: 0 },
  subsGiven: { type: Number, default: 0, min: 0 },
  isActive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  totalViews: { type: Number, default: 0, min: 0 },
  totalClicks: { type: Number, default: 0, min: 0 },
  joinedAt: { type: Date, default: Date.now, immutable: true },
  // Track which users this user has subscribed to (prevent spam)
  subscribedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
});

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
  email: { type: String, required: true, lowercase: true },
  plan: { type: String, enum: ['premium', 'vip', 'top'], required: true },
  amount: { type: Number, required: true, min: 0 },
  transactionId: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
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

// Admin Middleware
const isAdmin = (req, res, next) => {
  if (req.isAuthenticated() && req.user && req.user.email === process.env.ADMIN_EMAIL) {
    return next();
  }
  res.status(403).json({ success: false, message: 'Admin access required' });
};

// Input Validation Helper
const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Slot Update with proper locking
async function updateSlots() {
  const now = new Date();
  
  // Deactivate expired users
  const expired = await User.find({ 
    isActive: true, 
    startTime: { $lt: new Date(now - ACTIVE_DURATION) } 
  });
  
  for (const u of expired) {
    u.isActive = false;
    u.adsWatched = 0;
    u.subsGiven = 0;
    u.subscribedTo = [];
    await u.save();
  }
  
  const activeCount = await User.countDocuments({ isActive: true });
  const needed = SLOT_LIMIT - activeCount;
  
  if (needed <= 0) return;
  
  // Get eligible users sorted by priority and joinedAt
  const waiting = await User.find({ 
    isActive: false, 
    youtubeLink: { $ne: '' }, 
    adsWatched: { $gte: 1 } 
  }).sort({ 
    planPriority: -1, // Higher priority first
    joinedAt: 1 
  }).limit(needed);
  
  // Pre-calculate active count for all
  const currentActive = await User.countDocuments({ isActive: true });
  
  let activated = 0;
  for (const u of waiting) {
    if (activated >= needed) break;
    
    const plan = PLANS[u.plan] || PLANS.free;
    const requiredSubs = Math.min(plan.subs, currentActive);
    
    if (u.adsWatched >= plan.ads && u.subsGiven >= requiredSubs) {
      u.isActive = true;
      u.startTime = new Date();
      await u.save();
      activated++;
    }
  }
}

// Passport Configuration
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.CALLBACK_URL || 'https://ytsubexchange.online/auth/google/callback',
  scope: ['profile', 'email']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const email = profile.emails?.[0]?.value?.toLowerCase();
    if (!email) return done(new Error('No email from Google'), null);
    
    let user = await User.findOne({ googleId: profile.id });
    
    if (!user) {
      user = await User.findOne({ email });
      if (user) {
        user.googleId = profile.id;
        user.name = profile.displayName || '';
        user.photo = profile.photos?.[0]?.value || '';
        await user.save();
      } else {
        user = new User({
          email,
          googleId: profile.id,
          name: profile.displayName || '',
          photo: profile.photos?.[0]?.value || ''
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
    if (!isValidObjectId(id)) return done(null, false);
    const user = await User.findById(id);
    done(null, user || false);
  } catch(err) { 
    done(err, null); 
  }
});

// Auth Routes
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email'],
  prompt: 'select_account'
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=login_failed' }),
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

// API Routes with Validation

// Ad Watched
app.post('/api/ad-watched', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId || !isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Valid userId required' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    const plan = PLANS[user.plan] || PLANS.free;
    if (user.adsWatched < plan.ads) { 
      user.adsWatched += 1; 
      await user.save(); 
    }
    
    res.json({ success: true, adsWatched: user.adsWatched, required: plan.ads });
  } catch(err) { 
    console.error('ad-watched error:', err);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// Get Channels
app.get('/api/get-channels/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }
    
    await updateSlots();
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    const plan = PLANS[user.plan] || PLANS.free;
    const activeUsers = await User.find({ 
      _id: { $ne: userId }, 
      isActive: true 
    }).select('-subscribedTo').limit(plan.subs);
    
    res.json({ 
      success: true,
      channels: activeUsers, 
      totalActive: activeUsers.length, 
      required: plan.subs 
    });
  } catch(err) { 
    console.error('get-channels error:', err);
    res.status(500).json({ success: false, channels: [], totalActive: 0, required: 4 }); 
  }
});

// Subscribe Done (Anti-Spam)
app.post('/api/sub-done', async (req, res) => {
  try {
    const { userId, subscribedToId } = req.body;
    
    if (!userId || !isValidObjectId(userId) || !subscribedToId || !isValidObjectId(subscribedToId)) {
      return res.status(400).json({ success: false, message: 'Valid userId and subscribedToId required' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    // Check if already subscribed to this user
    if (user.subscribedTo.includes(subscribedToId)) {
      return res.status(400).json({ success: false, message: 'Already subscribed to this user' });
    }
    
    // Verify target user exists and is active
    const targetUser = await User.findById(subscribedToId);
    if (!targetUser || !targetUser.isActive) {
      return res.status(400).json({ success: false, message: 'Target channel not active' });
    }
    
    user.subsGiven += 1;
    user.subscribedTo.push(subscribedToId);
    
    const plan = PLANS[user.plan] || PLANS.free;
    const activeCount = await User.countDocuments({ isActive: true });
    const requiredSubs = Math.min(plan.subs, activeCount);
    
    if (user.adsWatched >= plan.ads && user.subsGiven >= requiredSubs) {
      user.isActive = true;
      user.startTime = new Date();
    }
    
    await user.save();
    res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive, requiredSubs });
  } catch(err) { 
    console.error('sub-done error:', err);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// Can Activate (Queue System)
app.get('/api/can-activate/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    const activeCount = await User.countDocuments({ isActive: true });
    const plan = PLANS[user.plan] || PLANS.free;
    
    // Only activate if queue is empty and user meets requirements
    if (activeCount === 0 && user.adsWatched >= plan.ads && user.youtubeLink) {
      user.isActive = true;
      user.startTime = new Date();
      await user.save();
      return res.json({ success: true, canActivate: true, isActive: true });
    }
    
    res.json({ success: true, canActivate: false, activeCount, message: 'Wait for your turn in queue' });
  } catch(err) { 
    console.error('can-activate error:', err);
    res.status(500).json({ success: false, canActivate: false }); 
  }
});

// Update YouTube Link
app.post('/api/update-youtube', async (req, res) => {
  try {
    const { userId, youtubeLink } = req.body;
    
    if (!userId || !isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Valid userId required' });
    }
    
    if (!youtubeLink || !/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(youtubeLink)) {
      return res.status(400).json({ success: false, message: 'Valid YouTube URL required' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    user.youtubeLink = youtubeLink;
    await user.save();
    res.json({ success: true, youtubeLink: user.youtubeLink });
  } catch(err) { 
    console.error('update-youtube error:', err);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// Status Check
app.get('/api/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ success: false, message: 'Invalid userId' });
    }
    
    await updateSlots();
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, found: false, message: 'User not found' });
    
    let message = '';
    if (user.isActive && user.startTime) {
      const timeLeft = ACTIVE_DURATION - (Date.now() - user.startTime.getTime());
      const hoursLeft = Math.max(0, Math.ceil(timeLeft / (1000 * 60 * 60)));
      message = hoursLeft > 0 
        ? `✅ Link active hai — ${hoursLeft} ghante baaki!`
        : `⏳ Link expired — refresh to rejoin queue`;
    } else {
      const aheadInQueue = await User.countDocuments({ 
        isActive: false, 
        adsWatched: { $gte: 1 }, 
        joinedAt: { $lt: user.joinedAt } 
      });
      const activeCount = await User.countDocuments({ isActive: true });
      
      if (activeCount < SLOT_LIMIT) message = '⏳ Jald active hoga!';
      else if (aheadInQueue === 0) message = '📅 Kal active hoga!';
      else if (aheadInQueue <= SLOT_LIMIT) message = '📅 Parson active hoga!';
      else message = `📅 ${Math.ceil(aheadInQueue / SLOT_LIMIT)} din baad active hoga!`;
    }
    
    res.json({
      success: true,
      found: true, 
      isActive: user.isActive, 
      message,
      youtubeLink: user.youtubeLink, 
      adsWatched: user.adsWatched,
      subsGiven: user.subsGiven, 
      email: user.email, 
      name: user.name,
      photo: user.photo, 
      plan: user.plan,
      totalViews: user.totalViews, 
      totalClicks: user.totalClicks
    });
  } catch(err) { 
    console.error('status error:', err);
    res.status(500).json({ success: false, found: false }); 
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activePromos = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.countDocuments({ plan: { $in: ['premium', 'vip', 'top'] } });
    res.json({ success: true, totalUsers, activePromos, premiumUsers });
  } catch(err) { 
    console.error('stats error:', err);
    res.status(500).json({ success: false, totalUsers: 0, activePromos: 0, premiumUsers: 0 }); 
  }
});

// Payment Create
app.post('/api/payment/create', async (req, res) => {
  try {
    const { userId, plan, amount } = req.body;
    
    if (!userId || !isValidObjectId(userId) || !plan || !PLANS[plan] || !PLANS[plan].price) {
      return res.status(400).json({ success: false, message: 'Valid userId and premium plan required' });
    }
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount required' });
    }
    
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    
    const payment = new Payment({ 
      userId, 
      email: user.email,
      plan, 
      amount, 
      transactionId: 'TXN' + Date.now() + crypto.randomBytes(4).toString('hex') 
    });
    await payment.save();
    
    res.json({ 
      success: true, 
      paymentId: payment._id, 
      amount, 
      upiId: process.env.UPI_ID || 'amanalam917696@okicici' 
    });
  } catch(err) { 
    console.error('payment-create error:', err);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// Payment Verify (Secure)
app.post('/api/payment/verify', async (req, res) => {
  try {
    const { paymentId, transactionId } = req.body;
    
    if (!paymentId || !isValidObjectId(paymentId) || !transactionId) {
      return res.status(400).json({ success: false, message: 'Valid paymentId and transactionId required' });
    }
    
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    
    if (payment.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Payment already verified' });
    }
    
    // In production, verify with payment gateway (UPI/Bank) here
    // For now, manual admin verification required
    
    payment.transactionId = transactionId;
    payment.status = 'pending'; // Will be approved by admin
    await payment.save();
    
    res.json({ 
      success: true, 
      message: 'Payment submitted for verification. Plan will upgrade after admin approval.' 
    });
  } catch(err) { 
    console.error('payment-verify error:', err);
    res.status(500).json({ success: false, message: 'Server error' }); 
  }
});

// Admin Approve Payment (Admin Only)
app.post('/admin/payment/approve', isAdmin, async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId || !isValidObjectId(paymentId)) {
      return res.status(400).json({ success: false, message: 'Valid paymentId required' });
    }
    
    const payment = await Payment.findById(paymentId);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    
    if (payment.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Payment already processed' });
    }
    
    payment.status = 'completed';
    await payment.save();
    
    const user = await User.findById(payment.userId);
    if (user) { 
      user.plan = payment.plan; 
      await user.save(); 
    }
    
    res.json({ success: true, message: `Plan upgraded to ${payment.plan}` });
  } catch(err) { 
    console.error('admin-approve error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// Admin Activate User (Admin Only)
app.post('/admin/activate', isAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Valid email required' });
    }
    
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'User nahi mila!' });
    
    user.isActive = true;
    user.startTime = new Date();
    await user.save();
    
    res.json({ success: true, message: 'User activate ho gaya: ' + email });
  } catch(err) { 
    console.error('admin-activate error:', err);
    res.status(500).json({ success: false, message: err.message }); 
  }
});

// Admin Stats (Admin Only)
app.get('/admin/stats', isAdmin, async (req, res) => {
  try {
    const totalUsers = await User.countDocuments();
    const activeUsers = await User.countDocuments({ isActive: true });
    const premiumUsers = await User.c
