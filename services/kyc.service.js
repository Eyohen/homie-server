const db = require('../models');
const { notify } = require('./notify.service');

const { Member, ChefProfile, ChefKyc, PayoutAccount } = db;

const httpError = (status, message, code, details) => Object.assign(new Error(message), { status, code, details });

const ID_TYPES = ['NIN', 'Passport', "Driver's licence"];
// Chef documents an admin reviews one by one.
const REVIEW_ITEMS = ['idDocument', 'photo', 'cv', 'foodSafety', 'references'];

const ageOn = (dob, now = new Date()) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
};

const isValidDob = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

// A private document reference must live in the member's own KYC folder.
const ownRef = (member, ref) => typeof ref === 'string' && ref.startsWith(`homie/kyc/${member.id}/`) && ref.length < 300;

// ------------------------------------------------------------- customers

// Lightweight KYC: everything a customer needs before their first booking.
const customerBasics = (member) => {
  const missing = [];
  if (!member.firstName || !member.lastName) missing.push('full name');
  // Phone verification needs an SMS provider; until then email is the verified contact (set HOMIE_REQUIRE_PHONE=true to enforce).
  if (process.env.HOMIE_REQUIRE_PHONE === 'true' && !member.phone) missing.push('verified phone number');
  if (!member.email || !member.emailVerifiedAt) missing.push('verified email');
  if (!member.dateOfBirth) missing.push('date of birth');
  else if (ageOn(member.dateOfBirth) < 18) missing.push('you must be 18 or older');
  if (!member.address || String(member.address).trim().length < 6) missing.push('residential address');
  return { complete: missing.length === 0, missing };
};

const refreshCustomerKyc = async (member) => {
  if (['suspended', 'rejected'].includes(member.kycStatus)) return member.kycStatus;
  const basics = customerBasics(member);
  let status = 'registered';
  if (member.idSubmittedAt && !member.idVerifiedAt) status = 'pending';
  else if (member.idVerifiedAt) status = 'verified';
  else if (basics.complete) status = 'approved';
  if (status !== member.kycStatus) await member.update({ kycStatus: status });
  return status;
};

const assertCanBook = async (member, total, settings) => {
  if (member.status !== 'active' || ['suspended', 'rejected'].includes(member.kycStatus)) {
    throw httpError(403, 'Your account cannot make bookings right now', 'ACCOUNT_RESTRICTED');
  }
  const basics = customerBasics(member);
  if (!basics.complete) {
    throw httpError(403, `Complete your profile to book: ${basics.missing.join(', ')}.`, 'KYC_REQUIRED', { missing: basics.missing });
  }
  if (Number(total) > settings.idRequiredAbove && !member.idVerifiedAt) {
    throw httpError(403, `Bookings above ₦${settings.idRequiredAbove.toLocaleString('en-NG')} need a verified ID.`, 'ID_REQUIRED', { idPending: !!member.idSubmittedAt });
  }
};

const customerKycView = (member, settings) => {
  const basics = customerBasics(member);
  return {
    status: member.kycStatus,
    basics,
    profile: { firstName: member.firstName, lastName: member.lastName, phone: member.phone, email: member.email, emailVerified: !!member.emailVerifiedAt, dateOfBirth: member.dateOfBirth, address: member.address },
    id: { type: member.idType, last4: member.idLast4, submitted: !!member.idSubmittedAt, verified: !!member.idVerifiedAt, note: member.kycNote },
    idRequiredAbove: settings.idRequiredAbove,
    idTypes: ID_TYPES,
  };
};

const submitCustomerId = async (member, { idType, idLast4, ref }) => {
  if (!ID_TYPES.includes(idType)) throw httpError(400, `ID type must be one of: ${ID_TYPES.join(', ')}`);
  if (!ownRef(member, ref)) throw httpError(400, 'Upload your ID through Homie first');
  await member.update({ idType, idLast4: idLast4 ? String(idLast4).replace(/\D/g, '').slice(-4) : null, idDocumentRef: ref, idSubmittedAt: new Date(), idVerifiedAt: null, kycNote: null });
  await refreshCustomerKyc(member);
  return member;
};

const decideCustomerId = async (memberId, approve, note) => {
  const member = await Member.findByPk(memberId);
  if (!member || !member.idSubmittedAt) throw httpError(404, 'No ID waiting for review');
  if (approve) {
    await member.update({ idVerifiedAt: new Date(), kycNote: null });
  } else {
    if (!String(note || '').trim()) throw httpError(400, 'Tell the customer why their ID was rejected');
    await member.update({ idSubmittedAt: null, idVerifiedAt: null, idDocumentRef: null, kycNote: `ID rejected: ${String(note).trim()}` });
  }
  await refreshCustomerKyc(member);
  notify(member.id, approve
    ? { type: 'kyc', title: 'ID verified', body: 'You can now make bookings of any size.' }
    : { type: 'kyc', title: 'ID needs attention', body: member.kycNote });
  return member;
};

// ----------------------------------------------------------------- chefs

const getOrCreateKyc = async (chefId) => {
  const [kyc] = await ChefKyc.findOrCreate({ where: { chefId }, defaults: { chefId } });
  return kyc;
};

const chefItemState = (kyc, bank) => {
  const docs = kyc.documents || {};
  const refs = kyc.references || [];
  const cl = kyc.checklist || {};
  const item = (key, provided) => ({ key, provided, review: cl[key]?.status || (provided ? 'submitted' : 'missing'), note: cl[key]?.note || null });
  return {
    profile: { key: 'profile', provided: !!(kyc.dateOfBirth && kyc.residentialAddress && kyc.idType), review: 'auto' },
    idDocument: item('idDocument', !!docs.idDocument),
    photo: item('photo', !!docs.photo),
    cv: item('cv', !!docs.cv),
    foodSafety: item('foodSafety', !!docs.foodSafety),
    references: item('references', refs.length >= 2),
    qualifications: { key: 'qualifications', provided: (docs.qualifications || []).length > 0, review: 'optional' },
    agreement: { key: 'agreement', provided: !!kyc.agreement?.acceptedAt, review: 'auto' },
    bankAccount: { key: 'bankAccount', provided: !!bank, review: 'auto' },
    backgroundCheck: { key: 'backgroundCheck', provided: kyc.backgroundCheck?.status !== 'not_started', review: kyc.backgroundCheck?.status || 'not_started', note: kyc.backgroundCheck?.note || null },
    practicalAssessment: { key: 'practicalAssessment', provided: kyc.practicalAssessment?.status !== 'not_started', review: kyc.practicalAssessment?.status || 'not_started', note: kyc.practicalAssessment?.note || null, score: kyc.practicalAssessment?.score ?? null },
  };
};

const missingForSubmit = (kyc, bank) => {
  const s = chefItemState(kyc, bank);
  const out = [];
  if (!s.profile.provided) out.push('date of birth, address and ID type');
  if (!s.idDocument.provided) out.push('ID document');
  if (!s.photo.provided) out.push('recent photograph');
  if (!s.cv.provided) out.push('CV / employment history');
  if (!s.foodSafety.provided) out.push('food safety certificate');
  if (!s.references.provided) out.push('two professional references');
  if (!s.agreement.provided) out.push('signed Chef Service Agreement');
  if (!s.bankAccount.provided) out.push('verified payout bank account');
  return out;
};

const chefKycView = async (chef, { admin = false, sign } = {}) => {
  const kyc = await getOrCreateKyc(chef.id);
  const bank = await PayoutAccount.findOne({ where: { chefId: chef.id } });
  const items = chefItemState(kyc, bank);
  const view = {
    chefId: chef.id,
    status: chef.verificationStatus,
    tier: chef.tier,
    note: chef.verificationNote,
    submittedAt: kyc.submittedAt,
    profile: { dateOfBirth: kyc.dateOfBirth, residentialAddress: kyc.residentialAddress, idType: kyc.idType, idLast4: kyc.idLast4 },
    references: kyc.references,
    agreement: kyc.agreement ? { version: kyc.agreement.version, fullName: kyc.agreement.fullName, acceptedAt: kyc.agreement.acceptedAt } : null,
    items,
    missing: missingForSubmit(kyc, bank),
    idTypes: ID_TYPES,
    bank: bank ? { bankName: bank.bankName, accountName: bank.accountName } : null,
  };
  const docs = kyc.documents || {};
  const mapDoc = (ref) => (ref ? (admin && sign ? { ref, url: sign(ref) } : { ref }) : null);
  view.documents = {
    idDocument: mapDoc(docs.idDocument), photo: mapDoc(docs.photo), cv: mapDoc(docs.cv), foodSafety: mapDoc(docs.foodSafety),
    qualifications: (docs.qualifications || []).map((q) => ({ name: q.name, ...mapDoc(q.ref) })),
  };
  return view;
};

const AGREEMENT_VERSION = '2026-11';

const saveChefProfile = async (chef, member, body) => {
  const kyc = await getOrCreateKyc(chef.id);
  const patch = {};
  if (body.dateOfBirth !== undefined) {
    if (!isValidDob(body.dateOfBirth)) throw httpError(400, 'Enter your date of birth as YYYY-MM-DD');
    if (ageOn(body.dateOfBirth) < 18) throw httpError(400, 'Chefs must be 18 or older');
    patch.dateOfBirth = body.dateOfBirth;
  }
  if (body.residentialAddress !== undefined) {
    if (String(body.residentialAddress).trim().length < 6) throw httpError(400, 'Enter your full residential address');
    patch.residentialAddress = String(body.residentialAddress).trim();
  }
  if (body.idType !== undefined) {
    if (!ID_TYPES.includes(body.idType)) throw httpError(400, `ID type must be one of: ${ID_TYPES.join(', ')}`);
    patch.idType = body.idType;
  }
  if (body.idLast4 !== undefined) patch.idLast4 = String(body.idLast4).replace(/\D/g, '').slice(-4) || null;
  await kyc.update(patch);
  return kyc;
};

const saveChefDocuments = async (chef, member, body) => {
  const kyc = await getOrCreateKyc(chef.id);
  const docs = { ...(kyc.documents || {}) };
  const cl = { ...(kyc.checklist || {}) };
  for (const key of ['idDocument', 'photo', 'cv', 'foodSafety']) {
    if (body[key] === undefined) continue;
    if (!ownRef(member, body[key])) throw httpError(400, `Upload the ${key} through Homie first`);
    docs[key] = body[key];
    if (cl[key]) cl[key] = { status: 'submitted' }; // a replaced document is reviewed again
  }
  if (body.qualifications !== undefined) {
    if (!Array.isArray(body.qualifications) || body.qualifications.length > 10) throw httpError(400, 'Add up to 10 qualifications');
    docs.qualifications = body.qualifications.map((q) => {
      if (!q.name || !ownRef(member, q.ref)) throw httpError(400, 'Each qualification needs a name and an uploaded document');
      return { name: String(q.name).slice(0, 120), ref: q.ref };
    });
  }
  await kyc.update({ documents: docs, checklist: cl });
  return kyc;
};

const saveChefReferences = async (chef, references) => {
  if (!Array.isArray(references) || references.length < 2 || references.length > 5) throw httpError(400, 'Provide two to five professional references');
  const clean = references.map((r) => {
    if (!r.name || !r.phone || !r.relationship) throw httpError(400, 'Each reference needs a name, phone number and relationship');
    return { name: String(r.name).slice(0, 120), phone: String(r.phone).slice(0, 30), relationship: String(r.relationship).slice(0, 120), company: r.company ? String(r.company).slice(0, 120) : null };
  });
  const kyc = await getOrCreateKyc(chef.id);
  const cl = { ...(kyc.checklist || {}) };
  if (cl.references) cl.references = { status: 'submitted' };
  await kyc.update({ references: clean, checklist: cl });
  return kyc;
};

const acceptAgreement = async (chef, { fullName, accept }, ip) => {
  if (accept !== true) throw httpError(400, 'You must accept the Chef Service Agreement');
  if (!fullName || String(fullName).trim().length < 3) throw httpError(400, 'Type your full legal name to sign');
  const kyc = await getOrCreateKyc(chef.id);
  await kyc.update({ agreement: { version: AGREEMENT_VERSION, fullName: String(fullName).trim(), acceptedAt: new Date().toISOString(), ip: ip || null } });
  return kyc;
};

const submitChefKyc = async (chef) => {
  if (['approved', 'suspended', 'verified'].includes(chef.verificationStatus)) throw httpError(409, 'Your application is already past the review stage');
  const kyc = await getOrCreateKyc(chef.id);
  const bank = await PayoutAccount.findOne({ where: { chefId: chef.id } });
  const missing = missingForSubmit(kyc, bank);
  if (missing.length) throw httpError(400, `Still needed: ${missing.join(', ')}.`, 'KYC_INCOMPLETE', { missing });
  const cl = { ...(kyc.checklist || {}) };
  for (const key of REVIEW_ITEMS) if (!cl[key] || cl[key].status === 'rejected') cl[key] = { status: 'submitted' };
  await kyc.update({ checklist: cl, submittedAt: new Date() });
  await chef.update({ verificationStatus: 'pending', verificationNote: null });
  return chef;
};

// ---- admin actions

const reviewItem = async (chefId, item, status, note, adminId) => {
  if (!REVIEW_ITEMS.includes(item)) throw httpError(400, `Unknown item. Choose one of: ${REVIEW_ITEMS.join(', ')}`);
  if (!['approved', 'rejected'].includes(status)) throw httpError(400, 'Status must be approved or rejected');
  if (status === 'rejected' && !String(note || '').trim()) throw httpError(400, 'Add a note explaining what to fix');
  const kyc = await ChefKyc.findOne({ where: { chefId } });
  if (!kyc) throw httpError(404, 'No KYC record');
  const cl = { ...(kyc.checklist || {}) };
  cl[item] = { status, note: note ? String(note).trim() : null, reviewedAt: new Date().toISOString(), reviewedBy: adminId };
  await kyc.update({ checklist: cl });
  return kyc;
};

const setBackgroundCheck = async (chefId, status, note) => {
  if (!['pending', 'clear', 'flagged'].includes(status)) throw httpError(400, 'Status must be pending, clear or flagged');
  const kyc = await ChefKyc.findOne({ where: { chefId } });
  if (!kyc) throw httpError(404, 'No KYC record');
  await kyc.update({ backgroundCheck: { status, note: note || null, at: new Date().toISOString() } });
  return kyc;
};

const setPracticalAssessment = async (chefId, { passed, score, note }) => {
  if (typeof passed !== 'boolean') throw httpError(400, 'passed must be true or false');
  const kyc = await ChefKyc.findOne({ where: { chefId } });
  if (!kyc) throw httpError(404, 'No KYC record');
  await kyc.update({ practicalAssessment: { status: passed ? 'passed' : 'failed', score: score ?? null, note: note || null, at: new Date().toISOString() } });
  return kyc;
};

const blockers = async (chef) => {
  const kyc = await getOrCreateKyc(chef.id);
  const bank = await PayoutAccount.findOne({ where: { chefId: chef.id } });
  const out = [];
  const cl = kyc.checklist || {};
  const LABEL = { idDocument: 'ID document', photo: 'Photograph', cv: 'CV / employment history', foodSafety: 'Food safety certificate', references: 'Professional references' };
  for (const key of REVIEW_ITEMS) if (cl[key]?.status !== 'approved') out.push(`${LABEL[key]} not approved yet`);
  if (!bank) out.push('No payout bank account');
  if (!kyc.agreement?.acceptedAt) out.push('Agreement not signed');
  if (kyc.backgroundCheck?.status !== 'clear') out.push('Background check not clear');
  if (kyc.practicalAssessment?.status !== 'passed') out.push('Practical assessment not passed');
  return out;
};

const verifyChef = async (chef) => {
  if (chef.verificationStatus !== 'pending') throw httpError(409, 'Only chefs with a submitted application can be verified');
  const out = await blockers(chef);
  if (out.length) throw httpError(409, `Cannot verify yet: ${out.join('; ')}.`, 'KYC_BLOCKERS', { blockers: out });
  await chef.update({ verificationStatus: 'verified', verificationNote: null });
  return chef;
};

const approveChef = async (chef, tier, settings) => {
  if (!['premium', 'standard', 'elite'].includes(tier)) throw httpError(400, 'Choose a tier: standard, premium or elite');
  if (chef.verificationStatus !== 'verified') throw httpError(409, 'Verify the chef before approving');
  // Re-check every requirement at the moment of approval (documents may have changed since verification).
  const outstanding = await blockers(chef);
  if (outstanding.length) throw httpError(409, `Cannot approve yet: ${outstanding.join('; ')}.`, 'KYC_BLOCKERS', { blockers: outstanding });
  await chef.update({
    verificationStatus: 'approved', tier, verifiedAt: new Date(), verificationNote: null,
    startingPrice: settings.tiers[tier].customerRate, startingUnit: 'hour',
  });
  notify(chef.memberId, { type: 'verification', title: "You're approved", body: `Welcome to Homie. You are listed as a ${tier} chef and can now take bookings.` });
  return chef;
};

const rejectChef = async (chef, note) => {
  if (!String(note || '').trim()) throw httpError(400, 'Tell the chef why they were rejected');
  await chef.update({ verificationStatus: 'rejected', verificationNote: String(note).trim() });
  notify(chef.memberId, { type: 'verification', title: 'Application needs attention', body: String(note).trim() });
  return chef;
};

const suspendChef = async (chef, note) => {
  if (!String(note || '').trim()) throw httpError(400, 'A reason is required to suspend a chef');
  await chef.update({ verificationStatus: 'suspended', verificationNote: String(note).trim(), available: false });
  notify(chef.memberId, { type: 'verification', title: 'Your account is suspended', body: String(note).trim() });
  return chef;
};

const reinstateChef = async (chef) => {
  if (chef.verificationStatus !== 'suspended') throw httpError(409, 'This chef is not suspended');
  await chef.update({ verificationStatus: 'approved', verificationNote: null });
  return chef;
};

module.exports = {
  ID_TYPES, REVIEW_ITEMS, httpError, customerBasics, refreshCustomerKyc, assertCanBook, customerKycView, submitCustomerId, decideCustomerId,
  getOrCreateKyc, chefKycView, saveChefProfile, saveChefDocuments, saveChefReferences, acceptAgreement, submitChefKyc,
  reviewItem, setBackgroundCheck, setPracticalAssessment, verifyChef, approveChef, rejectChef, suspendChef, reinstateChef, blockers, ageOn,
};
