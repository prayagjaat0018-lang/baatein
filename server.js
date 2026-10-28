// Baatein - server (v2: login + saved messages)
// Ye file chat ka "dimaag" hai. Ab ye har user ka login check karta hai
// aur messages Supabase database me save karta hai.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Ye dono public hain (publishable key chhupani nahi padti). Render me env se bhi de sakte ho.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qvmvquirpifymtbjhszf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_BwWzLpbMD_R2ZK1zWf8ugQ_Z7LqC9MJ';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Supabase se baat karne ka chhota helper (user ke apne token ke saath, to database ke rules lagte hain)
function sb(path, token, options = {}) {
  return fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// Har naye connection par: token check karo, profile dhundo
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('login_required'));

    const r = await sb('/auth/v1/user', token);
    if (!r.ok) return next(new Error('login_required'));
    const user = await r.json();

    const p = await sb('/rest/v1/profiles?id=eq.' + user.id + '&select=name', token);
    const rows = p.ok ? await p.json() : [];
    if (!rows.length) return next(new Error('no_profile'));

    socket.data.uid = user.id;
    socket.data.name = rows[0].name;
    socket.data.token = token;
    next();
  } catch (e) {
    next(new Error('server_error'));
  }
});

// Kaun-kaun online hai: socket id -> user id
const online = new Map();
function onlineCount() {
  return new Set(online.values()).size;
}

io.on('connection', async (socket) => {
  const { uid, name, token } = socket.data;
  online.set(socket.id, uid);

  // Purane 50 messages bhejo
  try {
    const r = await sb('/rest/v1/messages?select=user_id,name,text,created_at&order=created_at.desc&limit=50', token);
    if (r.ok) {
      const rows = (await r.json()).reverse();
      socket.emit('history', rows.map((m) => ({
        uid: m.user_id, name: m.name, text: m.text, time: new Date(m.created_at).getTime(),
      })));
    }
  } catch (e) { /* history na mile to bhi chat chalega */ }

  socket.broadcast.emit('system', name + ' joined');
  io.emit('online', onlineCount());

  // Naya message
  socket.on('message', async (payload) => {
    const text = String((payload && payload.text) || '').trim().slice(0, 500);
    if (!text) return;

    // Sabko turant bhejo
    io.emit('message', { uid, name, text, time: Date.now() });

    // Database me save karo (fresh token ke saath, warna purana)
    const t = (payload && payload.token) || token;
    try {
      await sb('/rest/v1/messages', t, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ user_id: uid, name, text }),
      });
    } catch (e) { /* save fail hua to bhi chat chalti rahe */ }
  });

  socket.on('typing', () => socket.broadcast.emit('typing', name));

  socket.on('disconnect', () => {
    online.delete(socket.id);
    io.emit('online', onlineCount());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Baatein chal raha hai: http://localhost:' + PORT);
});
