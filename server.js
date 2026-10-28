// Baatein - server (v3: private chats)
// Ye server ab "post office" ki tarah hai: message database me save karta hai
// aur sirf us chat ke members ko turant bhejta hai.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

// Ye dono public hain (publishable key chhupani nahi padti). Render me env se bhi de sakte ho.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qvmvquirpifymtbjhszf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_BwWzLpbMD_R2ZK1zWf8ugQ_Z7LqC9MJ';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Supabase se baat karne ka helper (user ke apne token ke saath, to database ke rules lagte hain)
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

io.on('connection', async (socket) => {
  const { uid, name, token } = socket.data;

  // Mera apna "kamra" (taaki mere saare devices ko message mile)
  socket.join('user:' + uid);

  // Meri saari chats ke kamre join karo
  try {
    const r = await sb('/rest/v1/conversation_members?user_id=eq.' + uid + '&select=conversation_id', token);
    if (r.ok) (await r.json()).forEach((x) => socket.join('conv:' + x.conversation_id));
  } catch (e) { /* dobara connect hone par phir try hoga */ }

  // Naya message
  socket.on('message', async (payload) => {
    const cid = String((payload && payload.conversation_id) || '');
    const text = String((payload && payload.text) || '').trim().slice(0, 500);
    if (!UUID.test(cid) || !text) return;
    const t = (payload && payload.token) || token;

    try {
      // Database me save (rules khud check karte hain ki main is chat ka member hoon)
      const r = await sb('/rest/v1/chat_messages', t, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ conversation_id: cid, sender_id: uid, text }),
      });
      if (!r.ok) { socket.emit('send_failed', { conversation_id: cid }); return; }
      const row = (await r.json())[0];

      // Is chat ke sabhi members ke sockets ko kamre me daalo (naye chat ke liye zaroori)
      const mr = await sb('/rest/v1/conversation_members?conversation_id=eq.' + cid + '&select=user_id', t);
      if (mr.ok) {
        for (const m of await mr.json()) io.in('user:' + m.user_id).socketsJoin('conv:' + cid);
      }

      io.to('conv:' + cid).emit('message', {
        id: row.id,
        conversation_id: cid,
        sender_id: uid,
        text: row.text,
        time: new Date(row.created_at).getTime(),
      });
    } catch (e) {
      socket.emit('send_failed', { conversation_id: cid });
    }
  });

  // "typing..." (sirf us chat ke dusre log dekhenge)
  socket.on('typing', (cid) => {
    if (UUID.test(String(cid))) socket.to('conv:' + cid).emit('typing', { conversation_id: cid, name });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Baatein chal raha hai: http://localhost:' + PORT);
});
