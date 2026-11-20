const axios = require('axios');

// SMS delivery for OTP codes. Providers:
//   SMS_PROVIDER=console (default) - logs the message; no SMS is sent. For development.
//   SMS_PROVIDER=termii            - Termii (https://termii.com). Needs TERMII_API_KEY, TERMII_SENDER_ID.
const provider = () => (process.env.SMS_PROVIDER || 'console').toLowerCase();

const send = async (to, message) => {
  if (provider() === 'termii') {
    if (!process.env.TERMII_API_KEY) throw new Error('TERMII_API_KEY is not set');
    await axios.post('https://api.ng.termii.com/api/sms/send', {
      to: to.replace('+', ''),
      from: process.env.TERMII_SENDER_ID || 'Homie',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.TERMII_API_KEY,
    });
    return { provider: 'termii' };
  }

  console.log(`[sms:console] to ${to}: ${message}`);
  return { provider: 'console' };
};

module.exports = { send, provider };
