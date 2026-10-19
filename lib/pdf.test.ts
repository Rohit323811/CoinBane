import assert from "node:assert/strict";
import { describe, it } from "node:test";

import jsQR from "jsqr";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { PNG } from "pngjs";

import {
  formatPdfMoney,
  generateInvoicePdf,
  invoiceQrDataUrl,
  pdfSafe,
} from "./pdf.ts";
import type { InvoicePayload } from "./types.ts";

/**
 * The PDF is verified by reading it back, not by trusting that pdf-lib did what
 * it was asked: the bytes must reload as a document, and the QR in it must
 * decode to the PayPal page. A rendered page is otherwise unreadable to a test.
 */

const PAY_URL = "https://www.sandbox.paypal.com/invoice/p/#7BJXYWVPTF9ZCYW2";

const SAMPLE: InvoicePayload = {
  id: "INV2-7BJX-YWVP-TF9Z-CYW2",
  number: "1042",
  status: "DRAFT",
  client: "Acme Studio",
  currency: "USD",
  total: 2100,
  issued: "2026-10-14",
  due: null,
  items: [
    {
      description: "Design retainer — Brand system and handoff",
      quantity: 12,
      unit: "HOURS",
      unitAmount: 150,
      amount: 1800,
    },
    { description: "Rush fee", quantity: 1, unit: null, unitAmount: 300, amount: 300 },
  ],
  payUrl: PAY_URL,
  invoicer: {
    name: "Rohit",
    business: "CoinBane Studio",
    email: "rohit@coinbane.example",
    lines: ["1 Ledger Lane", "Austin, TX", "78701", "US"],
  },
  recipient: {
    name: "Acme Studio",
    business: "Acme Studio",
    email: "billing@acme.example",
    lines: [],
  },
};

/** True when the document carries an embedded raster image — the QR. */
function hasImage(doc: PDFDocument): boolean {
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) return true;
  }
  return false;
}

function decodeQr(dataUrl: string): string | null {
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  const png = PNG.sync.read(Buffer.from(base64, "base64"));
  const decoded = jsQR(Uint8ClampedArray.from(png.data), png.width, png.height);
  return decoded ? decoded.data : null;
}

describe("invoiceQrDataUrl", () => {
  it("encodes the exact PayPal link, and the code scans back to it", async () => {
    const dataUrl = await invoiceQrDataUrl(PAY_URL);
    assert.match(dataUrl, /^data:image\/png;base64,/);
    assert.equal(decodeQr(dataUrl), PAY_URL);
  });

  it("encodes a different link as a different code", async () => {
    const other = "https://www.paypal.com/invoice/p/#AAAABBBBCCCCDDDD";
    assert.equal(decodeQr(await invoiceQrDataUrl(other)), other);
    assert.notEqual(decodeQr(await invoiceQrDataUrl(other)), PAY_URL);
  });
});

describe("generateInvoicePdf", () => {
  it("returns a PDF that reloads as one page with the QR embedded", async () => {
    const bytes = await generateInvoicePdf(SAMPLE);
    assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");

    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
    assert.ok(hasImage(doc), "the QR image must be embedded in the document");

    // The metadata is what a reader shows in its title bar, so it has to be
    // populated rather than left as pdf-lib's default.
    assert.equal(doc.getTitle(), "Invoice 1042 - Acme Studio");
    assert.equal(doc.getCreator(), "CoinBane");
  });

  it("renders an invoice with no PayPal link, without a QR", async () => {
    const bytes = await generateInvoicePdf({ ...SAMPLE, payUrl: null });
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), 1);
    assert.equal(hasImage(doc), false, "no link means no QR to print");
  });

  it("still produces a document when there are no line items", async () => {
    const bytes = await generateInvoicePdf({ ...SAMPLE, items: [] });
    await assert.doesNotReject(() => PDFDocument.load(bytes));
  });

  it("runs a long invoice onto more pages instead of off the page", async () => {
    const items = Array.from({ length: 60 }, (_, index) => ({
      description: `Retainer block ${index + 1}`,
      quantity: 1,
      unit: null,
      unitAmount: 100,
      amount: 100,
    }));
    const doc = await PDFDocument.load(
      await generateInvoicePdf({ ...SAMPLE, items, total: 6000 }),
    );
    assert.ok(doc.getPageCount() > 1, "60 lines do not fit on one page");
  });

  it("does not throw on the punctuation a real client name carries", async () => {
    const bytes = await generateInvoicePdf({
      ...SAMPLE,
      client: "Müller & Söhne “Design” GmbH — € 0",
      items: [{ ...SAMPLE.items[0], description: "Café redesign 😀 — phase 2" }],
    });
    await assert.doesNotReject(() => PDFDocument.load(bytes));
  });
});

describe("pdfSafe", () => {
  it("maps punctuation the standard fonts cannot encode", () => {
    assert.equal(pdfSafe("“Pay” — now…"), '"Pay" - now...');
  });

  it("drops characters outside the encoding rather than throwing", () => {
    // One replacement per code point: the emoji is a single character, not two
    // halves of a surrogate pair.
    assert.equal(pdfSafe("Acme 😀 Studio"), "Acme ? Studio");
    assert.equal(pdfSafe("Ünïcode ok"), "Ünïcode ok");
  });
});

describe("formatPdfMoney", () => {
  it("prints dollars with a sign and other currencies with their code", () => {
    assert.equal(formatPdfMoney(2100, "USD"), "$2,100.00");
    assert.equal(formatPdfMoney(2100, "usd"), "$2,100.00");
    assert.equal(formatPdfMoney(1200.5, "EUR"), "EUR 1,200.50");
  });
});
