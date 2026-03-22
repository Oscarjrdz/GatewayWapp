const axios = require('axios');
const { getInstances } = require('./store');

const sendWebhook = async (instanceId, type, data) => {
    const instance = getInstances()[instanceId];
    if (!instance || !instance.webhook_url) return;

    if (type === 'message_received' && !instance.webhook_message_received) return;
    if (type === 'message_ack' && !instance.webhook_message_ack) return;

    try {
        await axios.post(instance.webhook_url, {
            event_type: type,
            instanceId,
            data
        }, { timeout: 5000 });
    } catch (e) {
        console.error(`[${instanceId}] Webhook error: ${e.message}`);
    }
};

module.exports = {
    sendWebhook
};
