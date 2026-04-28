'use strict';

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT               = parseInt(process.env.PORT || '4315', 10);
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SERVICE_API_KEY    = process.env.SERVICE_API_KEY;
const QUEUE_CONCURRENCY  = parseInt(process.env.QUEUE_CONCURRENCY || '10', 10);

// Override the default origin via env var if needed
const DEFAULT_ORIGIN = process.env.DEFAULT_ORIGIN
    || '391 Hawthorn Road, Caulfield South VIC 3162, Australia';

const TIMEZONE    = 'Australia/Melbourne';
const MAPS_API_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

// ─── In-process Queue with Deduplication ─────────────────────────────────────
// Limits concurrent upstream Google API calls and collapses identical in-flight
// requests into a single call — critical when many requests arrive in rapid bursts.
class MapsQueue {
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running     = 0;
        this.queue       = [];
        this.inflight    = new Map(); // key → Promise
    }

    // Enqueue fn, sharing the result for any identical key already in-flight.
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

/**
 * Returns a Unix timestamp for the next available Tuesday at 09:00 AEST/AEDT.
 * If today IS Tuesday and it is before 09:00, returns today at 09:00.
 * Tuesday at 9 am is used as the default departure time to capture peak-traffic
 * estimates consistent across callers that don't supply their own departure time.
 */
function getNextTuesdayAt9amUnix() {
    const now = DateTime.now().setZone(TIMEZONE);
    // Luxon weekday: Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6, Sun=7
    const TUESDAY = 2;

    let candidate = now.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });

    if (now.weekday === TUESDAY && now.hour < 9) {
        // Today is Tuesday and it's not yet 9 am — use today
    } else if (now.weekday === TUESDAY) {
        // Today is Tuesday but past 9 am — jump to next week
        candidate = candidate.plus({ weeks: 1 });
    } else {
        // Advance to nearest future Tuesday
        candidate = candidate.set({ weekday: TUESDAY });
        if (candidate <= now) {
            candidate = candidate.plus({ weeks: 1 });
        }
    }

    return Math.floor(candidate.toSeconds());
}

/**
 * Appends Australian/VIC context to bare suburb names so Google can geo-resolve
 * them reliably. Full addresses (containing digits) are returned unchanged.
 */
function normalizeAddress(input) {
    if (!input) return null;
    const cleaned = input.trim();
    const hasDigit     = /\d/.test(cleaned);
    const hasAustralia = /australia/i.test(cleaned);
    if (!hasDigit && !hasAustralia) {
        return `${cleaned}, VIC, Australia`;
    }
    return cleaned;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    if (!SERVICE_API_KEY) return next(); // disabled when env var not set
    const provided = req.headers['x-api-key'];
    if (!provided || provided !== SERVICE_API_KEY) {
        return res.status(401).json({
            error:   'Unauthorized',
            message: 'Missing or invalid X-API-Key header',
        });
    }
    next();
}

// ─── Google Distance Matrix Client ────────────────────────────────────────────
async function callDistanceMatrix({ origins, destinations, departureTime }) {
    const params = {
        origins,
        destinations,
        mode: 'driving',
        key:  GOOGLE_MAPS_API_KEY,
    };

    if (departureTime) {
        params.departure_time = departureTime;
        params.traffic_model  = 'best_guess';
    }

    const response = await axios.get(MAPS_API_URL, { params, timeout: 10000 });
    const data     = response.data;

    if (data.status !== 'OK') {
        const msg = data.error_message ? ` — ${data.error_message}` : '';
        throw new Error(`Google Maps API error: ${data.status}${msg}`);
    }

    const element = data.rows[0]?.elements[0];
    if (!element || element.status !== 'OK') {
        throw new Error(`Route not found: ${element?.status || 'UNKNOWN'}`);
    }

    return element;
}

// ─── Route: Health ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'googlemapsapi', version: '1.0.0' });
});

// ─── Route 1: POST /travel-time ───────────────────────────────────────────────
/**
 * Get estimated driving travel time from an origin to a destination.
 * Uses Google's traffic prediction for the given (or default) departure time.
 *
 * Body:
 *   destination   {string}  required  — suburb or full address
 *   origin        {string}  optional  — suburb or full address; defaults to 391 Hawthorn Road, Caulfield South
 *   departureTime {string}  optional  — ISO 8601 datetime; defaults to next Tuesday 09:00 AEST
 *
 * Response:
 *   { origin, destination, departureTime, travelTime: { text, value } }
 *   travelTime.value is in seconds.
 */
app.post('/travel-time', requireApiKey, async (req, res) => {
    const { destination, origin, departureTime } = req.body;

    if (!destination) {
        return res.status(400).json({
            error:   'Bad Request',
            message: '`destination` is required',
        });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    let resolvedDepartureTime;
    if (departureTime) {
        const parsed = DateTime.fromISO(departureTime, { zone: TIMEZONE });
        if (!parsed.isValid) {
            return res.status(400).json({
                error:   'Bad Request',
                message: '`departureTime` must be a valid ISO 8601 datetime string',
            });
        }
        resolvedDepartureTime = Math.floor(parsed.toSeconds());
    } else {
        resolvedDepartureTime = getNextTuesdayAt9amUnix();
    }

    const queueKey = `travel:${resolvedOrigin}:${resolvedDestination}:${resolvedDepartureTime}`;

    try {
        const element = await queue.execute(queueKey, () =>
            callDistanceMatrix({
                origins:       resolvedOrigin,
                destinations:  resolvedDestination,
                departureTime: resolvedDepartureTime,
            })
        );

        res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: DateTime.fromSeconds(resolvedDepartureTime, { zone: TIMEZONE }).toISO(),
            travelTime: {
                text:  element.duration_in_traffic?.text  || element.duration.text,
                value: element.duration_in_traffic?.value ?? element.duration.value,
            },
        });
    } catch (err) {
        console.error('[travel-time]', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message });
    }
});

// ─── Route 2: POST /distance ──────────────────────────────────────────────────
/**
 * Get the driving distance between two locations. No traffic data.
 *
 * Body:
 *   origin      {string}  required  — suburb or full address
 *   destination {string}  required  — suburb or full address
 *
 * Response:
 *   { origin, destination, distance: { text, value } }
 *   distance.value is in metres.
 */
app.post('/distance', requireApiKey, async (req, res) => {
    const { origin, destination } = req.body;

    if (!destination) {
        return res.status(400).json({
            error:   'Bad Request',
            message: '`destination` is required',
        });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    const queueKey = `dist:${resolvedOrigin}:${resolvedDestination}`;

    try {
        const element = await queue.execute(queueKey, () =>
            callDistanceMatrix({
                origins:      resolvedOrigin,
                destinations: resolvedDestination,
            })
        );

        res.json({
            origin:      resolvedOrigin,
            destination: resolvedDestination,
            distance: {
                text:  element.distance.text,
                value: element.distance.value,
            },
        });
    } catch (err) {
        console.error('[distance]', err.message);
        res.status(502).json({ error: 'Upstream Error', message: err.message });
    }
});

// ─── Route 3: POST /search ────────────────────────────────────────────────────
/**
 * Get both driving distance AND travel time (with traffic) in a single call.
 *
 * Body:
 *   origin        {string}  required  — suburb or full address
 *   destination   {string}  required  — suburb or full address
 *   departureTime {string}  optional  — ISO 8601 datetime; defaults to next Tuesday 09:00 AEST
 *
 * Response:
 *   { origin, destination, departureTime, distance: { text, value }, travelTime: { text, value } }
 *   distance.value is in metres; travelTime.value is in seconds.
 */
app.post('/search', requireApiKey, async (req, res) => {
    const { origin, destination, departureTime } = req.body;

    if (!destination) {
        return res.status(400).json({
            error:   'Bad Request',
            message: '`destination` is required',
        });
    }

    const resolvedOrigin      = normalizeAddress(origin) || DEFAULT_ORIGIN;
    const resolvedDestination = normalizeAddress(destination);

    let resolvedDepartureTime;
    if (departureTime) {
        const parsed = DateTime.fromISO(departureTime, { zone: TIMEZONE });
        if (!parsed.isValid) {
            return res.status(400).json({
                error:   'Bad Request',
                message: '`departureTime` must be a valid ISO 8601 datetime string',
            });
        }
        resolvedDepartureTime = Math.floor(parsed.toSeconds());
    } else {
        resolvedDepartureTime = getNextTuesdayAt9amUnix();
    }

    const queueKey = `search:${resolvedOrigin}:${resolvedDestination}:${resolvedDepartureTime}`;

    try {
        const element = await queue.execute(queueKey, () =>
            callDistanceMatrix({
                origins:       resolvedOrigin,
                destinations:  resolvedDestination,
                departureTime: resolvedDepartureTime,
            })
        );

        res.json({
            origin:        resolvedOrigin,
            destination:   resolvedDestination,
            departureTime: DateTime.fromSeconds(resolvedDepartureTime, { zone: TIMEZONE }).toISO(),
            distance: {
                text:  element.distance.text,
                value: element.distance.value,
            },
            travelTime: {
                text:  element.duration_in_traffic?.text  || element.duration.text,
                value: element.duration_in_traffic?.value ?? element.duration.value,
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
        'all requests to Google will fail. See README.md for setup.'
    );
}

app.listen(PORT, () => {
    console.log(`[googlemapsapi] Running on port ${PORT}`);
    console.log(`[googlemapsapi] Queue concurrency: ${QUEUE_CONCURRENCY}`);
    console.log(`[googlemapsapi] Default origin: ${DEFAULT_ORIGIN}`);
});
