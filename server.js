// Baatein - server (v3: private chats)
// Ye server ab "post office" ki tarah hai: message database me save karta hai
// aur sirf us chat ke members ko turant bhejta hai.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');

// Ye dono public hain (publishable key chhupani nahi padti). Render me env se bhi de sakte ho.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qvmvquirpifymtbjhszf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_BwWzLpbMD_R2ZK1zWf8ugQ_Z7LqC9MJ';

// ---- Push notifications (app band ho tab bhi message/call ki notification) ----
// Render > Environment me ye 3 cheezein daalni hain (README me steps hain):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (jaise mailto:tumhari@email.com)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_ON = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (PUSH_ON) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); }
  catch (e) { console.warn('VAPID keys galat hain, push band:', e.message); }
} else {
  console.log('Push notifications band hain (VAPID keys set nahi hain).');
}
const RING_SECONDS = 45; // itni der baad "missed call"

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

// Chat ke baaki members ko push bhejo (database function push_targets se unki subscriptions milti hain)
async function pushToOthers(cid, token, payload, forCall) {
  if (!PUSH_ON) return;
  try {
    const r = await sb('/rest/v1/rpc/push_targets', token, { method: 'POST', body: JSON.stringify({ cid, for_call: !!forCall }) });
    if (!r.ok) return;
    const rows = await r.json();
    await Promise.all(rows.map((row) => sendPush(row, payload, token, forCall)));
  } catch (e) { /* push fail hua to chat chalti rahe */ }
}
// Kuch khaas users ko push (call ke liye)
async function pushToUsers(cid, token, userIds, payload, forCall) {
  if (!PUSH_ON || !userIds.length) return;
  try {
    const r = await sb('/rest/v1/rpc/push_targets', token, { method: 'POST', body: JSON.stringify({ cid, for_call: !!forCall }) });
    if (!r.ok) return;
    const want = new Set(userIds);
    const rows = (await r.json()).filter((x) => want.has(x.user_id));
    await Promise.all(rows.map((row) => sendPush(row, payload, token, forCall)));
  } catch (e) {}
}
async function sendPush(row, payload, token, forCall) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: forCall ? RING_SECONDS : 86400, urgency: 'high' }
    );
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      // Ye device ab valid nahi - list se hata do
      sb('/rest/v1/rpc/drop_push_sub', token, { method: 'POST', body: JSON.stringify({ ep: row.endpoint }) }).catch(() => {});
    }
  }
}
function previewOf(text, mime, name) {
  if (text) return text.slice(0, 140);
  if (mime && mime.startsWith('image/')) return '📷 Photo';
  if (mime && mime.startsWith('audio/')) return '🎤 Voice message';
  if (mime && mime.startsWith('video/')) return '🎬 Video';
  return '📎 ' + (name || 'File');
}

// Call khatam/cancel/miss: sabko batao, phone ki ringing notification ko "Missed call" se badlo
function finishRinging(callId, call, reason) {
  if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; }
  call.ringing = false;
  if (call.invited) {
    for (const id of call.invited) io.to('user:' + id).emit('call:ended', { call_id: callId, reason });
  }
  io.to('user:' + call.hostId).emit('call:ended', { call_id: callId, reason });
  if (call.invited && call.invited.size) {
    pushToUsers(call.conversationId, call.token, [...call.invited], {
      type: 'missed', call_id: callId, conversation_id: call.conversationId,
      title: 'Missed ' + (call.type === 'video' ? 'video' : 'voice') + ' call',
      body: (call.hostName || 'Someone') + ' ne call kiya tha',
      call_type: call.type,
    }, true);
  }
  activeCalls.delete(callId);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Browser ko batao ki push ke liye public key kya hai
app.get('/api/push-key', (req, res) => {
  if (!PUSH_ON) return res.status(404).json({ error: 'push_not_configured' });
  res.json({ key: VAPID_PUBLIC_KEY });
});

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

  // Agar mere liye call abhi ring ho rahi hai (jaise notification dabake app khola), to dobara dikhao
  for (const [callId, c] of activeCalls) {
    if (c.ringing && c.invited && c.invited.has(uid)) {
      socket.emit('call:incoming', { call_id: callId, conversation_id: c.conversationId, caller_id: c.hostId, caller_name: c.hostName, call_type: c.type, call_scope: c.scope });
    }
  }

  // Meri saari chats ke kamre join karo
  try {
    const r = await sb('/rest/v1/conversation_members?user_id=eq.' + uid + '&select=conversation_id', token);
    if (r.ok) (await r.json()).forEach((x) => socket.join('conv:' + x.conversation_id));
  } catch (e) { /* dobara connect hone par phir try hoga */ }

  // Naya message
  socket.on('message', async (payload) => {
    const cid = String((payload && payload.conversation_id) || '');
    const text = String((payload && payload.text) || '').trim().slice(0, 500);
    const attachmentPath = String((payload && payload.attachment_path) || '');
    const attachmentName = String((payload && payload.attachment_name) || '').slice(0, 120);
    const attachmentMime = String((payload && payload.attachment_mime) || '').slice(0, 120);
    const attachmentSize = Number(payload && payload.attachment_size) || 0;
    const hasAttachment = !!attachmentPath;
    if (!UUID.test(cid) || (!text && !hasAttachment)) return;
    if (hasAttachment && (!attachmentPath.startsWith(cid + '/' + uid + '/') || attachmentPath.length > 500 || attachmentSize < 1 || attachmentSize > 20*1024*1024)) return;
    const t = (payload && payload.token) || token;

    try {
      // Database me save (rules khud check karte hain ki main is chat ka member hoon)
      const replyToRaw = payload && payload.reply_to;
      const reply_to = Number.isSafeInteger(Number(replyToRaw)) && Number(replyToRaw) > 0 ? Number(replyToRaw) : null;
      const rowBody = { conversation_id: cid, sender_id: uid, text: text || '' };
      if (reply_to) rowBody.reply_to = reply_to;
      if (hasAttachment) { rowBody.attachment_path = attachmentPath; rowBody.attachment_name = attachmentName; rowBody.attachment_mime = attachmentMime; rowBody.attachment_size = attachmentSize; }
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
        const memberIds = new Set();
        for (const m of await mr.json()) { memberIds.add(m.user_id); io.in('user:' + m.user_id).socketsJoin('conv:' + cid); }
        // Jo ab member nahi (group se hata diye gaye) unke sockets ko is chat ke kamre se nikalo
        try { for (const sk of await io.in('conv:' + cid).fetchSockets()) { if (!memberIds.has(sk.data.uid)) sk.leave('conv:' + cid); } } catch (_) {}
      }

      io.to('conv:' + cid).emit('message', {
        id: row.id,
        conversation_id: cid,
        sender_id: uid,
        sender_name: name,
        text: row.text,
        attachment_path: row.attachment_path || null, attachment_name: row.attachment_name || null, attachment_mime: row.attachment_mime || null, attachment_size: row.attachment_size || null,
        reply_to: row.reply_to || null,
        edited_at: row.edited_at || null,
        created_at: row.created_at,
        time: new Date(row.created_at).getTime(),
      });

      // App band ho tab bhi dusre members ko notification
      let pushTitle = name, pushPrefix = '';
      try {
        const cr = await sb('/rest/v1/conversations?id=eq.' + cid + '&select=is_group,name', t);
        if (cr.ok) { const cv = (await cr.json())[0]; if (cv && cv.is_group) { pushTitle = cv.name || 'Group'; pushPrefix = name + ': '; } }
      } catch (_) {}
      pushToOthers(cid, t, {
        type: 'message', conversation_id: cid, message_id: row.id,
        title: pushTitle, body: pushPrefix + previewOf(row.text, row.attachment_mime, row.attachment_name),
      }, false);
    } catch (e) {
      socket.emit('send_failed', { conversation_id: cid });
    }
  });

  // Group me kuch badla (naya group, member juda/hata, naam badla): sabko batao aur kamre theek karo
  socket.on('group:changed', async (payload = {}) => {
    const cid = String(payload.conversation_id || '');
    if (!UUID.test(cid)) return;
    try {
      const ids = await getConversationMemberIds(cid, token);
      if (!ids || !ids.includes(uid)) {
        // Main ab member nahi (group chhod diya) - bas apne sockets nikalo
        io.in('user:' + uid).socketsLeave('conv:' + cid);
        return;
      }
      for (const id of ids) io.in('user:' + id).socketsJoin('conv:' + cid);
      io.to('conv:' + cid).emit('group:updated', { conversation_id: cid });
      const set = new Set(ids);
      for (const sk of await io.in('conv:' + cid).fetchSockets()) { if (!set.has(sk.data.uid)) sk.leave('conv:' + cid); }
    } catch (_) {}
  });

  // Emoji reaction: ek user ka ek message par ek reaction (dobara wahi dabaya to hat jata hai)
  const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  socket.on('reaction', async (payload = {}) => {
    const id = Number(payload.message_id); const cid = String(payload.conversation_id || '');
    const emoji = payload.emoji == null ? null : String(payload.emoji);
    if (!Number.isSafeInteger(id) || id <= 0 || !UUID.test(cid)) return;
    if (emoji !== null && !REACTIONS.includes(emoji)) return;
    try {
      if (!(await isMember(cid, uid, token))) return;
      const chk = await sb('/rest/v1/chat_messages?id=eq.' + id + '&conversation_id=eq.' + cid + '&select=id', token);
      if (!chk.ok || !(await chk.json()).length) return;
      let r;
      if (emoji === null) {
        r = await sb('/rest/v1/message_reactions?message_id=eq.' + id + '&user_id=eq.' + uid, token, { method: 'DELETE' });
      } else {
        r = await sb('/rest/v1/message_reactions?on_conflict=message_id,user_id', token, {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ message_id: id, user_id: uid, emoji }),
        });
      }
      if (!r.ok) return;
      io.to('conv:' + cid).emit('reaction:updated', { conversation_id: cid, message_id: id, user_id: uid, emoji });
    } catch (_) {}
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
    const invited = new Set(ids.filter((x) => x !== uid));
    const call = { conversationId: cid, hostId: uid, hostName: name, participants: new Set([uid]), invited, ringing: true, ringTimer: null, type, scope, token, startedAt: Date.now() };
    activeCalls.set(callId, call);
    for (const targetId of invited) {
      io.to('user:' + targetId).emit('call:incoming', { call_id: callId, conversation_id: cid, caller_id: uid, caller_name: name, call_type: type, call_scope: scope });
    }
    socket.emit('call:started', { call_id: callId });
    // Jo log offline/app band hain unhe phone par ringing notification
    pushToUsers(cid, token, [...invited], {
      type: 'call', call_id: callId, conversation_id: cid, call_type: type, call_scope: scope,
      title: name + (type === 'video' ? ' – video call' : ' – voice call'),
      body: 'Incoming ' + (type === 'video' ? 'video' : 'voice') + ' call… tap karke uthao',
    }, true);
    // Koi na uthaye to missed call
    call.ringTimer = setTimeout(() => { const c = activeCalls.get(callId); if (c && c.ringing) finishRinging(callId, c, 'missed'); }, RING_SECONDS * 1000);
  });

  socket.on('call:accept', async (payload = {}) => {
    const callId = String(payload.call_id || ''); const call = activeCalls.get(callId);
    if (!call || !(await isMember(call.conversationId, uid, token))) return;
    call.participants.add(uid);
    if (call.ringing) { call.ringing = false; if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; } }
    // Mere baaki devices par ringing band karo
    io.to('user:' + uid).emit('call:handled', { call_id: callId });
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
    if (!call) return;
    io.to('user:' + uid).emit('call:handled', { call_id: callId });
    io.to('user:' + call.hostId).emit('call:rejected', { call_id: callId, user_id: uid, name });
    if (call.invited) call.invited.delete(uid);
    // 1-to-1 me reject = call khatam. Group me baaki log abhi uth sakte hain.
    if (call.scope === 'one_to_one' || (call.ringing && call.invited && call.invited.size === 0)) {
      if (call.ringTimer) { clearTimeout(call.ringTimer); call.ringTimer = null; }
      call.ringing = false;
      activeCalls.delete(callId);
    }
  });

  socket.on('call:leave', (payload = {}) => {
    const callId = String(payload.call_id || ''); const call = activeCalls.get(callId);
    if (!call) return;
    // Caller ne uthne se pehle hi kaat diya
    if (call.ringing && uid === call.hostId) { finishRinging(callId, call, 'cancelled'); return; }
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
    if (current.sockets.size === 0) {
      onlineUsers.delete(uid); io.emit('presence:offline', { user_id: uid });
      // Agar main call kar raha tha aur ring ho rahi thi, to cancel
      for (const [callId, c] of activeCalls) { if (c.hostId === uid && c.ringing) finishRinging(callId, c, 'cancelled'); }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Baatein chal raha hai: http://localhost:' + PORT);
});
