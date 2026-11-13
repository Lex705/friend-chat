require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const twilio = require('twilio');
const { Server } = require('socket.io');
const { normalizePhone, formatTwilioWhatsappRecipient } = require('./phone-utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, 'public');
const roomHistory = new Map();
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/api/config', (req, res) => {
  res.json({
    hasTwilio: !!twilioClient,
    twilioNumber: process.env.TWILIO_WHATSAPP_NUMBER || null,
    message: twilioClient ? 'Twilio WhatsApp is configured.' : 'Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_NUMBER to enable real WhatsApp messages.'
  });
});

function getRoomHistory(room) {
  if (!roomHistory.has(room)) {
    roomHistory.set(room, []);
  }
  return roomHistory.get(room);
}

function createRoomMessage({ room, sender, text, source = 'local', audio = null, replyTo = null }) {
  const cleanText = String(text || '').trim();
  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sender,
    text: cleanText || 'Voice note',
    time: new Date().toISOString(),
    room,
    source,
    audio,
    replyTo
  };

  const history = getRoomHistory(room);
  history.push(message);
  if (history.length > 250) history.shift();

  return message;
}

app.post('/api/send-message', async (req, res) => {
  const to = String(req.body.to || '').trim();
  const text = String(req.body.message || req.body.text || '').trim();
  const sender = String(req.body.sender || 'Website User').trim() || 'Website User';
  const room = String(req.body.room || '').trim() || `phone-${normalizePhone(to)}`;

  if (!to || !text) {
    return res.status(400).json({ ok: false, error: 'Phone number and message are required.' });
  }

  let externalResult = null;
  let via = 'local';

  if (twilioClient && process.env.TWILIO_WHATSAPP_NUMBER) {
    try {
      const twilioTo = formatTwilioWhatsappRecipient(to);
      const twilioFrom = formatTwilioWhatsappRecipient(process.env.TWILIO_WHATSAPP_NUMBER);
      const sent = await twilioClient.messages.create({
        from: twilioFrom,
        to: twilioTo,
        body: text
      });
      via = 'twilio-whatsapp';
      externalResult = { sid: sent.sid, status: sent.status };
    } catch (error) {
      via = 'local-fallback';
      externalResult = { error: error.message };
    }
  }

  const message = createRoomMessage({
    room,
    sender,
    text,
    source: via,
    audio: req.body.audio || null
  });

  io.to(room).emit('chat-message', message);

  return res.json({
    ok: true,
    room,
    via,
    externalResult,
    messageId: message.id
  });
});

app.post('/webhooks/whatsapp', (req, res) => {
  const from = String(req.body.From || req.body.from || '').trim();
  const messageText = String(req.body.Body || req.body.body || '').trim();

  if (!from || !messageText) {
    return res.type('text/xml').send('<Response></Response>');
  }

  const normalizedFrom = normalizePhone(from);
  const room = `phone-${normalizedFrom}`;
  const message = createRoomMessage({
    room,
    sender: 'Incoming WhatsApp',
    text: messageText,
    source: 'twilio-webhook'
  });

  io.to(room).emit('chat-message', message);
  return res.type('text/xml').send('<Response></Response>');
});

io.on('connection', (socket) => {
  const initialRoom = socket.handshake.query.room || 'friend-chat';
  socket.data.room = initialRoom;
  socket.join(initialRoom);

  socket.emit('system-message', {
    text: `You joined the chat room: ${initialRoom}`
  });

  socket.emit('chat-history', getRoomHistory(initialRoom));

  socket.on('join-room', ({ room, userName, email, phone }) => {
    const targetRoom = room || socket.data.room || 'friend-chat';
    if (socket.data.room && socket.data.room !== targetRoom) {
      socket.leave(socket.data.room);
    }

    socket.data.room = targetRoom;
    socket.join(targetRoom);
    socket.emit('chat-history', getRoomHistory(targetRoom));
    io.to(targetRoom).emit('system-message', {
      text: `${userName || 'A guest'} joined the room.`
    });
  });

  socket.on('chat-message', ({ room: targetRoom, sender, text, audio, time, id }) => {
    const roomName = targetRoom || socket.data.room || 'friend-chat';
    const cleanText = String(text || '').trim();
    if (!sender || !cleanText) return;

    const message = createRoomMessage({
      room: roomName,
      sender,
      text: cleanText,
      source: 'socket',
      audio: audio || null,
      replyTo: null
    });

    if (id) message.id = id;
    if (time) message.time = new Date(time).toISOString();

    io.to(roomName).emit('chat-message', message);
  });
});

server.listen(PORT, () => {
  console.log(`Chat app is running at http://localhost:${PORT}`);
});
