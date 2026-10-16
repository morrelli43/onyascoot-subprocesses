const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const bwipjs = require("bwip-js");
const ipp = require("ipp");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = parseInt(process.env.PORT || "4317", 10);
const CUPS_SERVER_URL = process.env.CUPS_SERVER_URL || "http://172.17.43.12:631";
const CUPS_PRINTER_NAME = process.env.CUPS_PRINTER_NAME || "oys_label_printer_ql810w";
const DEFAULT_LABEL_HEIGHT_MM = parseInt(process.env.LABEL_HEIGHT_MM || "28", 10);

const LOGO_PATH = path.join(__dirname, "assets", "logo-mono.png");

// 1 mm = 72 / 25.4 points = 2.834645 pt
const MM_TO_PT = 2.834645;
const ROLL_WIDTH_MM = 62;
const WIDTH_PT = ROLL_WIDTH_MM * MM_TO_PT; // 175.75 pt

function getPrinterInstance() {
  return ipp.Printer(`${CUPS_SERVER_URL}/printers/${CUPS_PRINTER_NAME}`);
}

/**
 * Generate a Code128 barcode buffer
 */
async function generateBarcode(codeText) {
  return bwipjs.toBuffer({
    bcid: "code128",
    text: String(codeText).trim(),
    scale: 3,
    height: 6,
    includetext: false,
  });
}

/**
 * Generate a QR code buffer for mobile quick-stock scanning
 */
async function generateQrCode(url) {
  return bwipjs.toBuffer({
    bcid: "qrcode",
    text: String(url).trim(),
    scale: 4,
    padding: 0,
  });
}

/**
 * Resolve template identifier and default label height in mm
 */
function resolveTemplate(templateInput) {
  const norm = String(templateInput || "stock - small").trim().toLowerCase();
  if (norm === "job label" || norm === "job_label" || norm === "job - label") {
    return { id: "Job Label", heightMm: 100 };
  }
  if (norm === "stock - medium" || norm === "stock_medium" || norm === "medium") {
    return { id: "stock - medium", heightMm: 54 };
  }
  if (norm === "stock - large" || norm === "stock_large" || norm === "large") {
    return { id: "stock - large", heightMm: 100 };
  }
  return { id: "stock - small", heightMm: DEFAULT_LABEL_HEIGHT_MM };
}

/**
 * Render Stock - Small Template (62x28mm Production Label)
 * Breadcrumb + Title top-left, Larger QR Code top-right,
 * Price middle-left, SKU middle-right,
 * Barcode bottom-left, Logo bottom-right (same height as barcode)
 */
function renderStockSmallPage(doc, item, heightPt) {
  const leftMargin = 10;
  const rightMargin = 14; // Protect right edge from thermal cut margin
  const topY = 10;

  // 1. Top-Right: Larger QR Code for easy mobile scanning
  const qrSize = 27.5; // ~9.7mm square (significantly larger than previous 19.5pt)
  const qrX = WIDTH_PT - rightMargin - qrSize; // ~134.25 pt
  const qrY = topY - 1; // 9 pt (bottom at 36.5 pt, cleanly above SKU at 41.5 pt)

  if (item._qrPng) {
    doc.image(item._qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  }

  // 2. Top-Left: Category Breadcrumbs & Product Title
  const leftColX = leftMargin;
  const leftColWidth = qrX - leftColX - 6; // ~118.25 pt

  const breadcrumbText = String(item.breadcrumb || item.category || "").trim();
  let titleY = topY;

  if (breadcrumbText) {
    // Very small category breadcrumb above product name (e.g. "Wheels > Bearings")
    doc.fontSize(4.8).font("Helvetica").fillColor("#000000")
      .text(breadcrumbText, leftColX, topY - 1, {
        width: leftColWidth,
        align: "left",
        ellipsis: true
      });
    titleY = topY + 5.5;
  }

  const titleText = (item.title || "ITEM NAME").toUpperCase();
  const titleFontSize = breadcrumbText ? 7.6 : 8.1;
  doc.fontSize(titleFontSize).font("Helvetica-Bold").fillColor("#000000")
    .text(titleText, leftColX, titleY, {
      width: leftColWidth,
      align: "left",
      lineGap: -0.2
    });

  // 3. Shared Baseline: PRICE (left) & SKU (right) — 5.6pt regular
  const skuPriceY = 41.5;
  const priceDisplay = item.price !== undefined && item.price !== null
    ? (typeof item.price === "number" ? `$${item.price.toFixed(2)}` : (String(item.price).startsWith("$") ? item.price : `$${item.price}`))
    : "";

  if (priceDisplay) {
    doc.fontSize(5.6).font("Helvetica").fillColor("#000000")
      .text(priceDisplay, leftColX, skuPriceY, {
        width: 60,
        align: "left"
      });
  }

  const skuDisplay = item.sku || "";
  if (skuDisplay) {
    doc.fontSize(5.6).font("Helvetica").fillColor("#000000")
      .text(skuDisplay, WIDTH_PT - rightMargin - 70, skuPriceY, {
        width: 70,
        align: "right"
      });
  }

  // 4. Bottom Row: Barcode (Left) & Logo (Right, exact same height as barcode)
  const bottomMargin = 8.5; // ~3.0mm safety margin to prevent bottom thermal cut clipping
  const barcodeHeight = 16.5;
  const bottomRowY = heightPt - barcodeHeight - bottomMargin;

  const logoHeight = barcodeHeight; // Match barcode height (16.5 pt)
  const logoWidth = logoHeight * (2000 / 906); // ~36.42 pt
  const logoX = WIDTH_PT - rightMargin - logoWidth;
  const logoY = bottomRowY;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth, height: logoHeight });
  }

  if (item._barcodePng) {
    const barcodeX = leftMargin;
    const barcodeWidth = logoX - barcodeX - 7;
    doc.image(item._barcodePng, barcodeX, bottomRowY, { width: barcodeWidth, height: barcodeHeight });
  }
}

/**
 * Render Stock - Medium Template (62x54mm Production Label)
 * Proportional medium layout with larger QR code, bold title, Price/SKU row,
 * and taller barcode + height-matched OnyaScoot logo at bottom.
 */
function renderStockMediumPage(doc, item, heightPt) {
  const leftMargin = 11;
  const rightMargin = 14;
  const topY = 12;

  // 1. Top-Right: Medium-Large QR Code
  const qrSize = 42; // ~14.8mm square
  const qrX = WIDTH_PT - rightMargin - qrSize; // ~119.75 pt
  const qrY = topY;

  if (item._qrPng) {
    doc.image(item._qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  }

  // 2. Top-Left: Category Breadcrumbs & Product Title
  const leftColX = leftMargin;
  const leftColWidth = qrX - leftColX - 8; // ~100.75 pt

  const breadcrumbText = String(item.breadcrumb || item.category || "").trim();
  let titleY = topY;

  if (breadcrumbText) {
    doc.fontSize(6.5).font("Helvetica").fillColor("#000000")
      .text(breadcrumbText, leftColX, topY, {
        width: leftColWidth,
        align: "left",
        ellipsis: true
      });
    titleY = topY + 9;
  }

  const titleText = (item.title || "ITEM NAME").toUpperCase();
  const titleFontSize = breadcrumbText ? 10.2 : 11.0;
  doc.fontSize(titleFontSize).font("Helvetica-Bold").fillColor("#000000")
    .text(titleText, leftColX, titleY, {
      width: leftColWidth,
      align: "left",
      lineGap: 0.5
    });

  // 3. Shared Baseline: PRICE (left) & SKU (right)
  const skuPriceY = 86;
  const priceDisplay = item.price !== undefined && item.price !== null
    ? (typeof item.price === "number" ? `$${item.price.toFixed(2)}` : (String(item.price).startsWith("$") ? item.price : `$${item.price}`))
    : "";

  if (priceDisplay) {
    doc.fontSize(8.5).font("Helvetica").fillColor("#000000")
      .text(priceDisplay, leftColX, skuPriceY, {
        width: 75,
        align: "left"
      });
  }

  const skuDisplay = item.sku || "";
  if (skuDisplay) {
    doc.fontSize(8.5).font("Helvetica").fillColor("#000000")
      .text(skuDisplay, WIDTH_PT - rightMargin - 85, skuPriceY, {
        width: 85,
        align: "right"
      });
  }

  // 4. Bottom Row: Barcode (Left) & Logo (Right, exact same height as barcode)
  const bottomMargin = 11;
  const barcodeHeight = 25;
  const bottomRowY = heightPt - barcodeHeight - bottomMargin;

  const logoHeight = barcodeHeight; // Match barcode height (25 pt)
  const logoWidth = logoHeight * (2000 / 906); // ~55.19 pt
  const logoX = WIDTH_PT - rightMargin - logoWidth;
  const logoY = bottomRowY;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth, height: logoHeight });
  }

  if (item._barcodePng) {
    const barcodeX = leftMargin;
    const barcodeWidth = logoX - barcodeX - 8;
    doc.image(item._barcodePng, barcodeX, bottomRowY, { width: barcodeWidth, height: barcodeHeight });
  }
}

/**
 * Render Stock - Large Template (62x100mm Production Label)
 * High-visibility large box/shelf label with large QR code, prominent title,
 * large Price/SKU row, and tall barcode + height-matched OnyaScoot logo at bottom.
 */
function renderStockLargePage(doc, item, heightPt) {
  const leftMargin = 12;
  const rightMargin = 14;
  const topY = 15;

  // 1. Top-Right: Large QR Code for long-range scanning
  const qrSize = 54; // ~19.0mm square
  const qrX = WIDTH_PT - rightMargin - qrSize; // ~107.75 pt
  const qrY = topY;

  if (item._qrPng) {
    doc.image(item._qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  }

  // 2. Top-Left: Category Breadcrumbs & Product Title
  const leftColX = leftMargin;
  const leftColWidth = qrX - leftColX - 8; // ~87.75 pt

  const breadcrumbText = String(item.breadcrumb || item.category || "").trim();
  let titleY = topY;

  if (breadcrumbText) {
    doc.fontSize(8.0).font("Helvetica").fillColor("#000000")
      .text(breadcrumbText, leftColX, topY, {
        width: leftColWidth,
        align: "left",
        ellipsis: true
      });
    titleY = topY + 12;
  }

  const titleText = (item.title || "ITEM NAME").toUpperCase();
  const titleFontSize = breadcrumbText ? 13.0 : 14.0;
  doc.fontSize(titleFontSize).font("Helvetica-Bold").fillColor("#000000")
    .text(titleText, leftColX, titleY, {
      width: leftColWidth,
      align: "left",
      lineGap: 1.0
    });

  // 3. Shared Baseline: PRICE (left) & SKU (right)
  const skuPriceY = 178;
  const priceDisplay = item.price !== undefined && item.price !== null
    ? (typeof item.price === "number" ? `$${item.price.toFixed(2)}` : (String(item.price).startsWith("$") ? item.price : `$${item.price}`))
    : "";

  if (priceDisplay) {
    doc.fontSize(11.5).font("Helvetica").fillColor("#000000")
      .text(priceDisplay, leftColX, skuPriceY, {
        width: 80,
        align: "left"
      });
  }

  const skuDisplay = item.sku || "";
  if (skuDisplay) {
    doc.fontSize(11.5).font("Helvetica").fillColor("#000000")
      .text(skuDisplay, WIDTH_PT - rightMargin - 90, skuPriceY, {
        width: 90,
        align: "right"
      });
  }

  // 4. Bottom Row: Barcode (Left) & Logo (Right, exact same height as barcode)
  const bottomMargin = 14;
  const barcodeHeight = 31;
  const bottomRowY = heightPt - barcodeHeight - bottomMargin;

  const logoHeight = barcodeHeight; // Match barcode height (31 pt)
  const logoWidth = logoHeight * (2000 / 906); // ~68.43 pt
  const logoX = WIDTH_PT - rightMargin - logoWidth;
  const logoY = bottomRowY;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth, height: logoHeight });
  }

  if (item._barcodePng) {
    const barcodeX = leftMargin;
    const barcodeWidth = logoX - barcodeX - 8;
    doc.image(item._barcodePng, barcodeX, bottomRowY, { width: barcodeWidth, height: barcodeHeight });
  }
}

/**
 * Render Job Label Template (62x100mm Customer & Workshop Job Tag)
 * Includes:
 * - Job Number & Date Started (top-left)
 * - Bigger QR Code to Job Panel (top-right)
 * - eScooter Make & Model
 * - Customer Name & Customer Address
 * - Customer Phone Number + Small QR Code to start Phone Dialler (tel:)
 * - OnyaScoot Company Logo (bottom)
 */
function renderJobLabelPage(doc, item, heightPt) {
  const leftMargin = 12;
  const rightMargin = 14;
  const fullWidth = WIDTH_PT - leftMargin - rightMargin; // ~149.75 pt

  // 1. Top-Right: Bigger QR Code to the Job Panel
  const jobQrSize = 56; // ~19.8mm square
  const jobQrX = WIDTH_PT - rightMargin - jobQrSize; // ~105.75 pt
  const jobQrY = 14;

  if (item._jobQrPng || item._qrPng) {
    doc.image(item._jobQrPng || item._qrPng, jobQrX, jobQrY, {
      width: jobQrSize,
      height: jobQrSize,
    });
    doc.fontSize(5.2).font("Helvetica-Bold").fillColor("#000000")
      .text("JOB PANEL", jobQrX, jobQrY + jobQrSize + 2.5, {
        width: jobQrSize,
        align: "center",
      });
  }

  // 2. Top-Left: Job Number & Date Started
  const leftColWidth = jobQrX - leftMargin - 8; // ~85.75 pt
  const jobNumberText = String(item.jobNumber || item.sku || item.uid || "JOB-0000").trim();
  const dateStartedText = String(item.dateStarted || "Unknown Date").trim();

  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("JOB NUMBER", leftMargin, 14, { width: leftColWidth, align: "left" });

  doc.fontSize(10.5).font("Helvetica-Bold").fillColor("#000000")
    .text(jobNumberText, leftMargin, 21.5, {
      width: leftColWidth,
      align: "left",
      ellipsis: true,
    });

  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("DATE STARTED", leftMargin, 43, { width: leftColWidth, align: "left" });

  doc.fontSize(8.8).font("Helvetica-Bold").fillColor("#000000")
    .text(dateStartedText, leftMargin, 50.5, {
      width: leftColWidth,
      align: "left",
      ellipsis: true,
    });

  // 3. eScooter Make & Model
  const scooterText = String(item.scooterName || item.breadcrumb || "UNLISTED ESCOOTER").trim().toUpperCase();
  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("ESCOOTER", leftMargin, 83, { width: fullWidth, align: "left" });

  doc.fontSize(9.5).font("Helvetica-Bold").fillColor("#000000")
    .text(scooterText, leftMargin, 90.5, {
      width: fullWidth,
      height: 24,
      align: "left",
      ellipsis: true,
    });

  // 4. Customer Name & Address
  const customerNameText = String(item.customerName || item.title || "CUSTOMER").trim().toUpperCase();
  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("CUSTOMER", leftMargin, 118, { width: fullWidth, align: "left" });

  doc.fontSize(11.5).font("Helvetica-Bold").fillColor("#000000")
    .text(customerNameText, leftMargin, 125.5, {
      width: fullWidth,
      height: 27,
      align: "left",
      ellipsis: true,
    });

  const customerAddressText = String(item.customerAddress || "No address on file").trim();
  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("ADDRESS", leftMargin, 155, { width: fullWidth, align: "left" });

  doc.fontSize(8.2).font("Helvetica").fillColor("#000000")
    .text(customerAddressText, leftMargin, 162.5, {
      width: fullWidth,
      height: 22,
      align: "left",
      ellipsis: true,
    });

  // 5. Customer Phone Number (left) + Small Phone Dialler QR Code (right)
  const telQrSize = 32; // ~11.3mm square (smaller QR code for phone dialler)
  const telQrX = WIDTH_PT - rightMargin - telQrSize; // ~129.75 pt
  const telQrY = 189;
  const phoneColWidth = telQrX - leftMargin - 8;

  const phoneText = String(item.customerPhone || "No phone listed").trim();
  doc.fontSize(5.8).font("Helvetica").fillColor("#000000")
    .text("PHONE NUMBER", leftMargin, 194, { width: phoneColWidth, align: "left" });

  doc.fontSize(11.0).font("Helvetica-Bold").fillColor("#000000")
    .text(phoneText, leftMargin, 202.5, {
      width: phoneColWidth,
      align: "left",
      ellipsis: true,
    });

  if (item._telQrPng) {
    doc.image(item._telQrPng, telQrX, telQrY, {
      width: telQrSize,
      height: telQrSize,
    });
    doc.fontSize(5.0).font("Helvetica-Bold").fillColor("#000000")
      .text("SCAN TO CALL", telQrX - 6, telQrY + telQrSize + 2, {
        width: telQrSize + 12,
        align: "center",
      });
  }

  // 6. Bottom Footer: Company Logo (bottom-right, matching stock label placement)
  const bottomMargin = 14;
  const logoHeight = 29;
  const logoWidth = logoHeight * (2000 / 906); // ~64.02 pt
  const logoX = WIDTH_PT - rightMargin - logoWidth;
  const logoY = heightPt - logoHeight - bottomMargin;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth, height: logoHeight });
  }
}

/**
 * Generate a multi-page PDF buffer containing batch labels
 */
async function generateLabelsPdf(items, options = {}) {
  const resolved = resolveTemplate(options.template);
  const heightMm = options.labelHeightMm || resolved.heightMm;
  const heightPt = heightMm * MM_TO_PT;
  const isJobLabel = resolved.id === "Job Label";

  // Pre-generate unique barcodes and QR codes
  const barcodeCache = new Map();
  const qrCache = new Map();
  for (const item of items) {
    if (isJobLabel) {
      const jobNum = item.jobNumber || item.sku || item.uid || "JOB-0000";
      const jobUrl = item.jobUrl || item.qrUrl || `https://portal.onyascoot.com/dashboard/jobs/active?job=${encodeURIComponent(jobNum)}`;
      if (!qrCache.has(jobUrl)) {
        qrCache.set(jobUrl, await generateQrCode(jobUrl));
      }
      const rawPhone = String(item.customerPhone || "").replace(/[^+\d]/g, "");
      if (rawPhone) {
        const telUrl = `tel:${rawPhone}`;
        if (!qrCache.has(telUrl)) {
          qrCache.set(telUrl, await generateQrCode(telUrl));
        }
      }
    } else {
      const code = item.barcode || item.sku || "00000000";
      if (!barcodeCache.has(code)) {
        barcodeCache.set(code, await generateBarcode(code));
      }
      const qrUrl = item.qrUrl || `https://portal.onyascoot.com/m/stock/${encodeURIComponent(item.sku || code)}`;
      if (!qrCache.has(qrUrl)) {
        qrCache.set(qrUrl, await generateQrCode(qrUrl));
      }
    }
  }

  // Expand items by quantity
  const flatLabels = [];
  for (const it of items) {
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    if (isJobLabel) {
      const jobNum = it.jobNumber || it.sku || it.uid || "JOB-0000";
      const jobUrl = it.jobUrl || it.qrUrl || `https://portal.onyascoot.com/dashboard/jobs/active?job=${encodeURIComponent(jobNum)}`;
      const rawPhone = String(it.customerPhone || "").replace(/[^+\d]/g, "");
      const telUrl = rawPhone ? `tel:${rawPhone}` : null;
      const jobQrPng = qrCache.get(jobUrl);
      const telQrPng = telUrl ? qrCache.get(telUrl) : null;
      for (let i = 0; i < qty; i++) {
        flatLabels.push({ ...it, _jobQrPng: jobQrPng, _telQrPng: telQrPng });
      }
    } else {
      const code = it.barcode || it.sku || "00000000";
      const qrUrl = it.qrUrl || `https://portal.onyascoot.com/m/stock/${encodeURIComponent(it.sku || code)}`;
      const barcodePng = barcodeCache.get(code);
      const qrPng = qrCache.get(qrUrl);
      for (let i = 0; i < qty; i++) {
        flatLabels.push({ ...it, _barcodePng: barcodePng, _qrPng: qrPng });
      }
    }
  }

  if (flatLabels.length === 0) {
    throw new Error("No labels to print");
  }

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
    });

    const buffers = [];
    doc.on("data", (chunk) => buffers.push(chunk));
    doc.on("end", () => resolve({ pdfBuffer: Buffer.concat(buffers), totalLabels: flatLabels.length, heightMm }));
    doc.on("error", reject);

    for (const label of flatLabels) {
      doc.addPage({
        size: [WIDTH_PT, heightPt],
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });

      if (resolved.id === "Job Label") {
        renderJobLabelPage(doc, label, heightPt);
      } else if (resolved.id === "stock - medium") {
        renderStockMediumPage(doc, label, heightPt);
      } else if (resolved.id === "stock - large") {
        renderStockLargePage(doc, label, heightPt);
      } else {
        renderStockSmallPage(doc, label, heightPt);
      }
    }

    doc.end();
  });
}

/**
 * Submit PDF to CUPS via IPP
 */
function sendPdfToCups(pdfBuffer, options = {}) {
  const heightMm = options.labelHeightMm || DEFAULT_LABEL_HEIGHT_MM;
  const jobName = options.jobName || "OYS Label Print";

  return new Promise((resolve, reject) => {
    const printer = getPrinterInstance();

    const jobPayload = {
      "operation-attributes-tag": {
        "requesting-user-name": "onyascoot",
        "job-name": jobName,
        "document-format": "application/pdf",
      },
      "job-attributes-tag": {
        "media": `custom_62x${heightMm}mm_62x${heightMm}mm`,
        "print-quality": 5, // High
      },
      data: pdfBuffer,
    };

    printer.execute("Print-Job", jobPayload, (err, res) => {
      if (err) {
        return reject(err);
      }
      const jobAttrs = res["job-attributes-tag"] || {};
      resolve({
        jobId: jobAttrs["job-id"],
        jobState: jobAttrs["job-state"] || "submitted",
        jobStateReasons: jobAttrs["job-state-reasons"] || "",
      });
    });
  });
}

// -------------------------------------------------------------
// REST ENDPOINTS
// -------------------------------------------------------------

// Health endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "label-printer",
    cupsServer: CUPS_SERVER_URL,
    printerName: CUPS_PRINTER_NAME,
    defaultHeightMm: DEFAULT_LABEL_HEIGHT_MM,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Live printer status query via IPP
app.get("/api/printer/status", (req, res) => {
  const printer = getPrinterInstance();

  printer.execute("Get-Printer-Attributes", {
    "operation-attributes-tag": {
      "requested-attributes": [
        "printer-name",
        "printer-state",
        "printer-state-reasons",
        "printer-state-message",
        "media-default",
      ],
    },
  }, (err, response) => {
    if (err) {
      return res.status(502).json({
        online: false,
        error: err.message || "Failed to reach CUPS printer",
      });
    }

    const attrs = response["printer-attributes-tag"] || {};
    res.json({
      online: true,
      printerName: attrs["printer-name"] || CUPS_PRINTER_NAME,
      state: attrs["printer-state"] || "unknown",
      reasons: attrs["printer-state-reasons"] || "none",
      message: attrs["printer-state-message"] || "",
      mediaDefault: attrs["media-default"] || "custom_62x100mm_62x100mm",
    });
  });
});

// Test print endpoint
app.post("/api/print/test", async (req, res) => {
  try {
    const template = req.body.template || "stock - small";
    const testItem = {
      title: "FRONT HYDRAULIC FORK SUSPENSION ASSEMBLY",
      sku: "OYS-20941-FSK",
      price: 145.00,
      barcode: "OYS-20941-FSK",
      breadcrumb: "Suspension > Forks",
      quantity: 1,
    };

    const { pdfBuffer, heightMm } = await generateLabelsPdf([testItem], { template });
    const result = await sendPdfToCups(pdfBuffer, {
      labelHeightMm: heightMm,
      jobName: `OYS Test Print (${template})`,
    });

    res.json({
      success: true,
      message: `Test label (${template}) dispatched to Brother QL-810W`,
      jobId: result.jobId,
      jobState: result.jobState,
    });
  } catch (err) {
    console.error("Test print failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk / Batch label print endpoint
app.post("/api/print/labels", async (req, res) => {
  try {
    const { items, template = "stock - small", labelHeightMm } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array is required" });
    }

    const { pdfBuffer, totalLabels, heightMm } = await generateLabelsPdf(items, {
      template,
      labelHeightMm,
    });

    const result = await sendPdfToCups(pdfBuffer, {
      labelHeightMm: heightMm,
      jobName: `OYS Batch Print (${totalLabels} labels)`,
    });

    res.json({
      success: true,
      totalLabels,
      jobId: result.jobId,
      jobState: result.jobState,
      message: `Successfully sent ${totalLabels} label(s) to Brother QL-810W`,
    });
  } catch (err) {
    console.error("Batch print error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Label-Printer] Running on port ${PORT}`);
    console.log(`[Label-Printer] CUPS Target: ${CUPS_SERVER_URL}/printers/${CUPS_PRINTER_NAME}`);
  });
}

module.exports = {
  generateLabelsPdf,
  renderStockSmallPage,
  renderStockMediumPage,
  renderStockLargePage,
  renderJobLabelPage,
  resolveTemplate,
};
