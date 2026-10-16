# OnyaScoot Label Printer Subprocess

Standalone microservice running inside `onyascoot-subprocesses` to handle high-speed, silent thermal label printing to the networked **Brother QL-810W** via CUPS (IPP Everywhere).

## Port
`4317` (default)

## Features
- **Zero-Dialog Silent Printing:** Direct IPP document submission to CUPS at `http://172.17.43.12:631`.
- **Ultra-Fast Batch Printing:** Generates multi-page PDFs to stream 10–20+ labels in a single job.
- **Precise 300 DPI Vector Rendering:** Razor-sharp barcodes (Code128) with zero antialiasing fuzz.
- **Auto-Cut Support:** Formatted to 28mm length on 62mm continuous rolls with cutter clearance.
- **Stock Label Templates:**
  - `stock - small` (62×28mm): Category breadcrumb + title top-left, larger QR code top-right, Price & SKU middle, Code128 barcode + height-matched OnyaScoot logo at bottom.
  - `stock - medium` (62×54mm): Medium shelf/box layout scaled for 54mm height.
  - `stock - large` (62×100mm): Large carton/tyre/box layout scaled for 100mm height.

## Endpoints
- `GET /health` — Service health and CUPS target info.
- `GET /api/printer/status` — Live printer queue status query.
- `POST /api/print/test` — Dispatches a single test label.
- `POST /api/print/labels` — Accepts `{ items: [{ title, sku, price, barcode, quantity }], template?: string }`.
