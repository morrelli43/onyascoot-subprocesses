FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir rembg[cli]

EXPOSE 4317

ENTRYPOINT ["rembg"]
CMD ["s", "--host", "0.0.0.0", "--port", "4317"]
