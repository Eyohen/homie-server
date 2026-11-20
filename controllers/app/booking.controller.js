const { Op } = require('sequelize');
const db = require('../../models');
const svc = require('../../services/booking.service');
const { bookingView } = require('../../utils/homieSerializers');

const { Booking, BookingPayment, ChefProfile, Member, BookingReview, Dispute } = db;

const include = [
  { model: ChefProfile, as: 'chef', include: [{ model: Member, as: 'member', attributes: ['id', 'avatarUrl'] }] },
  { model: Member, as: 'hirer', attributes: ['id', 'firstName', 'lastName', 'avatarUrl'] },
  { model: BookingPayment, as: 'payments', required: false },
  { model: BookingReview, as: 'review', required: false },
  { model: Dispute, as: 'disputes', required: false },
];

const ACTIVE = ['awaiting_payment', 'pending_chef', 'confirmed', 'in_progress', 'awaiting_approval', 'disputed'];

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}) });
    }
    console.error(`${req.method} ${req.originalUrl} error:`, error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};

// Resolve the caller's side of a booking: 'hirer', 'chef' or null.
const sideOf = async (req, booking) => {
  if (booking.hirerId === req.member.id) return 'hirer';
  const chef = await ChefProfile.findOne({ where: { memberId: req.member.id }, attributes: ['id'] });
  return chef && booking.chefId === chef.id ? 'chef' : null;
};

const reload = (id) => Booking.findByPk(id, { include });

exports.create = handle(async (req, res) => {
  const booking = await svc.createBooking(req.member, req.body);
  return res.status(201).json({ success: true, data: { booking: bookingView(await reload(booking.id), 'hirer') } });
});

exports.pay = handle(async (req, res) => {
  const booking = await Booking.findByPk(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  const payment = await svc.initializePayment(booking, req.member);
  return res.json({
    success: true,
    data: {
      reference: payment.paystackReference,
      authorizationUrl: payment.authorizationUrl,
      accessCode: payment.accessCode,
      amount: Number(payment.amount),
    },
  });
});

exports.verifyPayment = handle(async (req, res) => {
  const payment = await svc.verifyPayment(req.params.reference, req.member);
  const booking = await reload(payment.bookingId);
  return res.json({ success: true, data: { paid: ['held', 'released'].includes(payment.status), booking: bookingView(booking, 'hirer') } });
});

exports.list = handle(async (req, res) => {
  const as = req.query.as || req.member.activeRole;
  const where = {};
  if (as === 'chef') {
    const chef = await ChefProfile.findOne({ where: { memberId: req.member.id }, attributes: ['id'] });
    if (!chef) return res.json({ success: true, data: { bookings: [], pagination: { page: 1, limit: 0, total: 0, pages: 0 } } });
    where.chefId = chef.id;
    // Chefs never see bookings that have not been paid.
    where.status = { [Op.ne]: 'awaiting_payment' };
  } else {
    where.hirerId = req.member.id;
  }

  const { status } = req.query;
  if (status === 'active') where.status = { [Op.in]: ACTIVE.filter((s) => as !== 'chef' || s !== 'awaiting_payment') };
  else if (status === 'past') where.status = { [Op.in]: ['completed', 'cancelled', 'declined', 'expired'] };
  else if (status && Booking.STATUSES.includes(status)) where.status = status;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const { rows, count } = await Booking.findAndCountAll({
    where, include, order: [['scheduledAt', status === 'past' ? 'DESC' : 'ASC']], limit, offset: (page - 1) * limit, distinct: true,
  });
  return res.json({
    success: true,
    data: { bookings: rows.map((b) => bookingView(b, as === 'chef' ? 'chef' : 'hirer')), pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } },
  });
});

exports.get = handle(async (req, res) => {
  const booking = await reload(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  const side = await sideOf(req, booking);
  if (!side) return res.status(403).json({ success: false, message: 'Not your booking' });
  if (side === 'chef' && booking.status === 'awaiting_payment') return res.status(404).json({ success: false, message: 'Booking not found' });
  return res.json({ success: true, data: { booking: bookingView(booking, side) } });
});

const chefAction = (fn) => handle(async (req, res) => {
  const booking = await fn(req);
  return res.json({ success: true, data: { booking: bookingView(await reload(booking.id), 'chef') } });
});

const hirerAction = (fn) => handle(async (req, res) => {
  const booking = await fn(req);
  return res.json({ success: true, data: { booking: bookingView(await reload(booking.id), 'hirer') } });
});

exports.accept = chefAction((req) => svc.chefAccept(req.params.id, req.chef));
exports.decline = chefAction((req) => svc.chefDecline(req.params.id, req.chef, req.body.reason));
exports.checkIn = chefAction((req) => svc.chefCheckIn(req.params.id, req.chef));
exports.complete = chefAction((req) => svc.chefComplete(req.params.id, req.chef));
exports.approve = hirerAction((req) => svc.approveBooking(req.params.id, { hirerId: req.member.id }));

exports.cancel = handle(async (req, res) => {
  const chef = await ChefProfile.findOne({ where: { memberId: req.member.id }, attributes: ['id'] });
  const booking = await svc.cancelBooking(req.params.id, { member: req.member, chef, reason: req.body.reason });
  const full = await reload(booking.id);
  return res.json({ success: true, data: { booking: bookingView(full, full.hirerId === req.member.id ? 'hirer' : 'chef') } });
});

exports.report = handle(async (req, res) => {
  const { booking } = await svc.reportProblem(req.params.id, req.member, req.body.reason);
  return res.json({ success: true, data: { booking: bookingView(await reload(booking.id), 'hirer') } });
});

exports.review = handle(async (req, res) => {
  await svc.addReview(req.params.id, req.member, req.body);
  return res.status(201).json({ success: true, data: { booking: bookingView(await reload(req.params.id), 'hirer') } });
});
