const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const paystack = require('./paystack.service');
const { notify } = require('./notify.service');
const cfg = require('../config/homie');

const { Booking, BookingPayment, ChefProfile, ChefService, ChefBlockedDate, Member, Dispute, BookingReview, PayoutAccount } = db;

const HOUR = 60 * 60 * 1000;
const LAGOS_OFFSET_MS = HOUR; // Africa/Lagos is UTC+1 all year
// Statuses that occupy a chef's calendar day.
const BLOCKING_STATUSES = ['pending_chef', 'confirmed', 'in_progress', 'awaiting_approval'];
const CHECKIN_WINDOW_HOURS = Number(process.env.HOMIE_CHECKIN_WINDOW_HOURS || 3);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toKobo = (n) => Math.round(Number(n) * 100);

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// ---------------------------------------------------------------- pricing

// Commission is taken from the booking total; the chef receives the rest.
const computePricing = ({ unitPrice, quantity = 1, groceries = 0, rate = cfg.COMMISSION_RATE }) => {
  const chefFee = round2(Number(unitPrice) * quantity);
  const grocery = round2(groceries);
  const total = round2(chefFee + grocery);
  const commission = round2(total * rate);
  return { chefFee, groceries: grocery, total, commissionRate: rate, commission, chefPayout: round2(total - commission) };
};

const generateReference = async () => {
  for (let i = 0; i < 10; i += 1) {
    const reference = `HM-${crypto.randomInt(10000, 99999)}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await Booking.count({ where: { reference } });
    if (!exists) return reference;
  }
  return `HM-${Date.now().toString().slice(-7)}`;
};

// ------------------------------------------------------------ availability

const lagosDayKey = (date) => new Date(new Date(date).getTime() + LAGOS_OFFSET_MS).toISOString().slice(0, 10);

const lagosDayRange = (date) => {
  const key = lagosDayKey(date);
  const start = new Date(`${key}T00:00:00.000Z`).getTime() - LAGOS_OFFSET_MS;
  return [new Date(start), new Date(start + 24 * HOUR)];
};

const unpaidCutoff = () => new Date(Date.now() - cfg.UNPAID_EXPIRY_MINUTES * 60 * 1000);

// Bookings that currently hold a chef's calendar (paid/active ones, plus fresh unpaid ones).
const calendarBookingsWhere = (chefId, range) => ({
  chefId,
  scheduledAt: { [Op.gte]: range[0], [Op.lt]: range[1] },
  [Op.or]: [
    { status: { [Op.in]: BLOCKING_STATUSES } },
    { status: 'awaiting_payment', createdAt: { [Op.gte]: unpaidCutoff() } },
  ],
});

const isDateTaken = async (chefId, date, { excludeBookingId, transaction } = {}) => {
  const blocked = await ChefBlockedDate.count({ where: { chefId, date: lagosDayKey(date) }, transaction });
  if (blocked) return true;
  const where = calendarBookingsWhere(chefId, lagosDayRange(date));
  if (excludeBookingId) where.id = { [Op.ne]: excludeBookingId };
  return (await Booking.count({ where, transaction })) > 0;
};

// Unavailable day keys (YYYY-MM-DD, Lagos time) for a chef between two dates.
const unavailableDays = async (chefId, from, to) => {
  const fromKey = lagosDayKey(from);
  const toKey = lagosDayKey(to);
  const blocked = await ChefBlockedDate.findAll({
    where: { chefId, date: { [Op.between]: [fromKey, toKey] } },
    attributes: ['date'],
  });
  const range = [lagosDayRange(from)[0], lagosDayRange(to)[1]];
  const bookings = await Booking.findAll({
    where: {
      chefId,
      scheduledAt: { [Op.gte]: range[0], [Op.lt]: range[1] },
      [Op.or]: [
        { status: { [Op.in]: BLOCKING_STATUSES } },
        { status: 'awaiting_payment', createdAt: { [Op.gte]: unpaidCutoff() } },
      ],
    },
    attributes: ['scheduledAt'],
  });
  const days = new Set(blocked.map((b) => b.date));
  bookings.forEach((b) => days.add(lagosDayKey(b.scheduledAt)));
  return [...days].sort();
};

// ---------------------------------------------------------- booking create

const createBooking = async (member, input) => {
  const { chefId, serviceId, address, notes } = input;
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw httpError(400, 'A valid date and time is required');
  if (scheduledAt.getTime() < Date.now() + cfg.MIN_LEAD_HOURS * HOUR) {
    throw httpError(400, `Bookings must be made at least ${cfg.MIN_LEAD_HOURS} hours ahead`);
  }

  const chef = await ChefProfile.findByPk(chefId);
  if (!chef) throw httpError(404, 'Chef not found');
  if (chef.memberId === member.id) throw httpError(400, 'You cannot book yourself');
  if (chef.verificationStatus !== 'verified') throw httpError(400, 'This chef is not verified yet');
  if (!chef.available) throw httpError(400, 'This chef is not taking bookings right now');

  const service = await ChefService.findOne({ where: { id: serviceId, chefId: chef.id, active: true } });
  if (!service) throw httpError(404, 'Service not found for this chef');

  let quantity = Math.max(1, parseInt(input.quantity, 10) || 1);
  if (service.unit === 'hour') quantity = Math.max(3, parseInt(input.quantity, 10) || 3);
  else if (service.unit === 'dish') quantity = Math.min(quantity, 50);
  else quantity = 1;

  const guests = Math.max(1, Math.min(parseInt(input.guests, 10) || 1, 500));
  const groceries = Math.max(0, Math.min(Number(input.groceries) || 0, 5000000));
  const pricing = computePricing({ unitPrice: service.price, quantity, groceries });

  return db.sequelize.transaction(async (transaction) => {
    // Serialise bookings for this chef so two hirers cannot take the same day.
    await ChefProfile.findByPk(chef.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (await isDateTaken(chef.id, scheduledAt, { transaction })) {
      throw httpError(409, 'The chef is not available on that date', 'DATE_UNAVAILABLE');
    }
    return Booking.create({
      reference: await generateReference(),
      hirerId: member.id,
      chefId: chef.id,
      serviceId: service.id,
      serviceTitle: service.title,
      serviceUnit: service.unit,
      unitPrice: service.price,
      quantity,
      scheduledAt,
      guests,
      address: String(address || '').trim(),
      notes: notes ? String(notes).trim() : null,
      ...pricing,
      status: 'awaiting_payment',
    }, { transaction });
  });
};

// ----------------------------------------------------------------- payment

const payerEmail = (member) =>
  member.email || `${String(member.phone || member.id).replace(/\D/g, '')}@pay.homie.app`;

const initializePayment = async (booking, member) => {
  if (booking.hirerId !== member.id) throw httpError(403, 'Not your booking');
  if (booking.status !== 'awaiting_payment') throw httpError(400, 'This booking is not awaiting payment');
  if (await BookingPayment.count({ where: { bookingId: booking.id, status: { [Op.in]: ['held', 'released'] } } })) {
    throw httpError(400, 'This booking is already paid');
  }

  const reference = `homie-${booking.reference.toLowerCase()}-${Date.now().toString(36)}`;
  const callbackUrl = process.env.PAYSTACK_CALLBACK_URL || `${process.env.CLIENT_URL || 'https://homie.app'}/payment-complete`;
  let init;
  try {
    init = await paystack.initializeTransaction({
      email: payerEmail(member),
      amount: toKobo(booking.total),
      reference,
      callback_url: callbackUrl,
      metadata: { bookingId: booking.id, bookingReference: booking.reference, hirerId: member.id },
    });
  } catch (error) {
    throw httpError(502, 'We could not start the payment. Please try again in a moment.', 'PAYMENT_INIT_FAILED');
  }

  return BookingPayment.create({
    bookingId: booking.id,
    paystackReference: init.reference || reference,
    accessCode: init.access_code,
    authorizationUrl: init.authorization_url,
    amount: booking.total,
    status: 'initialized',
  });
};

// Idempotent: safe to call from both the webhook and the client verify endpoint.
const confirmPayment = async (reference, gatewayData) => {
  let notifyChefOf = null;
  let refundAfter = null;

  const payment = await db.sequelize.transaction(async (transaction) => {
    const record = await BookingPayment.findOne({
      where: { paystackReference: reference }, transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!record) return null;
    if (!['initialized', 'failed'].includes(record.status)) return record;

    if (toKobo(record.amount) !== Number(gatewayData.amount)) {
      await record.update({ status: 'failed', gatewayResponse: gatewayData, payoutError: 'Paid amount did not match booking total' }, { transaction });
      return record;
    }

    const paidAt = gatewayData.paid_at ? new Date(gatewayData.paid_at) : new Date();
    await record.update({ status: 'held', paidAt, channel: gatewayData.channel || null, gatewayResponse: gatewayData }, { transaction });

    const booking = await Booking.findByPk(record.bookingId, { transaction, lock: transaction.LOCK.UPDATE });
    if (booking.status === 'awaiting_payment') {
      await booking.update({ status: 'pending_chef', paidAt }, { transaction });
      notifyChefOf = booking;
    } else {
      // Paid after the booking expired or was cancelled: money must go back to the hirer.
      refundAfter = booking;
    }
    return record;
  });

  if (notifyChefOf) {
    const chef = await ChefProfile.findByPk(notifyChefOf.chefId);
    if (chef) {
      notify(chef.memberId, {
        type: 'booking_request',
        title: 'New booking request',
        body: `${notifyChefOf.serviceTitle} · ${notifyChefOf.reference}`,
        data: { bookingId: notifyChefOf.id },
      });
    }
  }
  if (refundAfter) await refundBooking(refundAfter, { reason: 'Booking no longer available' });
  return payment;
};

const verifyPayment = async (reference, member) => {
  const payment = await BookingPayment.findOne({ where: { paystackReference: reference }, include: [{ model: Booking, as: 'booking' }] });
  if (!payment) throw httpError(404, 'Payment not found');
  if (payment.booking.hirerId !== member.id) throw httpError(403, 'Not your payment');
  if (payment.status !== 'initialized' && payment.status !== 'failed') return payment;

  const data = await paystack.verifyTransaction(reference);
  if (data.status === 'success') return confirmPayment(reference, data);
  return payment;
};

// ------------------------------------------------------ escrow: release/refund

const latestPayment = (bookingId, statuses) =>
  BookingPayment.findOne({
    where: { bookingId, ...(statuses ? { status: { [Op.in]: statuses } } : {}) },
    order: [['createdAt', 'DESC']],
  });

// Attempt (or retry) the Paystack transfer that pays the chef. Never throws.
const attemptPayout = async (paymentId) => {
  const payment = await BookingPayment.findByPk(paymentId, { include: [{ model: Booking, as: 'booking' }] });
  if (!payment || payment.status !== 'released' || !['pending', 'failed'].includes(payment.payoutStatus)) return payment;

  try {
    const account = await PayoutAccount.findOne({ where: { chefId: payment.booking.chefId } });
    if (!account) {
      await payment.update({ payoutStatus: 'pending', payoutError: 'Chef has no payout account yet' });
      return payment;
    }
    if (!account.recipientCode) {
      const recipient = await paystack.createTransferRecipient({
        name: account.accountName, accountNumber: account.accountNumber, bankCode: account.bankCode,
      });
      await account.update({ recipientCode: recipient.recipient_code });
    }
    const reference = `homie-po-${payment.id}`;
    const transfer = await paystack.initiateTransfer({
      amount: toKobo(payment.payoutAmount),
      recipientCode: account.recipientCode,
      reason: `Homie booking ${payment.booking.reference}`,
      reference,
    });
    await payment.update({
      payoutStatus: transfer.status === 'success' ? 'paid' : 'processing',
      payoutReference: transfer.reference || reference,
      payoutError: null,
    });
  } catch (error) {
    await payment.update({ payoutStatus: 'failed', payoutError: error.message });
  }
  return payment;
};

// Move held funds to the chef. `kept` is what remains after any hirer refund (defaults to the full total).
const releaseEscrow = async (booking, { kept } = {}) => {
  const payment = await latestPayment(booking.id, ['held']);
  if (!payment) return null;

  const keptAmount = kept === undefined ? Number(booking.total) : round2(kept);
  const pricing = computePricing({ unitPrice: keptAmount, quantity: 1, groceries: 0, rate: Number(booking.commissionRate) });
  await payment.update({
    status: 'released', releasedAt: new Date(), payoutStatus: 'pending', payoutAmount: pricing.chefPayout,
  });
  if (pricing.total !== Number(booking.total)) {
    await booking.update({ commission: pricing.commission, chefPayout: pricing.chefPayout });
  }
  attemptPayout(payment.id);
  return payment;
};

// Return held funds to the hirer (full refund when amount is omitted). Never throws.
const refundBooking = async (booking, { amount, reason } = {}) => {
  const payment = await latestPayment(booking.id, ['held', 'refund_pending']);
  if (!payment) return null;

  const refundAmount = amount === undefined ? Number(payment.amount) : round2(amount);
  const partial = refundAmount < Number(payment.amount);
  await payment.update({ status: 'refund_pending', refundAmount });
  try {
    await paystack.refundTransaction({
      transaction: payment.paystackReference,
      amount: partial ? toKobo(refundAmount) : undefined,
      reason,
    });
    await payment.update({
      status: partial ? 'partially_refunded' : 'refunded', refundedAt: new Date(), payoutError: null,
    });
  } catch (error) {
    // Stays refund_pending so staff can retry from the admin dashboard.
    await payment.update({ payoutError: `Refund failed: ${error.message}` });
  }
  return payment;
};

// ------------------------------------------------------------- transitions

const loadForUpdate = (id, transaction) =>
  Booking.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });

const guard = (booking, allowed, message) => {
  if (!allowed.includes(booking.status)) {
    throw httpError(409, message || `Booking is ${booking.status.replace('_', ' ')}`, 'INVALID_STATE');
  }
};

const transition = async (bookingId, fn) =>
  db.sequelize.transaction(async (transaction) => {
    const booking = await loadForUpdate(bookingId, transaction);
    if (!booking) throw httpError(404, 'Booking not found');
    await fn(booking, transaction);
    return booking;
  });

const chefAccept = (bookingId, chef) =>
  transition(bookingId, async (b, t) => {
    if (b.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(b, ['pending_chef'], 'This request can no longer be accepted');
    await b.update({ status: 'confirmed', acceptedAt: new Date() }, { transaction: t });
  }).then((b) => {
    notify(b.hirerId, { type: 'booking_confirmed', title: 'Chef accepted your booking', body: `${b.serviceTitle} · ${b.reference}`, data: { bookingId: b.id } });
    return b;
  });

const chefDecline = async (bookingId, chef, reason) => {
  const b = await transition(bookingId, async (booking, t) => {
    if (booking.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(booking, ['pending_chef'], 'This request can no longer be declined');
    await booking.update({ status: 'declined', cancelledAt: new Date(), cancelReason: reason || 'Declined by chef' }, { transaction: t });
  });
  await refundBooking(b, { reason: 'Chef declined' });
  notify(b.hirerId, { type: 'booking_declined', title: 'Booking declined', body: 'Your payment is being refunded in full.', data: { bookingId: b.id } });
  return b;
};

const chefCheckIn = (bookingId, chef) =>
  transition(bookingId, async (b, t) => {
    if (b.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(b, ['confirmed'], 'Only confirmed bookings can be started');
    if (Date.now() < new Date(b.scheduledAt).getTime() - CHECKIN_WINDOW_HOURS * HOUR) {
      throw httpError(400, `You can check in up to ${CHECKIN_WINDOW_HOURS} hours before the booking`, 'TOO_EARLY');
    }
    await b.update({ status: 'in_progress', startedAt: new Date() }, { transaction: t });
  }).then((b) => {
    notify(b.hirerId, { type: 'booking_started', title: 'Your chef has arrived', body: b.reference, data: { bookingId: b.id } });
    return b;
  });

const chefComplete = (bookingId, chef) =>
  transition(bookingId, async (b, t) => {
    if (b.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(b, ['in_progress'], 'Only bookings in progress can be completed');
    const now = new Date();
    await b.update({
      status: 'awaiting_approval', completedAt: now, autoReleaseAt: new Date(now.getTime() + cfg.AUTO_RELEASE_HOURS * HOUR),
    }, { transaction: t });
  }).then((b) => {
    notify(b.hirerId, {
      type: 'approval_needed', title: 'Approve & release payment',
      body: `${b.reference} is complete. Payment auto-releases in ${cfg.AUTO_RELEASE_HOURS} hours.`, data: { bookingId: b.id },
    });
    return b;
  });

// Shared by the hirer's approval and the auto-release job.
const approveBooking = async (bookingId, { hirerId, system = false } = {}) => {
  const booking = await transition(bookingId, async (b, t) => {
    if (!system && b.hirerId !== hirerId) throw httpError(403, 'Not your booking');
    guard(b, ['awaiting_approval'], 'This booking is not awaiting approval');
    const now = new Date();
    await b.update({ status: 'completed', approvedAt: now, releasedAt: now }, { transaction: t });
    await ChefProfile.increment('eventsCooked', { by: 1, where: { id: b.chefId }, transaction: t });
  });
  await releaseEscrow(booking);
  const chef = await ChefProfile.findByPk(booking.chefId);
  if (chef) {
    notify(chef.memberId, {
      type: 'payment_released', title: 'Payment released',
      body: `₦${Number(booking.chefPayout).toLocaleString('en-NG')} for ${booking.reference} is on its way.`, data: { bookingId: booking.id },
    });
  }
  return booking;
};

// Hirer or chef cancels before the service starts. Full refund.
const cancelBooking = async (bookingId, { member, chef, reason }) => {
  const booking = await transition(bookingId, async (b, t) => {
    const isHirer = b.hirerId === member.id;
    const isChef = chef && b.chefId === chef.id;
    if (!isHirer && !isChef) throw httpError(403, 'Not your booking');
    guard(b, isHirer ? ['awaiting_payment', 'pending_chef', 'confirmed'] : ['confirmed'],
      'This booking can no longer be cancelled');
    await b.update({
      status: 'cancelled', cancelledAt: new Date(),
      cancelReason: reason || (isHirer ? 'Cancelled by hirer' : 'Cancelled by chef'),
    }, { transaction: t });
  });
  await refundBooking(booking, { reason: booking.cancelReason });
  const chefProfile = await ChefProfile.findByPk(booking.chefId);
  const other = booking.hirerId === member.id ? chefProfile?.memberId : booking.hirerId;
  if (other) {
    notify(other, { type: 'booking_cancelled', title: 'Booking cancelled', body: booking.reference, data: { bookingId: booking.id } });
  }
  return booking;
};

const reportProblem = async (bookingId, member, reason) => {
  if (!reason || String(reason).trim().length < 5) throw httpError(400, 'Please describe the problem');
  let dispute;
  const booking = await transition(bookingId, async (b, t) => {
    if (b.hirerId !== member.id) throw httpError(403, 'Not your booking');
    guard(b, ['awaiting_approval'], 'You can only report a problem on a completed service awaiting approval');
    await b.update({ status: 'disputed', autoReleaseAt: null }, { transaction: t });
    dispute = await Dispute.create({ bookingId: b.id, openedById: member.id, reason: String(reason).trim() }, { transaction: t });
  });
  const chef = await ChefProfile.findByPk(booking.chefId);
  if (chef) {
    notify(chef.memberId, { type: 'dispute_opened', title: 'A problem was reported', body: `${booking.reference} is under review. Payment is on hold.`, data: { bookingId: booking.id } });
  }
  return { booking, dispute };
};

const addReview = async (bookingId, member, { rating, comment }) => {
  const stars = parseInt(rating, 10);
  if (!(stars >= 1 && stars <= 5)) throw httpError(400, 'Rating must be between 1 and 5');

  return db.sequelize.transaction(async (transaction) => {
    const booking = await loadForUpdate(bookingId, transaction);
    if (!booking) throw httpError(404, 'Booking not found');
    if (booking.hirerId !== member.id) throw httpError(403, 'Not your booking');
    guard(booking, ['completed'], 'You can review a booking once it is completed');
    if (await BookingReview.count({ where: { bookingId }, transaction })) throw httpError(409, 'You already reviewed this booking');

    const review = await BookingReview.create({
      bookingId, hirerId: member.id, chefId: booking.chefId, rating: stars, comment: comment ? String(comment).trim() : null,
    }, { transaction });

    const stats = await BookingReview.findOne({
      where: { chefId: booking.chefId },
      attributes: [
        [db.sequelize.fn('AVG', db.sequelize.col('rating')), 'avg'],
        [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count'],
      ],
      raw: true,
      transaction,
    });
    await ChefProfile.update(
      { ratingAvg: round2(stats.avg), ratingCount: Number(stats.count) },
      { where: { id: booking.chefId }, transaction }
    );
    return review;
  });
};

// ----------------------------------------------------------- dispute (admin)

// resolution: 'release' (chef gets paid), 'refund' (hirer refunded) or 'split' with percent to chef.
const resolveDispute = async (disputeId, { resolution, splitPercentToChef, note }, admin) => {
  if (!['release', 'refund', 'split'].includes(resolution)) throw httpError(400, 'Resolution must be release, refund or split');
  let percent = resolution === 'release' ? 100 : resolution === 'refund' ? 0 : parseInt(splitPercentToChef, 10);
  if (!(percent >= 0 && percent <= 100)) throw httpError(400, 'Split percentage must be between 0 and 100');

  const dispute = await Dispute.findByPk(disputeId);
  if (!dispute) throw httpError(404, 'Dispute not found');
  if (dispute.status === 'resolved') throw httpError(409, 'Dispute already resolved');

  const booking = await Booking.findByPk(dispute.bookingId);
  if (booking.status !== 'disputed') throw httpError(409, 'Booking is not in dispute');

  const total = Number(booking.total);
  const refundAmount = round2((total * (100 - percent)) / 100);
  const kept = round2(total - refundAmount);

  const payment = await latestPayment(booking.id, ['held']);
  if (!payment) throw httpError(409, 'No escrowed payment found for this booking');

  if (kept <= 0) {
    await refundBooking(booking, { reason: 'Dispute resolution' });
  } else {
    // Chef share is released first. Any hirer refund is tracked on the same payment row:
    // refundAmount > 0 with refundedAt empty means the refund still needs a retry.
    await releaseEscrow(booking, { kept });
    if (refundAmount > 0) {
      await payment.update({ refundAmount });
      try {
        await paystack.refundTransaction({
          transaction: payment.paystackReference, amount: toKobo(refundAmount), reason: 'Dispute resolution',
        });
        await payment.update({ refundedAt: new Date() });
      } catch (error) {
        await payment.update({ payoutError: `Refund failed: ${error.message}` });
      }
    }
  }

  await booking.update({
    status: kept > 0 ? 'completed' : 'cancelled',
    ...(kept > 0 ? { releasedAt: new Date() } : { cancelledAt: new Date(), cancelReason: 'Refunded after dispute' }),
  });
  await dispute.update({
    status: 'resolved', resolution, splitPercentToChef: percent, resolutionNote: note || null,
    resolvedByAdminId: admin.id, resolvedAt: new Date(),
  });

  const chef = await ChefProfile.findByPk(booking.chefId);
  const body = `Resolution for ${booking.reference}: ${resolution === 'split' ? `${percent}% to the chef` : resolution}.`;
  notify(booking.hirerId, { type: 'dispute_resolved', title: 'Dispute resolved', body, data: { bookingId: booking.id } });
  if (chef) notify(chef.memberId, { type: 'dispute_resolved', title: 'Dispute resolved', body, data: { bookingId: booking.id } });
  return { dispute, booking };
};

// -------------------------------------------------------------------- jobs

const runScheduledJobs = async () => {
  const now = new Date();
  const summary = { autoReleased: 0, expired: 0, chefTimeouts: 0, payoutsRetried: 0 };
  try {
    const due = await Booking.findAll({ where: { status: 'awaiting_approval', autoReleaseAt: { [Op.lte]: now } } });
    for (const booking of due) {
      try { await approveBooking(booking.id, { system: true }); summary.autoReleased += 1; } catch (e) { console.error('auto-release failed', booking.reference, e.message); }
    }

    const stale = await Booking.findAll({ where: { status: 'awaiting_payment', createdAt: { [Op.lt]: unpaidCutoff() } } });
    for (const booking of stale) {
      await booking.update({ status: 'expired' });
      summary.expired += 1;
    }

    const cutoff = new Date(now.getTime() - cfg.CHEF_RESPONSE_HOURS * HOUR);
    const silent = await Booking.findAll({ where: { status: 'pending_chef', paidAt: { [Op.lt]: cutoff } } });
    for (const booking of silent) {
      try {
        await transition(booking.id, async (b, t) => {
          guard(b, ['pending_chef']);
          await b.update({ status: 'cancelled', cancelledAt: now, cancelReason: 'Chef did not respond in time' }, { transaction: t });
        });
        await refundBooking(booking, { reason: 'Chef did not respond' });
        notify(booking.hirerId, { type: 'booking_cancelled', title: 'Booking cancelled', body: 'The chef did not respond in time. You have been refunded.', data: { bookingId: booking.id } });
        summary.chefTimeouts += 1;
      } catch (e) { console.error('chef timeout failed', booking.reference, e.message); }
    }

    const waiting = await BookingPayment.findAll({ where: { status: 'released', payoutStatus: 'pending' }, limit: 50 });
    for (const payment of waiting) {
      await attemptPayout(payment.id);
      summary.payoutsRetried += 1;
    }
  } catch (error) {
    console.error('Scheduled jobs error:', error);
  }
  return summary;
};

module.exports = {
  BLOCKING_STATUSES,
  computePricing,
  isDateTaken,
  unavailableDays,
  lagosDayKey,
  createBooking,
  initializePayment,
  confirmPayment,
  verifyPayment,
  attemptPayout,
  releaseEscrow,
  refundBooking,
  chefAccept,
  chefDecline,
  chefCheckIn,
  chefComplete,
  approveBooking,
  cancelBooking,
  reportProblem,
  addReview,
  resolveDispute,
  runScheduledJobs,
  httpError,
  toKobo,
};
