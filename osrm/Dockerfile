FROM vattana/osrm-backend-arm64:latest AS builder

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /data

# Download Victoria OSM extract (~230MB) and pre-compile the MLD routing graph
RUN curl -fSL -o victoria-latest.osm.pbf https://download.geofabrik.de/australia-oceania/australia/victoria-latest.osm.pbf \
    && osrm-extract -p /opt/car.lua /data/victoria-latest.osm.pbf \
    && rm -f victoria-latest.osm.pbf \
    && osrm-partition /data/victoria-latest.osrm \
    && osrm-customize /data/victoria-latest.osrm

FROM vattana/osrm-backend-arm64:latest

WORKDIR /data
COPY --from=builder /data /data

EXPOSE 5000

CMD ["osrm-routed", "--algorithm", "mld", "/data/victoria-latest.osrm"]
