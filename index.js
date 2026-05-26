const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let queue = []; // Waiting list
let activeSlots = []; // Sirf 4 active links
const SLOT_LIMIT = 4;
const SLOT_DURATION = 24 * 60 * 60 * 1000; // 24 ghante

// Expired slots hatao aur queue se agle lagao
function updateSlots() {
  const now = Date.now();
  activeSlots = activeSlots.filter(s => (now - s.startTime) < SLOT_DURATION);
  while (activeSlots.length < SLOT_LIMIT && queue.length > 0) {
    const next = queue.shift();
    next.startTime = Date.now();
    next.isActive = true;
    activeSlots.push(next);
  }
}

// Register
app.post('/api/register', (req, res) => {
  const { email, youtubeLink } = req.body;
  const allUsers = [...activeSlots, ...queue];
  if (allUsers.find(u => u.email === email)) {
    return res.json({ success: false, msg: 'Email already registered!' });
  }
  const user = { id: Date.now(), email, youtubeLink, adsWatched: 0, subsGiven: 0, startTime: null, isActive: false };
  updateSlots();
  if (activeSlots.length < SLOT_LIMIT) {
    user.startTime = Date.now();
    user.isActive = true;
    activeSlots.push(user);
  } else {
    queue.push(user);
  }
  const position = user.isActive ? 0 : queue.indexOf(user) + 1;
  const daysToWait = Math.ceil(position / SLOT_LIMIT);
  res.json({ success: true, userId: user.id, isActive: user.isActive, position, daysToWait });
});

// Ad watched
app.post('/api/ad-watched', (req, res) => {
  const all = [...activeSlots, ...queue];
  const user = all.find(u => u.id === parseInt(req.body.userId));
  if (!user) return res.json({ success: false });
  if (user.adsWatched < 3) user.adsWatched += 1;
  res.json({ adsWatched: user.adsWatched });
});

// Get 4 channels
app.get('/api/get-channels/:userId', (req, res) => {
  updateSlots();
  const channels = activeSlots.filter(u => u.id !== parseInt(req.params.userId)).slice(0, 4);
  res.json({ channels });
});

// Sub done
app.post('/api/sub-done', (req, res) => {
  const all = [...activeSlots, ...queue];
  const user = all.find(u => u.id === parseInt(req.body.userId));
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive });
});

// Queue status
app.get('/api/status/:userId', (req, res) => {
  updateSlots();
  const all = [...activeSlots, ...queue];
  const user = all.find(u => u.id === parseInt(req.params.userId));
  if (!user) return res.json({ found: false });
  const position = queue.indexOf(user) + 1;
  const daysToWait = Math.ceil(position / SLOT_LIMIT);
  let message = '';
  if (user.isActive) {
    const timeLeft = SLOT_DURATION - (Date.now() - user.startTime);
    const hoursLeft = Math.ceil(timeLeft / (1000 * 60 * 60));
    message = `Aapka link ${hoursLeft} ghante aur active rahega!`;
  } else if (daysToWait === 1) {
    message = 'Aapka link kal chalega!';
  } else if (daysToWait === 2) {
    message = 'Aapka link parson chalega!';
  } else {
    message = `Aapka link ${daysToWait} din baad chalega!`;
  }
  res.json({ found: true, isActive: user.isActive, position, daysToWait, message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
