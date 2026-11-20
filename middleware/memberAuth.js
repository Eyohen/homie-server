const jwt = require('jsonwebtoken');
const db = require('../models');

const fail = (res, status, message, code) =>
  res.status(status).json({ success: false, message, ...(code ? { code } : {}) });

const loadMember = async (req) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return { error: [401, 'Access token required'] };

  let decoded;
  try {
    decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') return { error: [401, 'Token expired', 'TOKEN_EXPIRED'] };
    return { error: [401, 'Invalid token'] };
  }

  if (decoded.type !== 'member' || !decoded.memberId) return { error: [401, 'Invalid token'] };

  const member = await db.Member.findByPk(decoded.memberId);
  if (!member) return { error: [401, 'Account not found'] };
  if (member.status !== 'active') return { error: [403, 'Your account is not active', 'ACCOUNT_SUSPENDED'] };
  return { member };
};

// Requires a valid Homie member access token.
const verifyMember = async (req, res, next) => {
  try {
    const { member, error } = await loadMember(req);
    if (error) return fail(res, ...error);
    req.member = member;
    return next();
  } catch (error) {
    console.error('verifyMember error:', error);
    return fail(res, 500, 'Authentication failed');
  }
};

// Like verifyMember, but anonymous requests pass through (req.member stays undefined).
const optionalMember = async (req, res, next) => {
  try {
    if (!req.headers.authorization) return next();
    const { member } = await loadMember(req);
    if (member) req.member = member;
    return next();
  } catch (error) {
    return next();
  }
};

// Requires the member to have a chef profile (use after verifyMember).
const requireChef = async (req, res, next) => {
  try {
    const chef = await db.ChefProfile.findOne({ where: { memberId: req.member.id } });
    if (!chef) return fail(res, 403, 'Chef profile required. Switch to chef mode and set up your profile first.');
    req.chef = chef;
    return next();
  } catch (error) {
    console.error('requireChef error:', error);
    return fail(res, 500, 'Could not load chef profile');
  }
};

module.exports = { verifyMember, optionalMember, requireChef };
