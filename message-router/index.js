const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
// Capture raw body so we can verify the Square HMAC signature downstream
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
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
    const contactSyncUrl = process.env.CONTACT_SYNC_URL || 'http://contact-sync:4310/send-it';
    const emailServiceUrl = process.env.EMAIL_SERVICE_URL || 'http://email-service:4311/send-it';
    const nodeifierUrl = process.env.NODEIFIER_URL || 'http://nodeifier:4312/send-it';
    const opsForwarderUrl = process.env.OPS_FORWARDER_URL || 'http://ops-forwarder:4313/send-it';
    const dontknowUrl = process.env.DONTKNOW_URL || 'http://dontknowescooter:4314';
    const dontknowPublicUrl = process.env.DONTKNOW_PUBLIC_URL || process.env.PHOTOS_PUBLIC_BASE_URL || '';

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

    // 2. Build and send Pushbullet alert
    (async () => {
        // Extract photo URLs from the frontend JSON payload
        const scooterPhotos = scooters.map(s => {
            return {
                modelUrls: s.model_photo_urls || [],
                issueUrls: s.issue_photo_urls || []
            };
        });

        const multiJob = scooters.length > 1;
        let alertTitle = "";
        const lines = [];
        
        const fullAddress = [address_line_1, suburb, state, postcode].filter(Boolean).join(', ');
        const emailAddress = rawData.email || '';

        if (!multiJob && scooters.length === 1) {
            const s = scooters[0];
            const label = `${s.make || 'Unknown'} ${s.model || ''}`.trim() || 'Unknown eScooter';
            const issuesArr = s.issues || [];
            let titleServices = 'Service Requested';
            if (issuesArr.length > 1) {
                titleServices = `${issuesArr.length}x Services`;
            } else if (issuesArr.length === 1) {
                titleServices = issuesArr[0];
            }
            alertTitle = `${suburb ? suburb + ' - ' : ''}${label} | ${titleServices}`;
            lines.push(`${first_name} ${surname}`);
            // Remove 'Other...' and add Repair/Notes as last item if present
            let filteredIssues = issuesArr.filter(issue => issue.toLowerCase() !== 'other');
            let servicesText = filteredIssues.map(issue => `- ${issue}`).join('\n');
            if (servicesText) lines.push(servicesText);
            
            const sPhotos = scooterPhotos[0];
            const issueLinks = sPhotos.issueUrls.map((url, idx) => `<a href="${url}">issue-${idx + 1}</a>`).join(', ');

            if (s.issue_extra || issueLinks) {
                let noteLine = `- Repair/Notes: ${s.issue_extra || ''}`;
                if (issueLinks) {
                    // if issue_extra exists, add a space before the links, otherwise just the links
                    noteLine = s.issue_extra ? `${noteLine} (${issueLinks})` : `- Repair/Notes: ${issueLinks}`;
                }
                lines.push(noteLine);
            }
            // Format phone number as clickable link
            const phoneClean = number ? number.replace(/\s+/g, '') : '';
            if (phoneClean) {
                lines.push(`<a href="tel:${phoneClean}">${phoneClean}</a>`);
            } else {
                lines.push('No Phone');
            }
            if (emailAddress) lines.push(emailAddress);
            if (fullAddress) lines.push(fullAddress);
            
            if (sPhotos.modelUrls.length > 0) {
                lines.push('');
                const photoLinks = sPhotos.modelUrls.map((url, idx) => `<a href="${url}">eScooter1-${idx + 1}</a>`).join(', ');
                lines.push(`Identify: ${photoLinks}`);
            }
        } else {
            alertTitle = `${suburb ? suburb + ' - ' : ''}${scooters.length}x eScooters`;
            lines.push(`${first_name} ${surname}`);
            // Show just the plain number (Telegram will auto-link)
            const phoneClean = number ? number.replace(/\s+/g, '') : '';
            if (phoneClean) {
                lines.push(`<a href=\"tel:${phoneClean}\">${phoneClean}</a>`);
            } else {
                lines.push('No Phone');
            }
            if (emailAddress) lines.push(emailAddress);
            if (fullAddress) lines.push(fullAddress);
            scooters.forEach((s, i) => {
                lines.push('');
                const label = `${s.make || 'Unknown'} ${s.model || ''}`.trim() || 'Unknown eScooter';
                const issuesArr = s.issues || [];
                let filteredIssues = issuesArr.filter(issue => issue.toLowerCase() !== 'other');
                let servicesText = filteredIssues.map(issue => `- ${issue}`).join('\n');
                
                const sPhotos = scooterPhotos[i];
                const issueLinks = sPhotos.issueUrls.map((url, idx) => `<a href="${url}">issue-${idx + 1}</a>`).join(', ');

                if (s.issue_extra || issueLinks) {
                    let noteText = `- Repair/Notes: ${s.issue_extra || ''}`;
                    if (issueLinks) {
                        noteText = s.issue_extra ? `${noteText} (${issueLinks})` : `- Repair/Notes: ${issueLinks}`;
                    }
                    servicesText = noteText + (servicesText ? '\n' + servicesText : '');
                }
                lines.push(`${i + 1}. ${label}`);
                if (servicesText) lines.push(servicesText);
                
                if (sPhotos.modelUrls.length > 0) {
                    const photoLinks = sPhotos.modelUrls.map((url, idx) => `<a href="${url}">eScooter${i + 1}-${idx + 1}</a>`).join(', ');
                    lines.push(`Identify: ${photoLinks}`);
                }
            });
        }

        const alertPayload = {
            app: 'telegram',
            target: 'dandroid',
            title: alertTitle,
            body: lines.join('\n')
        };

        axios.post(nodeifierUrl, alertPayload)
            .then(() => console.log('✅ Routed to Nodeifier'))
            .catch(err => console.error('⚠️ Nodeifier routing failed:', err.message));
    })();
});

/**
 * Square Webhook Fanout
 * Receives Square webhooks and routes them to sub-processes (contact-sync, calendar-sync)
 */
app.post('/webhooks/square', async (req, res) => {
    // Respond immediately to Square
    res.status(200).json({ status: 'routing' });

    console.log(`\n[Message Router] Received Square Webhook. Fanning out...`);

    const contactSyncSquareEnabled = String(
        process.env.CONTACT_SYNC_ENABLE_SQUARE || 'false'
    ).toLowerCase() === 'true';

    const rawData = req.rawBody || req.body;
    
    // Pass along whatever headers came in, especially the 'x-square-hmacsha256-signature'
    const signature = req.headers['x-square-hmacsha256-signature'] || '';
    
    const headers = { 
        'Content-Type': 'application/json',
        'x-square-hmacsha256-signature': signature 
    };

    // Define internal endpoints
    const contactSyncSquareUrl = (process.env.CONTACT_SYNC_URL || 'http://contact-sync:4310/send-it').replace('/send-it', '/webhooks/square');
    const calendarSyncSquareUrl = process.env.CALENDAR_SYNC_URL || 'http://calendar-sync:5001/webhooks/square';

    if (contactSyncSquareEnabled) {
        axios.post(contactSyncSquareUrl, rawData, { headers })
            .then(() => console.log('✅ Square Webhook -> Contact-Sync'))
            .catch(err => console.error('⚠️ Contact-Sync Square Webhook failed:', err.message));
    } else {
        console.log('⏭️ Square Webhook -> Contact-Sync skipped (disabled)');
    }

    // Route to Calendar Sync
    axios.post(calendarSyncSquareUrl, rawData, { headers })
        .then(() => console.log('✅ Square Webhook -> Calendar-Sync'))
        .catch(err => console.error('⚠️ Calendar-Sync Square Webhook failed:', err.message));
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
