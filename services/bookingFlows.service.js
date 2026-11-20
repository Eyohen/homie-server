// Booking flows for the managed-marketplace model: Chef Time (hourly, optional weekly/monthly series),
// "Match me" allocation, Chef + Ingredients quotations and ingredient procurement.
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../models');
const bookingSvc = require('./booking.service');
const pricing = require('./pricing.service');
const kyc = require('./kyc.service');
const { notify } = require('./notify.service');
const cfg = require('../config/homie');

const { Booking, ChefProfile, Member, Quote } = db;
const { httpError } = bookingSvc;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_HOURS = 12;

// ------------------------------------------------------------ chef time

// Same weekday every week, or same day of month (clamped to the month's last day) every month.
const occurrenceDates = (first, recurrence, sessions) => {
  const dates = [new Date(first)];
  for (let i = 1; i < sessions; i += 1) {
    const d = new Date(first);
    if (recurrence === 'weekly') {
      d.setUTCDate(d.getUTCDate() + 7 * i);
    } else {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + i);
      const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, lastDay));
    }
    dates.push(d);
  }
  return dates;
};

const parseChefTimeInput = (settings, input) => {
  const hours = parseInt(input.hours, 10);
  if (!(hours >= settings.minHours)) throw httpError(400, `The minimum booking is ${settings.minHours} hours`);
  if (hours > MAX_HOURS) throw httpError(400, `A single booking can be at most ${MAX_HOURS} hours`);
  const recurrence = input.recurrence || 'once';
  if (!['once', 'weekly', 'monthly'].includes(recurrence)) throw httpError(400, 'Recurrence must be once, weekly or monthly');
  let sessions = 1;
  if (recurrence !== 'once') {
    sessions = parseInt(input.sessions, 10);
    if (!(sessions >= 2 && sessions <= settings.maxRecurringSessions)) {
      throw httpError(400, `A recurring booking needs between 2 and ${settings.maxRecurringSessions} sessions`);
    }
  }
  return { hours, recurrence, sessions };
};

const resolveTier = async (input) => {
  if (input.chefId) {
    const chef = await ChefProfile.findByPk(input.chefId);
    if (!chef) throw httpError(404, 'Chef not found');
    return { chef, tier: chef.tier };
  }
  if (!pricing.TIERS.includes(input.tier)) throw httpError(400, 'Choose a chef tier: standard, premium or elite');
  return { chef: null, tier: input.tier };
};

// Price breakdown for the booking screen. Does not create anything.
const previewChefTime = async (input) => {
  const settings = await pricing.getSettings();
  const { hours, recurrence, sessions } = parseChefTimeInput(settings, input);
  const { tier } = await resolveTier(input);
  const perSession = pricing.computeChefTime(settings, { tier, hours });
  return {
    perSession, recurrence, sessions,
    seriesTotal: pricing.round2(perSession.total * sessions),
    minHours: settings.minHours,
  };
};

const createChefTimeBooking = async (member, input) => {
  const settings = await pricing.getSettings();
  const { hours, recurrence, sessions } = parseChefTimeInput(settings, input);
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw httpError(400, 'A valid date and time is required');
  if (scheduledAt.getTime() < Date.now() + cfg.MIN_LEAD_HOURS * HOUR) {
    throw httpError(400, `Bookings must be made at least ${cfg.MIN_LEAD_HOURS} hours ahead`);
  }
  const address = String(input.address || '').trim();
  if (address.length < 6) throw httpError(400, 'A full address is required');

  const { chef, tier } = await resolveTier(input);
  if (chef) {
    if (chef.memberId === member.id) throw httpError(400, 'You cannot book yourself');
    if (chef.verificationStatus !== 'approved') throw httpError(400, 'This chef is not available for booking');
    if (!chef.available) throw httpError(400, 'This chef is not taking bookings right now');
  }

  const price = pricing.computeChefTime(settings, { tier, hours });
  await kyc.assertCanBook(member, price.total, settings);

  const dates = occurrenceDates(scheduledAt, recurrence, sessions);
  const seriesId = sessions > 1 ? crypto.randomUUID() : null;
  const guests = Math.max(1, Math.min(parseInt(input.guests, 10) || 1, 500));

  return db.sequelize.transaction(async (transaction) => {
    if (chef) {
      // Serialise bookings for this chef, then check every session date.
      await ChefProfile.findByPk(chef.id, { transaction, lock: transaction.LOCK.UPDATE });
      for (const d of dates) {
        // eslint-disable-next-line no-await-in-loop
        if (await bookingSvc.isDateTaken(chef.id, d, { transaction })) {
          throw httpError(409, `The chef is not available on ${bookingSvc.lagosDayKey(d)}`, 'DATE_UNAVAILABLE', { date: bookingSvc.lagosDayKey(d) });
        }
      }
    }
    const created = [];
    for (const [i, when] of dates.entries()) {
      // eslint-disable-next-line no-await-in-loop
      created.push(await Booking.create({
        reference: await bookingSvc.generateReference(),
        hirerId: member.id, chefId: chef ? chef.id : null, serviceId: null,
        serviceLine: 'chef_time', serviceTitle: 'Chef Time', serviceUnit: 'hour',
        unitPrice: price.hourlyRate, quantity: hours, tier,
        scheduledAt: when, guests, address, notes: input.notes ? String(input.notes).trim() : null, cuisine: input.cuisine || null,
        chefFee: price.chefFee, serviceFee: price.serviceFee, groceries: 0, total: price.total,
        commissionRate: price.commissionRate, commission: price.commission, chefPayout: price.chefPayout,
        lineItems: [
          { type: 'chef', label: `${hours} h × ${tier} chef`, amount: price.chefFee },
          { type: 'service', label: 'Service fee', amount: price.serviceFee },
        ],
        recurrence, seriesId, seriesIndex: i + 1, seriesTotal: sessions, matchRequested: !chef,
        status: i === 0 ? 'awaiting_payment' : 'scheduled',
        payByAt: i === 0 ? null : new Date(when.getTime() - 12 * HOUR),
      }, { transaction }));
    }
    return { booking: created[0], series: created };
  });
};

// ------------------------------------------------------------ allocation

// Chefs an admin can allocate to a "Match me" booking: approved, available, same tier, free on every session date.
const candidatesFor = async (booking) => {
  const sessions = booking.seriesId
    ? await Booking.findAll({ where: { seriesId: booking.seriesId, status: { [Op.in]: ['scheduled', 'awaiting_payment', 'pending_allocation'] } } })
    : [booking];
  const chefs = await ChefProfile.findAll({
    where: { verificationStatus: 'approved', available: true, tier: booking.tier, memberId: { [Op.ne]: booking.hirerId } },
    include: [{ model: Member, as: 'member', attributes: ['avatarUrl', 'status'], where: { status: 'active' } }],
  });
  const out = [];
  for (const chef of chefs) {
    let free = true;
    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      if (await bookingSvc.isDateTaken(chef.id, s.scheduledAt, { excludeBookingId: s.id })) { free = false; break; }
    }
    if (!free) continue;
    out.push({
      id: chef.id, name: chef.displayName, avatarUrl: chef.member?.avatarUrl || null, tier: chef.tier, area: chef.area,
      cuisines: chef.cuisines, rating: Number(chef.ratingAvg) || 0, reviewCount: chef.ratingCount, eventsCooked: chef.eventsCooked,
      cuisineMatch: booking.cuisine ? chef.cuisines.includes(booking.cuisine) : null,
    });
  }
  return out.sort((a, b) => (b.cuisineMatch === true) - (a.cuisineMatch === true) || b.rating - a.rating);
};

const allocate = async (bookingId, chefId, admin) => {
  const result = await db.sequelize.transaction(async (transaction) => {
    const booking = await Booking.findByPk(bookingId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!booking) throw httpError(404, 'Booking not found');
    if (booking.status !== 'pending_allocation') throw httpError(409, 'This booking is not waiting for a chef', 'INVALID_STATE');
    const chef = await ChefProfile.findByPk(chefId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!chef || chef.verificationStatus !== 'approved' || !chef.available) throw httpError(400, 'That chef cannot take bookings right now');
    if (chef.tier !== booking.tier) throw httpError(409, `This booking was priced for a ${booking.tier} chef`, 'TIER_MISMATCH');
    if (chef.memberId === booking.hirerId) throw httpError(400, 'A chef cannot be allocated to their own booking');

    const sessions = booking.seriesId
      ? await Booking.findAll({ where: { seriesId: booking.seriesId, status: { [Op.in]: ['scheduled', 'awaiting_payment', 'pending_allocation'] } }, transaction })
      : [booking];
    for (const s of sessions) {
      // eslint-disable-next-line no-await-in-loop
      if (await bookingSvc.isDateTaken(chef.id, s.scheduledAt, { excludeBookingId: s.id, transaction })) {
        throw httpError(409, `${chef.displayName} is not free on ${bookingSvc.lagosDayKey(s.scheduledAt)}`, 'DATE_UNAVAILABLE');
      }
    }
    await Booking.update({ chefId: chef.id }, { where: { id: { [Op.in]: sessions.map((s) => s.id) } }, transaction });
    await booking.update({ chefId: chef.id, status: 'pending_chef', allocatedAt: new Date(), allocatedByAdminId: admin.id }, { transaction });
    return { booking, chef };
  });

  notify(result.chef.memberId, {
    type: 'booking_request', title: 'New booking for you', body: `${result.booking.serviceTitle} · ${result.booking.reference}`, data: { bookingId: result.booking.id },
  });
  notify(result.booking.hirerId, {
    type: 'booking_allocated', title: 'We found your chef', body: `${result.chef.displayName} has been matched to ${result.booking.reference}.`, data: { bookingId: result.booking.id },
  });
  return result.booking;
};

// ------------------------------------------------------------ quotes

const generateQuoteReference = async () => {
  for (let i = 0; i < 10; i += 1) {
    const reference = `QT-${crypto.randomInt(10000, 99999)}`;
    // eslint-disable-next-line no-await-in-loop
    if (!(await Quote.count({ where: { reference } }))) return reference;
  }
  return `QT-${Date.now().toString().slice(-7)}`;
};

const createQuoteRequest = async (member, input) => {
  const settings = await pricing.getSettings();
  const menuText = String(input.menuText || '').trim();
  if (menuText.length < 10) throw httpError(400, 'Tell us what you would like cooked (at least a short description)');
  const scheduledAt = new Date(input.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) throw httpError(400, 'A valid date and time is required');
  if (scheduledAt.getTime() < Date.now() + Math.max(cfg.MIN_LEAD_HOURS, 24) * HOUR) {
    throw httpError(400, 'Chef + Ingredients bookings need at least 24 hours notice so we can source ingredients');
  }
  const address = String(input.address || '').trim();
  if (address.length < 6) throw httpError(400, 'A full address is required');
  const { chef, tier } = await resolveTier({ chefId: input.chefId, tier: input.tier || 'standard' });
  if (chef && (chef.verificationStatus !== 'approved' || !chef.available || chef.memberId === member.id)) throw httpError(400, 'This chef is not available for booking');
  await kyc.assertCanBook(member, 0, settings); // profile basics now; the ID threshold applies when the quote is approved

  return Quote.create({
    reference: await generateQuoteReference(), customerId: member.id, preferredChefId: chef ? chef.id : null, matchRequested: !chef, tier,
    cuisine: input.cuisine || null, menuText,
    dishes: Array.isArray(input.dishes) ? input.dishes.map((d) => String(d).trim()).filter(Boolean).slice(0, 30) : [],
    guests: Math.max(1, Math.min(parseInt(input.guests, 10) || 1, 500)), scheduledAt, address,
    dietary: input.dietary ? String(input.dietary).trim() : null,
    status: 'requested', respondBy: new Date(Date.now() + settings.quoteSlaHours * HOUR),
  });
};

const buildQuote = async (quoteId, input, admin) => {
  const settings = await pricing.getSettings();
  const quote = await Quote.findByPk(quoteId);
  if (!quote) throw httpError(404, 'Quote request not found');
  if (!['requested', 'quoted'].includes(quote.status)) throw httpError(409, `This request is ${quote.status}`, 'INVALID_STATE');
  const chefFee = Number(input.chefFee);
  if (!(chefFee > 0)) throw httpError(400, 'Enter the chef fee');
  if (!(Number(input.ingredientsAmount) >= 0)) throw httpError(400, 'Enter the ingredients amount (0 if none)');
  const calc = pricing.computeQuote(settings, input);
  const validityHours = Math.max(1, Math.min(parseInt(input.validityHours, 10) || settings.quoteValidityHours, 168));
  const validUntil = new Date(Math.min(Date.now() + validityHours * HOUR, new Date(quote.scheduledAt).getTime() - 6 * HOUR));
  if (validUntil <= new Date()) throw httpError(400, 'The event is too close to send a quotation');

  await quote.update({
    status: 'quoted', quotedAt: new Date(), validUntil, quotedByAdminId: admin.id, adminNote: input.note ? String(input.note).trim() : null,
    lineItems: calc.lineItems, ingredientsAmount: calc.ingredientsAmount, chefFee: calc.chefFee, logisticsAmount: calc.logisticsAmount,
    platformFee: calc.platformFee, total: calc.total, chefPayout: calc.chefPayout,
  });
  notify(quote.customerId, { type: 'quote_ready', title: 'Your quotation is ready', body: `${quote.reference}: ₦${calc.total.toLocaleString('en-NG')}. Review and approve it to book.`, data: { quoteId: quote.id } });
  return { quote, calc };
};

const rejectQuoteRequest = async (quoteId, reason) => {
  const quote = await Quote.findByPk(quoteId);
  if (!quote) throw httpError(404, 'Quote request not found');
  if (!['requested', 'quoted'].includes(quote.status)) throw httpError(409, `This request is ${quote.status}`, 'INVALID_STATE');
  if (!String(reason || '').trim()) throw httpError(400, 'Tell the customer why we cannot quote this');
  await quote.update({ status: 'declined', declineReason: String(reason).trim() });
  notify(quote.customerId, { type: 'quote_declined', title: "We couldn't quote this request", body: String(reason).trim(), data: { quoteId: quote.id } });
  return quote;
};

// The customer approves a quotation: it becomes a booking awaiting payment.
const approveQuote = async (member, quoteId) => {
  const settings = await pricing.getSettings();
  const result = await db.sequelize.transaction(async (transaction) => {
    const quote = await Quote.findByPk(quoteId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!quote || quote.customerId !== member.id) throw httpError(404, 'Quotation not found');
    if (quote.status !== 'quoted') throw httpError(409, quote.status === 'approved' ? 'You already approved this quotation' : `This quotation is ${quote.status}`, 'INVALID_STATE');
    if (new Date(quote.validUntil) < new Date()) {
      await quote.update({ status: 'expired' }, { transaction });
      throw httpError(409, 'This quotation has expired. Ask us to quote again.', 'QUOTE_EXPIRED');
    }
    if (new Date(quote.scheduledAt).getTime() < Date.now() + cfg.MIN_LEAD_HOURS * HOUR) throw httpError(409, 'The event date is too close to book');
    await kyc.assertCanBook(member, Number(quote.total), settings);

    let chef = null;
    if (quote.preferredChefId) {
      chef = await ChefProfile.findByPk(quote.preferredChefId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!chef || chef.verificationStatus !== 'approved' || !chef.available) throw httpError(409, 'Your preferred chef is no longer available. Ask us to re-quote with another chef.', 'CHEF_UNAVAILABLE');
      if (await bookingSvc.isDateTaken(chef.id, quote.scheduledAt, { transaction })) throw httpError(409, 'Your preferred chef is already booked on that date', 'DATE_UNAVAILABLE');
    }
    const commission = pricing.round2(Number(quote.total) - Number(quote.chefPayout) - Number(quote.ingredientsAmount));
    const booking = await Booking.create({
      reference: await bookingSvc.generateReference(), hirerId: member.id, chefId: chef ? chef.id : null, serviceId: null,
      serviceLine: 'chef_ingredients', serviceTitle: 'Chef + Ingredients', serviceUnit: 'event', unitPrice: quote.chefFee, quantity: 1, tier: quote.tier,
      scheduledAt: quote.scheduledAt, guests: quote.guests, address: quote.address,
      notes: [quote.menuText, quote.dietary ? `Dietary: ${quote.dietary}` : null].filter(Boolean).join('\n'), cuisine: quote.cuisine,
      chefFee: quote.chefFee, serviceFee: 0, groceries: 0, ingredientsAmount: quote.ingredientsAmount, logisticsAmount: quote.logisticsAmount,
      platformFee: quote.platformFee, total: quote.total, commission, chefPayout: quote.chefPayout,
      commissionRate: Number(quote.total) ? pricing.round2((commission / Number(quote.total)) * 10000) / 10000 : 0,
      lineItems: quote.lineItems, matchRequested: !chef, quoteId: quote.id, procurementStatus: 'pending', status: 'awaiting_payment',
    }, { transaction });
    await quote.update({ status: 'approved', approvedAt: new Date(), bookingId: booking.id }, { transaction });
    return { quote, booking };
  });
  return result;
};

const declineQuote = async (member, quoteId, reason) => {
  const quote = await Quote.findByPk(quoteId);
  if (!quote || quote.customerId !== member.id) throw httpError(404, 'Quotation not found');
  if (!['requested', 'quoted'].includes(quote.status)) throw httpError(409, `This quotation is ${quote.status}`, 'INVALID_STATE');
  await quote.update({ status: quote.status === 'requested' ? 'cancelled' : 'declined', declineReason: reason ? String(reason).trim() : null });
  return quote;
};

// ------------------------------------------------------------ procurement

const PROCUREMENT_STATES = ['pending', 'purchasing', 'purchased', 'delivered'];

const updateProcurement = async (bookingId, input) => {
  const booking = await Booking.findByPk(bookingId);
  if (!booking) throw httpError(404, 'Booking not found');
  if (booking.serviceLine !== 'chef_ingredients') throw httpError(400, 'This booking does not include ingredients');
  if (['awaiting_payment', 'cancelled', 'declined', 'expired'].includes(booking.status)) throw httpError(409, 'This booking is not active');
  const patch = {};
  if (input.status !== undefined) {
    if (!PROCUREMENT_STATES.includes(input.status)) throw httpError(400, `Status must be one of: ${PROCUREMENT_STATES.join(', ')}`);
    patch.procurementStatus = input.status;
  }
  if (input.notes !== undefined) patch.procurementNotes = String(input.notes).trim() || null;
  if (input.actualCost !== undefined) {
    const cost = Number(input.actualCost);
    if (!(cost >= 0)) throw httpError(400, 'Actual cost must be a positive number');
    patch.ingredientsActualCost = cost;
  }
  if (Array.isArray(input.receipts)) patch.procurementReceipts = input.receipts.map(String).slice(0, 20);
  await booking.update(patch);

  if (patch.procurementStatus === 'purchased') {
    notify(booking.hirerId, { type: 'procurement', title: 'Ingredients purchased', body: `${booking.reference}: we have bought your ingredients.`, data: { bookingId: booking.id } });
  }
  if (patch.procurementStatus === 'delivered') {
    notify(booking.hirerId, { type: 'procurement', title: 'Ingredients delivered', body: `${booking.reference}: your ingredients are ready for the chef.`, data: { bookingId: booking.id } });
    const chef = booking.chefId ? await ChefProfile.findByPk(booking.chefId) : null;
    if (chef) notify(chef.memberId, { type: 'procurement', title: 'Ingredients delivered', body: `${booking.reference}: you can check in when you arrive.`, data: { bookingId: booking.id } });
  }
  return booking;
};

// ------------------------------------------------------------ jobs

// Later sessions of a series become payable 72 hours before they start.
const activateDueOccurrences = async () => {
  const now = new Date();
  const due = await Booking.findAll({ where: { status: 'scheduled', scheduledAt: { [Op.lte]: new Date(now.getTime() + 72 * HOUR) } } });
  let activated = 0;
  for (const b of due) {
    const payBy = new Date(new Date(b.scheduledAt).getTime() - 12 * HOUR);
    if (payBy <= now) {
      await b.update({ status: 'expired', cancelReason: 'Not paid in time' });
      continue;
    }
    await b.update({ status: 'awaiting_payment', payByAt: payBy });
    notify(b.hirerId, { type: 'payment_due', title: 'Pay for your upcoming session', body: `${b.reference} is coming up. Pay before ${payBy.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} to keep it.`, data: { bookingId: b.id } });
    activated += 1;
  }
  return activated;
};

const expireQuotes = async () => {
  const [count] = await Quote.update({ status: 'expired' }, { where: { status: 'quoted', validUntil: { [Op.lt]: new Date() } } });
  return count;
};

const runScheduledJobs = async () => {
  const summary = await bookingSvc.runScheduledJobs();
  try {
    summary.occurrencesActivated = await activateDueOccurrences();
    summary.quotesExpired = await expireQuotes();
  } catch (error) {
    console.error('Flow jobs error:', error);
  }
  return summary;
};

module.exports = {
  occurrenceDates, previewChefTime, createChefTimeBooking, candidatesFor, allocate,
  createQuoteRequest, buildQuote, rejectQuoteRequest, approveQuote, declineQuote,
  updateProcurement, PROCUREMENT_STATES, activateDueOccurrences, expireQuotes, runScheduledJobs, DAY,
};
