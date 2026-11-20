const db = require('../models');

const { PricingSetting } = db;

const TIERS = ['standard', 'premium', 'elite'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let cache = null;

const normalize = (row) => ({
  tiers: row.tiers,
  minHours: Number(row.minHours),
  serviceFeeRate: Number(row.serviceFeeRate),
  quoteFeeRate: Number(row.quoteFeeRate),
  chefPayoutShare: Number(row.chefPayoutShare),
  idRequiredAbove: Number(row.idRequiredAbove),
  maxRecurringSessions: Number(row.maxRecurringSessions),
  quoteSlaHours: Number(row.quoteSlaHours),
  quoteValidityHours: Number(row.quoteValidityHours),
});

// Commercial rules live in the PricingSettings row (editable by admins). Cached briefly.
const getSettings = async ({ fresh = false } = {}) => {
  if (!fresh && cache && Date.now() - cache.at < 30 * 1000) return cache.value;
  const row = await PricingSetting.findByPk(1);
  if (!row) throw Object.assign(new Error('Pricing settings are not configured'), { status: 500 });
  cache = { at: Date.now(), value: normalize(row) };
  return cache.value;
};

const invalidate = () => { cache = null; };

// Chef Time: total = hours x customer rate + service fee (% of the chef fee).
// The chef is paid hours x the tier's payout rate; Homie's gross contribution is the difference.
const computeChefTime = (settings, { tier, hours }) => {
  const rates = settings.tiers[tier];
  if (!rates) throw Object.assign(new Error('Unknown chef tier'), { status: 400 });
  const chefFee = round2(rates.customerRate * hours);
  const serviceFee = round2(chefFee * settings.serviceFeeRate);
  const total = round2(chefFee + serviceFee);
  const chefPayout = round2(rates.chefPayout * hours);
  const commission = round2(total - chefPayout);
  return {
    tier, hours, hourlyRate: rates.customerRate, chefHourlyPayout: rates.chefPayout,
    chefFee, serviceFee, total, chefPayout, commission, commissionRate: total ? round2((commission / total) * 10000) / 10000 : 0,
  };
};

// Chef + Ingredients quotation. Ingredients are a pass-through cost, so they are excluded from Homie's gross.
// Defaults: platform fee = quoteFeeRate of the subtotal, chef payout = chefPayoutShare of the chef fee.
const computeQuote = (settings, input) => {
  const ingredientsAmount = round2(input.ingredientsAmount || 0);
  const chefFee = round2(input.chefFee || 0);
  const logisticsAmount = round2(input.logisticsAmount || 0);
  const subtotal = ingredientsAmount + chefFee + logisticsAmount;
  const platformFee = input.platformFee === undefined || input.platformFee === null || input.platformFee === ''
    ? round2(subtotal * settings.quoteFeeRate) : round2(input.platformFee);
  const chefPayout = input.chefPayout === undefined || input.chefPayout === null || input.chefPayout === ''
    ? round2(chefFee * settings.chefPayoutShare) : round2(input.chefPayout);
  const total = round2(subtotal + platformFee);
  const commission = round2(total - chefPayout - ingredientsAmount);
  const lineItems = [
    { type: 'ingredients', label: 'Ingredients', amount: ingredientsAmount },
    { type: 'chef', label: 'Chef service fee', amount: chefFee },
    { type: 'logistics', label: 'Logistics', amount: logisticsAmount },
    { type: 'platform', label: 'Homie platform fee', amount: platformFee },
  ].filter((item) => item.amount > 0);
  return { ingredientsAmount, chefFee, logisticsAmount, platformFee, total, chefPayout, commission, lineItems };
};

const publicConfig = (settings) => ({
  tiers: Object.fromEntries(TIERS.map((t) => [t, { customerRate: settings.tiers[t].customerRate }])),
  minHours: settings.minHours,
  serviceFeeRate: settings.serviceFeeRate,
  maxRecurringSessions: settings.maxRecurringSessions,
  quoteSlaHours: settings.quoteSlaHours,
  idRequiredAbove: settings.idRequiredAbove,
});

module.exports = { TIERS, getSettings, invalidate, computeChefTime, computeQuote, publicConfig, round2 };
