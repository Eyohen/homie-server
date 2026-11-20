// Homie mobile app API, mounted at /api/app.
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { body, param } = require('express-validator');
const { validate } = require('../../middleware/validate.middleware');
const { verifyMember, optionalMember, requireChef } = require('../../middleware/memberAuth');

const auth = require('../../controllers/app/auth.controller');
const me = require('../../controllers/app/me.controller');
const chefs = require('../../controllers/app/chef.controller');
const bookings = require('../../controllers/app/booking.controller');
const payments = require('../../controllers/app/payment.controller');
const chat = require('../../controllers/app/chat.controller');
const engage = require('../../controllers/app/engage.controller');

const router = express.Router();

const uuid = (name = 'id') => param(name).isUUID().withMessage('Invalid id');
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => (/^image\/(jpe?g|png|webp|heic)$/i.test(file.mimetype) ? cb(null, true) : cb(new Error('Only image uploads are allowed'))),
});

// ---- Paystack webhook (signature-verified, no member auth)
router.post('/payments/webhook', payments.webhook);

// ---- Auth
router.post('/auth/otp/request', otpLimiter, auth.requestOtp);
router.post('/auth/otp/verify', otpLimiter, auth.verifyOtp);
router.post('/auth/refresh', auth.refresh);
router.post('/auth/logout', verifyMember, auth.logout);

// ---- Public discovery (signed-in members get favorites + default location)
router.get('/chefs', optionalMember, chefs.list);
router.get('/chefs/:id', optionalMember, uuid(), validate, chefs.detail);
router.get('/chefs/:id/reviews', uuid(), validate, chefs.reviews);
router.get('/chefs/:id/availability', uuid(), validate, chefs.availability);

// Everything below needs a signed-in member.
router.use(verifyMember);

// ---- Me
router.get('/me', me.getMe);
router.patch('/me', me.updateMe);
router.post('/me/role', me.switchRole);
router.post('/me/email/request', otpLimiter, me.requestEmailChange);
router.post('/me/email/verify', otpLimiter, me.verifyEmailChange);
router.post('/me/push-token', me.registerPushToken);
router.get('/banks', me.listBanks);

// ---- Chef self-management
router.get('/me/chef', me.getChefProfile);
router.put('/me/chef', me.upsertChefProfile);
router.put('/me/chef/services', requireChef, me.setServices);
router.put('/me/chef/availability', requireChef, me.setAvailability);
router.put('/me/chef/payout-account', requireChef, me.setPayoutAccount);
router.post('/me/chef/verification', requireChef, me.submitVerification);
router.get('/me/chef/earnings', requireChef, me.getEarnings);

// ---- Favorites
router.get('/favorites', engage.listFavorites);
router.put('/favorites/:chefId', uuid('chefId'), validate, engage.addFavorite);
router.delete('/favorites/:chefId', uuid('chefId'), validate, engage.removeFavorite);

// ---- Bookings
router.post(
  '/bookings',
  [
    body('chefId').isUUID().withMessage('chefId is required'),
    body('serviceId').isUUID().withMessage('serviceId is required'),
    body('scheduledAt').isISO8601().withMessage('scheduledAt must be a valid date'),
    body('address').trim().isLength({ min: 6, max: 500 }).withMessage('A full address is required'),
    body('guests').optional().isInt({ min: 1, max: 500 }),
    body('groceries').optional().isFloat({ min: 0 }),
  ],
  validate,
  bookings.create
);
router.get('/bookings', bookings.list);
router.get('/payments/verify/:reference', bookings.verifyPayment);
router.get('/bookings/:id', uuid(), validate, bookings.get);
router.post('/bookings/:id/pay', uuid(), validate, bookings.pay);
router.post('/bookings/:id/cancel', uuid(), validate, bookings.cancel);
router.post('/bookings/:id/approve', uuid(), validate, bookings.approve);
router.post('/bookings/:id/report', uuid(), validate, bookings.report);
router.post('/bookings/:id/review', uuid(), validate, bookings.review);
router.post('/bookings/:id/accept', uuid(), validate, requireChef, bookings.accept);
router.post('/bookings/:id/decline', uuid(), validate, requireChef, bookings.decline);
router.post('/bookings/:id/check-in', uuid(), validate, requireChef, bookings.checkIn);
router.post('/bookings/:id/complete', uuid(), validate, requireChef, bookings.complete);

// ---- Chat
router.get('/chat/threads', chat.listThreads);
router.post('/chat/threads', body('chefId').isUUID(), validate, chat.openThread);
router.get('/chat/threads/:id/messages', uuid(), validate, chat.listMessages);
router.post('/chat/threads/:id/messages', uuid(), validate, chat.sendMessage);

// ---- Notifications
router.get('/notifications', engage.listNotifications);
router.post('/notifications/read', engage.markRead);
router.post('/notifications/:id/read', uuid(), validate, engage.markRead);

// ---- Uploads
router.post('/uploads', upload.single('file'), engage.uploadImage);

module.exports = router;
