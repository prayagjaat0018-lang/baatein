// Baatein - server
// Ye file chat ka "dimaag" hai: sabke messages yahin se hokar guzarte hain.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// "public" folder ki files (index.html) browser ko dikhao
app.use(express.static('public'));

// Kaun-kaun online hai: socket id -> naam
const users = new Map();

io.on('connection', (socket) => {
  // Jab koi apna naam daal kar chat me aaye
  socket.on('join', (name) => {
    name = String(name || '').trim().slice(0, 20);
    if (!name) return;
    users.set(socket.id, name);
    io.emit('system', name + ' joined the chat');
    io.emit('online', users.size);
  });

  // Jab koi message bheje
  socket.on('message', (text) => {
    const name = users.get(socket.id);
    text = String(text || '').trim().slice(0, 500);
    if (!name || !text) return;
    // Message sabko bhej do (bhejne wale ko bhi)
    io.emit('message', { id: socket.id, name, text, time: Date.now() });
  });

  // "typing..." dikhane ke liye (bhejne wale ko chhodkar baaki sabko)
  socket.on('typing', () => {
    const name = users.get(socket.id);
    if (name) socket.broadcast.emit('typing', name);
  });

  // Jab koi chala jaye
  socket.on('disconnect', () => {
    const name = users.get(socket.id);
    if (!name) return;
    users.delete(socket.id);
    io.emit('system', name + ' left');
    io.emit('online', users.size);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Baatein chal raha hai: http://localhost:' + PORT);
});
