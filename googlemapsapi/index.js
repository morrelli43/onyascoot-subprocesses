'use strict';

require('dotenv').config();
const http    = require('http');
const https   = require('https');
const express = require('express');
const axios   = require('axios');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

// ─── HTTP Connection Pooling (Keep-Alive) ─────────────────────────────────────
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });
const axiosClient = axios.create({
    httpAgent,
    httpsAgent,
    timeout: 10000,
});

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT                = parseInt(process.env.PORT || '4315', 10);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SERVICE_API_KEY     = process.env.SERVICE_API_KEY;
const QUEUE_CONCURRENCY   = parseInt(process.env.QUEUE_CONCURRENCY || '10', 10);

const DEFAULT_ORIGIN = process.env.DEFAULT_ORIGIN
    || '391 Hawthorn Road, Caulfield South VIC 3162, Australia';

const TIMEZONE               = 'Australia/Melbourne';
const LEGACY_MAPS_API_URL    = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const ROUTES_MATRIX_API_URL  = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

// ─── In-Memory Cache (24-hour TTL) ───────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getCachedResult(key) {
    const item = _cache.get(key);
    if (item && item.expiresAt > Date.now()) {
        return item.data;
    }
    if (item) _cache.delete(key);
    return null;
}

function setCachedResult(key, data) {
    // Keep cache from growing unbounded (> 10,000 entries)
    if (_cache.size > 10000) {
        const firstKey = _cache.keys().next().value;
        if (firstKey) _cache.delete(firstKey);
    }
    _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── In-process Queue with Deduplication ─────────────────────────────────────
class MapsQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running     = 0;
        this.queue       = [];
        this.inflight    = new Map();
    }

    execute(key, fn) {
        if (this.inflight.has(key)) {
            return this.inflight.get(key);
        }
        const promise = new Promise((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            this._process();
        });
        this.inflight.set(key, promise);
        promise.finally(() => this.inflight.delete(key));
        return promise;
    }

    _process() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const { fn, resolve, reject } = this.queue.shift();
            this.running++;
            fn()
                .then(resolve)
                .catch(reject)
                .finally(() => {
                    this.running--;
                    this._process();
                });
        }
    }
}

const queue = new MapsQueue(QUEUE_CONCURRENCY);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getNextTuesdayAt9amUnix() {
    const now = DateTime.now().setZone(TIMEZONE);
    const TUESDAY = 2;

    let candidate = now.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    if (now.weekday === TUESDAY && now.hour < 9) {
        // Today is Tuesday and it's not yet 9 am
    } else if (now.weekday === TUESDAY) {
        // Today is Tuesday but past 9 am
        candidate = candidate.plus({ weeks: 1 });
    } else {
        candidate = candidate.set({ weekday: TUESDAY });
        if (candidate <= now) {
            candidate = candidate.plus({ weeks: 1 });
        }
    }

    return Math.floor(candidate.toSeconds());
}

function normalizeAddress(input) {
    if (!input) return null;
    const cleaned = input.trim();
    if (!cleaned || cleaned === 'VIC' || cleaned === 'VIC, Australia' || cleaned === 'VIC, VIC, Australia') {
        return null;
    }
    const hasDigit     = /\d/.test(cleaned);
    const hasAustralia = /australia/i.test(cleaned);
    if (!hasDigit && !hasAustralia) {
        return `${cleaned}, VIC, Australia`;
    }
    return cleaned;
}

function formatDurationText(seconds) {
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return `${mins} mins`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem > 0 ? `${hrs} hr ${rem} mins` : `${hrs} hr`;
}

function formatDistanceText(meters) {
    if (meters < 1000) return `${meters} m`;
    return `${(meters / 1000).toFixed(1)} km`;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    if (!SERVICE_API_KEY) return next();
    const provided = req.headers['x-api-key'];
    if (!provided || provided !== SERVICE_API_KEY) {
        return res.status(401).json({
            error:   'Unauthorized',
            message: 'Missing or invalid X-API-Key header',
        });
    }
    next();
}

// ─── High-Performance Routes API v2 (computeRouteMatrix) ──────────────────────
async function callComputeRouteMatrix({ origins, destinations }) {
    if (!GOOGLE_MAPS_API_KEY) {
        throw new Error('GOOGLE_MAPS_API_KEY is not configured');
    }

    const payload = {
        origins: origins.map(addr => ({ waypoint: { address: addr } })),
        destinations: destinations.map(addr => ({ waypoint: { address: addr } })),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE'
    };

    const res = await axiosClient.post(ROUTES_MATRIX_API_URL, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,duration,status'
        }
    });

    const elements = Array.isArray(res.data) ? res.data : [];
    const matrixResult = {};

    for (const el of elements) {
        const oIdx = el.originIndex ?? 0;
        const dIdx = el.destinationIndex ?? 0;
        const oAddr = origins[oIdx];
        const dAddr = destinations[dIdx];

        if (!oAddr || !dAddr) continue;

        let seconds = 0;
        if (typeof el.duration === 'string') {
            seconds = parseInt(el.duration.replace('s', ''), 10) || 0;
        } else if (typeof el.duration === 'number') {
            seconds = el.duration;
        }

        const distanceMeters = el.distanceMeters || 0;
        const key = `${oAddr}|${dAddr}`;

        matrixResult[key] = {
            seconds,
            text: formatDurationText(seconds),
            meters: distanceMeters,
            distanceText: formatDistanceText(distanceMeters),
            status: el.status?.code === 0 || !el.status ? 'OK' : el.status.message || 'NOT_FOUND'
        };
    }

    return matrixResult;
}

// ─── Legacy Distance Matrix Client (Fallback) ────────────────────────────────
async function callDistanceMatrixLegacy({ origins, destinations, departureTime }) {
    const params = {
        origins: Array.isArray(origins) ? origins.join('|') : origins,
        destinations: Array.isArray(destinations) ? destinations.join('|') : destinations,
        mode: 'driving',
        key:  GOOGLE_MAPS_API_KEY,
    };

    if (departureTime) {
        params.departure_time = departureTime;
        params.traffic_model  = 'best_guess';
    }

    const response = await axiosClient.get(LEGACY_MAPS_API_URL, { params });
    const data     = response.data;

    if (data.status !== 'OK') {
        const msg = data.error_message ? ` — ${data.error_message}` : '';
        throw new Error(`Google Maps API error: ${data.status}${msg}`);
    }

    return data;
}

// ─── Health Route ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'googlemapsapi', version: '2.0.0', cachedEntries: _cache.size });
});

// ─── Route: POST /matrix (Batch Travel Matrix) ────────────────────────────────
/**
 * Computes distances and driving durations for ALL pairs of (origins × destinations)
 * in a SINGLE high-performance Google Routes API v2 call.
 *
 * Body:
 *   origins       {string[]}  required  — list of origin addresses
 *   destinations  {string[]}  required  — list of destination addresses
 *   departureTime {string}    optional  — ISO 8601 datetime
 *
 * Response:
 *   {
 *     matrix: {
 *       "Origin A|Destination B": { seconds: 1200, text: "20 mins", meters: 15400, distanceText: "15.4 km" }
 *     }
 *   }
 */
app.post(['/matrix', '/travel-matrix'], requireApiKey, async (req, res) => {
    const rawOrigins = Array.isArray(req.body.origins) ? req.body.origins : (req.body.origin ? [req.body.origin] : []);
    const rawDests   = Array.isArray(req.body.destinations) ? req.body.destinations : (req.body.destination ? [req.body.destination] : []);

    const origins = Array.from(new Set(rawOrigins.map(normalizeAddress).filter(Boolean)));
    const destinations = Array.from(new Set(rawDests.map(normalizeAddress).filter(Boolean)));

    if (origins.length === 0 || destinations.length === 0) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Both `origins` and `destinations` arrays must contain at least one valid address'
        });
    }

    const finalMatrix = {};
    const uncachedOrigins = new Set();
    const uncachedDests = new Set();

    // Check in-memory cache first
    for (const o of origins) {
        for (const d of destinations) {
            const pairKey = `${o}|${d}`;
            const cached = getCachedResult(pairKey);
            if (cached) {
                finalMatrix[pairKey] = cached;
            } else {
                uncachedOrigins.add(o);
                uncachedDests.add(d);
            }
        }
    }

    // If all pairs were cached, return immediately in < 1ms
    if (uncachedOrigins.size === 0 || uncachedDests.size === 0) {
        return res.json({ matrix: finalMatrix, fromCache: true });
    }

    const queryOrigins = Array.from(uncachedOrigins);
    const queryDests   = Array.from(uncachedDests);
    const batchKey = `matrix:${queryOrigins.sort().join(';')}:${queryDests.sort().join(';')}`;

    try {
        const fetchedMatrix = await queue.execute(batchKey, async () => {
            try {
                return await callComputeRouteMatrix({ origins: queryOrigins, destinations: queryDests });
            } catch (v2Err) {
                console.warn('[matrix] Routes API v2 failed, falling back to legacy Distance Matrix:', v2Err.message);
                const legacyData = await callDistanceMatrixLegacy({
                    origins: queryOrigins,
                    destinations: queryDests,
                    departureTime: getNextTuesdayAt9amUnix()
                });

                const result = {};
                for (let r = 0; r < (legacyData.rows || []).length; r++) {
                    const row = legacyData.rows[r];
                    const oAddr = queryOrigins[r];
                    for (let c = 0; c < (row.elements || []).length; c++) {
                        const el = row.elements[c];
                        const dAddr = queryDests[c];
                        if (!oAddr || !dAddr) continue;
                        const key = `${oAddr}|${dAddr}`;
                        const sec = el.duration_in_traffic?.value ?? el.duration?.value ?? 0;
                        const meters = el.distance?.value ?? 0;
                        result[key] = {
                            seconds: sec,
                            text: el.duration_in_traffic?.text || el.duration?.text || formatDurationText(sec),
                            meters,
                            distanceText: el.distance?.text || formatDistanceText(meters),
                            status: el.status || 'OK'
                        };
                    }
                }
                return result;
            }
        });

        // Store fetched pairs into cache and assemble final response
        for (const [key, val] of Object.entries(fetchedMatrix)) {
            setCachedResult(key, val);
            finalMatrix[key] = val;
        }

        res.json({ matrix: finalMatrix });
    } catch (err) {
        console.error('[matrix] Error computing matrix:', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message, matrix: finalMatrix });
    }
});

// ─── Route: POST /travel-time (Single Pair) ───────────────────────────────────
app.post('/travel-time', requireApiKey, async (req, res) => {
    const { destination, origin, departureTime } = req.body;

    if (!destination) {
        return res.status(400).json({ error: 'Bad Request', message: '`destination` is required' });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    if (!resolvedDestination) {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid destination address' });
    }

    const pairKey = `${resolvedOrigin}|${resolvedDestination}`;
    const cached = getCachedResult(pairKey);
    if (cached) {
        return res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: departureTime || DateTime.fromSeconds(getNextTuesdayAt9amUnix(), { zone: TIMEZONE }).toISO(),
            travelTime: {
                text:  cached.text,
                value: cached.seconds,
            },
        });
    }

    const queueKey = `travel:${pairKey}`;

    try {
        const matrixResult = await queue.execute(queueKey, () =>
            callComputeRouteMatrix({
                origins:      [resolvedOrigin],
                destinations: [resolvedDestination]
            }).catch(async () => {
                const legacy = await callDistanceMatrixLegacy({
                    origins: resolvedOrigin,
                    destinations: resolvedDestination,
                    departureTime: getNextTuesdayAt9amUnix()
                });
                const el = legacy.rows[0]?.elements[0];
                const sec = el?.duration_in_traffic?.value ?? el?.duration?.value ?? 0;
                return {
                    [pairKey]: {
                        seconds: sec,
                        text: el?.duration_in_traffic?.text || el?.duration?.text || formatDurationText(sec),
                        meters: el?.distance?.value ?? 0,
                    }
                };
            })
        );

        const data = matrixResult[pairKey] || { seconds: 1800, text: '30 mins', meters: 0 };
        setCachedResult(pairKey, data);

        res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: departureTime || DateTime.fromSeconds(getNextTuesdayAt9amUnix(), { zone: TIMEZONE }).toISO(),
            travelTime: {
                text:  data.text,
                value: data.seconds,
            },
        });
    } catch (err) {
        console.error('[travel-time]', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message });
    }
});

// ─── Route: POST /distance ────────────────────────────────────────────────────
app.post('/distance', requireApiKey, async (req, res) => {
    const { origin, destination } = req.body;

    if (!destination) {
        return res.status(400).json({ error: 'Bad Request', message: '`destination` is required' });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    if (!resolvedDestination) {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid destination address' });
    }

    const pairKey = `${resolvedOrigin}|${resolvedDestination}`;
    const cached = getCachedResult(pairKey);
    if (cached) {
        return res.json({
            origin:      resolvedOrigin,
            destination: resolvedDestination,
            distance: {
                text:  cached.distanceText || formatDistanceText(cached.meters || 0),
                value: cached.meters || 0,
            },
        });
    }

    const queueKey = `dist:${pairKey}`;

    try {
        const matrixResult = await queue.execute(queueKey, () =>
            callComputeRouteMatrix({
                origins:      [resolvedOrigin],
                destinations: [resolvedDestination]
            })
        );

        const data = matrixResult[pairKey] || { seconds: 0, meters: 0 };
        setCachedResult(pairKey, data);

        res.json({
            origin:      resolvedOrigin,
            destination: resolvedDestination,
            distance: {
                text:  data.distanceText || formatDistanceText(data.meters),
                value: data.meters,
            },
        });
    } catch (err) {
        console.error('[distance]', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message });
    }
});

// ─── Route: POST /search ──────────────────────────────────────────────────────
app.post('/search', requireApiKey, async (req, res) => {
    const { origin, destination, departureTime } = req.body;

    if (!destination) {
        return res.status(400).json({ error: 'Bad Request', message: '`destination` is required' });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    if (!resolvedDestination) {
        return res.status(400).json({ error: 'Bad Request', message: 'Invalid destination address' });
    }

    const pairKey = `${resolvedOrigin}|${resolvedDestination}`;
    const cached = getCachedResult(pairKey);
    if (cached) {
        return res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: departureTime || DateTime.fromSeconds(getNextTuesdayAt9amUnix(), { zone: TIMEZONE }).toISO(),
            distance: {
                text:  cached.distanceText || formatDistanceText(cached.meters || 0),
                value: cached.meters || 0,
            },
            travelTime: {
                text:  cached.text,
                value: cached.seconds,
            },
        });
    }

    const queueKey = `search:${pairKey}`;

    try {
        const matrixResult = await queue.execute(queueKey, () =>
            callComputeRouteMatrix({
                origins:      [resolvedOrigin],
                destinations: [resolvedDestination]
            })
        );

        const data = matrixResult[pairKey] || { seconds: 1800, text: '30 mins', meters: 0 };
        setCachedResult(pairKey, data);

        res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: departureTime || DateTime.fromSeconds(getNextTuesdayAt9amUnix(), { zone: TIMEZONE }).toISO(),
            distance: {
                text:  data.distanceText || formatDistanceText(data.meters),
                value: data.meters,
            },
            travelTime: {
                text:  data.text,
                value: data.seconds,
            },
        });
    } catch (err) {
        console.error('[search]', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message });
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (!GOOGLE_MAPS_API_KEY) {
    console.warn(
        '[googlemapsapi] WARNING: GOOGLE_MAPS_API_KEY is not set — ' +
        'all requests to Google will fail.'
    );
}

app.listen(PORT, () => {
    console.log(`[googlemapsapi] v2.0.0 (Routes Matrix + Keep-Alive) running on port ${PORT}`);
    console.log(`[googlemapsapi] Queue concurrency: ${QUEUE_CONCURRENCY}`);
    console.log(`[googlemapsapi] Default origin: ${DEFAULT_ORIGIN}`);
});
