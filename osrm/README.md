# OSRM (Open Source Routing Machine) Service

High-performance, zero-cost, offline routing engine for the OnyaScoot ecosystem.

## Overview
The OSRM service computes exact driving distances and standard road durations across Victoria using OpenStreetMap data. It serves table matrix lookups in **< 5 milliseconds** locally in memory, replacing expensive and slow external Google Cloud Routes API calls.

## Architecture
```
[Operations Portal] 
       │ HTTP (POST /matrix)
       ▼
[googlemapsapi Gateway (Port 4315)]
       │ Suburb Coordinates & Heuristic Multiplier (Peak vs Off-Peak)
       ▼
[osrm Service (Port 5000)] (osrm-routed --algorithm mld /data/victoria-latest.osrm)
       │
[OpenStreetMap Road Graph (/data/victoria-latest.osrm)]
```

## Quick Setup

### 1. Download and Process Victoria Road Data
Run the automated preprocessing script:
```bash
cd osrm
chmod +x setup-osrm.sh
./setup-osrm.sh
```
This downloads `victoria-latest.osm.pbf` (~140MB) into `osrm-data/` and builds the Multi-Level Dijkstra (MLD) graph. The generated files will be ~350MB.

### 2. Start the Service
```bash
docker compose up -d osrm googlemapsapi
```

### 3. Verify Health & Routing
Test the OSRM raw API:
```bash
# Caulfield South (-37.8913, 145.0232) to Richmond (-37.8230, 144.9980)
curl "http://localhost:5000/table/v1/driving/145.0232,-37.8913;144.9980,-37.8230"
```

Test through the OnyaScoot Gateway (with peak-hour traffic heuristics):
```bash
curl -X POST http://localhost:4315/matrix \
  -H "Content-Type: application/json" \
  -H "X-API-Key: ce769c383153836addf23b5f78cee0422ca691dd76a748385639c09ad1725c7f" \
  -d '{
    "origins": ["391 Hawthorn Road, Caulfield South, VIC"],
    "destinations": ["Richmond, VIC"],
    "departureTime": "2026-09-16T15:30:00+10:00"
  }'
```

## Hardware & System Requirements
- **RAM**: ~350 MB to 450 MB resident memory during operation.
- **Disk**: ~500 MB in `osrm-data/`.
- **Platform**: Compatible with both `amd64` (Intel/AMD x86_64) and `arm64` (Apple Silicon Mac & Raspberry Pi 4/5).

## Updating Map Data
OpenStreetMap data can be refreshed as roads update (typically every 3–6 months):
```bash
cd osrm
./setup-osrm.sh
docker compose restart osrm
```
