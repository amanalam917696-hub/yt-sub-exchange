const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');

const app = express();

app.set('trust proxy', 1);

app.use(cors({
  origin: 'https://ytsubexchange.online',
  credentials: true
}));

app.use(express.json());
app.use(express.static('public'));

app.use(session({
  secret: 'ytsubexchange_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: 'none',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(passport.initialize());
app.use(passport.session());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: { type: String, default: '' },
  googleId: { type: String, default: '' },
  youtubeLink: { type: String, default: '' },
  adsWatched: { type: Number, default: 0 },
  subsGiven: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const SLOT_LIMIT = 4;
const ACTIVE_DURATION = 24 * 60 * 60 * 1000;

async function updateSlots() {
  const now = new Date();
  const expired = await User.find({ 
    isActive: true, 
    startTime: { $lt: new Date(now - ACTIVE_DURATION) } 
  });
  for (const u of expired) {
    u.isActive = false;
    u.adsWatched = 0;
    u.subsGiven = 0;
    await u.save();
  }
  const activeCount = await User.countDocuments({ isActive: true });
  const needed = SLOT_LIMIT - activeCount;
  if (needed > 0) {
    const waiting = await User.find({ 
      isActive: false,
      youtubeLink: { $ne: '' },
      adsWatched: { $gte: 3 }
    }).sort({ joinedAt: 1 }).limit(needed);
    for (const u of waiting) {
      const activeUsers = await User.countDocuments({ isActive: true });
      const requiredSubs = Math.min(activeUsers, 4);
      if (u.subsGiven >= requiredSubs) {
        u.isActive = true;
        u.startTime = new Date();
        await u.save();
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
        await user.save();
      } else {
        user = new User({
          email: profile.emails[0].value,
          googleId: profile.id
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
  } catch(err) {
    done(err, null);
  }
});

// Google Login Routes
app.get('/auth/google', passport.authenticate('google', { 
  scope: ['profile', 'email'],
  prompt: 'select_account'
}));

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/?error=login_failed' }),
  async (req, res) => {
    try {
      const user = req.user;
      res.redirect(`/?userId=${user._id}&email=${encodeURIComponent(user.email)}&ytLink=${encodeURIComponent(user.youtubeLink||'')}&isActive=${user.isActive}&adsWatched=${user.adsWatched}`);
    } catch(err) {
      res.redirect('/?error=callback_failed');
    }
  }
);

// Register
app.post('/api/register', async (req, res) => {
  const { email, password, youtubeLink } = req.body;
  try {
    const exists = await User.findOne({ email });
    if (exists) return res.json({ success: false, msg: 'Email already registered!' });
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    const user = new User({ email, password: hashedPassword, youtubeLink });
    await user.save();
    res.json({ success: true, userId: user._id });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    const user = await User.findOne({ email, password: hashedPassword });
    if (!user) return res.json({ success: false, msg: 'Email ya password galat hai!' });
    await updateSlots();
    res.json({ 
      success: true, 
      userId: user._id, 
      youtubeLink: user.youtubeLink,
      adsWatched: user.adsWatched,
      subsGiven: user.subsGiven,
      isActive: user.isActive
    });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

// Ad watched
app.post('/api/ad-watched', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  if (user.adsWatched < 3) { user.adsWatched += 1; await user.save(); }
  res.json({ adsWatched: user.adsWatched });
});

// Get channels
app.get('/api/get-channels/:userId', async (req, res) => {
  await updateSlots();
  const activeUsers = await User.find({ 
    _id: { $ne: req.params.userId }, 
    isActive: true 
  }).limit(4);
  res.json({ channels: activeUsers, totalActive: activeUsers.length });
});

// Sub done
app.post('/api/sub-done', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  const activeCount = await User.countDocuments({ isActive: true });
  const requiredSubs = Math.min(activeCount, 4);
  if (user.adsWatched >= 3 && user.subsGiven >= requiredSubs) {
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
  if (activeCount === 0 && user.adsWatched >= 3) {
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
  let hoursLeft = 0;
  if (user.isActive && user.startTime) {
    const timeLeft = ACTIVE_DURATION - (Date.now() - user.startTime);
    hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
    message = `✅ Aapka link active hai — ${hoursLeft} ghante baaki!`;
  } else {
    const aheadInQueue = await User.countDocuments({
      isActive: false,
      adsWatched: { $gte: 3 },
      joinedAt: { $lt: user.joinedAt }
    });
    const activeCount = await User.countDocuments({ isActive: true });
    if (activeCount < SLOT_LIMIT && user.adsWatched >= 3) {
      message = '⏳ Aapka link jald active hoga!';
    } else if (aheadInQueue === 0) {
      message = '📅 Aapka link kal active hoga!';
    } else if (aheadInQueue <= SLOT_LIMIT) {
      message = '📅 Aapka link parson active hoga!';
    } else {
      const daysToWait = Math.ceil(aheadInQueue / SLOT_LIMIT);
      message = `📅 Aapka link ${daysToWait} din baad active hoga!`;
    }
  }
  res.json({ 
    found: true, 
    isActive: user.isActive, 
    message, hoursLeft,
    youtubeLink: user.youtubeLink, 
    adsWatched: user.adsWatched, 
    subsGiven: user.subsGiven,
    email: user.email
  });
});

// Admin activate
app.get('/admin/activate/:email', async (req, res) => {
  const user = await User.findOne({ email: req.params.email });
  if (!user) return res.send('User nahi mila!');
  user.isActive = true;
  user.startTime = new Date();
  await user.save();
  res.send('User activate ho gaya: ' + req.params.email);
});

// Password reset
app.post('/api/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.json({ success: false, msg: 'Email nahi mila!' });
    user.password = crypto.createHash('sha256').update(newPassword).digest('hex');
    await user.save();
    res.json({ success: true, msg: 'Password reset ho gaya!' });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

// YouTube redirect
app.get('/c/:userId', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.send('Link expired!');
  res.redirect(user.youtubeLink);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
