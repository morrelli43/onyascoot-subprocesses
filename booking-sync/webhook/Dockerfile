# Dockerfile for Square webhook receiver
FROM python:3.10-slim
WORKDIR /app
# Copy all booking-sync source files (for robust context handling)
COPY main.py ./
COPY booking_model.py ./
COPY square_booking_connector.py ./
COPY google_calendar_connector.py ./
COPY requirements.txt ./requirements-base.txt
COPY webhook/requirements.txt ./requirements.txt
COPY webhook/app.py ./
# Install all dependencies (base + webhook)
RUN pip install --no-cache-dir -r requirements-base.txt && pip install --no-cache-dir -r requirements.txt
CMD ["python", "app.py"]
