const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'ops-forwarder', version: '1.0.1' });
});

/**
 * Accepted fields:
 *   first_name, surname, number, location,
 *   address_line_1, suburb, state, postcode, country,
 *   escooter_make, escooter_model, issue, issue_extra
 */
app.post('/send-it', async (req, res) => {
    const payload = req.body;

    console.log(`\n[Ops-Forwarder] Received submission: ${payload.first_name || ''} ${payload.surname || ''}`);

    const targetUrl = process.env.OPS_WEBHOOK_URL || 'http://onya-operations-live-app:3000/api/webhooks/customer';

    // Forward recognised fields (deprecated top-level escooter_make/model/issue are excluded)
    const forwardPayload = {
        first_name: payload.first_name,
        surname: payload.surname,
        number: payload.number,
        ...(payload.date_time && { date_time: payload.date_time }),
        ...(payload.location && { location: payload.location }),
        ...(payload.address_line_1 && { address_line_1: payload.address_line_1 }),
        ...(payload.suburb && { suburb: payload.suburb }),
        ...(payload.state && { state: payload.state }),
        ...(payload.postcode && { postcode: payload.postcode }),
        ...(payload.country && { country: payload.country }),
        scooter_count: payload.scooter_count,
        has_photos: payload.has_photos,
        total_photos_all: payload.total_photos_all,
        scooters: payload.scooters,
    };

    const apiKey = process.env.OPS_API_KEY;
    const authHeaders = apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {};

    try {
        console.log(`[Ops-Forwarder] Forwarding to ${targetUrl}`);
        const response = await axios.post(targetUrl, forwardPayload, {
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            timeout: 10000, // 10 second timeout
        });

        if (response.status >= 200 && response.status < 300) {
            console.log('✅ Successfully forwarded to Operations site.');
            return res.status(200).json({ success: true, message: 'Forwarded to Operations site' });
        } else {
            console.error(`⚠️ Operations site returned status: ${response.status}`);
            return res.status(response.status).json({ success: false, message: 'Operations site error' });
        }
    } catch (error) {
        console.error('❌ Error forwarding to Operations site:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to forward to Operations site',
            error: error.message,
        });
    }
});

const PORT = process.env.PORT || 4313;
app.listen(PORT, () => {
    console.log(`Ops-Forwarder listening on port ${PORT}`);
    console.log(`Target Operations URL: ${process.env.OPS_WEBHOOK_URL || '(not set)'}`);
});
