// Business rules for the Homie marketplace. Override via environment where noted.
const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  // Share of every successful booking total that Homie keeps.
  COMMISSION_RATE: num(process.env.HOMIE_COMMISSION_RATE, 0.1),
  // Hours after the chef marks a job complete before escrow releases automatically.
  AUTO_RELEASE_HOURS: num(process.env.HOMIE_AUTO_RELEASE_HOURS, 48),
  // Unpaid bookings are expired after this many minutes.
  UNPAID_EXPIRY_MINUTES: num(process.env.HOMIE_UNPAID_EXPIRY_MINUTES, 120),
  // Paid bookings a chef has not accepted within this many hours are cancelled and refunded.
  CHEF_RESPONSE_HOURS: num(process.env.HOMIE_CHEF_RESPONSE_HOURS, 24),
  // "Match me" bookings nobody could be allocated to within this many hours are cancelled and refunded.
  ALLOCATION_DEADLINE_HOURS: num(process.env.HOMIE_ALLOCATION_DEADLINE_HOURS, 24),
  // Earliest a booking may be scheduled, in hours from now.
  MIN_LEAD_HOURS: num(process.env.HOMIE_MIN_LEAD_HOURS, 12),
  // Payouts or refunds above this naira amount need a second staff approval (enforced in admin API).
  DUAL_APPROVAL_THRESHOLD: num(process.env.HOMIE_DUAL_APPROVAL_THRESHOLD, 50000),
  OTP_TTL_MINUTES: 10,
  OTP_MAX_ATTEMPTS: 5,
  OTP_RESEND_SECONDS: 30,
  ACCESS_TOKEN_TTL: process.env.HOMIE_ACCESS_TOKEN_TTL || '1h',
  REFRESH_TOKEN_TTL_DAYS: 30,
};
