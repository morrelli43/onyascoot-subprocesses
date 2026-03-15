const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'message-router', version: '1.0.0' });
});

/**
 * Main entry point for frontend submissions
 */
app.post('/submit', async (req, res) => {
    const rawData = req.body;

    console.log(`\n[Message Router] Received raw submission: ${rawData.first_name} ${rawData.surname}`);

    const {
        first_name, surname, number, location,
        address_line_1, suburb, state, postcode, country,
        date_time, scooter_count, has_photos, total_photos_all,
        scooters = []
    } = rawData;

    // --- Build per-scooter fields for contact-sync (escooter1, escooter2, escooter3) ---
    const escooterFields = {};
    scooters.slice(0, 3).forEach((s, i) => {
        const label = `${s.make || 'Unknown'} ${s.model || ''}`.trim();
        escooterFields[`escooter${i + 1}`] = label;
    });

    // --- Build notes summary from scooters ---
    const notesText = scooters.map(s => {
        const label = `${s.make || 'Unknown'} ${s.model || ''}`.trim() || 'Unknown Scooter';
        const issues = (s.issues || []).join(', ');
        const extra = s.issue_extra ? ` (${s.issue_extra})` : '';
        return `${label}: ${issues}${extra}`;
    }).join(' | ') || 'No Issue';

    // --- 1. Map to contact-sync ---
    const syncData = {
        first_name,
        last_name: surname,
        phone: number,
        email: "",
        address_line_1: address_line_1 || "",
        suburb: suburb || "",
        state: state || "",
        postcode: postcode || "",
        country: country || "",
        company: "",
        notes: notesText,
        ...escooterFields,
        timestamp: new Date().toISOString()
    };

    // --- 2. Map to nodeifier (Alerts) ---
    const scooterSummary = scooters.map(s => `${s.make || '?'} ${s.model || ''}`.trim()).join(', ');
    const issueSummary = scooters.map(s => (s.issues || []).join('/')).join(', ');
    const alertPayload = {
        app: "pushbullet",
        target: "dandroid",
        title: `NEW: ${scooterSummary}, ${issueSummary}`,
        body: `Name: ${first_name} ${surname}\nPhone: ${number}\n`
    };

    // Define service URLs
    const contactSyncUrl = process.env.CONTACT_SYNC_URL || 'http://contact-sync:4310/send-it';
    const emailServiceUrl = process.env.EMAIL_SERVICE_URL || 'http://email-service:4311/send-it';
    const nodeifierUrl = process.env.NODEIFIER_URL || 'http://nodeifier:4312/send-it';
    const opsForwarderUrl = process.env.OPS_FORWARDER_URL || 'http://ops-forwarder:4313/send-it';

    // Fan out requests in background
    console.log(`[Message Router] Routing to sub-processes...`);

    // We respond success immediately to the frontend, but wait for downstream to trigger in background
    // for robust logging and potential retry logic in the future.

    // 1. Sync to Contacts
    axios.post(contactSyncUrl, syncData)
        .then(() => console.log('✅ Routed to Contact-Sync'))
        .catch(err => console.error('⚠️ Contact-Sync routing failed:', err.message));

    // 2. Trigger Nodeifier (Alerts)
    axios.post(nodeifierUrl, alertPayload)
        .then(() => console.log('✅ Routed to Nodeifier'))
        .catch(err => console.error('⚠️ Nodeifier routing failed:', err.message));

    // 3. Trigger Email-Service
    axios.post(emailServiceUrl, rawData)
        .then(() => console.log('✅ Routed to Email-Service'))
        .catch(err => console.error('⚠️ Email-Service routing failed:', err.message));

    // 4. Forward to Operations Site
    axios.post(opsForwarderUrl, rawData)
        .then(() => console.log('✅ Routed to Ops-Forwarder'))
        .catch(err => {
            const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error('⚠️ Ops-Forwarder routing failed:', detail);
        });

    res.status(200).json({
        success: true,
        message: 'Submission received and routing in progress'
    });
});

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => {
    console.log(`Message Router listening on port ${PORT}`);
    console.log(`Contact-Sync: ${process.env.CONTACT_SYNC_URL || 'http://contact-sync:4310/send-it'}`);
    console.log(`Email-Service: ${process.env.EMAIL_SERVICE_URL || 'http://email-service:4311/send-it'}`);
    console.log(`Nodeifier: ${process.env.NODEIFIER_URL || 'http://nodeifier:4312/send-it'}`);
    console.log(`Ops-Forwarder: ${process.env.OPS_FORWARDER_URL || 'http://ops-forwarder:4313/send-it'}`);
});
