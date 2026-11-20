const db = require('../../models');
const paystack = require('../../services/paystack.service');
const svc = require('../../services/booking.service');

const { BookingPayment } = db;

// Paystack webhook. Needs the raw body (captured in index.js) to validate the signature.
exports.webhook = async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  if (!paystack.verifyWebhookSignature(req.rawBody, signature)) {
    return res.status(401).json({ success: false, message: 'Invalid signature' });
  }

  const { event, data } = req.body || {};
  try {
    if (event === 'charge.success' && data?.reference) {
      await svc.confirmPayment(data.reference, data);
    } else if (event === 'transfer.success' && data?.reference) {
      await BookingPayment.update({ payoutStatus: 'paid', payoutError: null }, { where: { payoutReference: data.reference } });
    } else if ((event === 'transfer.failed' || event === 'transfer.reversed') && data?.reference) {
      await BookingPayment.update(
        { payoutStatus: 'failed', payoutError: data.reason || `Transfer ${event.split('.')[1]}` },
        { where: { payoutReference: data.reference } }
      );
    }
  } catch (error) {
    // Return 500 so Paystack retries the event.
    console.error('webhook processing error:', error);
    return res.status(500).json({ success: false });
  }
  return res.sendStatus(200);
};
