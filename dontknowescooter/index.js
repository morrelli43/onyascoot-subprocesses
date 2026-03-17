const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const os      = require('os');

const app  = express();
const PORT = process.env.PORT || 4314;

// ---------------------------------------------------------------------------
// Upload directory
// ---------------------------------------------------------------------------
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getLanIP() {
    for (const iface of Object.values(os.networkInterfaces())) {
        for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Multer — direct upload from mobile (customer details in body)
// ---------------------------------------------------------------------------
const directStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const first = (req.body.first_name || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
        const last  = (req.body.surname   || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
        const phone = (req.body.phone     || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
        const ext   = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${first}_${last}_${phone}_${file.fieldname}_${Date.now()}${ext}`);
    }
});

const photoUpload = multer({
    storage: directStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 9 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files are allowed'));
        cb(null, true);
    }
});

// ---------------------------------------------------------------------------
// Multer — QR session upload (one photo at a time from scanned phone)
// ---------------------------------------------------------------------------
const sessionStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const sid = (req.params.sessionId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 36);
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `ph_${sid}_${Date.now()}${ext}`);
    }
});

const sessionUpload = multer({
    storage: sessionStorage,
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) return cb(new Error('Images only'));
        cb(null, true);
    }
});

// ---------------------------------------------------------------------------
// In-memory QR session store  { sessionId -> { photos: [], createdAt: ms } }
// ---------------------------------------------------------------------------
const photoSessions = new Map();

function cleanupSessions() {
    const cutoff = Date.now() - 2 * 3600000; // 2 hours
    for (const [id, data] of photoSessions) {
        if (data.createdAt < cutoff) photoSessions.delete(id);
    }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Create a new QR session and return the base URL for the QR code
app.get('/photo-session', (req, res) => {
    cleanupSessions();
    const sessionId = crypto.randomUUID();
    photoSessions.set(sessionId, { photos: [], createdAt: Date.now() });

    // Base URL priority:
    //   1. PUBLIC_URL env var  — set on staging/production
    //   2. x-forwarded-host from nginx
    //   3. LAN IP:PORT — pure local / same-WiFi dev
    let baseUrl;
    if (process.env.PUBLIC_URL) {
        baseUrl = process.env.PUBLIC_URL.replace(/\/$/, '');
    } else {
        const protocol = req.get('x-forwarded-proto') || 'http';
        const lanIP    = getLanIP();
        const host     = req.get('x-forwarded-host') || (lanIP ? `${lanIP}:${PORT}` : req.get('host'));
        baseUrl = `${protocol}://${host}`;
    }

    res.json({ sessionId, baseUrl });
});

// Mobile uploads a single photo to the session
app.post('/photo-upload-session/:sessionId', sessionUpload.single('photo'), (req, res) => {
    const sessionId = (req.params.sessionId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 36);
    const session   = photoSessions.get(sessionId);
    if (!session)                  return res.status(404).json({ error: 'Session expired or not found' });
    if (session.photos.length >= 3) return res.status(400).json({ error: 'Max 3 photos reached' });
    session.photos.push(req.file.filename);
    console.log(`📱 QR photo received: ${req.file.filename}`);
    res.json({ success: true, count: session.photos.length, remaining: 3 - session.photos.length });
});

// Desktop polls for newly arrived photos
app.get('/photo-poll/:sessionId', (req, res) => {
    const sessionId = (req.params.sessionId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 36);
    const session   = photoSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    // PHOTOS_PUBLIC_BASE_URL = e.g. https://onyascoot.com/uploads/dontknowescooter
    const photosBase = (process.env.PHOTOS_PUBLIC_BASE_URL || '').replace(/\/$/, '');
    const photoUrls = session.photos.map((filename, i) => ({
        filename,
        url: photosBase ? `${photosBase}/${filename}` : null
    }));

    res.json({ count: session.photos.length, photos: session.photos, photoUrls });
});

// Serve a QR session photo for desktop thumbnail preview
app.get('/photo-file/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    if (!/^ph_[a-f0-9-]+_\d+\.(jpg|jpeg|png|webp|gif|heic)$/i.test(safeName)) {
        return res.status(403).end();
    }
    res.sendFile(path.join(uploadDir, safeName), err => { if (err) res.status(404).end(); });
});

// Claim QR session: rename temp files to include customer details
app.post('/photo-claim', express.json(), (req, res) => {
    const { sessionId, scooterNum, first_name, surname, phone } = req.body || {};
    const sid     = (sessionId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 36);
    const session = photoSessions.get(sid);
    if (!session) return res.json({ success: true });

    const first = (first_name || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
    const last  = (surname   || 'unknown').replace(/[^a-zA-Z0-9]/g, '');
    const ph    = (phone     || 'unknown').replace(/[^a-zA-Z0-9]/g, '');

    session.photos.forEach((filename, i) => {
        const ext     = path.extname(filename);
        const newName = `${first}_${last}_${ph}_scooter${scooterNum}_qr${i + 1}_${Date.now()}${ext}`;
        try {
            fs.renameSync(path.join(uploadDir, filename), path.join(uploadDir, newName));
            session.photos[i] = newName;
        } catch (e) {
            console.error('Rename error:', e.message);
        }
    });

    console.log(`📸 QR photos claimed for ${first} ${last} (${ph}), scooter ${scooterNum}`);
    res.json({ success: true });
});

// Direct mobile upload — saves with customer name + phone in filename
app.post('/upload-photos', photoUpload.any(), (req, res) => {
    const { first_name = '', surname = '', phone = '' } = req.body;
    const count = req.files ? req.files.length : 0;
    console.log(`📸 ${count} photo(s) uploaded for ${first_name} ${surname} (${phone})`);
    if (req.files) req.files.forEach(f => console.log(`   → ${f.filename}`));
    res.json({ success: true, count });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`
🛵 Don't Know eScooter — Photo Service
----------------------------------------------
🚀 Listening on port ${PORT}
📂 Uploads:        ${uploadDir}
🌍 PUBLIC_URL:     ${process.env.PUBLIC_URL || '(auto-detect from headers/LAN)'}
`);
});
