const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let users = [];
let nextId = 1;

app.post('/api/register', (req, res) => {
  const { email, youtubeLink } = req.body;
  const exists = users.find(u => u.email === email);
  if (exists) return res.json({ success: false, msg: 'Email already registered!' });
  const newUser = { id: nextId++, email, youtubeLink, adsWatched: 0, subsGiven: 0, isActive: false };
  users.push(newUser);
  res.json({ success: true, userId: newUser.id });
});

app.post('/api/ad-watched', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.body.userId));
  if (!user) return res.json({ success: false });
  if (user.adsWatched < 3) user.adsWatched += 1;
  res.json({ adsWatched: user.adsWatched });
});

app.get('/api/get-channels/:userId', (req, res) => {
  const userId = parseInt(req.params.userId);
  const channels = users.filter(u => u.id !== userId).slice(0, 4);
  res.json({ channels });
});

app.post('/api/sub-done', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.body.userId));
  const target = users.find(u => u.id === parseInt(req.body.subscribedToId));
  if (!user) return res.json({ success: false });
  user.subsGiven += 1;
  if (target) target.subsReceived = (target.subsReceived || 0) + 1;
  if (user.adsWatched >= 3 && user.subsGiven >= 4) user.isActive = true;
  res.json({ success: true, subsGiven: user.subsGiven, isActive: user.isActive });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));
