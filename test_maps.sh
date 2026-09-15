#!/usr/bin/env bash
# ==============================================================================
# test_maps.sh - Test Google Maps (4315) & OSRM (5000) Endpoints
# ==============================================================================
MAPS_PORT=${1:-4315}
OSRM_PORT=${2:-5000}

echo "==========================================================="
echo "1. Testing Independent OSRM Container at http://localhost:$OSRM_PORT"
echo "==========================================================="
curl -s "http://localhost:$OSRM_PORT/table/v1/driving/145.0232,-37.8913;144.9980,-37.8230?annotations=duration,distance" | jq . 2>/dev/null || curl -s "http://localhost:$OSRM_PORT/table/v1/driving/145.0232,-37.8913;144.9980,-37.8230"

echo -e "\n\n==========================================================="
echo "2. Testing Independent Google Maps API at http://localhost:$MAPS_PORT"
echo "==========================================================="
echo "Health Check:"
curl -s "http://localhost:$MAPS_PORT/health" | jq . 2>/dev/null || curl -s "http://localhost:$MAPS_PORT/health"

echo -e "\n\nTravel Time (Caulfield South -> Richmond):"
curl -s -X POST "http://localhost:$MAPS_PORT/travel-time" \
     -H "Content-Type: application/json" \
     -d '{
       "origin": "391 Hawthorn Road, Caulfield South VIC 3162, Australia",
       "destination": "123 Bridge Road, Richmond VIC 3121, Australia"
     }' | jq . 2>/dev/null || true

echo -e "\n\nTest complete."
