// Back-office API for the Homie admin dashboard (mounted at /api/admin-homie).
const { Op, QueryTypes } = require('sequelize');
const db = require('../models');
const svc = require('../services/booking.service');
const { notify } = require('../services/notify.service');
const cfg = require('../config/homie');
const { memberName, bookingView, num } = require('../utils/homieSerializers');

const { Member, ChefProfile, Booking, BookingPayment, Dispute, ChatMessage, ChatThread, PayoutAccount, AuditLog, BookingReview } = db;

const PAID_STATUSES = ['pending_chef', 'confirmed', 'in_progress', 'awaiting_approval', 'completed', 'disputed'];

const audit = (req, action, entity, entityId, { previous, next, description } = {}) =>
  AuditLog.create({
    adminId: req.admin.id, action, entity, entityId,
    previousData: previous || null, newData: next || null, description: description || null,
    ipAddress: req.ip, userAgent: req.headers['user-agent'] || null,
  }).catch((error) => console.error('audit log failed:', error.message));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
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

// ---------------------------------------------------------------- overview

exports.overview = wrap(async (req, res) => {
  const q = (sql, replacements) => db.sequelize.query(sql, { type: QueryTypes.SELECT, replacements });
  const paid = PAID_STATUSES.map((s) => `'${s}'`).join(',');

  const [money] = await q(`
    SELECT COALESCE(SUM(total),0) AS "bookingValue",
           COALESCE(SUM(total) FILTER (WHERE status = 'completed'),0) AS "completedValue",
           COALESCE(SUM(commission) FILTER (WHERE status = 'completed'),0) AS "revenue",
           COUNT(*) AS "paidBookings"
    FROM "Bookings" WHERE status IN (${paid})`);
  const [escrow] = await q(`SELECT COALESCE(SUM(amount),0) AS "held", COUNT(*) AS "count" FROM "BookingPayments" WHERE status = 'held'`);
  const [users] = await q(`
    SELECT COUNT(*) FILTER (WHERE status = 'active') AS "activeMembers",
           COUNT(*) FILTER (WHERE "isChef") AS "chefs",
           COUNT(*) FILTER (WHERE "createdAt" >= now() - interval '7 days') AS "newThisWeek"
    FROM "Members"`);
  const [disputes] = await q(`SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE status <> 'resolved') AS "open" FROM "Disputes"`);
  const weekly = await q(`
    SELECT date_trunc('week', "paidAt") AS week, COUNT(*) AS bookings, COALESCE(SUM(total),0) AS value
    FROM "Bookings" WHERE "paidAt" >= now() - interval '8 weeks' AND status IN (${paid})
    GROUP BY 1 ORDER BY 1`);
  const cuisines = await q(`
    SELECT c AS cuisine, COUNT(*) AS bookings
    FROM "Bookings" b JOIN "ChefProfiles" p ON p.id = b."chefId", unnest(p.cuisines) c
    WHERE b.status IN (${paid}) GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
  const pipeline = await q(`SELECT status, COUNT(*) AS count FROM "Bookings" GROUP BY status`);

  const [pendingVerifications, flagged, failedPayouts, refundsPending, waitingPayouts] = await Promise.all([
    ChefProfile.count({ where: { verificationStatus: 'pending' } }),
    ChatMessage.count({ where: { flagged: true, reviewedAt: null } }),
    BookingPayment.count({ where: { payoutStatus: 'failed' } }),
    BookingPayment.count({ where: { status: 'refund_pending' } }),
    BookingPayment.count({ where: { status: 'released', payoutStatus: 'pending' } }),
  ]);

  const paidBookings = Number(money.paidBookings);
  return res.json({
    success: true,
    data: {
      commissionRate: cfg.COMMISSION_RATE,
      bookingValue: Number(money.bookingValue),
      completedValue: Number(money.completedValue),
      revenue: Number(money.revenue),
      escrowHeld: Number(escrow.held),
      escrowCount: Number(escrow.count),
      members: { active: Number(users.activeMembers), chefs: Number(users.chefs), newThisWeek: Number(users.newThisWeek) },
      disputeRate: paidBookings ? Number(disputes.total) / paidBookings : 0,
      openDisputes: Number(disputes.open),
      weeklyBookings: weekly.map((w) => ({ week: w.week, bookings: Number(w.bookings), value: Number(w.value) })),
      topCuisines: cuisines.map((c) => ({ cuisine: c.cuisine, bookings: Number(c.bookings) })),
      pipeline: Object.fromEntries(pipeline.map((p) => [p.status, Number(p.count)])),
      needsAttention: {
        openDisputes: Number(disputes.open), pendingVerifications, flaggedMessages: flagged,
        failedPayouts, refundsPending, payoutsWaitingForAccount: waitingPayouts,
      },
    },
  });
});

// ------------------------------------------------------------------- users

const memberRow = (m) => ({
  id: m.id,
  name: memberName(m),
  phone: m.phone,
  email: m.email,
  status: m.status,
  suspendedReason: m.suspendedReason,
  activeRole: m.activeRole,
  isChef: m.isChef,
  chef: m.chefProfile ? {
    id: m.chefProfile.id, verificationStatus: m.chefProfile.verificationStatus, rating: num(m.chefProfile.ratingAvg),
    reviewCount: m.chefProfile.ratingCount, eventsCooked: m.chefProfile.eventsCooked, cuisines: m.chefProfile.cuisines,
  } : null,
  lastLoginAt: m.lastLoginAt,
  createdAt: m.createdAt,
});

exports.listUsers = wrap(async (req, res) => {
  const p = paging(req);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.type === 'chef') where.isChef = true;
  if (req.query.type === 'hirer') where.isChef = false;
  if (req.query.q) {
    const term = `%${String(req.query.q).replace(/[%_\\]/g, '\\$&')}%`;
    where[Op.or] = [
      { firstName: { [Op.iLike]: term } }, { lastName: { [Op.iLike]: term } },
      { phone: { [Op.iLike]: term } }, { email: { [Op.iLike]: term } },
    ];
  }
  const { rows, count } = await Member.findAndCountAll({
    where, include: [{ model: ChefProfile, as: 'chefProfile', required: false }],
    order: [['createdAt', 'DESC']], limit: p.limit, offset: p.offset, distinct: true,
  });
  return res.json({ success: true, data: { users: rows.map(memberRow), pagination: pageInfo(p, count) } });
});

exports.getUser = wrap(async (req, res) => {
  const member = await Member.findByPk(req.params.id, { include: [{ model: ChefProfile, as: 'chefProfile', required: false }] });
  if (!member) return res.status(404).json({ success: false, message: 'User not found' });

  const [asHirer, asChef, spend] = await Promise.all([
    Booking.count({ where: { hirerId: member.id, status: { [Op.in]: PAID_STATUSES } } }),
    member.chefProfile ? Booking.count({ where: { chefId: member.chefProfile.id, status: { [Op.in]: PAID_STATUSES } } }) : 0,
    Booking.sum('total', { where: { hirerId: member.id, status: 'completed' } }),
  ]);
  return res.json({
    success: true,
    data: { user: memberRow(member), stats: { bookingsAsHirer: asHirer, bookingsAsChef: asChef, hirerSpend: Number(spend || 0) } },
  });
});

exports.setUserStatus = wrap(async (req, res) => {
  const { status, reason } = req.body;
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ success: false, message: 'Status must be active or suspended' });
  if (status === 'suspended' && !String(reason || '').trim()) return res.status(400).json({ success: false, message: 'A reason is required to suspend a user' });

  const member = await Member.findByPk(req.params.id);
  if (!member) return res.status(404).json({ success: false, message: 'User not found' });
  const previous = member.status;
  await member.update({
    status, suspendedReason: status === 'suspended' ? String(reason).trim() : null,
    ...(status === 'suspended' ? { refreshTokenHash: null, pushToken: null } : {}),
  });
  audit(req, status === 'suspended' ? 'user_suspended' : 'user_activated', 'Member', member.id, { previous: { status: previous }, next: { status }, description: reason });
  return res.json({ success: true, data: { user: memberRow(member) } });
});

// ----------------------------------------------------------- verification

const verificationRow = (c) => ({
  chefId: c.id,
  name: c.displayName,
  phone: c.member?.phone,
  email: c.member?.email,
  avatarUrl: c.member?.avatarUrl,
  cuisines: c.cuisines,
  area: c.area,
  verificationStatus: c.verificationStatus,
  verificationNote: c.verificationNote,
  verificationData: c.verificationData,
  portfolio: c.portfolio,
  createdAt: c.createdAt,
});

exports.listVerifications = wrap(async (req, res) => {
  const p = paging(req);
  const { rows, count } = await ChefProfile.findAndCountAll({
    where: { verificationStatus: req.query.status || 'pending' },
    include: [{ model: Member, as: 'member', attributes: ['phone', 'email', 'avatarUrl'] }],
    order: [['updatedAt', 'ASC']], limit: p.limit, offset: p.offset,
  });
  return res.json({ success: true, data: { chefs: rows.map(verificationRow), pagination: pageInfo(p, count) } });
});

exports.decideVerification = wrap(async (req, res) => {
  const { approve, note } = req.body;
  if (typeof approve !== 'boolean') return res.status(400).json({ success: false, message: 'approve must be true or false' });
  if (!approve && !String(note || '').trim()) return res.status(400).json({ success: false, message: 'Tell the chef why they were rejected' });

  const chef = await ChefProfile.findByPk(req.params.chefId);
  if (!chef) return res.status(404).json({ success: false, message: 'Chef not found' });
  if (chef.verificationStatus !== 'pending') return res.status(409).json({ success: false, message: 'This chef has no pending verification' });

  await chef.update({
    verificationStatus: approve ? 'verified' : 'rejected', verificationNote: approve ? null : String(note).trim(), verifiedAt: approve ? new Date() : null,
  });
  audit(req, approve ? 'chef_verified' : 'chef_rejected', 'ChefProfile', chef.id, { next: { approve }, description: note });
  notify(chef.memberId, approve
    ? { type: 'verification', title: "You're verified", body: 'Hirers can now find and book you on Homie.' }
    : { type: 'verification', title: 'Verification needs attention', body: String(note).trim() });
  return res.json({ success: true, data: { chef: verificationRow(chef) } });
});

// ---------------------------------------------------------------- bookings

const bookingInclude = [
  { model: ChefProfile, as: 'chef', include: [{ model: Member, as: 'member', attributes: ['id', 'avatarUrl'] }] },
  { model: Member, as: 'hirer', attributes: ['id', 'firstName', 'lastName', 'avatarUrl'] },
  { model: BookingPayment, as: 'payments', required: false },
  { model: BookingReview, as: 'review', required: false },
  { model: Dispute, as: 'disputes', required: false },
];

exports.listBookings = wrap(async (req, res) => {
  const p = paging(req);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.q) where.reference = { [Op.iLike]: `%${String(req.query.q).replace(/[%_\\]/g, '\\$&')}%` };
  const { rows, count } = await Booking.findAndCountAll({
    where, include: bookingInclude, order: [['createdAt', 'DESC']], limit: p.limit, offset: p.offset, distinct: true,
  });
  return res.json({ success: true, data: { bookings: rows.map((b) => bookingView(b, 'admin')), pagination: pageInfo(p, count) } });
});

exports.getBooking = wrap(async (req, res) => {
  const booking = await Booking.findByPk(req.params.id, { include: bookingInclude });
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  return res.json({ success: true, data: { booking: bookingView(booking, 'admin'), payments: booking.payments } });
});

// ---------------------------------------------------------------- payments

exports.listPaymentIssues = wrap(async (req, res) => {
  const rows = await BookingPayment.findAll({
    where: {
      [Op.or]: [
        { status: 'refund_pending' },
        { payoutStatus: { [Op.in]: ['failed', 'pending'] }, status: 'released' },
        { status: 'released', refundAmount: { [Op.gt]: 0 }, refundedAt: null },
        { status: 'failed' },
      ],
    },
    include: [{ model: Booking, as: 'booking', attributes: ['id', 'reference', 'chefId', 'total', 'chefPayout'] }],
    order: [['updatedAt', 'DESC']], limit: 100,
  });
  return res.json({ success: true, data: { payments: rows } });
});

exports.retryPayout = wrap(async (req, res) => {
  const payment = await BookingPayment.findByPk(req.params.id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status !== 'released' || !['pending', 'failed'].includes(payment.payoutStatus)) {
    return res.status(409).json({ success: false, message: 'This payment has no payout to retry' });
  }
  const result = await svc.attemptPayout(payment.id);
  audit(req, 'payout_processed', 'BookingPayment', payment.id, { next: { payoutStatus: result.payoutStatus } });
  return res.json({ success: true, data: { payment: result } });
});

exports.retryRefund = wrap(async (req, res) => {
  const payment = await BookingPayment.findByPk(req.params.id, { include: [{ model: Booking, as: 'booking' }] });
  if (!payment || payment.status !== 'refund_pending') return res.status(409).json({ success: false, message: 'No pending refund on this payment' });
  const result = await svc.refundBooking(payment.booking, { amount: Number(payment.refundAmount) < Number(payment.amount) ? Number(payment.refundAmount) : undefined, reason: 'Retry by staff' });
  audit(req, 'refund_processed', 'BookingPayment', payment.id, { next: { status: result.status } });
  return res.json({ success: true, data: { payment: result } });
});

// ---------------------------------------------------------------- disputes

exports.listDisputes = wrap(async (req, res) => {
  const p = paging(req);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  else where.status = { [Op.ne]: 'resolved' };
  const { rows, count } = await Dispute.findAndCountAll({
    where,
    include: [
      { model: Booking, as: 'booking', include: bookingInclude },
      { model: Member, as: 'openedBy', attributes: ['id', 'firstName', 'lastName'] },
    ],
    order: [['createdAt', 'ASC']], limit: p.limit, offset: p.offset, distinct: true,
  });
  return res.json({
    success: true,
    data: {
      disputes: rows.map((d) => ({
        id: d.id, status: d.status, reason: d.reason, resolution: d.resolution, splitPercentToChef: d.splitPercentToChef,
        resolutionNote: d.resolutionNote, openedBy: memberName(d.openedBy), createdAt: d.createdAt, resolvedAt: d.resolvedAt,
        booking: bookingView(d.booking, 'admin'),
        requiresSecondApproval: Number(d.booking.total) > cfg.DUAL_APPROVAL_THRESHOLD,
        proposedResolution: d.proposedResolution, proposedByAdminId: d.proposedByAdminId,
      })),
      pagination: pageInfo(p, count),
    },
  });
});

exports.resolveDispute = wrap(async (req, res) => {
  const dispute = await Dispute.findByPk(req.params.id, { include: [{ model: Booking, as: 'booking', attributes: ['id', 'total', 'reference'] }] });
  if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' });
  if (dispute.status === 'resolved') return res.status(409).json({ success: false, message: 'Dispute already resolved' });

  // Large amounts need two different staff members: one proposes, another confirms the same outcome.
  if (Number(dispute.booking.total) > cfg.DUAL_APPROVAL_THRESHOLD) {
    const { resolution, splitPercentToChef, note } = req.body;
    if (!['release', 'refund', 'split'].includes(resolution)) {
      return res.status(400).json({ success: false, message: 'Resolution must be release, refund or split' });
    }
    const percent = resolution === 'split' ? parseInt(splitPercentToChef, 10) : null;
    if (resolution === 'split' && !(percent >= 0 && percent <= 100)) {
      return res.status(400).json({ success: false, message: 'Split percentage must be between 0 and 100' });
    }

    const proposal = dispute.proposedResolution;
    const sameOutcome = proposal && proposal.resolution === resolution && (proposal.splitPercentToChef ?? null) === percent;
    if (proposal && sameOutcome && dispute.proposedByAdminId === req.admin.id) {
      return res.status(403).json({ success: false, message: 'You proposed this outcome. A different staff member must approve it.' });
    }
    if (!proposal || !sameOutcome) {
      // First proposal, or a counter-proposal that replaces the previous one.
      await dispute.update({
        status: 'under_review', proposedResolution: { resolution, splitPercentToChef: percent, note: note || null },
        proposedByAdminId: req.admin.id, proposedAt: new Date(),
      });
      audit(req, 'dispute_resolution_proposed', 'Dispute', dispute.id, { next: { resolution, splitPercentToChef: percent }, description: note });
      return res.status(202).json({
        success: true,
        message: `Proposal saved. A different staff member must approve it because this booking is above ₦${cfg.DUAL_APPROVAL_THRESHOLD.toLocaleString('en-NG')}.`,
        data: { awaitingSecondApproval: true, proposal: dispute.proposedResolution },
      });
    }
  }

  const result = await svc.resolveDispute(req.params.id, req.body, req.admin);
  audit(req, 'dispute_resolved', 'Dispute', req.params.id, { next: req.body, description: req.body.note });
  return res.json({ success: true, data: { dispute: result.dispute, bookingStatus: result.booking.status } });
});

exports.markDisputeUnderReview = wrap(async (req, res) => {
  const dispute = await Dispute.findByPk(req.params.id);
  if (!dispute || dispute.status === 'resolved') return res.status(409).json({ success: false, message: 'Dispute not open' });
  await dispute.update({ status: 'under_review' });
  return res.json({ success: true, data: { dispute } });
});

// -------------------------------------------------------------- moderation

exports.listFlags = wrap(async (req, res) => {
  const p = paging(req);
  const where = { flagged: true, reviewedAt: req.query.reviewed === 'true' ? { [Op.ne]: null } : null };
  const { rows, count } = await ChatMessage.findAndCountAll({
    where,
    include: [
      { model: Member, as: 'sender', attributes: ['id', 'firstName', 'lastName', 'phone'] },
      { model: ChatThread, as: 'thread', attributes: ['id', 'hirerId', 'chefId'] },
    ],
    order: [['createdAt', 'DESC']], limit: p.limit, offset: p.offset,
  });
  return res.json({
    success: true,
    data: {
      flags: rows.map((m) => ({
        id: m.id, body: m.body, reason: m.flagReason, createdAt: m.createdAt, reviewedAt: m.reviewedAt,
        sender: { id: m.sender.id, name: memberName(m.sender), phone: m.sender.phone }, threadId: m.threadId,
      })),
      pagination: pageInfo(p, count),
    },
  });
});

exports.reviewFlag = wrap(async (req, res) => {
  const message = await ChatMessage.findByPk(req.params.id);
  if (!message || !message.flagged) return res.status(404).json({ success: false, message: 'Flag not found' });
  await message.update({ reviewedAt: new Date() });
  audit(req, 'message_reviewed', 'ChatMessage', message.id, { description: req.body.note });
  return res.json({ success: true });
});

// ------------------------------------------------------------ settings/audit

exports.settings = wrap(async (req, res) => res.json({
  success: true,
  data: {
    commissionRate: cfg.COMMISSION_RATE,
    autoReleaseHours: cfg.AUTO_RELEASE_HOURS,
    chefResponseHours: cfg.CHEF_RESPONSE_HOURS,
    unpaidExpiryMinutes: cfg.UNPAID_EXPIRY_MINUTES,
    minLeadHours: cfg.MIN_LEAD_HOURS,
    dualApprovalThreshold: cfg.DUAL_APPROVAL_THRESHOLD,
    note: 'Values are set via environment variables (HOMIE_*). Editing from the dashboard is not available yet.',
  },
}));

exports.auditLog = wrap(async (req, res) => {
  const p = paging(req);
  const { rows, count } = await AuditLog.findAndCountAll({
    include: [{ model: db.Admin, as: 'admin', attributes: ['id', 'firstName', 'lastName', 'role'] }],
    order: [['createdAt', 'DESC']], limit: p.limit, offset: p.offset,
  });
  return res.json({ success: true, data: { entries: rows, pagination: pageInfo(p, count) } });
});
