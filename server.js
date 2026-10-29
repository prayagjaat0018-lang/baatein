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


// ---- WebRTC calling signalling (media travels peer-to-peer; server only relays setup messages) ----
const activeCalls = new Map(); // callId -> { conversationId, hostId, participants:Set<userId>, type, scope }
const onlineUsers = new Map(); // uid -> { name, sockets:Set<socketId> }
async function getConversationMemberIds(conversationId, token) {
  const r = await sb('/rest/v1/conversation_members?conversation_id=eq.' + encodeURIComponent(conversationId) + '&select=user_id', token);
  if (!r.ok) return null;
  return (await r.json()).map(x => x.user_id);
}
async function isMember(conversationId, uid, token) {
  const ids = await getConversationMemberIds(conversationId, token);
  return !!ids && ids.includes(uid);
}

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

  // Online presence: ek user ke multiple tabs/devices ko support karo.
  let presence = onlineUsers.get(uid);
  const wasOnline = !!presence;
  if (!presence) { presence = { name, sockets: new Set() }; onlineUsers.set(uid, presence); }
  presence.sockets.add(socket.id);
  socket.emit('presence:list', [...onlineUsers.entries()].map(([user_id, v]) => ({ user_id, name: v.name })));
  if (!wasOnline) socket.broadcast.emit('presence:online', { user_id: uid, name });

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
      const replyToRaw = payload && payload.reply_to;
      const reply_to = Number.isSafeInteger(Number(replyToRaw)) && Number(replyToRaw) > 0 ? Number(replyToRaw) : null;
      const rowBody = { conversation_id: cid, sender_id: uid, text };
      if (reply_to) rowBody.reply_to = reply_to;
      const r = await sb('/rest/v1/chat_messages', t, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rowBody),
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
        reply_to: row.reply_to || null,
        edited_at: row.edited_at || null,
        created_at: row.created_at,
        time: new Date(row.created_at).getTime(),
      });
    } catch (e) {
      socket.emit('send_failed', { conversation_id: cid });
    }
  });

  // Message edit/delete: server enforces sender ownership; database RLS is a second guard.
  socket.on('message:edit', async (payload = {}) => {
    const id = Number(payload.id); const text = String(payload.text || '').trim().slice(0, 500);
    const cid = String(payload.conversation_id || '');
    if (!Number.isSafeInteger(id) || id <= 0 || !UUID.test(cid) || !text || !(await isMember(cid, uid, token))) return;
    try {
      const r = await sb('/rest/v1/chat_messages?id=eq.' + id + '&conversation_id=eq.' + cid + '&sender_id=eq.' + uid, token, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ text, edited_at: new Date().toISOString() }),
      });
      if (!r.ok) { socket.emit('message:action-failed', { action: 'edit' }); return; }
      const rows = await r.json(); if (!rows.length) return;
      io.to('conv:' + cid).emit('message:updated', { id: rows[0].id, conversation_id: cid, sender_id: uid, text: rows[0].text, edited_at: rows[0].edited_at });
    } catch (_) { socket.emit('message:action-failed', { action: 'edit' }); }
  });

  socket.on('message:delete', async (payload = {}) => {
    const id = Number(payload.id); const cid = String(payload.conversation_id || '');
    if (!Number.isSafeInteger(id) || id <= 0 || !UUID.test(cid) || !(await isMember(cid, uid, token))) return;
    try {
      const r = await sb('/rest/v1/chat_messages?id=eq.' + id + '&conversation_id=eq.' + cid + '&sender_id=eq.' + uid, token, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
      if (!r.ok) { socket.emit('message:action-failed', { action: 'delete' }); return; }
      const rows = await r.json(); if (rows.length) io.to('conv:' + cid).emit('message:deleted', { id: rows[0].id, conversation_id: cid, sender_id: uid });
    } catch (_) { socket.emit('message:action-failed', { action: 'delete' }); }
  });

  // Read receipts are based on conversation_members.last_read_at.
  socket.on('read:conversation', async (payload = {}) => {
    const cid = String(payload.conversation_id || '');
    if (!UUID.test(cid) || !(await isMember(cid, uid, token))) return;
    io.to('conv:' + cid).emit('read:receipt', { conversation_id: cid, user_id: uid, read_at: new Date().toISOString() });
  });

  // Call invite: verify that the caller belongs to the conversation before notifying others.
  socket.on('call:invite', async (payload = {}) => {
    const cid = String(payload.conversation_id || '');
    const callId = String(payload.call_id || '');
    const type = payload.call_type === 'video' ? 'video' : 'audio';
    const scope = payload.call_scope === 'group' ? 'group' : 'one_to_one';
    if (!UUID.test(cid) || !UUID.test(callId) || !(await isMember(cid, uid, token))) return;
    const ids = await getConversationMemberIds(cid, token);
    if (!ids || ids.length < 2) { socket.emit('call:error', { message: 'Is chat mein call karne ke liye doosra member nahi mila.' }); return; }
    const call = { conversationId: cid, hostId: uid, participants: new Set([uid]), type, scope, token, startedAt: Date.now() };
    activeCalls.set(callId, call);
    for (const targetId of ids) {
      if (targetId === uid) continue;
      io.to('user:' + targetId).emit('call:incoming', { call_id: callId, conversation_id: cid, caller_id: uid, caller_name: name, call_type: type, call_scope: scope });
    }
    socket.emit('call:started', { call_id: callId });
  });

  socket.on('call:accept', async (payload = {}) => {
    const callId = String(payload.call_id || ''); const call = activeCalls.get(callId);
    if (!call || !(await isMember(call.conversationId, uid, token))) return;
    call.participants.add(uid);
    const participantList = [...call.participants];
    for (const id of participantList) {
      if (id === uid) continue;
      io.to('user:' + id).emit('call:participant-joined', { call_id: callId, user_id: uid, name });
    }
    socket.emit('call:accepted', { call_id: callId, conversation_id: call.conversationId, participants: participantList, call_type: call.type, call_scope: call.scope });
    // The host needs the accept notification even if the accepting user is remote.
    io.to('user:' + call.hostId).emit('call:peer-accepted', { call_id: callId, user_id: uid, name });
  });

  socket.on('call:signal', async (payload = {}) => {
    const callId = String(payload.call_id || ''); const targetId = String(payload.target_id || '');
    const call = activeCalls.get(callId);
    if (!call || !call.participants.has(uid) || !call.participants.has(targetId)) return;
    io.to('user:' + targetId).emit('call:signal', { call_id: callId, from_id: uid, signal: payload.signal });
  });

  socket.on('call:reject', (payload = {}) => {
    const callId = String(payload.call_id || ''); const call = activeCalls.get(callId);
    if (call) io.to('user:' + call.hostId).emit('call:rejected', { call_id: callId, user_id: uid, name });
  });

  socket.on('call:leave', (payload = {}) => {
    const callId = String(payload.call_id || ''); const call = activeCalls.get(callId);
    if (!call) return;
    call.participants.delete(uid);
    for (const id of call.participants) io.to('user:' + id).emit('call:participant-left', { call_id: callId, user_id: uid });
    if (call.participants.size < 2 || uid === call.hostId) {
      for (const id of call.participants) io.to('user:' + id).emit('call:ended', { call_id: callId });
      activeCalls.delete(callId);
    }
  });

  // "typing..." (sirf us chat ke dusre log dekhenge)
  socket.on('typing', async (cid) => {
    if (UUID.test(String(cid)) && await isMember(String(cid), uid, token)) socket.to('conv:' + cid).emit('typing', { conversation_id: cid, name });
  });

  socket.on('disconnect', () => {
    const current = onlineUsers.get(uid);
    if (!current) return;
    current.sockets.delete(socket.id);
    if (current.sockets.size === 0) { onlineUsers.delete(uid); io.emit('presence:offline', { user_id: uid }); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Baatein chal raha hai: http://localhost:' + PORT);
});
