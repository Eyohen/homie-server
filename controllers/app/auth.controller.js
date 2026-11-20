const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const db = require('../../models');
const sms = require('../../services/sms.service');
const emailService = require('../../services/email.service');
const cfg = require('../../config/homie');
const { memberPublic } = require('../../utils/homieSerializers');

const { Member, OtpCode, ChefProfile } = db;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// "0803 412 7790", "+234 803...", "234803..." -> "+2348034127790". Returns null when invalid.
const normalizePhone = (raw) => {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  let normalized = null;
  if (digits.startsWith('+')) normalized = digits;
  else if (digits.startsWith('234')) normalized = `+${digits}`;
  else if (digits.startsWith('0')) normalized = `+234${digits.slice(1)}`;
  else if (digits.length === 10) normalized = `+234${digits}`;
  return normalized && /^\+\d{10,15}$/.test(normalized) ? normalized : null;
};

const normalizeEmail = (raw) => {
  const email = String(raw || '').trim().toLowerCase();
  return /^\S+@\S+\.\S+$/.test(email) ? email : null;
};

const resolveTarget = (body) => {
  if (body.phone) {
    const phone = normalizePhone(body.phone);
    return phone ? { channel: 'sms', target: phone, field: 'phone' } : { error: 'Enter a valid phone number' };
  }
  if (body.email) {
    const email = normalizeEmail(body.email);
    return email ? { channel: 'email', target: email, field: 'email' } : { error: 'Enter a valid email address' };
  }
  return { error: 'Phone number or email is required' };
};

const issueTokens = async (member) => {
  const accessToken = jwt.sign({ memberId: member.id, type: 'member' }, process.env.JWT_SECRET, { expiresIn: cfg.ACCESS_TOKEN_TTL });
  const refreshToken = jwt.sign(
    { memberId: member.id, type: 'member_refresh', jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: `${cfg.REFRESH_TOKEN_TTL_DAYS}d` }
  );
  await member.update({ refreshTokenHash: sha256(refreshToken), lastLoginAt: new Date() });
  return { accessToken, refreshToken };
};

exports.requestOtp = async (req, res) => {
  try {
    const resolved = resolveTarget(req.body);
    if (resolved.error) return res.status(400).json({ success: false, message: resolved.error });
    const { channel, target } = resolved;

    const last = await OtpCode.findOne({ where: { target }, order: [['createdAt', 'DESC']] });
    if (last && Date.now() - new Date(last.createdAt).getTime() < cfg.OTP_RESEND_SECONDS * 1000) {
      return res.status(429).json({ success: false, message: `Please wait ${cfg.OTP_RESEND_SECONDS} seconds before requesting another code` });
    }
    const lastHour = await OtpCode.count({ where: { target, createdAt: { [Op.gte]: new Date(Date.now() - 3600 * 1000) } } });
    if (lastHour >= 5) {
      return res.status(429).json({ success: false, message: 'Too many codes requested. Try again later.' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await OtpCode.create({
      target, channel, codeHash: await bcrypt.hash(code, 8),
      expiresAt: new Date(Date.now() + cfg.OTP_TTL_MINUTES * 60 * 1000),
    });

    const message = `Your Homie code is ${code}. It expires in ${cfg.OTP_TTL_MINUTES} minutes.`;
    if (channel === 'sms') {
      await sms.send(target, message);
    } else {
      await emailService.sendEmail({
        to: target,
        subject: 'Your Homie verification code',
        html: `<p>${message}</p>`,
        text: message,
      });
    }

    const exposeCode = process.env.NODE_ENV === 'development' && process.env.OTP_ECHO !== 'false' && sms.provider() === 'console';
    return res.json({
      success: true,
      message: 'Verification code sent',
      data: { target, channel, expiresInSeconds: cfg.OTP_TTL_MINUTES * 60, ...(exposeCode ? { devCode: code } : {}) },
    });
  } catch (error) {
    console.error('requestOtp error:', error);
    return res.status(500).json({ success: false, message: 'Could not send verification code' });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const resolved = resolveTarget(req.body);
    if (resolved.error) return res.status(400).json({ success: false, message: resolved.error });
    const { target, field } = resolved;
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter the 6-digit code' });

    const otp = await OtpCode.findOne({
      where: { target, consumedAt: null, expiresAt: { [Op.gt]: new Date() } },
      order: [['createdAt', 'DESC']],
    });
    if (!otp || otp.attempts >= cfg.OTP_MAX_ATTEMPTS) {
      return res.status(400).json({ success: false, message: 'Code expired. Request a new one.', code: 'OTP_EXPIRED' });
    }
    await otp.increment('attempts');
    if (!(await bcrypt.compare(code, otp.codeHash))) {
      return res.status(400).json({ success: false, message: 'Incorrect code', code: 'OTP_INVALID' });
    }
    await otp.update({ consumedAt: new Date() });

    const wantsChef = req.body.role === 'chef';
    let member = await Member.findOne({ where: { [field]: target } });
    const isNewUser = !member;
    if (!member) {
      member = await Member.create({ [field]: target, activeRole: 'hirer' });
    }
    if (member.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Your account is not active', code: 'ACCOUNT_SUSPENDED' });
    }

    // Returning chefs can sign in straight into chef mode.
    const chefProfile = await ChefProfile.findOne({ where: { memberId: member.id }, attributes: ['id'] });
    if (wantsChef && chefProfile && member.activeRole !== 'chef') await member.update({ activeRole: 'chef' });

    const tokens = await issueTokens(member);
    return res.json({
      success: true,
      message: 'Signed in',
      data: { ...tokens, member: memberPublic(member), isNewUser, wantsChef: wantsChef && !chefProfile },
    });
  } catch (error) {
    console.error('verifyOtp error:', error);
    return res.status(500).json({ success: false, message: 'Verification failed' });
  }
};

exports.refresh = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'Refresh token required' });

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token', code: 'REFRESH_INVALID' });
    }
    if (decoded.type !== 'member_refresh') {
      return res.status(401).json({ success: false, message: 'Invalid refresh token', code: 'REFRESH_INVALID' });
    }

    const member = await Member.findByPk(decoded.memberId);
    if (!member || member.refreshTokenHash !== sha256(refreshToken)) {
      return res.status(401).json({ success: false, message: 'Session expired. Please sign in again.', code: 'REFRESH_INVALID' });
    }
    if (member.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Your account is not active', code: 'ACCOUNT_SUSPENDED' });
    }

    const tokens = await issueTokens(member);
    return res.json({ success: true, data: tokens });
  } catch (error) {
    console.error('refresh error:', error);
    return res.status(500).json({ success: false, message: 'Could not refresh session' });
  }
};

exports.logout = async (req, res) => {
  try {
    await req.member.update({ refreshTokenHash: null, pushToken: null });
    return res.json({ success: true, message: 'Signed out' });
  } catch (error) {
    console.error('logout error:', error);
    return res.status(500).json({ success: false, message: 'Could not sign out' });
  }
};

exports.normalizePhone = normalizePhone;
