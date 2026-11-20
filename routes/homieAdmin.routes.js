// Homie back-office routes, mounted at /api/admin-homie. All require an admin token (see /api/admin-auth/login).
const express = require('express');
const { param } = require('express-validator');
const adminAuth = require('../middleware/adminAuth');
const { validate } = require('../middleware/validate.middleware');
const ctrl = require('../controllers/homieAdmin.controller');
const ops = require('../controllers/homieAdminOps.controller');

const router = express.Router();
router.use(adminAuth);

const uuid = (name = 'id') => [param(name).isUUID().withMessage('Invalid id'), validate];

// Role gate: super_admin always passes. Roles: super_admin, admin, moderator, support.
const allow = (...roles) => (req, res, next) =>
  req.admin.role === 'super_admin' || roles.includes(req.admin.role)
    ? next()
    : res.status(403).json({ success: false, message: 'Your role cannot do this' });

router.get('/overview', ctrl.overview);
router.get('/settings', ctrl.settings);
router.get('/audit-log', allow('admin'), ctrl.auditLog);

router.get('/users', ctrl.listUsers);
router.get('/users/:id', uuid(), ctrl.getUser);
router.patch('/users/:id/status', uuid(), allow('admin', 'moderator'), ctrl.setUserStatus);

// Pricing (view for all staff, edit for admins)
router.get('/pricing', ops.getPricing);
router.put('/pricing', allow('admin'), ops.updatePricing);

// Allocation of "Match me" bookings
router.get('/allocations', ops.listAllocations);
router.get('/bookings/:id/candidates', uuid(), ops.candidates);
router.post('/bookings/:id/allocate', uuid(), allow('admin'), ops.allocate);

// Chef + Ingredients quotations and procurement
router.get('/quotes', ops.listQuotes);
router.post('/quotes/preview', allow('admin'), ops.previewQuote);
router.get('/quotes/:id', uuid(), ops.getQuote);
router.post('/quotes/:id/quote', uuid(), allow('admin'), ops.sendQuote);
router.post('/quotes/:id/reject', uuid(), allow('admin'), ops.rejectQuote);
router.get('/procurement', ops.listProcurement);
router.post('/bookings/:id/procurement', uuid(), allow('admin'), ops.updateProcurement);

// KYC: chefs (full review) and customers (ID above the booking threshold)
router.get('/chef-kyc', ops.listChefKyc);
router.get('/chef-kyc/:chefId', uuid('chefId'), ops.getChefKyc);
router.post('/chef-kyc/:chefId/items/:item', uuid('chefId'), allow('admin', 'moderator'), ops.reviewChefItem);
router.post('/chef-kyc/:chefId/background', uuid('chefId'), allow('admin', 'moderator'), ops.setBackgroundCheck);
router.post('/chef-kyc/:chefId/practical', uuid('chefId'), allow('admin', 'moderator'), ops.setPractical);
router.post('/chef-kyc/:chefId/verify', uuid('chefId'), allow('admin', 'moderator'), ops.verifyChef);
router.post('/chef-kyc/:chefId/approve', uuid('chefId'), allow('admin'), ops.approveChef);
router.post('/chef-kyc/:chefId/reject', uuid('chefId'), allow('admin', 'moderator'), ops.rejectChef);
router.post('/chef-kyc/:chefId/suspend', uuid('chefId'), allow('admin', 'moderator'), ops.suspendChef);
router.post('/chef-kyc/:chefId/reinstate', uuid('chefId'), allow('admin'), ops.reinstateChef);
router.post('/chef-kyc/:chefId/tier', uuid('chefId'), allow('admin'), ops.changeTier);
router.get('/customer-kyc', ops.listCustomerKyc);
router.post('/customer-kyc/:memberId/decision', uuid('memberId'), allow('admin', 'moderator'), ops.decideCustomerKyc);

router.get('/bookings', ctrl.listBookings);
router.get('/bookings/:id', uuid(), ctrl.getBooking);

router.get('/payments/issues', allow('admin'), ctrl.listPaymentIssues);
router.post('/payments/:id/retry-payout', uuid(), allow('admin'), ctrl.retryPayout);
router.post('/payments/:id/retry-refund', uuid(), allow('admin'), ctrl.retryRefund);

router.get('/disputes', ctrl.listDisputes);
router.post('/disputes/:id/review', uuid(), allow('admin', 'moderator', 'support'), ctrl.markDisputeUnderReview);
router.post('/disputes/:id/resolve', uuid(), allow('admin'), ctrl.resolveDispute);

router.get('/moderation/flags', ctrl.listFlags);
router.post('/moderation/flags/:id/review', uuid(), allow('admin', 'moderator'), ctrl.reviewFlag);

module.exports = router;
