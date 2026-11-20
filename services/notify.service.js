const db = require('../models');
const { sendPush } = require('./push.service');

// Persist an in-app notification and send a push. Never throws, so callers can fire and forget.
const notify = async (memberId, { type, title, body, data }) => {
  try {
    const member = await db.Member.findByPk(memberId, { attributes: ['id', 'pushToken'] });
    if (!member) return null;
    const record = await db.AppNotification.create({ memberId, type, title, body, data });
    sendPush(member.pushToken, { title, body, data: { type, ...(data || {}) } });
    return record;
  } catch (error) {
    console.error('notify failed:', error.message);
    return null;
  }
};

module.exports = { notify };
