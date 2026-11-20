const axios = require('axios');

// Expo push notifications (the mobile app is built with Expo). Fire-and-forget: never throws.
const sendPush = async (pushToken, { title, body, data }) => {
  if (!pushToken || !/^Expo(nent)?PushToken\[/.test(pushToken)) return false;
  try {
    await axios.post(
      'https://exp.host/--/api/v2/push/send',
      { to: pushToken, title, body, data, sound: 'default' },
      { timeout: 8000 }
    );
    return true;
  } catch (error) {
    console.error('Push send failed:', error.response?.data || error.message);
    return false;
  }
};

module.exports = { sendPush };
