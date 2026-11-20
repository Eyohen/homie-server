const { Op } = require('sequelize');
const db = require('../../models');
const { emitToMember } = require('../../socket/homie');
const { sendPush } = require('../../services/push.service');
const { memberName } = require('../../utils/homieSerializers');

const { ChatThread, ChatMessage, ChefProfile, Member } = db;

// Heuristics for moving payment off-platform. Messages are still delivered but flagged for staff review.
const FLAG_RULES = [
  [/(\+?\d[\d\s().-]{8,}\d)/, 'Phone number shared'],
  [/\b(account\s*(number|no\.?)|acct\s*no|opay|palmpay|moniepoint|kuda|gtbank|gtb|zenith|access bank|first bank|uba)\b/i, 'Bank details mentioned'],
  [/\b(pay\s*(me\s*)?(directly|outside|in cash)|outside\s*(the\s*)?app|whats\s?app|telegram|transfer\s*(it\s*)?to\s*me|cash\s*only)\b/i, 'Possible off-platform payment'],
];

const detectFlag = (body) => {
  for (const [pattern, reason] of FLAG_RULES) if (pattern.test(body)) return reason;
  return null;
};

const threadInclude = [
  { model: Member, as: 'hirer', attributes: ['id', 'firstName', 'lastName', 'avatarUrl'] },
  { model: ChefProfile, as: 'chef', attributes: ['id', 'memberId', 'displayName'], include: [{ model: Member, as: 'member', attributes: ['id', 'avatarUrl'] }] },
];

const myChefId = async (memberId) => (await ChefProfile.findOne({ where: { memberId }, attributes: ['id'] }))?.id || null;

const isParticipant = (thread, member) => thread.hirerId === member.id || thread.chef.memberId === member.id;

const messageView = (m) => ({ id: m.id, threadId: m.threadId, senderId: m.senderId, body: m.body, createdAt: m.createdAt, readAt: m.readAt });

const threadView = (thread, member, unread = 0) => {
  const iAmHirer = thread.hirerId === member.id;
  return {
    id: thread.id,
    counterpart: iAmHirer
      ? { id: thread.chef.id, name: thread.chef.displayName, avatarUrl: thread.chef.member?.avatarUrl || null, role: 'chef' }
      : { id: thread.hirer.id, name: memberName(thread.hirer), avatarUrl: thread.hirer.avatarUrl, role: 'hirer' },
    chefId: thread.chefId,
    lastMessage: thread.lastMessageText,
    lastMessageAt: thread.lastMessageAt,
    unread,
  };
};

exports.listThreads = async (req, res) => {
  try {
    const as = req.query.as || req.member.activeRole;
    const where = {};
    if (as === 'chef') {
      const chefId = await myChefId(req.member.id);
      if (!chefId) return res.json({ success: true, data: { threads: [] } });
      where.chefId = chefId;
    } else {
      where.hirerId = req.member.id;
    }
    where.lastMessageAt = { [Op.ne]: null };

    const threads = await ChatThread.findAll({ where, include: threadInclude, order: [['lastMessageAt', 'DESC']], limit: 100 });
    const counts = threads.length
      ? await ChatMessage.findAll({
        where: { threadId: threads.map((t) => t.id), senderId: { [Op.ne]: req.member.id }, readAt: null },
        attributes: ['threadId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
        group: ['threadId'],
        raw: true,
      })
      : [];
    const unread = Object.fromEntries(counts.map((c) => [c.threadId, Number(c.n)]));
    return res.json({ success: true, data: { threads: threads.map((t) => threadView(t, req.member, unread[t.id] || 0)) } });
  } catch (error) {
    console.error('listThreads error:', error);
    return res.status(500).json({ success: false, message: 'Could not load conversations' });
  }
};

// Hirer opens (or reuses) a conversation with a chef.
exports.openThread = async (req, res) => {
  try {
    const chef = await ChefProfile.findByPk(req.body.chefId, { attributes: ['id', 'memberId'] });
    if (!chef) return res.status(404).json({ success: false, message: 'Chef not found' });
    if (chef.memberId === req.member.id) return res.status(400).json({ success: false, message: 'You cannot message yourself' });
    const [thread] = await ChatThread.findOrCreate({
      where: { hirerId: req.member.id, chefId: chef.id },
      defaults: { hirerId: req.member.id, chefId: chef.id },
    });
    const full = await ChatThread.findByPk(thread.id, { include: threadInclude });
    return res.json({ success: true, data: { thread: threadView(full, req.member) } });
  } catch (error) {
    console.error('openThread error:', error);
    return res.status(500).json({ success: false, message: 'Could not open conversation' });
  }
};

exports.listMessages = async (req, res) => {
  try {
    const thread = await ChatThread.findByPk(req.params.id, { include: threadInclude });
    if (!thread || !isParticipant(thread, req.member)) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const where = { threadId: thread.id };
    if (req.query.before) {
      const before = new Date(req.query.before);
      if (!Number.isNaN(before.getTime())) where.createdAt = { [Op.lt]: before };
    }
    const rows = await ChatMessage.findAll({ where, order: [['createdAt', 'DESC']], limit });
    await ChatMessage.update({ readAt: new Date() }, { where: { threadId: thread.id, senderId: { [Op.ne]: req.member.id }, readAt: null } });
    return res.json({
      success: true,
      data: { thread: threadView(thread, req.member), messages: rows.reverse().map(messageView), hasMore: rows.length === limit },
    });
  } catch (error) {
    console.error('listMessages error:', error);
    return res.status(500).json({ success: false, message: 'Could not load messages' });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ success: false, message: 'Message cannot be empty' });
    if (body.length > 2000) return res.status(400).json({ success: false, message: 'Message is too long' });

    const thread = await ChatThread.findByPk(req.params.id, { include: threadInclude });
    if (!thread || !isParticipant(thread, req.member)) return res.status(404).json({ success: false, message: 'Conversation not found' });

    const flagReason = detectFlag(body);
    const message = await ChatMessage.create({ threadId: thread.id, senderId: req.member.id, body, flagged: !!flagReason, flagReason });
    await thread.update({ lastMessageText: body.slice(0, 300), lastMessageAt: message.createdAt });

    const recipientId = thread.hirerId === req.member.id ? thread.chef.memberId : thread.hirerId;
    const payload = messageView(message);
    emitToMember(recipientId, 'chat:message', payload);
    const recipient = await Member.findByPk(recipientId, { attributes: ['pushToken'] });
    sendPush(recipient?.pushToken, { title: memberName(req.member), body: body.slice(0, 120), data: { type: 'chat', threadId: thread.id } });

    return res.status(201).json({ success: true, data: { message: payload, ...(flagReason ? { warning: 'For your protection, keep payments inside Homie.' } : {}) } });
  } catch (error) {
    console.error('sendMessage error:', error);
    return res.status(500).json({ success: false, message: 'Could not send message' });
  }
};
