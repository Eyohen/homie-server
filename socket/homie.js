// Realtime channel for the Homie mobile app. Each signed-in member joins a private room
// (member:<id>) so the server can push chat messages and booking updates to them.
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('../models');

let io = null;

const init = (httpServer) => {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: { origin: true, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Authentication required'));
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded.type !== 'member') return next(new Error('Invalid token'));
      const member = await db.Member.findByPk(decoded.memberId, { attributes: ['id', 'status'] });
      if (!member || member.status !== 'active') return next(new Error('Account not active'));
      socket.memberId = member.id;
      return next();
    } catch (error) {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    socket.join(`member:${socket.memberId}`);

    // Typing indicator: { threadId, isTyping }
    socket.on('chat:typing', async ({ threadId, isTyping } = {}) => {
      try {
        const thread = await db.ChatThread.findByPk(threadId, {
          include: [{ model: db.ChefProfile, as: 'chef', attributes: ['memberId'] }],
        });
        if (!thread) return;
        const otherId = thread.hirerId === socket.memberId ? thread.chef.memberId : thread.chef.memberId === socket.memberId ? thread.hirerId : null;
        if (otherId) io.to(`member:${otherId}`).emit('chat:typing', { threadId, memberId: socket.memberId, isTyping: !!isTyping });
      } catch (error) {
        // ignore malformed events
      }
    });
  });

  return io;
};

const emitToMember = (memberId, event, payload) => {
  if (io) io.to(`member:${memberId}`).emit(event, payload);
};

module.exports = { init, emitToMember };
