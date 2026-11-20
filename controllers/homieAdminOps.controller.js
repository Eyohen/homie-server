// Back-office operations for the managed-marketplace model (mounted under /api/admin-homie):
// pricing settings, chef allocation, quotations, procurement, and chef/customer KYC review.
const { Op } = require('sequelize');
const db = require('../models');
const pricing = require('../services/pricing.service');
const kyc = require('../services/kyc.service');
const flows = require('../services/bookingFlows.service');
const cloudinaryService = require('../services/cloudinary.service');
const { memberName, bookingView, num } = require('../utils/homieSerializers');
const { quoteView } = require('./app/quote.controller');

const { PricingSetting, ChefProfile, Member, Booking, BookingPayment, Quote, AuditLog, ChefKyc } = db;

const audit = (req, action, entity, entityId, { previous, next, description } = {}) =>
  AuditLog.create({
    adminId: req.admin.id, action, entity, entityId, previousData: previous || null, newData: next || null, description: description || null,
    ipAddress: req.ip, userAgent: req.headers['user-agent'] || null,
  }).catch((error) => console.error('audit log failed:', error.message));

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
    console.error(`${req.method} ${req.originalUrl} error:`, error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};

const paging = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
};
const pageInfo = (p, total) => ({ page: p.page, limit: p.limit, total, pages: Math.ceil(total / p.limit) });

const sign = (ref) => { try { return cloudinaryService.signedUrl(ref); } catch (e) { return null; } };

const bookingInclude = [
  { model: ChefProfile, as: 'chef', include: [{ model: Member, as: 'member', attributes: ['id', 'avatarUrl'] }], required: false },
  { model: Member, as: 'hirer', attributes: ['id', 'firstName', 'lastName', 'avatarUrl'] },
  { model: BookingPayment, as: 'payments', required: false },
];

// ------------------------------------------------------------------ pricing

exports.getPricing = wrap(async (req, res) => {
  const row = await PricingSetting.findByPk(1);
  const tiers = await ChefProfile.findAll({ attributes: ['tier', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']], where: { verificationStatus: 'approved' }, group: ['tier'], raw: true });
  return res.json({ success: true, data: { pricing: await pricing.getSettings({ fresh: true }), updatedAt: row.updatedAt, chefsPerTier: Object.fromEntries(tiers.map((t) => [t.tier, Number(t.n)])) } });
});

exports.updatePricing = wrap(async (req, res) => {
  const b = req.body;
  const fail = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
  const patch = {};
  if (b.tiers !== undefined) {
    for (const t of pricing.TIERS) {
      const r = b.tiers[t];
      if (!r || !(Number(r.customerRate) > 0) || !(Number(r.chefPayout) > 0)) fail(`Set a customer rate and chef payout for ${t}`);
      if (Number(r.chefPayout) >= Number(r.customerRate)) fail(`The ${t} chef payout must be lower than the customer rate`);
    }
    patch.tiers = Object.fromEntries(pricing.TIERS.map((t) => [t, { customerRate: Number(b.tiers[t].customerRate), chefPayout: Number(b.tiers[t].chefPayout) }]));
  }
  const ranged = (key, min, max, label) => {
    if (b[key] === undefined) return;
    const v = Number(b[key]);
    if (!(v >= min && v <= max)) fail(`${label} must be between ${min} and ${max}`);
    patch[key] = v;
  };
  ranged('minHours', 1, 8, 'Minimum hours');
  ranged('serviceFeeRate', 0, 0.5, 'Service fee rate');
  ranged('quoteFeeRate', 0, 0.5, 'Quotation platform fee rate');
  ranged('chefPayoutShare', 0.1, 1, 'Chef payout share');
  ranged('idRequiredAbove', 0, 100000000, 'ID threshold');
  ranged('maxRecurringSessions', 2, 52, 'Maximum recurring sessions');
  ranged('quoteSlaHours', 1, 72, 'Quotation turnaround hours');
  ranged('quoteValidityHours', 1, 168, 'Quotation validity hours');
  if (!Object.keys(patch).length) fail('Nothing to update');

  const before = await pricing.getSettings({ fresh: true });
  await PricingSetting.update({ ...patch, updatedByAdminId: req.admin.id }, { where: { id: 1 } });
  pricing.invalidate();
  const after = await pricing.getSettings({ fresh: true });
  audit(req, 'pricing_updated', 'PricingSetting', null, { previous: before, next: after, description: 'Pricing settings changed' });
  return res.json({ success: true, data: { pricing: after } });
});

// --------------------------------------------------------------- allocation

exports.listAllocations = wrap(async (req, res) => {
  const rows = await Booking.findAll({ where: { status: 'pending_allocation' }, include: bookingInclude, order: [['paidAt', 'ASC']], limit: 100 });
  return res.json({
    success: true,
    data: { bookings: rows.map((b) => ({ ...bookingView(b, 'admin'), waitingHours: Math.round(((Date.now() - new Date(b.paidAt).getTime()) / 3600000) * 10) / 10 })) },
  });
});

exports.candidates = wrap(async (req, res) => {
  const booking = await Booking.findByPk(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  return res.json({ success: true, data: { tier: booking.tier, cuisine: booking.cuisine, candidates: await flows.candidatesFor(booking) } });
});

exports.allocate = wrap(async (req, res) => {
  const booking = await flows.allocate(req.params.id, req.body.chefId, req.admin);
  audit(req, 'booking_allocated', 'Booking', booking.id, { next: { chefId: req.body.chefId }, description: booking.reference });
  return res.json({ success: true, data: { booking: bookingView(await Booking.findByPk(booking.id, { include: bookingInclude }), 'admin') } });
});

// ------------------------------------------------------------------- quotes

const quoteInclude = [
  { model: ChefProfile, as: 'preferredChef', attributes: ['id', 'displayName'] },
  { model: Member, as: 'customer', attributes: ['id', 'firstName', 'lastName', 'phone', 'email'] },
];

const adminQuoteView = (q) => ({ ...quoteView(q), customer: q.customer ? { id: q.customer.id, name: memberName(q.customer), email: q.customer.email, phone: q.customer.phone } : null });

exports.listQuotes = wrap(async (req, res) => {
  const p = paging(req);
  const statuses = req.query.status ? [req.query.status] : ['requested', 'quoted'];
  const { rows, count } = await Quote.findAndCountAll({ where: { status: { [Op.in]: statuses } }, include: quoteInclude, order: [['respondBy', 'ASC']], limit: p.limit, offset: p.offset, distinct: true });
  return res.json({ success: true, data: { quotes: rows.map(adminQuoteView), pagination: pageInfo(p, count) } });
});

exports.getQuote = wrap(async (req, res) => {
  const quote = await Quote.findByPk(req.params.id, { include: quoteInclude });
  if (!quote) return res.status(404).json({ success: false, message: 'Quote request not found' });
  const settings = await pricing.getSettings();
  return res.json({ success: true, data: { quote: adminQuoteView(quote), defaults: { quoteFeeRate: settings.quoteFeeRate, chefPayoutShare: settings.chefPayoutShare, validityHours: settings.quoteValidityHours } } });
});

exports.sendQuote = wrap(async (req, res) => {
  const { quote, calc } = await flows.buildQuote(req.params.id, req.body, req.admin);
  audit(req, 'quote_sent', 'Quote', quote.id, { next: { total: calc.total }, description: quote.reference });
  return res.json({ success: true, data: { quote: adminQuoteView(await Quote.findByPk(quote.id, { include: quoteInclude })), commission: calc.commission } });
});

// Dry run so the admin sees the total, chef payout and Homie's gross before sending.
exports.previewQuote = wrap(async (req, res) => {
  const settings = await pricing.getSettings();
  return res.json({ success: true, data: pricing.computeQuote(settings, req.body) });
});

exports.rejectQuote = wrap(async (req, res) => {
  const quote = await flows.rejectQuoteRequest(req.params.id, req.body.reason);
  audit(req, 'quote_declined', 'Quote', quote.id, { description: req.body.reason });
  return res.json({ success: true, data: { quote: adminQuoteView(await Quote.findByPk(quote.id, { include: quoteInclude })) } });
});

// -------------------------------------------------------------- procurement

exports.listProcurement = wrap(async (req, res) => {
  const where = { serviceLine: 'chef_ingredients', status: { [Op.notIn]: ['awaiting_payment', 'cancelled', 'declined', 'expired'] } };
  if (req.query.status) where.procurementStatus = req.query.status; else where.procurementStatus = { [Op.ne]: 'delivered' };
  const rows = await Booking.findAll({ where, include: bookingInclude, order: [['scheduledAt', 'ASC']], limit: 100 });
  return res.json({ success: true, data: { bookings: rows.map((b) => bookingView(b, 'admin')) } });
});

exports.updateProcurement = wrap(async (req, res) => {
  const booking = await flows.updateProcurement(req.params.id, req.body);
  audit(req, 'procurement_updated', 'Booking', booking.id, { next: { status: booking.procurementStatus, actualCost: num(booking.ingredientsActualCost) }, description: booking.reference });
  return res.json({ success: true, data: { booking: bookingView(await Booking.findByPk(booking.id, { include: bookingInclude }), 'admin') } });
});

// ------------------------------------------------------------------ chef KYC

const chefRow = (c, k) => ({
  chefId: c.id, name: c.displayName, email: c.member?.email, phone: c.member?.phone, avatarUrl: c.member?.avatarUrl, area: c.area, cuisines: c.cuisines,
  status: c.verificationStatus, tier: c.tier, submittedAt: k?.submittedAt || null, note: c.verificationNote,
});

exports.listChefKyc = wrap(async (req, res) => {
  const p = paging(req);
  const { rows, count } = await ChefProfile.findAndCountAll({
    where: { verificationStatus: req.query.status || 'pending' },
    include: [{ model: Member, as: 'member', attributes: ['email', 'phone', 'avatarUrl'] }, { model: ChefKyc, as: 'kyc', required: false }],
    order: [['updatedAt', 'ASC']], limit: p.limit, offset: p.offset, distinct: true,
  });
  return res.json({ success: true, data: { chefs: rows.map((c) => chefRow(c, c.kyc)), pagination: pageInfo(p, count) } });
});

const loadChef = async (id) => {
  const chef = await ChefProfile.findByPk(id, { include: [{ model: Member, as: 'member', attributes: ['email', 'phone', 'avatarUrl'] }] });
  if (!chef) throw Object.assign(new Error('Chef not found'), { status: 404 });
  return chef;
};

exports.getChefKyc = wrap(async (req, res) => {
  const chef = await loadChef(req.params.chefId);
  const view = await kyc.chefKycView(chef, { admin: true, sign });
  return res.json({ success: true, data: { chef: chefRow(chef), kyc: view, blockers: await kyc.blockers(chef) } });
});

const chefAction = (name, fn) => wrap(async (req, res) => {
  const chef = await loadChef(req.params.chefId);
  await fn(chef, req);
  audit(req, name, 'ChefProfile', chef.id, { next: req.body, description: req.body.note });
  const fresh = await loadChef(chef.id);
  return res.json({ success: true, data: { chef: chefRow(fresh), kyc: await kyc.chefKycView(fresh, { admin: true, sign }), blockers: await kyc.blockers(fresh) } });
});

exports.reviewChefItem = chefAction('chef_kyc_item_reviewed', (chef, req) => kyc.reviewItem(chef.id, req.params.item, req.body.status, req.body.note, req.admin.id));
exports.setBackgroundCheck = chefAction('chef_background_check', (chef, req) => kyc.setBackgroundCheck(chef.id, req.body.status, req.body.note));
exports.setPractical = chefAction('chef_practical_assessment', (chef, req) => kyc.setPracticalAssessment(chef.id, req.body));
exports.verifyChef = chefAction('chef_verified', (chef) => kyc.verifyChef(chef));
exports.approveChef = chefAction('chef_approved', async (chef, req) => kyc.approveChef(chef, req.body.tier, await pricing.getSettings()));
exports.rejectChef = chefAction('chef_rejected', (chef, req) => kyc.rejectChef(chef, req.body.note));
exports.suspendChef = chefAction('chef_suspended', (chef, req) => kyc.suspendChef(chef, req.body.note));
exports.reinstateChef = chefAction('chef_reinstated', (chef) => kyc.reinstateChef(chef));
exports.changeTier = chefAction('chef_tier_changed', async (chef, req) => {
  if (!pricing.TIERS.includes(req.body.tier)) throw Object.assign(new Error('Choose standard, premium or elite'), { status: 400 });
  const settings = await pricing.getSettings();
  await chef.update({ tier: req.body.tier, startingPrice: settings.tiers[req.body.tier].customerRate, startingUnit: 'hour' });
});

// -------------------------------------------------------------- customer KYC

exports.listCustomerKyc = wrap(async (req, res) => {
  const p = paging(req);
  const { rows, count } = await Member.findAndCountAll({
    where: { idSubmittedAt: { [Op.ne]: null }, idVerifiedAt: null }, order: [['idSubmittedAt', 'ASC']], limit: p.limit, offset: p.offset,
  });
  return res.json({
    success: true,
    data: {
      customers: rows.map((m) => ({
        id: m.id, name: memberName(m), email: m.email, phone: m.phone, dateOfBirth: m.dateOfBirth, address: m.address,
        idType: m.idType, idLast4: m.idLast4, idUrl: sign(m.idDocumentRef), submittedAt: m.idSubmittedAt, status: m.kycStatus,
      })),
      pagination: pageInfo(p, count),
    },
  });
});

exports.decideCustomerKyc = wrap(async (req, res) => {
  const { approve, note } = req.body;
  if (typeof approve !== 'boolean') return res.status(400).json({ success: false, message: 'approve must be true or false' });
  const member = await kyc.decideCustomerId(req.params.memberId, approve, note);
  audit(req, approve ? 'customer_id_verified' : 'customer_id_rejected', 'Member', member.id, { description: note });
  return res.json({ success: true, data: { status: member.kycStatus } });
});
