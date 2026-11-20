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
const BLOCKING_STATUSES = ['pending_chef', 'confirmed', 'in_progress', 'awaiting_approval', 'scheduled'];
const CHECKIN_WINDOW_HOURS = Number(process.env.HOMIE_CHECKIN_WINDOW_HOURS || 3);

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const toKobo = (n) => Math.round(Number(n) * 100);

const httpError = (status, message, code, details) => Object.assign(new Error(message), { status, code, details });

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

// An unpaid booking holds the calendar until its payment window closes: payByAt (series sessions) or a short default.
const freshUnpaid = () => ({
  status: 'awaiting_payment',
  [Op.or]: [{ payByAt: { [Op.gt]: new Date() } }, { payByAt: null, createdAt: { [Op.gte]: unpaidCutoff() } }],
});

// Bookings that currently hold a chef's calendar (paid/active ones, plus fresh unpaid ones).
const calendarBookingsWhere = (chefId, range) => ({
  chefId,
  scheduledAt: { [Op.gte]: range[0], [Op.lt]: range[1] },
  [Op.or]: [
    { status: { [Op.in]: BLOCKING_STATUSES } },
    freshUnpaid(),
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
        freshUnpaid(),
      ],
    },
    attributes: ['scheduledAt'],
  });
  const days = new Set(blocked.map((b) => b.date));
  bookings.forEach((b) => days.add(lagosDayKey(b.scheduledAt)));
  return [...days].sort();
};

// Booking creation (Chef Time, series, quotes, allocation) lives in bookingFlows.service.js.

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
      // "Match me" bookings wait for an admin to allocate a chef; later sessions of an accepted series are pre-accepted.
      const next = !booking.chefId ? 'pending_allocation' : booking.preAccepted ? 'confirmed' : 'pending_chef';
      await booking.update({ status: next, paidAt, ...(next === 'confirmed' ? { acceptedAt: new Date() } : {}) }, { transaction });
      if (next === 'pending_chef') notifyChefOf = booking;
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

  const total = Number(booking.total);
  const keptAmount = kept === undefined ? total : round2(kept);
  const share = total > 0 ? keptAmount / total : 0;
  const chefPayout = keptAmount === total ? Number(booking.chefPayout) : round2(Number(booking.chefPayout) * share);
  await payment.update({
    status: 'released', releasedAt: new Date(), payoutStatus: 'pending', payoutAmount: chefPayout,
  });
  if (keptAmount !== total) {
    // Dispute split: the chef's payout and Homie's gross shrink in proportion; ingredients are a pass-through cost.
    await booking.update({
      chefPayout, commission: round2(keptAmount - chefPayout - Number(booking.ingredientsAmount || 0) * share),
    });
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
    if (b.seriesId) {
      await Booking.update({ preAccepted: true }, {
        where: { seriesId: b.seriesId, id: { [Op.ne]: b.id }, status: { [Op.in]: ['scheduled', 'awaiting_payment'] } }, transaction: t,
      });
    }
  }).then((b) => {
    notify(b.hirerId, { type: 'booking_confirmed', title: 'Chef accepted your booking', body: `${b.serviceTitle} · ${b.reference}`, data: { bookingId: b.id } });
    return b;
  });

// Send an allocated booking (and the rest of its series) back to the allocation queue. The payment stays held.
const unallocateInTx = async (booking, transaction) => {
  await booking.update({ chefId: null, status: 'pending_allocation', allocatedAt: null, allocatedByAdminId: null, preAccepted: false }, { transaction });
  if (booking.seriesId) {
    await Booking.update({ chefId: null, preAccepted: false }, {
      where: { seriesId: booking.seriesId, id: { [Op.ne]: booking.id }, status: { [Op.in]: ['scheduled', 'awaiting_payment', 'pending_allocation'] } }, transaction,
    });
  }
};

// Cancel the remaining sessions of a series (refunding any that were already paid).
const cancelRestOfSeries = async (booking, reason) => {
  if (!booking.seriesId) return 0;
  const others = await Booking.findAll({
    where: { seriesId: booking.seriesId, id: { [Op.ne]: booking.id }, status: { [Op.in]: ['scheduled', 'awaiting_payment', 'pending_chef', 'pending_allocation', 'confirmed'] } },
  });
  for (const other of others) {
    await other.update({ status: 'cancelled', cancelledAt: new Date(), cancelReason: reason });
    await refundBooking(other, { reason });
  }
  return others.length;
};

const chefDecline = async (bookingId, chef, reason) => {
  const b = await transition(bookingId, async (booking, t) => {
    if (booking.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(booking, ['pending_chef'], 'This request can no longer be declined');
    if (booking.matchRequested) {
      await unallocateInTx(booking, t); // Homie picked this chef, so Homie finds another. No refund.
    } else {
      await booking.update({ status: 'declined', cancelledAt: new Date(), cancelReason: reason || 'Declined by chef' }, { transaction: t });
    }
  });
  if (b.matchRequested) {
    notify(b.hirerId, { type: 'booking_reassigned', title: "We're finding you another chef", body: `${b.reference} is back with our team. Your payment is safe.`, data: { bookingId: b.id } });
    return b;
  }
  await refundBooking(b, { reason: 'Chef declined' });
  await cancelRestOfSeries(b, 'Chef declined the series');
  notify(b.hirerId, { type: 'booking_declined', title: 'Booking declined', body: 'Your payment is being refunded in full.', data: { bookingId: b.id } });
  return b;
};

const chefCheckIn = (bookingId, chef) =>
  transition(bookingId, async (b, t) => {
    if (b.chefId !== chef.id) throw httpError(403, 'Not your booking');
    guard(b, ['confirmed'], 'Only confirmed bookings can be started');
    if (b.serviceLine === 'chef_ingredients' && b.procurementStatus !== 'delivered') {
      throw httpError(409, 'The ingredients have not been delivered yet', 'INGREDIENTS_PENDING');
    }
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

// Hirer or chef cancels before the service starts. Full refund. A chef cancelling a Homie-allocated booking
// returns it to the allocation queue instead (the hirer keeps their booking and payment).
const cancelBooking = async (bookingId, { member, chef, reason, wholeSeries = false }) => {
  let unallocated = false;
  const booking = await transition(bookingId, async (b, t) => {
    const isHirer = b.hirerId === member.id;
    const isChef = chef && b.chefId === chef.id;
    if (!isHirer && !isChef) throw httpError(403, 'Not your booking');
    guard(b, isHirer ? ['awaiting_payment', 'pending_chef', 'confirmed', 'scheduled', 'pending_allocation'] : ['confirmed'],
      'This booking can no longer be cancelled');
    if (!isHirer && b.matchRequested) {
      await unallocateInTx(b, t);
      unallocated = true;
      return;
    }
    await b.update({
      status: 'cancelled', cancelledAt: new Date(),
      cancelReason: reason || (isHirer ? 'Cancelled by hirer' : 'Cancelled by chef'),
    }, { transaction: t });
  });
  if (unallocated) {
    notify(booking.hirerId, { type: 'booking_reassigned', title: "We're finding you another chef", body: `${booking.reference} is back with our team.`, data: { bookingId: booking.id } });
    return booking;
  }
  await refundBooking(booking, { reason: booking.cancelReason });
  if (wholeSeries && booking.hirerId === member.id) await cancelRestOfSeries(booking, booking.cancelReason);
  const chefProfile = booking.chefId ? await ChefProfile.findByPk(booking.chefId) : null;
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
  const summary = { autoReleased: 0, expired: 0, chefTimeouts: 0, allocationExpired: 0, payoutsRetried: 0 };
  try {
    const due = await Booking.findAll({ where: { status: 'awaiting_approval', autoReleaseAt: { [Op.lte]: now } } });
    for (const booking of due) {
      try { await approveBooking(booking.id, { system: true }); summary.autoReleased += 1; } catch (e) { console.error('auto-release failed', booking.reference, e.message); }
    }

    const stale = await Booking.findAll({
      where: {
        status: 'awaiting_payment',
        [Op.or]: [{ payByAt: { [Op.lt]: now } }, { payByAt: null, createdAt: { [Op.lt]: unpaidCutoff() } }],
      },
    });
    for (const booking of stale) {
      await booking.update({ status: 'expired' });
      summary.expired += 1;
    }

    const cutoff = new Date(now.getTime() - cfg.CHEF_RESPONSE_HOURS * HOUR);
    const silent = await Booking.findAll({ where: { status: 'pending_chef', paidAt: { [Op.lt]: cutoff } } });
    for (const booking of silent) {
      try {
        if (booking.matchRequested) {
          // Homie allocated this chef and they did not answer: back to the queue, payment stays held.
          await transition(booking.id, async (b, t) => { if (b.status === 'pending_chef') await unallocateInTx(b, t); });
          summary.chefTimeouts += 1;
          continue;
        }
        await transition(booking.id, async (b, t) => {
          guard(b, ['pending_chef']);
          await b.update({ status: 'cancelled', cancelledAt: now, cancelReason: 'Chef did not respond in time' }, { transaction: t });
        });
        await refundBooking(booking, { reason: 'Chef did not respond' });
        notify(booking.hirerId, { type: 'booking_cancelled', title: 'Booking cancelled', body: 'The chef did not respond in time. You have been refunded.', data: { bookingId: booking.id } });
        summary.chefTimeouts += 1;
      } catch (e) { console.error('chef timeout failed', booking.reference, e.message); }
    }

    const allocationCutoff = new Date(now.getTime() - cfg.ALLOCATION_DEADLINE_HOURS * HOUR);
    const unmatched = await Booking.findAll({ where: { status: 'pending_allocation', paidAt: { [Op.lt]: allocationCutoff } } });
    for (const booking of unmatched) {
      try {
        await booking.update({ status: 'cancelled', cancelledAt: now, cancelReason: 'We could not find an available chef in time' });
        await refundBooking(booking, { reason: 'No chef available' });
        await cancelRestOfSeries(booking, 'We could not find an available chef in time');
        notify(booking.hirerId, { type: 'booking_cancelled', title: 'Booking cancelled', body: 'We could not find an available chef in time. You have been refunded.', data: { bookingId: booking.id } });
        summary.allocationExpired += 1;
      } catch (e) { console.error('allocation expiry failed', booking.reference, e.message); }
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
  generateReference,
  unallocateInTx,
  cancelRestOfSeries,
  transition,
  round2,
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
