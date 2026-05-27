const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected!'))
  .catch(err => console.log('MongoDB error:', err));

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  youtubeLinks: [{ 
    link: String,
    isActive: { type: Boolean, default: false },
    startTime: { type: Date, default: null },
    lastAdTime: { type: Date, default: null },
    adsWatched: { type: Number, default: 0 },
    subsGiven: { type: Number, default: 0 },
    approved: { type: Boolean, default: false }
  }],
  joinedAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

const SLOT_LIMIT = 4;
const ACTIVE_DURATION = 24 * 60 * 60 * 1000; // 24 ghante
const AD_REFRESH = 12 * 60 * 60 * 1000; // 12 ghante

// Register ya naya link add karo
app.post('/api/register', async (req, res) => {
  const { email, youtubeLink } = req.body;
  try {
    let user = await User.findOne({ email });
    
    if (!user) {
      // Naya user
      user = new User({ 
        email, 
        youtubeLinks: [{ link: youtubeLink, adsWatched: 0, subsGiven: 0 }] 
      });
      await user.save();
      return res.json({ success: true, userId: user._id, isNew: true, linkIndex: 0 });
    }
    
    // Purana user — naya link add karo
    user.youtubeLinks.push({ link: youtubeLink, adsWatched: 0, subsGiven: 0 });
    await user.save();
    const linkIndex = user.youtubeLinks.length - 1;
    res.json({ success: true, userId: user._id, isNew: false, linkIndex });
  } catch (err) {
    res.json({ success: false, msg: err.message });
  }
});

// Ad watched
app.post('/api/ad-watched', async (req, res) => {
  const { userId, linkIndex } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.json({ success: false });
  
  const linkObj = user.youtubeLinks[linkIndex];
  if (linkObj.adsWatched < 3) {
    linkObj.adsWatched += 1;
    linkObj.lastAdTime = new Date();
  }
  await user.save();
  res.json({ adsWatched: linkObj.adsWatched });
});

// 12 ghante baad refresh ads
app.post('/api/refresh-ads', async (req, res) => {
  const { userId, linkIndex } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.json({ success: false });
  
  const linkObj = user.youtubeLinks[linkIndex];
  const now = Date.now();
  
  // Check 12 ghante ho gaye?
  if (linkObj.lastAdTime && (now - linkObj.lastAdTime) < AD_REFRESH) {
    const timeLeft = AD_REFRESH - (now - linkObj.lastAdTime);
    const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
    return res.json({ canRefresh: false, hoursLeft });
  }
  
  // Reset ads
  linkObj.adsWatched = 0;
  await user.save();
  res.json({ canRefresh: true });
});

// Get channels
app.get('/api/get-channels/:userId', async (req, res) => {
  const now = Date.now();
  const users = await User.find({ _id: { $ne: req.params.userId } });
  
  const activeChannels = [];
  for (const u of users) {
    for (const l of u.youtubeLinks) {
      if (l.isActive && l.startTime && (now - l.startTime) < ACTIVE_DURATION) {
        activeChannels.push({ id: u._id, linkIndex: u.youtubeLinks.indexOf(l), youtubeLink: l.link });
      }
    }
  }
  res.json({ channels: activeChannels.slice(0, 4) });
});

// Sub done
app.post('/api/sub-done', async (req, res) => {
  const { userId, linkIndex } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.json({ success: false });
  
  const linkObj = user.youtubeLinks[linkIndex];
  linkObj.subsGiven += 1;
  
  // 3 ads + 4 subs ke baad approved
  if (linkObj.adsWatched >= 3 && linkObj.subsGiven >= 4) {
    linkObj.approved = true;
  }
  
  await user.save();
  res.json({ success: true, subsGiven: linkObj.subsGiven, approved: linkObj.approved });
});

// Activate link - queue check
app.post('/api/activate', async (req, res) => {
  const { userId, linkIndex } = req.body;
  const user = await User.findById(userId);
  if (!user) return res.json({ success: false });
  
  const linkObj = user.youtubeLinks[linkIndex];
  if (!linkObj.approved) return res.json({ success: false, msg: 'Pehle ads dekho aur subscribe karo!' });
  
  // Active slots check
  const now = Date.now();
  const allUsers = await User.find();
  let activeCount = 0;
  for (const u of allUsers) {
    for (const l of u.youtubeLinks) {
      if (l.isActive && l.startTime && (now - l.startTime) < ACTIVE_DURATION) activeCount++;
    }
  }
  
  if (activeCount < SLOT_LIMIT) {
    linkObj.isActive = true;
    linkObj.startTime = new Date();
    await user.save();
    return res.json({ success: true, isActive: true, message: 'Aapka link active ho gaya!' });
  }
  
  // Queue mein
  const position = activeCount - SLOT_LIMIT + 1;
  const daysToWait = Math.ceil(position / SLOT_LIMIT);
  let message = '';
  if (daysToWait <= 1) message = 'Aapka link kal active hoga!';
  else if (daysToWait === 2) message = 'Aapka link parson active hoga!';
  else message = `Aapka link ${daysToWait} din baad active hoga!`;
  
  res.json({ success: true, isActive: false, message });
});

// Status check
app.get('/api/status/:userId/:linkIndex', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.json({ found: false });
  
  const linkObj = user.youtubeLinks[req.params.linkIndex];
  if (!linkObj) return res.json({ found: false });
  
  const now = Date.now();
  let message = '';
  let needsRefresh = false;
  
  if (linkObj.isActive && linkObj.startTime) {
    const timeLeft = ACTIVE_DURATION - (now - linkObj.startTime);
    if (timeLeft <= 0) {
      linkObj.isActive = false;
      await user.save();
      message = 'Aapka link expire ho gaya! Dobara ads dekho.';
    } else {
      const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
      message = `Aapka link ${hoursLeft} ghante aur active hai!`;
      
      // 12 ghante check
      if (linkObj.lastAdTime && (now - linkObj.lastAdTime) >= AD_REFRESH) {
        needsRefresh = true;
        message = '⚠️ 12 ghante ho gaye! 3 ads dekho link active rakhne ke liye!';
      }
    }
  }
  
  res.json({ 
    found: true, 
    isActive: linkObj.isActive, 
    message, 
    needsRefresh,
    adsWatched: linkObj.adsWatched,
    youtubeLink: linkObj.link
  });
});

// YouTube redirect
app.get('/c/:userId/:linkIndex', async (req, res) => {
  const user = await User.findById(req.params.userId);
  if (!user) return res.send('Link expired!');
  const linkObj = user.youtubeLinks[req.params.linkIndex];
  if (!linkObj) return res.send('Link nahi mila!');
  res.redirect(linkObj.link);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
