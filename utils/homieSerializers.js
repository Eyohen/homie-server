// Shapes returned to the mobile app. Field names mirror what the app's screens render.
const num = (v) => (v === null || v === undefined ? null : Number(v));

const memberName = (m) => [m?.firstName, m?.lastName].filter(Boolean).join(' ') || 'Homie member';

const memberPublic = (m) => ({
  id: m.id,
  firstName: m.firstName,
  lastName: m.lastName,
  name: memberName(m),
  phone: m.phone,
  email: m.email,
  avatarUrl: m.avatarUrl,
  activeRole: m.activeRole,
  isChef: m.isChef,
  address: m.address,
  lat: num(m.lat),
  lng: num(m.lng),
  needsProfile: !m.firstName,
  dateOfBirth: m.dateOfBirth,
  emailVerified: !!m.emailVerifiedAt,
  kycStatus: m.kycStatus,
  idVerified: !!m.idVerifiedAt,
});

const serviceView = (s) => ({
  id: s.id,
  title: s.title,
  desc: s.description,
  price: num(s.price),
  unit: s.unit,
  icon: s.icon,
});

const chefSummary = (chef, { distance, isFavorite } = {}) => ({
  id: chef.id,
  name: chef.displayName,
  avatarUrl: chef.member?.avatarUrl || null,
  coverUrl: chef.coverUrl,
  cuisines: chef.cuisines,
  tags: chef.tags,
  rating: num(chef.ratingAvg) || 0,
  reviewCount: chef.ratingCount,
  area: chef.area,
  distance: distance === undefined || distance === null ? null : Math.round(Number(distance) * 10) / 10,
  verified: chef.verificationStatus === 'approved',
  tier: chef.tier,
  years: chef.yearsExperience,
  events: chef.eventsCooked,
  reply: chef.replyTime,
  from: num(chef.startingPrice),
  unit: chef.startingUnit,
  available: chef.available,
  isFavorite: !!isFavorite,
});

const reviewView = (r) => ({
  id: r.id,
  name: r.hirer ? `${r.hirer.firstName || 'Homie'} ${(r.hirer.lastName || '').charAt(0)}.`.replace(' .', '') : 'Homie member',
  stars: r.rating,
  text: r.comment,
  createdAt: r.createdAt,
});

// Before a chef accepts, show only the area (last segment), never the street address.
const maskAddress = (address) => {
  const parts = String(address || '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : 'Full address shared once you accept';
};

// viewerRole: 'hirer' | 'chef' | 'admin'
const bookingView = (b, viewerRole = 'hirer') => {
  const payment = (b.payments || []).slice().sort((a, c) => new Date(c.createdAt) - new Date(a.createdAt))[0];
  const hideAddress = viewerRole === 'chef' && ['awaiting_payment', 'pending_chef', 'pending_allocation', 'scheduled'].includes(b.status);
  const view = {
    id: b.id,
    reference: b.reference,
    status: b.status,
    serviceLine: b.serviceLine,
    tier: b.tier,
    hours: b.serviceLine === 'chef_time' ? b.quantity : null,
    hourlyRate: b.serviceLine === 'chef_time' ? num(b.unitPrice) : null,
    serviceFee: num(b.serviceFee),
    ingredientsAmount: num(b.ingredientsAmount),
    logisticsAmount: num(b.logisticsAmount),
    platformFee: num(b.platformFee),
    lineItems: b.lineItems,
    recurrence: b.recurrence,
    series: b.seriesId ? { id: b.seriesId, index: b.seriesIndex, total: b.seriesTotal } : null,
    matchRequested: b.matchRequested,
    cuisine: b.cuisine,
    payByAt: b.payByAt,
    quoteId: b.quoteId,
    procurement: b.serviceLine === 'chef_ingredients' ? { status: b.procurementStatus, notes: viewerRole === 'admin' ? b.procurementNotes : undefined, actualCost: viewerRole === 'admin' ? num(b.ingredientsActualCost) : undefined } : null,
    service: { id: b.serviceId, title: b.serviceTitle, unit: b.serviceUnit },
    quantity: b.quantity,
    scheduledAt: b.scheduledAt,
    guests: b.guests,
    address: hideAddress ? maskAddress(b.address) : b.address,
    notes: b.notes,
    chefFee: num(b.chefFee),
    groceries: num(b.groceries),
    total: num(b.total),
    commissionRate: num(b.commissionRate),
    commission: num(b.commission),
    chefPayout: num(b.chefPayout),
    paidAt: b.paidAt,
    acceptedAt: b.acceptedAt,
    startedAt: b.startedAt,
    completedAt: b.completedAt,
    releasedAt: b.releasedAt,
    cancelledAt: b.cancelledAt,
    cancelReason: b.cancelReason,
    autoReleaseAt: b.autoReleaseAt,
    createdAt: b.createdAt,
  };
  if (b.chef) {
    view.chef = {
      id: b.chef.id,
      memberId: b.chef.memberId,
      name: b.chef.displayName,
      avatarUrl: b.chef.member?.avatarUrl || null,
      area: b.chef.area,
      verified: b.chef.verificationStatus === 'verified',
    };
  }
  if (b.hirer) view.hirer = { id: b.hirer.id, name: memberName(b.hirer), avatarUrl: b.hirer.avatarUrl };
  if (payment) {
    view.payment = {
      reference: payment.paystackReference,
      status: payment.status,
      payoutStatus: payment.payoutStatus,
      refundAmount: num(payment.refundAmount),
      ...(viewerRole === 'hirer' && payment.status === 'initialized' ? { authorizationUrl: payment.authorizationUrl } : {}),
    };
  }
  if (b.review) view.review = { id: b.review.id, rating: b.review.rating, comment: b.review.comment };
  view.reviewed = !!b.review;
  if (b.disputes?.length) {
    const d = b.disputes[0];
    view.dispute = { id: d.id, status: d.status, reason: d.reason, resolution: d.resolution };
  }
  return view;
};

module.exports = { memberPublic, memberName, chefSummary, serviceView, reviewView, bookingView, num };
