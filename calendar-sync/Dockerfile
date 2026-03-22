# Dockerfile for Unified Calendar Sync (Polling + Webhooks)
FROM python:3.10-slim
WORKDIR /app

# Copy source files
COPY main.py ./
COPY booking_model.py ./
COPY square_booking_connector.py ./
COPY google_calendar_connector.py ./
COPY requirements.txt ./

# Install all dependencies
RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 5001
CMD ["python", "main.py", "serve"]
