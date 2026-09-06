const axios = require('axios');
const { getInstances } = require('./store');

const sendWebhook = async (instanceId, type, data) => {
    const instance = getInstances()[instanceId];
    if (!instance || !instance.webhook_url) return;

    if (type === 'message_received' && !instance.webhook_message_received) return;
    if (type === 'message_ack' && !instance.webhook_message_ack) return;

    try {
        const headers = {};
        if (instance.webhook_auth_header && instance.webhook_auth_value) {
            headers[instance.webhook_auth_header] = instance.webhook_auth_value;
        }

        // ── Diagnostic log (secret masked) ───────────────────────────────────
        const authHeaderNames = Object.keys(headers);
        const maskedAuth = authHeaderNames.length
            ? authHeaderNames.map(h => `${h}: ${String(headers[h]).slice(0, 14)}…(${String(headers[h]).length} chars)`).join(', ')
            : 'NONE';
        console.log(`[${instanceId}] WEBHOOK OUT → ${type} | url=${instance.webhook_url} | auth=[${maskedAuth}]`);

        const resp = await axios.post(instance.webhook_url, {
            event_type: type,
            instanceId,
            data
        }, { timeout: 5000, headers });

        console.log(`[${instanceId}] WEBHOOK OK ← ${type} | HTTP ${resp.status}`);
    } catch (e) {
        const status = e.response?.status;
        const body = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : '';
        console.error(`[${instanceId}] WEBHOOK ERROR ← ${type} | HTTP ${status || 'no-response'} | ${e.message} | ${body}`);
    }
};

module.exports = {
    sendWebhook
};
