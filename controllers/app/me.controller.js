const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const db = require('../../models');
const emailService = require('../../services/email.service');
const cfg = require('../../config/homie');
const paystack = require('../../services/paystack.service');
const { memberPublic, serviceView, num } = require('../../utils/homieSerializers');
const { lagosDayKey } = require('../../services/booking.service');

const { Member, OtpCode, ChefProfile, ChefService, ChefBlockedDate, PayoutAccount, Booking, BookingPayment } = db;

const bad = (res, message, status = 400) => res.status(status).json({ success: false, message });
const strList = (value, max = 20) =>
  Array.isArray(value) ? [...new Set(value.map((v) => String(v).trim()).filter(Boolean))].slice(0, max) : undefined;

// ------------------------------------------------------------------ member

exports.getMe = async (req, res) => {
  const chef = await ChefProfile.findOne({ where: { memberId: req.member.id }, attributes: ['id', 'verificationStatus', 'tier'] });
  return res.json({
    success: true,
    data: { member: memberPublic(req.member), chef: chef ? { id: chef.id, verificationStatus: chef.verificationStatus, tier: chef.tier } : null },
  });
};

exports.updateMe = async (req, res) => {
  try {
    const patch = {};
    ['firstName', 'lastName', 'address', 'avatarUrl'].forEach((key) => {
      if (req.body[key] !== undefined) patch[key] = String(req.body[key]).trim() || null;
    });
    // Email is a login identifier, so it can only change through /me/email/request + /me/email/verify.
    ['lat', 'lng'].forEach((key) => {
      if (req.body[key] !== undefined) patch[key] = req.body[key] === null ? null : Number(req.body[key]);
    });
    if (patch.firstName === null) return bad(res, 'First name is required');
    await req.member.update(patch);
    return res.json({ success: true, data: { member: memberPublic(req.member) } });
  } catch (error) {
    console.error('updateMe error:', error);
    return bad(res, 'Could not update profile', 500);
  }
};

// Changing the email proves control of the new address with a one-time code before it is saved.
exports.requestEmailChange = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) return bad(res, 'Enter a valid email address');
    if (await Member.count({ where: { email, id: { [Op.ne]: req.member.id } } })) {
      return bad(res, 'That email is already in use', 409);
    }

    const last = await OtpCode.findOne({ where: { target: email }, order: [['createdAt', 'DESC']] });
    if (last && Date.now() - new Date(last.createdAt).getTime() < cfg.OTP_RESEND_SECONDS * 1000) {
      return bad(res, `Please wait ${cfg.OTP_RESEND_SECONDS} seconds before requesting another code`, 429);
    }
    const lastHour = await OtpCode.count({ where: { target: email, createdAt: { [Op.gte]: new Date(Date.now() - 3600 * 1000) } } });
    if (lastHour >= 5) return bad(res, 'Too many codes requested. Try again later.', 429);

    const code = String(crypto.randomInt(100000, 1000000));
    await OtpCode.create({
      target: email, channel: 'email', codeHash: await bcrypt.hash(code, 8),
      expiresAt: new Date(Date.now() + cfg.OTP_TTL_MINUTES * 60 * 1000),
    });
    const message = `Your Homie code to confirm this email is ${code}. It expires in ${cfg.OTP_TTL_MINUTES} minutes.`;
    await emailService.sendEmail({ to: email, subject: 'Confirm your email for Homie', html: `<p>${message}</p>`, text: message });

    const exposeCode = process.env.NODE_ENV === 'development' && process.env.OTP_ECHO !== 'false';
    return res.json({ success: true, message: 'Verification code sent', data: { email, ...(exposeCode ? { devCode: code } : {}) } });
  } catch (error) {
    console.error('requestEmailChange error:', error);
    return bad(res, 'Could not send verification code', 500);
  }
};

exports.verifyEmailChange = async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    if (!/^\S+@\S+\.\S+$/.test(email) || !/^\d{6}$/.test(code)) return bad(res, 'Enter the email and the 6-digit code');

    const otp = await OtpCode.findOne({
      where: { target: email, consumedAt: null, expiresAt: { [Op.gt]: new Date() } },
      order: [['createdAt', 'DESC']],
    });
    if (!otp || otp.attempts >= cfg.OTP_MAX_ATTEMPTS) return bad(res, 'Code expired. Request a new one.');
    await otp.increment('attempts');
    if (!(await bcrypt.compare(code, otp.codeHash))) return bad(res, 'Incorrect code');
    await otp.update({ consumedAt: new Date() });

    try {
      await req.member.update({ email, emailVerifiedAt: new Date() });
    } catch (error) {
      if (error.name === 'SequelizeUniqueConstraintError') return bad(res, 'That email is already in use', 409);
      throw error;
    }
    return res.json({ success: true, data: { member: memberPublic(req.member) } });
  } catch (error) {
    console.error('verifyEmailChange error:', error);
    return bad(res, 'Could not verify email', 500);
  }
};

exports.switchRole = async (req, res) => {
  const { role } = req.body;
  if (!['hirer', 'chef'].includes(role)) return bad(res, 'Role must be hirer or chef');
  if (role === 'chef') {
    const chef = await ChefProfile.findOne({ where: { memberId: req.member.id }, attributes: ['id'] });
    if (!chef) {
      return res.status(400).json({ success: false, message: 'Set up your chef profile first', code: 'CHEF_SETUP_REQUIRED' });
    }
  }
  await req.member.update({ activeRole: role });
  return res.json({ success: true, data: { member: memberPublic(req.member) } });
};

exports.registerPushToken = async (req, res) => {
  const { token } = req.body;
  if (!token || String(token).length > 255) return bad(res, 'A valid push token is required');
  await req.member.update({ pushToken: token });
  return res.json({ success: true });
};

// -------------------------------------------------------------------- chef

const chefInclude = [
  { model: ChefBlockedDate, as: 'blockedDates', where: { date: { [Op.gte]: lagosDayKey(new Date()) } }, required: false },
  { model: PayoutAccount, as: 'payoutAccount', required: false },
];

const maskAccount = (n) => (n ? `••••${String(n).slice(-4)}` : null);

const ownChefView = (chef) => ({
  id: chef.id,
  displayName: chef.displayName,
  bio: chef.bio,
  cuisines: chef.cuisines,
  tags: chef.tags,
  yearsExperience: chef.yearsExperience,
  eventsCooked: chef.eventsCooked,
  replyTime: chef.replyTime,
  area: chef.area,
  lat: num(chef.lat),
  lng: num(chef.lng),
  coverUrl: chef.coverUrl,
  portfolio: chef.portfolio,
  available: chef.available,
  rating: num(chef.ratingAvg) || 0,
  reviewCount: chef.ratingCount,
  verificationStatus: chef.verificationStatus,
  verificationNote: chef.verificationNote,
  tier: chef.tier,
  blockedDates: (chef.blockedDates || []).map((d) => d.date).sort(),
  payoutAccount: chef.payoutAccount
    ? { bankCode: chef.payoutAccount.bankCode, bankName: chef.payoutAccount.bankName, accountName: chef.payoutAccount.accountName, accountNumber: maskAccount(chef.payoutAccount.accountNumber) }
    : null,
});

const loadOwnChef = (memberId) => ChefProfile.findOne({ where: { memberId }, include: chefInclude });

exports.getChefProfile = async (req, res) => {
  const chef = await loadOwnChef(req.member.id);
  if (!chef) return res.status(404).json({ success: false, message: 'No chef profile yet', code: 'CHEF_SETUP_REQUIRED' });
  return res.json({ success: true, data: { chef: ownChefView(chef) } });
};

// Creates the chef profile on first call (this is how a member becomes a chef).
exports.upsertChefProfile = async (req, res) => {
  try {
    const b = req.body;
    const patch = {};
    if (b.displayName !== undefined) patch.displayName = String(b.displayName).trim().slice(0, 150);
    ['bio', 'area', 'coverUrl', 'replyTime'].forEach((key) => {
      if (b[key] !== undefined) patch[key] = String(b[key]).trim() || null;
    });
    const cuisines = strList(b.cuisines);
    const tags = strList(b.tags, 30);
    if (cuisines) patch.cuisines = cuisines;
    if (tags) patch.tags = tags;
    if (b.yearsExperience !== undefined) patch.yearsExperience = Math.max(0, Math.min(60, parseInt(b.yearsExperience, 10) || 0));
    ['lat', 'lng'].forEach((key) => {
      if (b[key] !== undefined) patch[key] = b[key] === null ? null : Number(b[key]);
    });
    if (Array.isArray(b.portfolio)) {
      patch.portfolio = b.portfolio.slice(0, 40).map((p) => (typeof p === 'string' ? { url: p } : { url: String(p.url), caption: p.caption ? String(p.caption) : undefined }));
    }
    if (b.available !== undefined) patch.available = !!b.available;

    let chef = await ChefProfile.findOne({ where: { memberId: req.member.id } });
    if (!chef) {
      patch.displayName = patch.displayName || [req.member.firstName, req.member.lastName].filter(Boolean).join(' ');
      if (!patch.displayName) return bad(res, 'A display name is required');
      chef = await ChefProfile.create({ memberId: req.member.id, ...patch });
      await req.member.update({ isChef: true });
    } else {
      if (patch.displayName === '') return bad(res, 'A display name is required');
      await chef.update(patch);
    }
    return res.json({ success: true, data: { chef: ownChefView(await loadOwnChef(req.member.id)) } });
  } catch (error) {
    console.error('upsertChefProfile error:', error);
    return bad(res, 'Could not save chef profile', 500);
  }
};

exports.setAvailability = async (req, res) => {
  try {
    const { available, blockedDates } = req.body;
    await db.sequelize.transaction(async (transaction) => {
      if (available !== undefined) await req.chef.update({ available: !!available }, { transaction });
      if (Array.isArray(blockedDates)) {
        const today = lagosDayKey(new Date());
        const days = [...new Set(blockedDates.map(String))].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today).slice(0, 366);
        await ChefBlockedDate.destroy({ where: { chefId: req.chef.id, date: { [Op.gte]: today } }, transaction });
        if (days.length) await ChefBlockedDate.bulkCreate(days.map((date) => ({ chefId: req.chef.id, date })), { transaction });
      }
    });
    return res.json({ success: true, data: { chef: ownChefView(await loadOwnChef(req.member.id)) } });
  } catch (error) {
    console.error('setAvailability error:', error);
    return bad(res, 'Could not update availability', 500);
  }
};

let bankCache = { at: 0, banks: [] };
exports.listBanks = async (req, res) => {
  try {
    if (Date.now() - bankCache.at > 12 * 3600 * 1000 || !bankCache.banks.length) {
      const banks = await paystack.getBanks();
      bankCache = { at: Date.now(), banks: banks.map((b) => ({ name: b.name, code: b.code })) };
    }
    return res.json({ success: true, data: { banks: bankCache.banks } });
  } catch (error) {
    return bad(res, 'Could not load banks right now', 502);
  }
};

exports.setPayoutAccount = async (req, res) => {
  try {
    const { bankCode, bankName } = req.body;
    const accountNumber = String(req.body.accountNumber || '').replace(/\D/g, '');
    if (!bankCode || accountNumber.length !== 10) return bad(res, 'Choose a bank and enter a 10-digit account number');

    let resolved;
    try {
      resolved = await paystack.resolveAccount(accountNumber, bankCode);
    } catch (error) {
      return bad(res, 'We could not verify that account. Check the bank and account number.');
    }

    const [account] = await PayoutAccount.findOrCreate({
      where: { chefId: req.chef.id },
      defaults: { chefId: req.chef.id, bankCode, bankName: bankName || null, accountNumber, accountName: resolved.account_name },
    });
    await account.update({ bankCode, bankName: bankName || account.bankName, accountNumber, accountName: resolved.account_name, recipientCode: null });
    return res.json({
      success: true,
      data: { payoutAccount: { bankCode, bankName: account.bankName, accountName: account.accountName, accountNumber: maskAccount(accountNumber) } },
    });
  } catch (error) {
    console.error('setPayoutAccount error:', error);
    return bad(res, 'Could not save payout account', 500);
  }
};

exports.getEarnings = async (req, res) => {
  try {
    const bookings = await Booking.findAll({
      where: { chefId: req.chef.id, status: { [Op.in]: ['pending_chef', 'confirmed', 'in_progress', 'awaiting_approval', 'completed', 'disputed'] } },
      include: [{ model: BookingPayment, as: 'payments', required: false }],
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    let released = 0; let inEscrow = 0; let paidOut = 0;
    const items = bookings.map((b) => {
      const payment = (b.payments || []).sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0];
      const amount = b.status === 'completed' ? Number(payment?.payoutAmount ?? b.chefPayout) : Number(b.chefPayout);
      if (b.status === 'completed') {
        released += amount;
        if (payment?.payoutStatus === 'paid') paidOut += amount;
      } else if (b.status !== 'disputed' || payment?.status === 'held') inEscrow += amount;
      return {
        bookingId: b.id, reference: b.reference, service: b.serviceTitle, scheduledAt: b.scheduledAt,
        total: Number(b.total), commission: Number(b.commission), payout: amount, status: b.status,
        payoutStatus: payment?.payoutStatus || 'none',
      };
    });
    return res.json({ success: true, data: { released, inEscrow, paidOut, commissionRate: items[0] ? Number(bookings[0].commissionRate) : null, items } });
  } catch (error) {
    console.error('getEarnings error:', error);
    return bad(res, 'Could not load earnings', 500);
  }
};
