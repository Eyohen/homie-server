// Homie back-office routes, mounted at /api/admin-homie. All require an admin token (see /api/admin-auth/login).
const express = require('express');
const { param } = require('express-validator');
const adminAuth = require('../middleware/adminAuth');
const { validate } = require('../middleware/validate.middleware');
const ctrl = require('../controllers/homieAdmin.controller');

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

router.get('/verifications', ctrl.listVerifications);
router.post('/verifications/:chefId/decision', uuid('chefId'), allow('admin', 'moderator'), ctrl.decideVerification);

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
