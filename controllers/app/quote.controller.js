const flows = require('../../services/bookingFlows.service');
const db = require('../../models');
const { bookingView } = require('../../utils/homieSerializers');

const { Quote, Booking, ChefProfile, Member, BookingPayment } = db;

const num = (v) => (v === null || v === undefined ? null : Number(v));

const quoteView = (q) => ({
  id: q.id, reference: q.reference, status: q.status, tier: q.tier, cuisine: q.cuisine, menuText: q.menuText, dishes: q.dishes,
  guests: q.guests, scheduledAt: q.scheduledAt, address: q.address, dietary: q.dietary, matchRequested: q.matchRequested,
  preferredChef: q.preferredChef ? { id: q.preferredChef.id, name: q.preferredChef.displayName } : null,
  respondBy: q.respondBy, quotedAt: q.quotedAt, validUntil: q.validUntil, bookingId: q.bookingId, createdAt: q.createdAt,
  quote: q.total === null ? null : {
    lineItems: q.lineItems, ingredientsAmount: num(q.ingredientsAmount), chefFee: num(q.chefFee), logisticsAmount: num(q.logisticsAmount),
    platformFee: num(q.platformFee), total: num(q.total), note: q.adminNote,
  },
  declineReason: q.declineReason,
});

const include = [{ model: ChefProfile, as: 'preferredChef', attributes: ['id', 'displayName'] }];

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
    console.error(`${req.method} ${req.originalUrl} error:`, error);
    return res.status(500).json({ success: false, message: 'Something went wrong' });
  }
};

exports.create = wrap(async (req, res) => {
  const quote = await flows.createQuoteRequest(req.member, req.body);
  return res.status(201).json({ success: true, data: { quote: quoteView(await Quote.findByPk(quote.id, { include })) } });
});

exports.list = wrap(async (req, res) => {
  const quotes = await Quote.findAll({ where: { customerId: req.member.id }, include, order: [['createdAt', 'DESC']], limit: 50 });
  return res.json({ success: true, data: { quotes: quotes.map(quoteView) } });
});

exports.get = wrap(async (req, res) => {
  const quote = await Quote.findOne({ where: { id: req.params.id, customerId: req.member.id }, include });
  if (!quote) return res.status(404).json({ success: false, message: 'Quotation not found' });
  return res.json({ success: true, data: { quote: quoteView(quote) } });
});

// Approving creates the booking (awaiting payment). The app then calls POST /bookings/:id/pay.
exports.approve = wrap(async (req, res) => {
  const { quote, booking } = await flows.approveQuote(req.member, req.params.id);
  const full = await Booking.findByPk(booking.id, {
    include: [{ model: ChefProfile, as: 'chef', include: [{ model: Member, as: 'member', attributes: ['id', 'avatarUrl'] }] }, { model: Member, as: 'hirer', attributes: ['id', 'firstName', 'lastName', 'avatarUrl'] }, { model: BookingPayment, as: 'payments', required: false }],
  });
  return res.json({ success: true, data: { quote: quoteView(await Quote.findByPk(quote.id, { include })), booking: bookingView(full, 'hirer') } });
});

exports.decline = wrap(async (req, res) => {
  const quote = await flows.declineQuote(req.member, req.params.id, req.body.reason);
  return res.json({ success: true, data: { quote: quoteView(await Quote.findByPk(quote.id, { include })) } });
});

exports.quoteView = quoteView;
