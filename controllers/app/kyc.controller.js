const kyc = require('../../services/kyc.service');
const pricing = require('../../services/pricing.service');
const db = require('../../models');
const { memberPublic } = require('../../utils/homieSerializers');

const { ChefProfile } = db;

const fail = (res, error) => {
  if (error.status) {
    return res.status(error.status).json({ success: false, message: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ? { details: error.details } : {}) });
  }
  console.error('kyc error:', error);
  return res.status(500).json({ success: false, message: 'Something went wrong' });
};

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (error) { fail(res, error); }
};

// ---------------------------------------------------------------- customer

exports.getCustomerKyc = wrap(async (req, res) => {
  await kyc.refreshCustomerKyc(req.member);
  const settings = await pricing.getSettings();
  return res.json({ success: true, data: { kyc: kyc.customerKycView(req.member, settings) } });
});

// Name, date of birth and address. (Email is verified through /me/email/*; sign-in by email already verifies it.)
exports.saveCustomerProfile = wrap(async (req, res) => {
  const patch = {};
  ['firstName', 'lastName'].forEach((k) => { if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim() || null; });
  if (req.body.address !== undefined) patch.address = String(req.body.address).trim() || null;
  if (req.body.dateOfBirth !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(req.body.dateOfBirth) || Number.isNaN(new Date(`${req.body.dateOfBirth}T00:00:00Z`).getTime())) throw kyc.httpError(400, 'Enter your date of birth as YYYY-MM-DD');
    if (kyc.ageOn(req.body.dateOfBirth) < 18) throw kyc.httpError(400, 'You must be 18 or older to book');
    patch.dateOfBirth = req.body.dateOfBirth;
  }
  if (req.body.lat !== undefined) patch.lat = req.body.lat === null ? null : Number(req.body.lat);
  if (req.body.lng !== undefined) patch.lng = req.body.lng === null ? null : Number(req.body.lng);
  await req.member.update(patch);
  await kyc.refreshCustomerKyc(req.member);
  const settings = await pricing.getSettings();
  return res.json({ success: true, data: { member: memberPublic(req.member), kyc: kyc.customerKycView(req.member, settings) } });
});

exports.submitCustomerId = wrap(async (req, res) => {
  await kyc.submitCustomerId(req.member, req.body);
  const settings = await pricing.getSettings();
  return res.json({ success: true, message: 'ID submitted for review', data: { kyc: kyc.customerKycView(req.member, settings) } });
});

// -------------------------------------------------------------------- chef

const chefOf = (req) => ChefProfile.findOne({ where: { memberId: req.member.id } });

exports.getChefKyc = wrap(async (req, res) => {
  const chef = await chefOf(req);
  if (!chef) return res.status(404).json({ success: false, message: 'Set up your chef profile first', code: 'CHEF_SETUP_REQUIRED' });
  return res.json({ success: true, data: { kyc: await kyc.chefKycView(chef) } });
});

const chefStep = (fn, message) => wrap(async (req, res) => {
  const chef = await chefOf(req);
  if (!chef) return res.status(404).json({ success: false, message: 'Set up your chef profile first', code: 'CHEF_SETUP_REQUIRED' });
  if (['approved', 'suspended'].includes(chef.verificationStatus)) throw kyc.httpError(409, 'Your application has already been decided');
  await fn(chef, req);
  // Any change after checks were completed (status "verified") invalidates them: back to review.
  if (chef.verificationStatus === 'verified') await chef.update({ verificationStatus: 'pending' });
  return res.json({ success: true, ...(message ? { message } : {}), data: { kyc: await kyc.chefKycView(chef) } });
});

exports.saveChefProfile = chefStep((chef, req) => kyc.saveChefProfile(chef, req.member, req.body));
exports.saveChefDocuments = chefStep((chef, req) => kyc.saveChefDocuments(chef, req.member, req.body));
exports.saveChefReferences = chefStep((chef, req) => kyc.saveChefReferences(chef, req.body.references));
exports.acceptAgreement = chefStep((chef, req) => kyc.acceptAgreement(chef, req.body, req.ip));
exports.submitChefKyc = chefStep((chef) => kyc.submitChefKyc(chef), 'Application submitted for review');
