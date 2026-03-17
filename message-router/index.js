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

    // Define service URLs
    const contactSyncUrl   = process.env.CONTACT_SYNC_URL    || 'http://contact-sync:4310/send-it';
    const emailServiceUrl  = process.env.EMAIL_SERVICE_URL   || 'http://email-service:4311/send-it';
    const nodeifierUrl     = process.env.NODEIFIER_URL       || 'http://nodeifier:4312/send-it';
    const opsForwarderUrl  = process.env.OPS_FORWARDER_URL   || 'http://ops-forwarder:4313/send-it';
    const dontknowUrl      = process.env.DONTKNOW_URL        || 'http://dontknowescooter:4314';
    const dontknowPublicUrl = process.env.DONTKNOW_PUBLIC_URL || '';

    // Fan out requests in background
    console.log(`[Message Router] Routing to sub-processes...`);

    // Respond immediately to the frontend
    res.status(200).json({ success: true, message: 'Submission received and routing in progress' });

    // 1. Sync to Contacts
    axios.post(contactSyncUrl, syncData)
        .then(() => console.log('✅ Routed to Contact-Sync'))
        .catch(err => console.error('⚠️ Contact-Sync routing failed:', err.message));

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

    // 2. Build and send Pushbullet alert (async — fetches QR photo URLs first)
    (async () => {
        // Fetch QR photo filenames for each scooter that has a session
        const scooterPhotos = await Promise.all(scooters.map(async s => {
            if (!s.qr_session_id || s.qr_photos === 0) return [];
            try {
                const resp = await axios.get(`${dontknowUrl}/photo-poll/${s.qr_session_id}`, { timeout: 5000 });
                return (resp.data.photoUrls || []).map((p, i) => ({
                    num: i + 1,
                    url: p.url || `${dontknowPublicUrl}/photo-file/${p.filename}`
                }));
            } catch (e) {
                console.error(`[Message Router] Could not fetch photos for session ${s.qr_session_id}:`, e.message);
                return [];
            }
        }));

        // Title: first issue of first scooter + suburb
        const firstIssue = scooters[0]?.issues?.[0] || 'New Job';
        const alertTitle = `🆕 ${firstIssue}${suburb ? ' - ' + suburb : ''}`;

        // Body
        const multiJob = scooters.length > 1;
        const lines = [];

        lines.push(`${first_name} ${surname}`);
        if (suburb) lines.push(suburb);
        lines.push(`tel:${number}`);

        if (multiJob) {
            lines.push('');
            lines.push(`--- ${scooters.length} Jobs ---`);
        }

        scooters.forEach((s, i) => {
            const photos = scooterPhotos[i] || [];
            const issues = (s.issues || []).join(', ');
            const label  = `${s.make || ''} ${s.model || ''}`.trim();

            lines.push('');
            if (multiJob) lines.push(`Job ${s.scooter_num}:`);
            if (issues)   lines.push(issues);
            if (!s.dont_know_mode && label) lines.push(label);
            if (s.dont_know_mode && photos.length > 0) {
                const photoLinks = photos.map(p => `${p.num} (${p.url})`).join(', ');
                lines.push(`Unknown: ${photoLinks}`);
            }
            if (s.issue_extra) lines.push(`Issue Note: ${s.issue_extra}`);
        });

        const alertPayload = {
            app:    'pushbullet',
            target: 'dandroid',
            title:  alertTitle,
            body:   lines.join('\n')
        };

        axios.post(nodeifierUrl, alertPayload)
            .then(() => console.log('✅ Routed to Nodeifier'))
            .catch(err => console.error('⚠️ Nodeifier routing failed:', err.message));
    })();
});

const PORT = process.env.PORT || 4300;
app.listen(PORT, () => {
    console.log(`Message Router listening on port ${PORT}`);
    console.log(`Contact-Sync: ${process.env.CONTACT_SYNC_URL || 'http://contact-sync:4310/send-it'}`);
    console.log(`Email-Service: ${process.env.EMAIL_SERVICE_URL || 'http://email-service:4311/send-it'}`);
    console.log(`Nodeifier: ${process.env.NODEIFIER_URL || 'http://nodeifier:4312/send-it'}`);
    console.log(`Ops-Forwarder: ${process.env.OPS_FORWARDER_URL || 'http://ops-forwarder:4313/send-it'}`);
    console.log(`Dontknow: ${process.env.DONTKNOW_URL || 'http://dontknowescooter:4314'}`);
});
