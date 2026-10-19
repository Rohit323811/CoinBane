import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateHistory } from "./clients.ts";
import {
  assembleProofPack,
  collectDisputes,
  DISPUTE_TOPIC,
  fallbackPositionStatement,
  fixtureDisputesFor,
  parseDispute,
  proofPackFileName,
  simulatedDisputes,
  type PositionFacts,
  type ProofPackDeps,
} from "./dispute-pack.ts";
import { formatDay, ledgerInvoiceToPayload } from "./invoices.ts";
import type { DisputeProofPack } from "./types.ts";

/**
 * Fixtures follow PayPal's disputes v1 payload. The sandbox holds no dispute to
 * compare against, so every field is treated as optional by the parser and the
 * tests cover both a full record and a half-empty one.
 */

const BUYER = "Acme Studio";

const DISPUTE = {
  dispute_id: "PP-D-27803",
  create_time: "2026-10-05T09:12:00.000Z",
  update_time: "2026-10-06T10:00:00.000Z",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "OPEN",
  dispute_state: "REQUIRED_EVIDENCE",
  dispute_life_cycle_stage: "CHARGEBACK",
  seller_response_due_date: "2026-10-20T23:59:59.000Z",
  dispute_amount: { currency_code: "USD", value: "2100.00" },
  disputed_transactions: [
    {
      seller_transaction_id: "3JC14525H76084841",
      create_time: "2026-09-15T00:00:00.000Z",
      invoice_number: "1042",
      gross_amount: { currency_code: "USD", value: "2100.00" },
      buyer: { name: { given_name: "Acme", surname: "Studio" } },
    },
  ],
  messages: [
    { posted_by: "BUYER", time_posted: "2026-10-05T09:14:00.000Z", content: "Working on it" },
    { posted_by: "SELLER", time_posted: "2026-10-06T08:00:00.000Z", content: "The work was handed over in September." },
  ],
};

const INVOICE_RECORD = {
  id: "INV2-5BAP-9PMP-9TP4-967Y",
  status: "SENT",
  detail: {
    currency_code: "USD",
    invoice_number: "1042",
    invoice_date: "2026-09-15",
    payment_term: { term_type: "DUE_ON_DATE", due_date: "2026-10-01" },
    metadata: {
      recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#5BAP9PMP9TP4967Y",
    },
  },
  invoicer: { business_name: "CoinBane Studio", name: { full_name: "Rohit" } },
  primary_recipients: [{ billing_info: { business_name: BUYER } }],
  items: [
    {
      name: "Design retainer",
      quantity: "12",
      unit_of_measure: "HOURS",
      unit_amount: { currency_code: "USD", value: "150.00" },
    },
  ],
  amount: { currency_code: "USD", value: "2100.00" },
  due_amount: { currency_code: "USD", value: "1600.00" },
  payments: {
    paid_amount: { currency_code: "USD", value: "500.00" },
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

const FIXED_NOW = new Date("2026-10-14T12:00:00Z");

const draft = async () => "The invoice was issued and remains unpaid.";

function deps(overrides: Partial<ProofPackDeps> = {}) {
  return {
    now: FIXED_NOW,
    draftPosition: draft,
    readDispute: async () => null,
    listDisputes: async () => [],
    readInvoice: async () => null,
    listInvoices: async () => [],
    ...overrides,
  };
}

describe("parseDispute", () => {
  it("normalises a full PayPal dispute", () => {
    const parsed = parseDispute(DISPUTE)!;
    assert.equal(parsed.summary.id, "PP-D-27803");
    assert.equal(parsed.summary.source, "paypal");
    assert.equal(parsed.summary.client, "Acme Studio");
    assert.equal(parsed.summary.amount, 2100);
    assert.equal(parsed.summary.currency, "USD");
    assert.equal(parsed.summary.reason, "Merchandise or service not received");
    assert.equal(parsed.summary.reasonCode, "MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    assert.equal(parsed.summary.status, "OPEN");
    assert.equal(parsed.summary.stage, "CHARGEBACK");
    assert.equal(parsed.summary.openedAt, "2026-10-05");
    assert.equal(parsed.summary.respondBy, "2026-10-20");
    assert.equal(parsed.summary.invoiceNumber, "1042");
    assert.deepEqual(parsed.invoiceRefs, ["1042"]);
  });

  it("attributes each message to the side that wrote it", () => {
    const parsed = parseDispute(DISPUTE)!;
    assert.deepEqual(
      parsed.messages.map((message) => [message.actor, message.text]),
      [
        [BUYER, "Working on it"],
        ["Rohit", "The work was handed over in September."],
      ],
    );
  });

  it("accepts a JSON string, which is how tool results arrive", () => {
    assert.equal(parseDispute(JSON.stringify(DISPUTE))!.summary.id, "PP-D-27803");
  });

  it("falls back to the sum of the disputed transactions", () => {
    const withoutTotal = { ...DISPUTE } as Record<string, unknown>;
    delete withoutTotal.dispute_amount;
    assert.equal(parseDispute(withoutTotal)!.summary.amount, 2100);
  });

  it("survives a record with almost nothing in it", () => {
    const sparse = parseDispute({ dispute_id: "PP-D-1" })!;
    assert.equal(sparse.summary.client, "Client");
    assert.equal(sparse.summary.amount, 0);
    assert.equal(sparse.summary.currency, "USD");
    assert.equal(sparse.summary.openedAt, null);
    assert.equal(sparse.summary.invoiceNumber, null);
  });

  it("rejects anything without a dispute id", () => {
    assert.equal(parseDispute({ status: "OPEN" }), null);
    assert.equal(parseDispute('{"error":{"message":"nope"}}'), null);
    assert.equal(parseDispute(null), null);
  });
});

describe("collectDisputes", () => {
  const steps = (results: { toolName: string; result: unknown }[]) => [{ toolResults: results }];

  it("reads a single dispute, a list page, and deduplicates by id", () => {
    const other = { ...DISPUTE, dispute_id: "PP-D-27804" };
    const collected = collectDisputes(
      steps([
        { toolName: "get_dispute", result: JSON.stringify(DISPUTE) },
        { toolName: "list_disputes", result: JSON.stringify({ items: [DISPUTE, other] }) },
        { toolName: "get_invoice", result: JSON.stringify(INVOICE_RECORD) },
      ]),
    );
    assert.deepEqual(
      collected.map((entry) => entry.id),
      ["PP-D-27803", "PP-D-27804"],
    );
  });

  it("returns nothing for an empty sandbox", () => {
    assert.deepEqual(
      collectDisputes(steps([{ toolName: "list_disputes", result: '{"items":[],"links":[]}' }])),
      [],
    );
    assert.deepEqual(collectDisputes(undefined), []);
  });
});

describe("simulatedDisputes", () => {
  it("is deterministic and attached to real ledger invoices", () => {
    const first = simulatedDisputes();
    const second = simulatedDisputes();
    assert.deepEqual(first, second);
    assert.ok(first.length >= 1, "the sandbox has no disputes, so a fixture is required");

    const ledger = generateHistory();
    for (const entry of first) {
      const row = ledger.find((candidate) => candidate.id === entry.ledgerInvoiceId);
      assert.ok(row, `${entry.ledgerInvoiceId} is not a ledger invoice`);
      assert.equal(row.status, "UNPAID");
      assert.equal(entry.summary.amount, row.amount);
      assert.equal(entry.summary.client, row.client);
    }
  });

  it("ages the dispute off the invoice, not off the clock", () => {
    const entry = simulatedDisputes()[0];
    assert.equal(entry.summary.source, "simulated");
    assert.ok(entry.summary.openedAt! > "2020-01-01");
    assert.ok(entry.summary.respondBy! > entry.summary.openedAt!);
  });
});

/**
 * What a turn about disputes is shown, and what it is not.
 *
 * The fixture answers a general question, but a named case PayPal does not hold
 * must stay unanswered: a card for a different client's dispute would put the
 * wrong case in front of the freelancer, and its button would build that case's
 * pack while the question named another invoice.
 */
describe("fixtureDisputesFor", () => {
  const all = simulatedDisputes();

  it("answers a general question with the whole fixture", () => {
    for (const question of [
      "Do I have any open disputes?",
      "Any chargebacks I should worry about?",
      "What are my disputes in 2026?",
    ]) {
      assert.equal(fixtureDisputesFor(question).length, all.length, question);
    }
  });

  it("answers with the one case that was named", () => {
    const first = all[0];
    for (const question of [
      `Tell me about ${first.summary.id}`,
      `Is invoice ${first.ledgerInvoiceId} disputed?`,
      `What is happening with ${first.summary.invoiceNumber}?`,
    ]) {
      const shown = fixtureDisputesFor(question);
      assert.equal(shown.length, 1, question);
      assert.equal(shown[0].id, first.summary.id, question);
    }
  });

  it("shows nothing when the question names a case the fixture does not hold", () => {
    for (const question of [
      "Show me the dispute on invoice PDF-TEST-1042",
      "Is invoice 1042 disputed?",
      "Do I have a dispute on PP-D-27803?",
    ]) {
      assert.deepEqual(fixtureDisputesFor(question), [], question);
    }
  });
});

describe("DISPUTE_TOPIC", () => {
  it("recognises a question about a dispute however it is worded", () => {
    for (const question of [
      "Do I have any open disputes?",
      "Is invoice inv-36 disputed?",
      "Are we disputing anything right now?",
      "Show me my chargebacks",
      "Build me a proof pack",
    ]) {
      assert.ok(DISPUTE_TOPIC.test(question), question);
    }
  });

  it("leaves an ordinary money question alone", () => {
    for (const question of [
      "What did I invoice last month?",
      "Which clients owe me money?",
      "Forecast my cashflow",
    ]) {
      assert.equal(DISPUTE_TOPIC.test(question), false, question);
    }
  });
});

describe("assembleProofPack — a real PayPal dispute", () => {
  const pack = async (): Promise<DisputeProofPack> =>
    (await assembleProofPack(
      { disputeId: "PP-D-27803" },
      deps({
        readDispute: async () => DISPUTE,
        listDisputes: async () => [DISPUTE],
        readInvoice: async () => INVOICE_RECORD,
      }),
    ))!;

  it("takes the dispute as the authority", async () => {
    const built = await pack();
    assert.equal(built.dispute?.source, "paypal");
    assert.equal(built.client, "Acme Studio");
    assert.equal(built.amount, 2100);
    assert.equal(built.invoice?.number, "1042");
    assert.equal(built.invoice?.due, "2026-10-01");
  });

  it("applies the invoice's payments and reports the balance", async () => {
    const built = await pack();
    assert.deepEqual(
      built.payments.map((payment) => [payment.date, payment.amount, payment.balance]),
      [["2026-10-02", 500, 1600]],
    );
    assert.equal(built.outstanding, 1600);
  });

  it("builds a dated timeline from the invoice, the client and PayPal", async () => {
    const built = await pack();
    const dates = built.timeline.map((entry) => entry.date);
    assert.deepEqual([...dates].sort(), dates, "the timeline must read oldest first");
    assert.ok(built.timeline.some((entry) => entry.event.includes("issued to Acme Studio")));
    assert.ok(built.timeline.some((entry) => entry.event.includes("fell due")));
    assert.ok(
      built.timeline.some((entry) => entry.event.includes('Acme Studio wrote: "Working on it"')),
    );
    assert.ok(built.timeline.some((entry) => entry.event.includes("opened a dispute")));
    assert.ok(built.timeline.some((entry) => entry.event.includes("Deadline")));
    assert.ok(built.timeline.every((entry) => entry.date && entry.actor));
  });

  it("uses the drafted position and says it came from the model", async () => {
    const built = await pack();
    assert.equal(built.position.source, "model");
    assert.equal(built.position.text, "The invoice was issued and remains unpaid.");
  });

  it("lists the evidence the freelancer still has to attach", async () => {
    const built = await pack();
    assert.ok(built.evidence.length >= 5);
    for (const item of built.evidence) {
      assert.ok(item.description.length > 0 && item.note.length > 0);
    }
    assert.ok(built.evidence.some((item) => /contract|agreement/i.test(item.description)));
    assert.ok(built.evidence.some((item) => /delivery email/i.test(item.description)));
    assert.ok(built.evidence.some((item) => item.description.includes("Oct 20, 2026")));
  });

  it("names a filename from the invoice number", async () => {
    assert.equal(proofPackFileName(await pack()), "dispute-1042-proof-pack.pdf");
  });
});

describe("assembleProofPack — the ledger, when PayPal has nothing", () => {
  it("labels a fixture dispute as simulated", async () => {
    const fixture = simulatedDisputes()[0];
    const built = (await assembleProofPack({ disputeId: fixture.summary.id }, deps()))!;
    assert.equal(built.dispute?.source, "simulated");
    assert.equal(built.dispute?.id, fixture.summary.id);
    assert.equal(built.client, fixture.summary.client);
    assert.equal(built.amount, fixture.summary.amount);
    assert.equal(built.invoice?.id, fixture.ledgerInvoiceId);
  });

  it("derives reminders from the chasing ladder, and only ones already sent", async () => {
    const fixture = simulatedDisputes()[0];
    const built = (await assembleProofPack({ disputeId: fixture.summary.id }, deps()))!;
    const reminders = built.timeline.filter((entry) => entry.kind === "schedule");
    for (const reminder of reminders) {
      assert.ok(reminder.date <= "2026-10-14", "a reminder in the future was not sent");
      assert.match(reminder.event, /\((gentle|firm|urgent) tone, \d+ days? past due\)$/);
    }
  });

  it("reports no payment rather than a zero payment", async () => {
    const fixture = simulatedDisputes()[0];
    const built = (await assembleProofPack({ disputeId: fixture.summary.id }, deps()))!;
    assert.deepEqual(built.payments, []);
    assert.equal(built.outstanding, built.amount);
    assert.ok(
      built.timeline.some((entry) => entry.event.includes("unpaid and past due")),
    );
  });

  it("never credits a simulated pack's dates to PayPal", async () => {
    /*
     * The pack is filed as evidence with PayPal, so the source column has to
     * distinguish what PayPal can confirm from what the ledger asserts. Nothing
     * in a pack built without a PayPal record comes from PayPal.
     */
    const fixture = simulatedDisputes()[0];
    const built = (await assembleProofPack({ disputeId: fixture.summary.id }, deps()))!;

    assert.equal(built.dispute?.source, "simulated");
    for (const entry of built.timeline) {
      if (entry.kind === "schedule") continue;
      assert.notEqual(entry.kind, "paypal", entry.event);
    }
    for (const event of ["opened a dispute", "Deadline"]) {
      const entry = built.timeline.find((candidate) => candidate.event.includes(event));
      assert.equal(entry?.kind, "simulated", event);
    }
  });

  it("credits a PayPal invoice's payments to PayPal", async () => {
    const built = (await assembleProofPack(
      { disputeId: "PP-D-27803" },
      deps({
        readDispute: async () => DISPUTE,
        listDisputes: async () => [DISPUTE],
        readInvoice: async () => INVOICE_RECORD,
      }),
    ))!;

    const payment = built.timeline.find((entry) => entry.event.includes("Payment received"));
    assert.equal(payment?.kind, "paypal");
    assert.equal(
      built.timeline.find((entry) => entry.event.includes("Deadline"))?.kind,
      "paypal",
    );
  });

  it("builds a pack from an invoice alone, with no dispute on file", async () => {
    const row = generateHistory().find((entry) => entry.status === "UNPAID")!;
    const built = (await assembleProofPack({ invoiceId: row.id }, deps()))!;
    assert.equal(built.dispute, null);
    assert.equal(built.invoice?.id, row.id);
    assert.equal(built.amount, row.amount);
    assert.ok(built.evidence.some((item) => /no payment against this invoice/i.test(item.description)));
  });

  it("assembles for a PayPal invoice the sandbox still holds", async () => {
    const built = (await assembleProofPack(
      { invoiceNumber: "1042" },
      deps({ readInvoice: async () => INVOICE_RECORD }),
    ))!;
    assert.equal(built.invoice?.payUrl, "https://www.sandbox.paypal.com/invoice/p/#5BAP9PMP9TP4967Y");
    assert.equal(built.dispute, null, "PayPal returned no dispute for this invoice");
  });

  it("treats a failed read as no read, and falls through to the list", async () => {
    /*
     * The toolkit answers a rejected call with `{ ok: false, status: 404 }`
     * rather than throwing, which is what a read by invoice *number* produces.
     * It must not be mistaken for the invoice.
     */
    const built = (await assembleProofPack(
      { invoiceNumber: "1042" },
      deps({
        readInvoice: async () => ({
          ok: false,
          status: 404,
          code: "PAYPAL_API_HTTP_ERROR",
          message: "The specified resource does not exist.",
        }),
        listInvoices: async () => [INVOICE_RECORD],
      }),
    ))!;

    assert.equal(built.invoice?.number, "1042");
    assert.equal(built.invoice?.total, 2100);
    assert.equal(built.invoice?.payUrl, "https://www.sandbox.paypal.com/invoice/p/#5BAP9PMP9TP4967Y");
  });

  it("returns null when the read fails and the list holds nothing", async () => {
    assert.equal(
      await assembleProofPack(
        { invoiceNumber: "1042" },
        deps({ readInvoice: async () => ({ ok: false, status: 404 }) }),
      ),
      null,
    );
  });

  it("reads by id before number, since only the id resolves directly", async () => {
    const tried: string[] = [];
    const built = (await assembleProofPack(
      { invoiceId: "INV2-5BAP-9PMP-9TP4-967Y", invoiceNumber: "1042" },
      deps({
        readInvoice: async (ref: string) => {
          tried.push(ref);
          return ref === "INV2-5BAP-9PMP-9TP4-967Y" ? { ...INVOICE_RECORD, detail: { ...INVOICE_RECORD.detail, invoice_number: "1042" } } : null;
        },
      }),
    ))!;
    assert.deepEqual(tried, ["INV2-5BAP-9PMP-9TP4-967Y"]);
    assert.equal(built.invoice?.id, "INV2-5BAP-9PMP-9TP4-967Y");
  });

  it("returns null when nothing at all matches", async () => {
    assert.equal(await assembleProofPack({ disputeId: "PP-D-0000" }, deps()), null);
    assert.equal(await assembleProofPack({ invoiceNumber: "9999" }, deps()), null);
  });

  it("falls back to a deterministic paragraph when the model is unavailable", async () => {
    const failing = deps({
      draftPosition: async () => {
        throw new Error("provider down");
      },
    });
    const built = (await assembleProofPack(
      { invoiceNumber: "1042" },
      { ...failing, readInvoice: async () => INVOICE_RECORD },
    ))!;
    assert.equal(built.position.source, "fallback");
    assert.match(built.position.text, /Invoice 1042/);
    assert.match(built.position.text, /USD 2,100\.00/);
  });
});

describe("the deterministic position paragraph", () => {
  const facts: PositionFacts = {
    client: "Acme Studio",
    invoiceNumber: "1042",
    amount: 2100,
    currency: "USD",
    issued: "2026-09-15",
    due: "2026-10-01",
    disputeReason: "Merchandise or service not received",
    disputeStatus: "OPEN",
    openedAt: "2026-10-05",
    respondBy: "2026-10-20",
    reminderDates: ["2026-10-02", "2026-10-08"],
    paid: 0,
    outstanding: 2100,
    source: "paypal",
  };

  it("reads the facts back without inventing a delivery date", () => {
    const text = fallbackPositionStatement(facts);
    assert.match(text, /Invoice 1042 for USD 2,100\.00/);
    assert.match(text, /Sep 15, 2026/);
    assert.match(text, /Oct 2, 2026, Oct 8, 2026/);
    assert.match(text, /No payment has been received/);
    assert.doesNotMatch(text, /was delivered on|we delivered|proof of delivery/i);
  });

  it("mentions payments when there were any", () => {
    const text = fallbackPositionStatement({ ...facts, paid: 500, outstanding: 1600 });
    assert.match(text, /total USD 500\.00, leaving USD 1,600\.00 outstanding/);
  });

  it("reads as a record, not an argument", () => {
    /*
     * This paragraph is filed with PayPal as evidence. Anything that argues,
     * pleads, judges the client or threatens a next step weakens it.
     */
    const text = fallbackPositionStatement(facts);

    for (const banned of [
      "unfortunately",
      "clearly",
      "obviously",
      "honestly",
      "frustrating",
      "disappointed",
      "unfair",
      "surprising",
      "kindly",
      "please",
      "asap",
      "urgent",
      "!",
      // Pressure and judgment of the client.
      "escalat",
      "legal",
      "collections",
      "late fee",
      "refused",
      "ignored",
      "lied",
      "bad faith",
    ]) {
      assert.equal(text.toLowerCase().includes(banned), false, `the position says "${banned}"`);
    }

    assert.doesNotMatch(text, /\b(?:I|we|my|our|us)\b/);
  });
});

/**
 * Length is part of the deliverable, and the arithmetic is not.
 *
 * A pack is read by a reviewer, so it is capped. The cap may shorten the tables
 * and never the totals: an outstanding balance computed from trimmed rows would
 * understate or overstate what is owed.
 */
describe("a history longer than the pack allows", () => {
  const hugeInvoice = {
    ...INVOICE_RECORD,
    amount: { currency_code: "USD", value: "2100.00" },
    payments: {
      transactions: Array.from({ length: 40 }, (_, index) => ({
        payment_id: `PAY-${300 + index}`,
        payment_date: "2026-10-02",
        method: "PAYPAL",
        amount: { currency_code: "USD", value: "50.00" },
      })),
    },
  };

  it("trims the payments table without touching what is owed", async () => {
    const built = (await assembleProofPack(
      { disputeId: "PP-D-27803" },
      deps({
        readDispute: async () => DISPUTE,
        listDisputes: async () => [DISPUTE],
        readInvoice: async () => hugeInvoice,
      }),
    ))!;

    assert.equal(built.payments.length, 20);
    assert.equal(built.paymentsOmitted, 20);
    assert.equal(built.outstanding, 2100 - 40 * 50);
    /* The last row still lands on the balance the summary reports. */
    assert.equal(built.payments.at(-1)!.balance, built.outstanding);
  });

  it("leaves a pack within the limit untouched", async () => {
    const built = (await assembleProofPack(
      { invoiceNumber: "1042" },
      deps({ readInvoice: async () => INVOICE_RECORD }),
    ))!;

    assert.equal(built.paymentsOmitted, 0);
    assert.equal(built.timelineOmitted, 0);
  });
});

describe("small helpers", () => {
  it("formats a date the way a timeline reads", () => {
    assert.equal(formatDay("2026-09-15"), "Sep 15, 2026");
    assert.equal(formatDay(null), "date unknown");
  });

  it("turns a ledger invoice into an invoice document without inventing hours", () => {
    const row = generateHistory().find((entry) => entry.client === "Nova Startup")!;
    const payload = ledgerInvoiceToPayload(row);
    assert.equal(payload.number, row.id);
    assert.equal(payload.total, row.amount);
    assert.equal(payload.items.length, 1);
    assert.equal(payload.items[0].quantity, 1);
    assert.equal(payload.items[0].unitAmount, row.amount);
    assert.equal(payload.payUrl, null);
    assert.equal(payload.invoicer.name, "Rohit");
  });

  it("slugs a filename safely", () => {
    const pack = {
      dispute: { invoiceNumber: "../../etc/passwd" },
      invoice: null,
    } as unknown as DisputeProofPack;
    assert.equal(proofPackFileName(pack), "dispute-etc-passwd-proof-pack.pdf");
  });
});
