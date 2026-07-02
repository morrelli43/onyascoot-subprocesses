const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'nodeifier', version: '1.0.0' });
});

/**
 * Endpoint to receive alerts and forward to external webhooks
 */
app.post('/send-it', async (req, res) => {
    const payload = req.body;

    // Attach subject for n8n webhooks if not already set
    payload.subject = payload.subject || 'new_webform_submission';

    console.log(`\n[Nodeifier] Received push request: ${payload.title || 'No Title'}`);

    // External Webhook URL (e.g. n8n)
    const pushWebhookUrl = process.env.PUSH_WEBHOOK_URL || 'https://hooks.morrelli43media.com/webhook/message-center';

    try {
        const response = await axios.post(pushWebhookUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.status >= 200 && response.status < 300) {
            console.log("✅ Alert forwarded to external webhook successfully.");
            return res.status(200).json({ success: true, message: 'Alert forwarded' });
        } else {
            console.error("⚠️ External webhook returned:", response.status);
            return res.status(response.status).json({ success: false, message: 'External webhook error' });
        }
    } catch (error) {
        console.error("❌ Error forwarding alert:", error.message);
        return res.status(500).json({ success: false, message: 'Failed to forward alert', error: error.message });
    }
});

/**
 * Endpoint specifically for routing eScooter make + model details to n8n
 */
app.post('/ai-escooter-details-searcher', async (req, res) => {
    const payload = req.body;

    console.log(`\n[Nodeifier] Received AI details fetch searcher request: ${payload.title || 'No Title'}`);

    // Direct target webhook URL for AI eScooter searcher
    const pushWebhookUrl = 'https://hooks.morrelli43media.com/webhook/ai-escooter-details-searcher';

    try {
        const response = await axios.post(pushWebhookUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.status >= 200 && response.status < 300) {
            console.log("✅ AI details fetch forwarded successfully.");
            return res.status(200).json(response.data);
        } else {
            console.error("⚠️ External webhook returned:", response.status);
            return res.status(response.status).json({ success: false, message: 'External webhook error' });
        }
    } catch (error) {
        console.error("❌ Error forwarding AI details fetch:", error.message);
        return res.status(500).json({ success: false, message: 'Failed to forward AI details fetch', error: error.message });
    }
});


const PORT = process.env.PORT || 4312;
app.listen(PORT, () => {
    console.log(`Nodeifier listening on port ${PORT}`);
    console.log(`Target Webhook: ${process.env.PUSH_WEBHOOK_URL || 'Using default n8n URL'}`);
});