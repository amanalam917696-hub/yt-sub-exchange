const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  password: { type: String },
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
    const waiting = await User.find({ isActive: false, youtubeLink: { $ne: '' }, adsWatched: { $gte: 3 }, subsGiven: { $gte: 4 } }).sort({ joinedAt: 1 }).limit(needed);
    for (const u of waiting) {
      u.isActive = true;
      u.startTime = new Date();
      await u.save();
    }
  }
}

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
  const channels = await User.find({ _id: { $ne: req.params.userId }, isActive: true }).limit(4);
  res.json({ channels });
});

// Sub done
app.post('/api/sub-done', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  if (user.adsWatched >= 3 && user.subsGiven >= 4) {
    user.isActive = true;
    user.startTime = new Date();
  }
  await user.save();
  res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive });
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
    message = `Aapka link ${hoursLeft} ghante aur active hai!`;
  } else if (!user.isActive && user.adsWatched >= 3 && user.subsGiven >= 4) {
    message = 'Aapka link queue mein hai — jald active hoga!';
  } else if (!user.isActive) {
    message = '24 ghante baad link expire hua — 3 ads dekho aur active karo!';
  }
  res.json({ found: true, isActive: user.isActive, message, youtubeLink: user.youtubeLink, adsWatched: user.adsWatched, subsGiven: user.subsGiven });
});

// YouTube redirect
app.get('/c/:userId', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.send('Link expired!');
  res.redirect(user.youtubeLink);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
// Admin - force activate user
app.get('/admin/activate/:email', async (req, res) => {
  const user = await User.findOne({ email: req.params.email });
  if (!user) return res.send('User nahi mila!');
  user.isActive = true;
  user.startTime = new Date();
  await user.save();
  res.send('User activate ho gaya: ' + req.params.email);
});
