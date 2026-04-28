# googlemapsapi

Google Maps API gateway for travel time, distance, and combined search queries.
Built with Node.js / Express. Part of the onyascoot-subprocesses stack.

## What it does

Wraps the [Google Maps Distance Matrix API](https://developers.google.com/maps/documentation/distance-matrix/overview) and exposes three endpoints optimised for burst-load scenarios (in-process concurrency queue with request deduplication).

| Endpoint | Purpose | Min required fields |
|---|---|---|
| `POST /travel-time` | Travel time with traffic prediction | `destination` |
| `POST /distance` | Driving distance, no traffic | `origin`, `destination` |
| `POST /search` | Distance + travel time combined | `origin`, `destination` |

## Defaults

| Default | Value |
|---|---|
| Origin | 391 Hawthorn Road, Caulfield South VIC 3162, Australia |
| Departure day | Next available Tuesday |
| Departure time | 09:00 AEST / AEDT (Melbourne) |
| Transport mode | Driving |
| Traffic model | `best_guess` |

Bare suburb names (e.g. `"Fitzroy"`) are automatically expanded to `"Fitzroy, VIC, Australia"` for Google's geocoder.

---

## Google Maps API key setup

This service requires the **Distance Matrix API** to be enabled on your Google Cloud project.

1. Go to [Google Cloud Console → APIs & Services](https://console.cloud.google.com/apis/library)
2. Search for **Distance Matrix API** and enable it
3. Go to **Credentials → Create Credentials → API Key**
4. Restrict the key to the **Distance Matrix API** (recommended)
5. Copy the key into your `.env` or `docker-compose.yml` as `GOOGLE_MAPS_API_KEY`

> **Note:** The Distance Matrix API is a paid product. Check [pricing](https://developers.google.com/maps/documentation/distance-matrix/usage-and-billing) before high-volume use. Each `/travel-time` or `/search` call counts as one "element" (1 origin × 1 destination).

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_MAPS_API_KEY` | **Yes** | — | Your Google Maps API key |
| `SERVICE_API_KEY` | No | _(disabled)_ | `X-API-Key` value callers must supply. Omit to disable auth. |
| `PORT` | No | `4315` | HTTP port to listen on |
| `DEFAULT_ORIGIN` | No | `391 Hawthorn Road...` | Override the default origin address |
| `QUEUE_CONCURRENCY` | No | `10` | Max concurrent upstream Google API calls |

---

## API reference

### Authentication

All endpoints (except `GET /health`) require the `X-API-Key` header when `SERVICE_API_KEY` is configured:

```
X-API-Key: <your-service-api-key>
```

---

### `POST /travel-time`

Get estimated driving travel time with peak-traffic prediction.

**Request body (JSON):**
```json
{
  "destination": "Richmond",
  "origin": "Caulfield South",
  "departureTime": "2026-05-06T09:00:00"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `destination` | string | **Yes** | Suburb name or full address |
| `origin` | string | No | Suburb name or full address. Defaults to 391 Hawthorn Road, Caulfield South |
| `departureTime` | string | No | ISO 8601 datetime in Melbourne time. Defaults to next Tuesday 09:00 AEST |

**Response (200):**
```json
{
  "origin": "Caulfield South, VIC, Australia",
  "destination": "Richmond, VIC, Australia",
  "departureTime": "2026-05-05T09:00:00.000+10:00",
  "travelTime": {
    "text": "18 mins",
    "value": 1080
  }
}
```
`travelTime.value` is in **seconds**.

---

### `POST /distance`

Get the driving distance between two locations. No traffic data; fastest endpoint.

**Request body (JSON):**
```json
{
  "origin": "Caulfield South",
  "destination": "Fitzroy"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `origin` | string | **Yes** | Suburb name or full address |
| `destination` | string | **Yes** | Suburb name or full address |

**Response (200):**
```json
{
  "origin": "Caulfield South, VIC, Australia",
  "destination": "Fitzroy, VIC, Australia",
  "distance": {
    "text": "11.2 km",
    "value": 11200
  }
}
```
`distance.value` is in **metres**.

---

### `POST /search`

Get distance and travel time (with traffic) in a single call.

**Request body (JSON):**
```json
{
  "origin": "Caulfield South",
  "destination": "South Yarra",
  "departureTime": "2026-05-06T09:00:00"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `origin` | string | **Yes** | Suburb name or full address |
| `destination` | string | **Yes** | Suburb name or full address |
| `departureTime` | string | No | ISO 8601 datetime. Defaults to next Tuesday 09:00 AEST |

**Response (200):**
```json
{
  "origin": "Caulfield South, VIC, Australia",
  "destination": "South Yarra, VIC, Australia",
  "departureTime": "2026-05-05T09:00:00.000+10:00",
  "distance": {
    "text": "7.5 km",
    "value": 7500
  },
  "travelTime": {
    "text": "15 mins",
    "value": 900
  }
}
```

---

### `GET /health`

```json
{ "status": "ok", "service": "googlemapsapi", "version": "1.0.0" }
```

---

## Error responses

| Status | Meaning |
|---|---|
| `400` | Missing required field or invalid `departureTime` format |
| `401` | Missing or wrong `X-API-Key` header |
| `502` | Google Maps API returned an error or route not found |

---

## Running locally

```bash
cd googlemapsapi
npm install
GOOGLE_MAPS_API_KEY=your_key SERVICE_API_KEY=secret node index.js
```

## Docker Compose

The service is defined in `docker-compose.yml` as `googlemapsapi` on port `4315`.
Set `GOOGLE_MAPS_API_KEY` and `GOOGLEMAPSAPI_SERVICE_API_KEY` in your `.env` file.
