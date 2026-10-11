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
 * Render Modern Open Template (Locked-in Production Choice)
 * Title left, Logo top-right, Price left, SKU right under logo, Barcode bottom
 */
function renderModernOpenPage(doc, item, heightPt) {
  const leftMargin = 10;
  const rightMargin = 14; // Protect right edge from thermal cut margin
  const topY = 10;

  // 1. Right Column: Logo
  const logoWidth = 44;
  const logoHeight = logoWidth / (2000 / 906); // ~19.9 pt
  const logoX = WIDTH_PT - rightMargin - logoWidth; // ~117.75 pt
  const logoY = topY;

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, logoX, logoY, { width: logoWidth, height: logoHeight });
  }

  // 2. Left Column: Product Title
  const leftColX = leftMargin;
  const leftColWidth = logoX - leftColX - 6; // ~101.75 pt

  const titleText = (item.title || "ITEM NAME").toUpperCase();
  doc.fontSize(8.1).font("Helvetica-Bold").fillColor("#000000")
    .text(titleText, leftColX, topY, {
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

  // 4. Barcode
  if (item._barcodePng) {
    const barcodeHeight = 18;
    const barcodeY = heightPt - barcodeHeight - 7;
    const barcodeX = 12;
    const barcodeWidth = WIDTH_PT - 24;
    doc.image(item._barcodePng, barcodeX, barcodeY, { width: barcodeWidth, height: barcodeHeight });
  }
}

/**
 * Render Classic Hairline Template (Preserved Template A)
 * Logo left, Hairline divider, Title right, SKU left, Price right, Barcode bottom
 */
function renderClassicHairlinePage(doc, item, heightPt) {
  const rightMargin = 14;
  const leftMargin = 10;
  const colDividerX = 56;
  const rightColX = 62;
  const rightColWidth = WIDTH_PT - rightColX - rightMargin;

  const lineTopY = 10;
  const lineBottomY = 49;

  // 1. Hairline divider
  doc.moveTo(colDividerX, lineTopY)
     .lineTo(colDividerX, lineBottomY)
     .lineWidth(0.35)
     .strokeColor("#000000")
     .stroke();

  // 2. Logo Left Column (vertically centered)
  const logoWidth = 44;
  const logoHeight = logoWidth / (2000 / 906);
  const lineCenterY = (lineTopY + lineBottomY) / 2;
  const logoY = lineCenterY - (logoHeight / 2);

  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, leftMargin, logoY, { width: logoWidth, height: logoHeight });
  }

  // 3. Title Right Column
  const titleText = (item.title || "ITEM NAME").toUpperCase();
  doc.fontSize(8.1).font("Helvetica-Bold").fillColor("#000000")
    .text(titleText, rightColX, 10, {
      width: rightColWidth,
      align: "left",
      lineGap: -0.2
    });

  // 4. SKU & Price
  const skuPriceY = lineBottomY - 8.5;
  const skuDisplay = item.sku || "";
  if (skuDisplay) {
    doc.fontSize(5.6).font("Helvetica").fillColor("#000000")
      .text(skuDisplay, rightColX, skuPriceY + 1.4, {
        width: rightColWidth - 40,
        align: "left"
      });
  }

  const priceDisplay = item.price !== undefined && item.price !== null
    ? (typeof item.price === "number" ? `$${item.price.toFixed(2)}` : (String(item.price).startsWith("$") ? item.price : `$${item.price}`))
    : "";

  if (priceDisplay) {
    doc.fontSize(7.4).font("Helvetica-Bold").fillColor("#000000")
      .text(priceDisplay, rightColX, skuPriceY, {
        width: rightColWidth,
        align: "right"
      });
  }

  // 5. Barcode
  if (item._barcodePng) {
    const barcodeHeight = 18;
    const barcodeY = heightPt - barcodeHeight - 7;
    const barcodeX = 12;
    const barcodeWidth = WIDTH_PT - 24;
    doc.image(item._barcodePng, barcodeX, barcodeY, { width: barcodeWidth, height: barcodeHeight });
  }
}

/**
 * Generate a multi-page PDF buffer containing batch labels
 */
async function generateLabelsPdf(items, options = {}) {
  const heightMm = options.labelHeightMm || DEFAULT_LABEL_HEIGHT_MM;
  const heightPt = heightMm * MM_TO_PT;
  const template = options.template || "modern_open";

  // Pre-generate unique barcodes
  const barcodeCache = new Map();
  for (const item of items) {
    const code = item.barcode || item.sku || "00000000";
    if (!barcodeCache.has(code)) {
      barcodeCache.set(code, await generateBarcode(code));
    }
  }

  // Expand items by quantity
  const flatLabels = [];
  for (const it of items) {
    const qty = Math.max(1, parseInt(it.quantity || 1, 10));
    const barcodePng = barcodeCache.get(it.barcode || it.sku || "00000000");
    for (let i = 0; i < qty; i++) {
      flatLabels.push({ ...it, _barcodePng: barcodePng });
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
    doc.on("end", () => resolve({ pdfBuffer: Buffer.concat(buffers), totalLabels: flatLabels.length }));
    doc.on("error", reject);

    for (const label of flatLabels) {
      doc.addPage({
        size: [WIDTH_PT, heightPt],
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
      });

      if (template === "classic_hairline") {
        renderClassicHairlinePage(doc, label, heightPt);
      } else {
        renderModernOpenPage(doc, label, heightPt);
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
    const template = req.body.template || "modern_open";
    const testItem = {
      title: "FRONT HYDRAULIC FORK SUSPENSION ASSEMBLY",
      sku: "OYS-20941-FSK",
      price: 145.00,
      barcode: "OYS-20941-FSK",
      quantity: 1,
    };

    const { pdfBuffer } = await generateLabelsPdf([testItem], { template });
    const result = await sendPdfToCups(pdfBuffer, { jobName: "OYS Test Print" });

    res.json({
      success: true,
      message: "Test label dispatched to Brother QL-810W",
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
    const { items, template = "modern_open", labelHeightMm = DEFAULT_LABEL_HEIGHT_MM } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: "Items array is required" });
    }

    const { pdfBuffer, totalLabels } = await generateLabelsPdf(items, {
      template,
      labelHeightMm,
    });

    const result = await sendPdfToCups(pdfBuffer, {
      labelHeightMm,
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Label-Printer] Running on port ${PORT}`);
  console.log(`[Label-Printer] CUPS Target: ${CUPS_SERVER_URL}/printers/${CUPS_PRINTER_NAME}`);
});
