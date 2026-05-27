const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB connect
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  youtubeLink: String,
  adsWatched: { type: Number, default: 0 },
  subsGiven: { type: Number, default: 0 },
  subsReceived: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  startTime: { type: Date, default: null },
  joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

const SLOT_LIMIT = 4;
const SLOT_DURATION = 24 * 60 * 60 * 1000;

async function updateSlots() {
  const now = new Date();
  const expired = await User.find({ isActive: true, startTime: { $lt: new Date(now - SLOT_DURATION) } });
  for (const u of expired) {
    u.isActive = false;
    await u.save();
  }
  const activeCount = await User.countDocuments({ isActive: true });
  const needed = SLOT_LIMIT - activeCount;
  if (needed > 0) {
    const waiting = await User.find({ isActive: false, startTime: null }).sort({ joinedAt: 1 }).limit(needed);
    for (const u of waiting) {
      u.isActive = true;
      u.startTime = new Date();
      await u.save();
    }
  }
}

app.post('/api/register', async (req, res) => {
  const { email, youtubeLink } = req.body;
  const exists = await User.findOne({ email });
  if (exists) return res.json({ success: false, msg: 'Email already registered!' });
  await updateSlots();
  const activeCount = await User.countDocuments({ isActive: true });
  const user = new User({ email, youtubeLink });
  if (activeCount < SLOT_LIMIT) {
    user.isActive = true;
    user.startTime = new Date();
  }
  await user.save();
  const queuePos = user.isActive ? 0 : await User.countDocuments({ isActive: false, startTime: null, joinedAt: { $lte: user.joinedAt } });
  const daysToWait = Math.ceil(queuePos / SLOT_LIMIT);
  res.json({ success: true, userId: user._id, isActive: user.isActive, daysToWait, shareLink: `https://yt-sub-exchange.onrender.com/c/${user._id}` });
});

app.post('/api/ad-watched', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  if (user.adsWatched < 3) { user.adsWatched += 1; await user.save(); }
  res.json({ adsWatched: user.adsWatched });
});

app.get('/api/get-channels/:userId', async (req, res) => {
  await updateSlots();
  const channels = await User.find({ _id: { $ne: req.params.userId }, isActive: true }).limit(4);
  res.json({ channels });
});

app.post('/api/sub-done', async (req, res) => {
  const user = await User.findById(req.body.userId);
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  await user.save();
  res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive });
});

app.get('/api/status/:userId', async (req, res) => {
  await updateSlots();
  const user = await User.findById(req.params.userId);
  if (!user) return res.json({ found: false });
  let message = '';
  if (user.isActive) {
    const timeLeft = SLOT_DURATION - (Date.now() - user.startTime);
    const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
    message = `Aapka link ${hoursLeft} ghante aur active rahega!`;
  } else {
    const queuePos = await User.countDocuments({ isActive: false, startTime: null, joinedAt: { $lte: user.joinedAt } });
    const daysToWait = Math.ceil(queuePos / SLOT_LIMIT);
    if (daysToWait <= 1) message = 'Aapka link kal chalega!';
    else if (daysToWait === 2) message = 'Aapka link parson chalega!';
    else message = `Aapka link ${daysToWait} din baad chalega!`;
  }
  res.json({ found: true, isActive: user.isActive, message });
});

app.get('/c/:userId', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.send('Link expired ya galat hai!');
  res.redirect(user.youtubeLink);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
