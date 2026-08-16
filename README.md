# OYS Live Subprocesses 🚀

A modular microservice stack designed to handle contact synchronization, automated alerts, and specialized routing for the OYS platform.

## 🏗️ Architecture Overview

The system architecture has been modernized into a specialized routing stack to ensure smooth frontend integration and reliable data propagation.

```mermaid
graph TD
    A[Frontend / Mobile App] -->|POST /send-it| B(Message Router - Port 4300)
    B -->|Async Fan-out| C[Contact Sync - Port 4310]
    B -->|Async Fan-out| D[Email Service - Port 4311]
    B -->|Async Fan-out| E[Nodeifier - Port 4312]
    B -->|Async Fan-out| F[Ops Forwarder - Port 4313]
    
    C -->|API| G[Google Contacts]
    C -->|API| S[Square Up]
    D -->|SMTP| M[Recipient Inbox]
    E -->|Webhook| N[Alerting Systems / n8n]
    F -->|POST /api/webhooks/customer| O[OYS Operations Site]
```

## 📦 Services Summary

| Service | Port | Description |
| :--- | :--- | :--- |
| **Message Router** | `4300` | The primary entry point. Transforms raw JSON and routes it downstream. |
| **Contact Sync** | `4310` | Synchronizes data between Square, Google, and local storage. |
| **Email Service** | `4311` | Pure SMTP service for sending alerts and confirmations. |
| **Nodeifier** | `4312` | Centralized alerting service for pushing notifications to webhooks. |
| **Ops Forwarder** | `4313` | Forwards form submissions to the OYS Operations site. |

---

## 🚀 Getting Started

### Prerequisites

- Docker and Docker Compose
- Node.js (for local service development)
- Python 3.11+ (for Contact Sync development)

### Environment Configuration

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Configure the required secrets:
   - `SQUARE_ACCESS_TOKEN`
   - `SMTP_USER` / `SMTP_PASS`
   - `GOOGLE_CREDENTIALS_FILE` (Path to JSON)
   - `OYS_OPS_URL` / `OYS_OPS_PORT` (Operations site endpoint — defaults to `http://localhost:3002`)

---

## 🛠️ Development & Deployment

### Docker Deployment (Recommended)

The stack is designed to run cohesively using Docker Compose.

```bash
# Build and start the entire stack
docker compose up -d
```

### CI/CD Workflow

Deployment is handled via GitHub Actions (`.github/workflows/docker-publish.yml`). 
- **Staging**: Deploys on push to `staging` branch.
- **Production**: Deploys on push to `live` or `main` branches.

All images are built for multi-platform support (`linux/amd64`, `linux/arm64`) to support Raspberry Pi and cloud deployments.

---

## 🔌 API Interaction

### Submitting Data

The **Message Router** is the single point of contact for the frontend.

**Endpoint:** `POST http://<host>:4300/submit`

**Sample Payload:**
```json
{
  "first_name": "John",
  "surname": "Doe",
  "number": "0412 345 678",
  "location": "Sydney",
  "address_line_1": "123 Main Street",
  "suburb": "Sydney CBD",
  "state": "NSW",
  "postcode": "2000",
  "country": "Australia",
  "escooter_make": "Apollo",
  "escooter_model": "Air",
  "issue": "Brake Adjustment",
  "issue_extra": "The rear brake is squeaking and needs tightening."
}
```

The Message Router fans this out to **Contact Sync**, **Email Service**, **Nodeifier**, and the **Ops Forwarder** (which POSTs to the Operations site at `/api/webhooks/customer`).

---

## 📁 Project Structure

```text
oys_live_subprocesses/
├── message-router/   # Entry point & fan-out logic (Node.js)
├── contact-sync/     # Python Sync Engine (Square <-> Google)
├── email-service/    # SMTP Sending Service (Node.js)
├── nodeifier/        # Alerting & Webhook Service (Node.js)
├── ops-forwarder/    # Forwards submissions to OYS Ops site (Node.js)
├── docker-compose.yml # Orchestration
└── .github/          # CI/CD Workflows
```

---

## ⚖️ License

This project is specialized for OYS internal infrastructure. See LICENSE for details.
