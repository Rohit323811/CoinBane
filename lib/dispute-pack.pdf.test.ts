import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inflateSync } from "node:zlib";

import jsQR from "jsqr";
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";

import { assembleProofPack, simulatedDisputes } from "./dispute-pack.ts";
import { generateDisputePackPdf, generateInvoicePdf } from "./pdf.ts";
import type { DisputeProofPack } from "./types.ts";

/**
 * The proof pack is checked the way the invoice PDF is: the bytes are read back
 * and the text inside them is extracted, so an assertion here fails if the
 * document stops saying what it is supposed to say. A pack that renders but
 * drops its evidence list is not a proof pack.
 */

const PAY_URL = "https://www.sandbox.paypal.com/invoice/p/#5BAP9PMP9TP4967Y";

const DISPUTE = {
  dispute_id: "PP-D-27803",
  create_time: "2026-10-05T09:12:00.000Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "OPEN",
  dispute_life_cycle_stage: "CHARGEBACK",
  seller_response_due_date: "2026-10-20T23:59:59.000Z",
  dispute_amount: { currency_code: "USD", value: "2100.00" },
  disputed_transactions: [
    {
      invoice_number: "1042",
      gross_amount: { currency_code: "USD", value: "2100.00" },
      buyer: { name: { given_name: "Acme", surname: "Studio" } },
    },
  ],
  messages: [
    { posted_by: "BUYER", time_posted: "2026-10-05T09:14:00.000Z", content: "Working on it" },
  ],
};

const INVOICE = {
  id: "INV2-5BAP-9PMP-9TP4-967Y",
  status: "SENT",
  detail: {
    currency_code: "USD",
    invoice_number: "1042",
    invoice_date: "2026-09-15",
    payment_term: { term_type: "DUE_ON_DATE", due_date: "2026-10-01" },
    metadata: { recipient_view_url: PAY_URL },
  },
  invoicer: { business_name: "CoinBane Studio", name: { full_name: "Rohit" } },
  primary_recipients: [{ billing_info: { business_name: "Acme Studio" } }],
  items: [
    {
      name: "Design retainer",
      quantity: "12",
      unit_of_measure: "HOURS",
      unit_amount: { currency_code: "USD", value: "150.00" },
    },
  ],
  amount: { currency_code: "USD", value: "2100.00" },
  payments: {
    transactions: [
      {
        payment_id: "PAY-77A",
        payment_date: "2026-10-02",
        method: "PAYPAL",
        amount: { currency_code: "USD", value: "500.00" },
      },
    ],
  },
};

const NOW = new Date("2026-10-14T12:00:00Z");

function deps(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    draftPosition: async () => "Invoice 1042 was issued and remains partly unpaid.",
    readDispute: async () => DISPUTE,
    listDisputes: async () => [DISPUTE],
    readInvoice: async () => INVOICE,
    listInvoices: async () => [],
    ...overrides,
  };
}

async function buildPack(): Promise<DisputeProofPack> {
  const pack = await assembleProofPack({ disputeId: "PP-D-27803" }, deps());
  assert.ok(pack, "the pack must assemble from a dispute that exists");
  return pack;
}

/**
 * A thread and an invoice far heavier than anything a freelancer would file.
 *
 * PayPal imposes no limit on either, so the pack has to hold its length on its
 * own: uncapped, this input rendered fourteen pages.
 */
async function buildHugePack(): Promise<DisputeProofPack> {
  const hugeDispute = {
    ...DISPUTE,
    messages: Array.from({ length: 60 }, (_, index) => ({
      posted_by: index % 2 === 0 ? "BUYER" : "SELLER",
      time_posted: "2026-10-03T09:14:00.000Z",
      content:
        "A client message long enough to wrap across three lines of the timeline column, as a real thread does. ".repeat(
          3,
        ),
    })),
  };
  const hugeInvoice = {
    ...INVOICE,
    items: Array.from({ length: 40 }, (_, index) => ({
      name: `Line item ${index + 1} \u2014 a described deliverable long enough to wrap in the table`,
      quantity: "4",
      unit_of_measure: "HOURS",
      unit_amount: { currency_code: "USD", value: "150.00" },
    })),
    payments: {
      transactions: Array.from({ length: 40 }, (_, index) => ({
        payment_id: `PAY-${200 + index}`,
        payment_date: "2026-10-02",
        method: "PAYPAL",
        amount: { currency_code: "USD", value: "60.00" },
      })),
    },
  };

  const pack = await assembleProofPack(
    { disputeId: "PP-D-27803" },
    deps({
      readDispute: async () => hugeDispute,
      listDisputes: async () => [hugeDispute],
      readInvoice: async () => hugeInvoice,
    }),
  );
  assert.ok(pack);
  return pack;
}

/** Every text run in the document, whitespace-collapsed so it reads as prose. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const runs: string[] = [];

  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const raw = object.getContents();
    let stream: Buffer;
    try {
      stream = inflateSync(raw);
    } catch {
      stream = Buffer.from(raw); // Uncompressed content stream.
    }

    const content = stream.toString("latin1");
    // pdf-lib writes standard-font text as hex strings: `<48656c6c6f> Tj`.
    for (const match of content.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
      const bytes = Buffer.from(match[1].replace(/\s+/g, ""), "hex");
      runs.push(bytes.toString("latin1"));
    }
    for (const match of content.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      runs.push(match[1].replace(/\\([()\\])/g, "$1"));
    }
  }

  return runs.join(" ").replace(/\s+/g, " ").trim();
}

async function hasImage(bytes: Uint8Array): Promise<boolean> {
  const doc = await PDFDocument.load(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (object.dict.lookup(PDFName.of("Subtype")) === PDFName.of("Image")) return true;
  }
  return false;
}

/**
 * The QR buried in the pack, decoded back to its URL.
 *
 * pdf-lib embeds a PNG as a raw RGB sample stream, not as a PNG, so the pixels
 * are inflated and handed to the decoder directly. Decoding the pixels the
 * document actually prints is what proves the code scans — checking that a
 * bitmap was embedded would not.
 */
async function decodePackQr(bytes: Uint8Array): Promise<string | null> {
  const doc = await PDFDocument.load(bytes);
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const dict = object.dict;
    if (dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Image")) continue;

    const width = dict.lookup(PDFName.of("Width"), PDFNumber).asNumber();
    const height = dict.lookup(PDFName.of("Height"), PDFNumber).asNumber();
    const samples = inflateSync(object.getContents());

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      rgba[pixel * 4] = samples[pixel * 3];
      rgba[pixel * 4 + 1] = samples[pixel * 3 + 1];
      rgba[pixel * 4 + 2] = samples[pixel * 3 + 2];
      rgba[pixel * 4 + 3] = 255;
    }

    const decoded = jsQR(rgba, width, height);
    return decoded ? decoded.data : null;
  }
  return null;
}

describe("generateDisputePackPdf — the cover", () => {
  it("states the case, the amount, the date and the required summary", async () => {
    const pack = await buildPack();
    const bytes = await generateDisputePackPdf(pack);
    const text = await pdfText(bytes);

    assert.equal(Buffer.from(bytes.slice(0, 5)).toString("latin1"), "%PDF-");
    assert.match(text, /DISPUTE PROOF PACK/);
    assert.match(text, /Acme Studio/);
    assert.match(text, /PP-D-27803/);
    assert.match(text, /\$2,100\.00 in dispute/);
    assert.match(
      text,
      /This document contains all evidence supporting the freelancer's position in the dispute referenced above\./,
    );
    assert.match(text, /Generated Oct 14, 2026/);
    assert.match(text, /CoinBane/);
    assert.match(text, /Command every coin\./);
  });

  it("labels a real PayPal dispute as one, and carves it out from a fixture", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    assert.match(text, /Dispute record: PayPal sandbox, read directly from the dispute\./);
    assert.doesNotMatch(text, /simulated ledger fixture/);
  });

  it("says so when the dispute is a simulated fixture", async () => {
    const pack = await assembleProofPack(
      { disputeId: simulatedDisputes()[0].summary.id },
      deps({ readDispute: async () => null, listDisputes: async () => [], readInvoice: async () => null }),
    );
    const text = await pdfText(await generateDisputePackPdf(pack!));
    assert.match(text, /simulated ledger fixture/);
    assert.match(text, /prepared draft, not a PayPal case file/);
  });

  it("does not credit a fixture's dates to PayPal in the timeline", async () => {
    /*
     * The reader is PayPal, deciding a case. Every date a simulated pack shows
     * is the ledger's, so none of them may be attributed to PayPal.
     */
    const pack = await assembleProofPack(
      { disputeId: simulatedDisputes()[0].summary.id },
      deps({ readDispute: async () => null, listDisputes: async () => [], readInvoice: async () => null }),
    );
    const text = await pdfText(await generateDisputePackPdf(pack!));
    assert.match(text, /source: simulated/);
    assert.match(text, /source: ledger/);
    assert.doesNotMatch(text, /source: paypal/);
  });

  it("says so when no dispute is on file at all", async () => {
    const pack = await assembleProofPack(
      { invoiceNumber: "1042" },
      deps({ readDispute: async () => null, listDisputes: async () => [] }),
    );
    assert.equal(pack!.dispute, null);
    const text = await pdfText(await generateDisputePackPdf(pack!));
    assert.match(text, /No PayPal dispute is on file for this invoice\./);
    assert.match(text, /None on file/);
  });
});

describe("generateDisputePackPdf — the sections", () => {
  it("numbers every section the pack is required to carry", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    for (const [index, title] of [
      "Invoice details",
      "Communication timeline",
      "Payment history",
      "The freelancer's position",
      "Supporting evidence to attach",
    ].entries()) {
      assert.match(text, new RegExp(`SECTION ${index + 1}`), `section ${index + 1} is missing`);
      assert.ok(text.includes(title), `the heading "${title}" is missing`);
    }
  });

  it("reproduces the invoice, with its line items and total", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    assert.match(text, /INVOICE/);
    assert.match(text, /Design retainer/);
    assert.match(text, /12 hrs/);
    assert.match(text, /\$150\.00/);
    assert.match(text, /TOTAL/);
    assert.match(text, /INVOICE NUMBER 1042/);
    assert.match(text, /Sep 15, 2026/);
  });

  it("carries the timeline with each actor and its source", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    assert.match(text, /Invoice 1042 issued to Acme Studio/);
    assert.match(text, /fell due/);
    assert.match(text, /Acme Studio wrote: "Working on it"/);
    assert.match(text, /Acme Studio opened a dispute/);
    assert.match(text, /Deadline for the seller's response and evidence/);
    assert.match(text, /source: paypal/);
  });

  it("tabulates the payments and the outstanding balance", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    assert.match(text, /Payment history/);
    assert.match(text, /Oct 2, 2026/);
    assert.match(text, /PAY-77A/);
    assert.match(text, /\$500\.00/);
    assert.match(text, /OUTSTANDING/);
    assert.match(text, /\$1,600\.00/);
  });

  it("says the invoice is untouched when nothing was paid", async () => {
    const unpaid = await assembleProofPack(
      { invoiceNumber: "1042" },
      deps({
        readDispute: async () => null,
        listDisputes: async () => [],
        readInvoice: async () => ({ ...INVOICE, payments: undefined }),
      }),
    );
    const text = await pdfText(await generateDisputePackPdf(unpaid!));
    assert.match(text, /No payments have been received against this invoice\./);
    assert.match(text, /The full \$2,100\.00 is outstanding\./);
  });

  it("prints the drafted position and who drafted it", async () => {
    const text = await pdfText(await generateDisputePackPdf(await buildPack()));
    assert.match(text, /Invoice 1042 was issued and remains partly unpaid\./);
    assert.match(text, /Drafted by CoinBane from the records in this pack\./);
  });

  it("prints the position as deterministic prose when the model is unavailable", async () => {
    const pack = await assembleProofPack(
      { disputeId: "PP-D-27803" },
      deps({
        draftPosition: async () => {
          throw new Error("provider down");
        },
      }),
    );
    const text = await pdfText(await generateDisputePackPdf(pack!));
    assert.equal(pack!.position.source, "fallback");
    assert.match(text, /Drafted from the records in this pack without the model/);
  });

  it("lists every piece of evidence as something the freelancer attaches", async () => {
    const pack = await buildPack();
    const text = await pdfText(await generateDisputePackPdf(pack));
    assert.equal(text.match(/\[ATTACH: /g)?.length, pack.evidence.length);
    assert.match(text, /\[ATTACH: The signed contract, statement of work or written agreement with Acme Studio\]/);
    assert.match(text, /\[ATTACH: The delivery email or handoff message that transferred the finished work\]/);
    assert.match(text, /File the response and these attachments with PayPal before Oct 20, 2026\./);
  });
});

describe("generateDisputePackPdf — the document itself", () => {
  it("stays under ten pages even on a thread and invoice far heavier than usual", async () => {
    const bytes = await generateDisputePackPdf(await buildHugePack());
    const doc = await PDFDocument.load(bytes);

    assert.ok(doc.getPageCount() <= 10, `the pack ran to ${doc.getPageCount()} pages`);
    assert.ok(doc.getPageCount() >= 4, "a trimmed pack is still a full document");

    /* Trimming has to be visible, or the gap reads as a quiet client. */
    const text = await pdfText(bytes);
    assert.match(text, /further events are omitted from this timeline/);
    assert.match(text, /earlier payments are omitted from this table/);
    assert.match(text, /The outstanding balance below accounts for all of them\./);
  });

  it("keeps the ends of a trimmed timeline", async () => {
    const pack = await buildHugePack();
    assert.equal(pack.timeline.length, 30);
    assert.ok(pack.timelineOmitted! > 0);

    /* The issue, the send and the due date sit at the front... */
    assert.match(pack.timeline[0].event, /issued to Acme Studio/);
    /* ...and the dispute and its deadline at the back. */
    assert.match(pack.timeline.at(-1)!.event, /Deadline/);
    assert.ok(pack.timeline.some((entry) => entry.event.includes("opened a dispute")));
  });

  it("runs onto multiple pages and embeds the invoice's pay QR", async () => {
    const pack = await buildPack();
    const bytes = await generateDisputePackPdf(pack);
    const doc = await PDFDocument.load(bytes);

    assert.ok(doc.getPageCount() >= 3, "cover, invoice and evidence do not share a page");
    assert.equal(doc.getCreator(), "CoinBane");
    assert.equal(doc.getSubject(), "Dispute proof pack");
    assert.match(doc.getTitle() ?? "", /Dispute proof pack - Acme Studio - \$2,100\.00/);
    assert.ok(await hasImage(bytes), "the pay QR must be embedded");
    assert.equal(await decodePackQr(bytes), PAY_URL);
  });

  it("drops the QR, and says why, when the invoice has no pay link", async () => {
    const pack = await buildPack();
    const bytes = await generateDisputePackPdf({
      ...pack,
      invoice: { ...pack.invoice!, payUrl: null },
    });
    const text = await pdfText(bytes);
    assert.equal(await hasImage(bytes), false);
    assert.match(text, /No PayPal pay link on this invoice yet\./);
  });

  it("keeps going when PayPal will not return the invoice", async () => {
    const pack = await assembleProofPack(
      { disputeId: "PP-D-27803" },
      deps({ readInvoice: async () => null }),
    );
    assert.equal(pack!.invoice, null);
    const bytes = await generateDisputePackPdf(pack!);
    const text = await pdfText(bytes);
    assert.match(text, /PayPal did not return an invoice for this dispute/);
    assert.match(text, /\[ATTACH: /);
    await assert.doesNotReject(() => PDFDocument.load(bytes));
  });

  it("paginates a pack with a long history instead of running off the page", async () => {
    const pack = await buildPack();
    const bytes = await generateDisputePackPdf({
      ...pack,
      timeline: Array.from({ length: 40 }, (_, index) => ({
        date: `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
        event: `Follow-up ${index + 1} sent to the client about the outstanding balance and the terms`,
        actor: "Rohit",
        kind: "schedule" as const,
      })),
      evidence: Array.from({ length: 12 }, (_, index) => ({
        description: `Evidence item ${index + 1}`,
        note: "Attach the file before filing the response with PayPal.",
      })),
    });
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() > 3, "40 events and 12 attachments need more pages");
  });

  it("does not throw on the punctuation a real client name carries", async () => {
    const pack = await buildPack();
    const bytes = await generateDisputePackPdf({
      ...pack,
      client: "Müller & Söhne “Design” GmbH — € 0",
      dispute: { ...pack.dispute!, client: "Müller & Söhne “Design” GmbH — € 0" },
    });
    await assert.doesNotReject(() => PDFDocument.load(bytes));
  });

  it("agrees with the invoice PDF on the invoice it reproduces", async () => {
    const pack = await buildPack();
    const [packText, invoiceText] = await Promise.all([
      pdfText(await generateDisputePackPdf(pack)),
      pdfText(await generateInvoicePdf(pack.invoice!)),
    ]);
    for (const marker of ["Design retainer", "12 hrs", "$150.00", "TOTAL", "$2,100.00"]) {
      assert.ok(packText.includes(marker), `the pack dropped ${marker}`);
      assert.ok(invoiceText.includes(marker), `the invoice dropped ${marker}`);
    }
  });
});
