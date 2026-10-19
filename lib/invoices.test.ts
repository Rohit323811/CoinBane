import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { generateHistory } from "./clients.ts";
import {
  collectInvoices,
  collectLedgerInvoices,
  formatInvoiceMoney,
  invoiceFileName,
  invoiceIdFromSelfLink,
  ledgerInvoiceById,
  ledgerInvoiceToPayload,
  cardInvoices,
  MAX_INVOICE_CARDS,
  readInvoiceInput,
  sanitizeInvoicePayload,
  shortPayUrl,
  toInvoicePayload,
} from "./invoices.ts";

/**
 * Fixtures are the shapes the sandbox actually returned, trimmed to the fields
 * the parser reads. The distinction that matters throughout: `create_invoice`
 * answers with a self link, every other read answers with a full record.
 */

const CREATE_LINK = JSON.stringify({
  rel: "self",
  href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-7BJX-YWVP-TF9Z-CYW2",
  method: "GET",
});

const INVOICE = {
  id: "INV2-7BJX-YWVP-TF9Z-CYW2",
  status: "DRAFT",
  detail: {
    currency_code: "USD",
    note: "Thanks for your business.",
    invoice_number: "1042",
    invoice_date: "2026-10-14",
    payment_term: { term_type: "NO_DUE_DATE" },
    metadata: {
      create_time: "2026-10-14T15:02:31Z",
      last_update_time: "2026-10-14T15:02:31Z",
      recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#7BJXYWVPTF9ZCYW2",
      invoicer_view_url: "https://www.sandbox.paypal.com/invoice/details/INV2-7BJX-YWVP-TF9Z-CYW2",
    },
  },
  invoicer: {
    business_name: "CoinBane Studio",
    name: { given_name: "Rohit", full_name: "Rohit" },
    address: {
      address_line_1: "1 Ledger Lane",
      admin_area_2: "Austin",
      admin_area_1: "TX",
      postal_code: "78701",
      country_code: "US",
    },
    email_address: "rohit@coinbane.example",
  },
  primary_recipients: [
    { billing_info: { business_name: "Acme Studio", email_address: "billing@acme.example" } },
  ],
  items: [
    {
      name: "Design retainer",
      description: "Brand system and handoff",
      quantity: "12",
      unit_of_measure: "HOURS",
      unit_amount: { currency_code: "USD", value: "150.00" },
    },
    { name: "Rush fee", quantity: "1", unit_amount: { currency_code: "USD", value: "300.00" } },
  ],
  amount: {
    currency_code: "USD",
    value: "2100.00",
    breakdown: { item_total: { currency_code: "USD", value: "2100.00" } },
  },
  due_amount: { currency_code: "USD", value: "2100.00" },
  links: [
    {
      href: "https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-7BJX-YWVP-TF9Z-CYW2",
      rel: "self",
      method: "GET",
    },
  ],
};

function invoice(overrides: Record<string, unknown> = {}) {
  return { ...structuredClone(INVOICE), ...overrides };
}

describe("toInvoicePayload", () => {
  it("normalises a full invoice record", () => {
    const payload = toInvoicePayload(JSON.stringify(INVOICE))!;
    assert.ok(payload, "a full record must parse");
    assert.equal(payload.id, "INV2-7BJX-YWVP-TF9Z-CYW2");
    assert.equal(payload.number, "1042");
    assert.equal(payload.client, "Acme Studio");
    assert.equal(payload.currency, "USD");
    assert.equal(payload.total, 2100);
    assert.equal(payload.issued, "2026-10-14");
    assert.equal(payload.due, null);
    assert.equal(payload.payUrl, "https://www.sandbox.paypal.com/invoice/p/#7BJXYWVPTF9ZCYW2");
    assert.equal(payload.invoicer.business, "CoinBane Studio");
    assert.equal(payload.invoicer.name, "Rohit");
    assert.deepEqual(payload.invoicer.lines, [
      "1 Ledger Lane",
      "Austin, TX",
      "78701",
      "US",
    ]);
  });

  it("multiplies quantity by rate for every line", () => {
    const payload = toInvoicePayload(invoice())!;
    assert.equal(payload.items.length, 2);
    assert.deepEqual(
      payload.items.map((item) => [item.quantity, item.unitAmount, item.amount]),
      [
        [12, 150, 1800],
        [1, 300, 300],
      ],
    );
  });

  it("keeps the item label when it differs from the description", () => {
    const payload = toInvoicePayload(invoice())!;
    assert.equal(payload.items[0].description, "Design retainer — Brand system and handoff");
    assert.equal(payload.items[1].description, "Rush fee");
  });

  it("reads a due date when the payment term carries one", () => {
    const payload = toInvoicePayload(
      invoice({ detail: { ...INVOICE.detail, payment_term: { term_type: "DUE_ON_DATE", due_date: "2026-11-14" } } }),
    )!;
    assert.equal(payload.due, "2026-11-14");
  });

  it("falls back to the create time when no invoice date is set", () => {
    const detail = { ...INVOICE.detail } as Record<string, unknown>;
    delete detail.invoice_date;
    const payload = toInvoicePayload(invoice({ detail }))!;
    assert.equal(payload.issued, "2026-10-14");
  });

  it("sums the lines when the record carries no total", () => {
    const payload = toInvoicePayload(invoice({ amount: undefined }))!;
    assert.equal(payload.total, 2100);
  });

  it("refuses a pay link that is not PayPal's own https page", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "https://evil.example/pay",
      "https://paypal.com.evil.example/pay",
      "not a url",
    ]) {
      const payload = toInvoicePayload(
        invoice({
          detail: { ...INVOICE.detail, metadata: { ...INVOICE.detail.metadata, recipient_view_url: hostile } },
        }),
      )!;
      assert.equal(payload.payUrl, null, hostile);
    }
  });

  it("rejects things that are not invoices", () => {
    assert.equal(toInvoicePayload(CREATE_LINK), null);
    assert.equal(toInvoicePayload('{"error":{"message":"nope"}}'), null);
    assert.equal(toInvoicePayload("not json"), null);
    assert.equal(toInvoicePayload(null), null);
    assert.equal(toInvoicePayload({ id: "ITEM-1", name: "Design" }), null);
  });

  it("caps the line items it will print", () => {
    const many = Array.from({ length: 80 }, (_, index) => ({
      name: `Item ${index}`,
      quantity: "1",
      unit_amount: { currency_code: "USD", value: "1.00" },
    }));
    const payload = toInvoicePayload(invoice({ items: many }))!;
    assert.equal(payload.items.length, 50);
  });

  it("labels a nameless recipient rather than printing an empty block", () => {
    const payload = toInvoicePayload(invoice({ primary_recipients: [] }))!;
    assert.equal(payload.client, "Client");
  });

  it("names the freelancer when PayPal holds no invoicer details", () => {
    // An invoice created without invoicer fields is still the freelancer's own,
    // and their name is the one thing the app knows that the record does not.
    const payload = toInvoicePayload(invoice({ invoicer: undefined }))!;
    assert.equal(payload.invoicer.name, "Rohit");
    assert.equal(payload.invoicer.business, null);
    assert.deepEqual(payload.invoicer.lines, []);
  });

  it("still prefers the invoicer PayPal has on the record", () => {
    assert.equal(toInvoicePayload(invoice())!.invoicer.name, "Rohit");
    const named = toInvoicePayload(
      invoice({ invoicer: { business_name: "CoinBane Studio", name: { full_name: "Rohit Sharma" } } }),
    )!;
    assert.equal(named.invoicer.name, "Rohit Sharma");
    assert.equal(named.invoicer.business, "CoinBane Studio");
  });
});

describe("invoiceIdFromSelfLink", () => {
  it("reads the id out of the create link", () => {
    assert.equal(invoiceIdFromSelfLink(CREATE_LINK), "INV2-7BJX-YWVP-TF9Z-CYW2");
  });

  it("reads an id straight off a record", () => {
    assert.equal(invoiceIdFromSelfLink(INVOICE), "INV2-7BJX-YWVP-TF9Z-CYW2");
  });

  it("returns null for a link that names no invoice", () => {
    assert.equal(invoiceIdFromSelfLink({ rel: "self", href: "https://api.paypal.com/v2/" }), null);
    assert.equal(invoiceIdFromSelfLink(null), null);
  });
});

describe("collectInvoices", () => {
  const steps = (results: { toolName: string; result: unknown }[]) => [
    { toolResults: results },
  ];

  it("reports a created invoice as an id to fetch, with no payload", () => {
    const collected = collectInvoices(
      steps([{ toolName: "create_invoice", result: CREATE_LINK }]),
    );
    assert.deepEqual(collected.payloads, []);
    assert.deepEqual(collected.pendingIds, ["INV2-7BJX-YWVP-TF9Z-CYW2"]);
  });

  it("reads invoices straight out of a get_invoice result", () => {
    const collected = collectInvoices(
      steps([{ toolName: "get_invoice", result: JSON.stringify(INVOICE) }]),
    );
    assert.equal(collected.payloads.length, 1);
    assert.equal(collected.payloads[0].number, "1042");
    assert.deepEqual(collected.pendingIds, []);
  });

  it("reads every invoice in a list page", () => {
    const second = invoice({
      id: "INV2-AAAA-BBBB-CCCC-DDDD",
      detail: { ...INVOICE.detail, invoice_number: "1043" },
    });
    const collected = collectInvoices(
      steps([
        {
          toolName: "list_invoices",
          result: JSON.stringify({ total_items: 2, items: [INVOICE, second] }),
        },
      ]),
    );
    assert.deepEqual(
      collected.payloads.map((payload) => payload.number),
      ["1042", "1043"],
    );
  });

  it("does not ask for a re-read of an invoice the same run already read", () => {
    const collected = collectInvoices(
      steps([
        { toolName: "create_invoice", result: CREATE_LINK },
        { toolName: "get_invoice", result: JSON.stringify(INVOICE) },
      ]),
    );
    assert.equal(collected.payloads.length, 1);
    assert.deepEqual(collected.pendingIds, []);
  });

  it("ignores tools that cannot carry an invoice", () => {
    const collected = collectInvoices(
      steps([
        { toolName: "list_transactions", result: JSON.stringify({ transaction_details: [INVOICE] }) },
        { toolName: "render_data_grid", result: '{"kind":"grid"}' },
      ]),
    );
    assert.deepEqual(collected.payloads, []);
    assert.deepEqual(collected.pendingIds, []);
  });

  it("survives a step list that is not a step list", () => {
    assert.deepEqual(collectInvoices(undefined), { payloads: [], pendingIds: [] });
    assert.deepEqual(collectInvoices([{ toolResults: "nope" }]), { payloads: [], pendingIds: [] });
  });
});

describe("sanitizeInvoicePayload", () => {
  const payload = () => structuredClone(toInvoicePayload(INVOICE)!);

  it("round-trips a normalised payload", () => {
    const before = payload();
    const after = sanitizeInvoicePayload(before)!;
    assert.deepEqual(after, before);
  });

  it("re-clamps a payload that came from the browser", () => {
    const hostile = {
      ...payload(),
      client: "x".repeat(500),
      currency: "usd",
      payUrl: "https://evil.example/pay",
      total: "not a number",
      items: Array.from({ length: 80 }, () => ({
        description: "Item",
        quantity: "2",
        unitAmount: "10",
        amount: "20",
      })),
    };
    const safe = sanitizeInvoicePayload(hostile)!;
    assert.equal(safe.client.length, 160);
    assert.equal(safe.currency, "USD");
    assert.equal(safe.payUrl, null);
    assert.equal(safe.items.length, 50);
    // The total is re-derived from the lines rather than trusted.
    assert.equal(safe.total, 1000);
  });

  it("needs something to identify the invoice", () => {
    assert.equal(sanitizeInvoicePayload({ client: "Acme" }), null);
    assert.equal(sanitizeInvoicePayload("nope"), null);
    assert.equal(sanitizeInvoicePayload(null), null);
  });

  it("keeps a display-only payload renderable", () => {
    const minimal = sanitizeInvoicePayload({ number: "1042", client: "Acme Studio" })!;
    assert.equal(minimal.id, "1042");
    assert.equal(minimal.total, 0);
    assert.equal(minimal.due, null);
    assert.equal(minimal.invoicer.name, "Rohit");
  });
});

describe("readInvoiceInput", () => {
  it("takes a raw PayPal record", () => {
    assert.equal(readInvoiceInput(JSON.stringify(INVOICE))!.number, "1042");
  });

  it("takes a normalised payload, wrapped or bare", () => {
    const normalised = toInvoicePayload(INVOICE)!;
    assert.equal(readInvoiceInput(normalised)!.number, "1042");
    assert.equal(readInvoiceInput({ invoice: normalised })!.number, "1042");
  });

  it("rejects a create link, which carries no invoice to print", () => {
    assert.equal(readInvoiceInput(CREATE_LINK), null);
    assert.equal(readInvoiceInput({}), null);
  });
});

describe("filenames and display helpers", () => {
  it("builds the download name from number and client", () => {
    assert.equal(
      invoiceFileName({ number: "1042", client: "Acme Studio" }),
      "invoice-1042-acme-studio.pdf",
    );
  });

  it("keeps a filename usable when the fields are hostile", () => {
    assert.equal(
      invoiceFileName({ number: "../../etc", client: "A/B\\C" }),
      "invoice-etc-a-b-c.pdf",
    );
    assert.equal(invoiceFileName({ number: "***", client: "??" }), "invoice-invoice-invoice.pdf");
  });

  it("shortens the pay URL to something a client can type", () => {
    assert.equal(
      shortPayUrl("https://www.sandbox.paypal.com/invoice/p/#7BJXYWVPTF9ZCYW2"),
      "sandbox.paypal.com/invoice/p/#7BJXYWVPTF9ZCYW2",
    );
  });

  it("formats money the way the rest of the product does", () => {
    assert.equal(formatInvoiceMoney(2100, "USD"), "USD 2,100.00");
    assert.equal(formatInvoiceMoney(0, "EUR"), "EUR 0.00");
  });
});

/**
 * The ledger's own invoices, carded like PayPal's.
 *
 * Without this the download and the reminder exist for sandbox invoices and
 * quietly not for the invoices this deployment actually models, which is what a
 * demo shows first.
 */
describe("collectLedgerInvoices", () => {
  const row = generateHistory()[0];

  const steps = (...results: unknown[]) => [
    { toolResults: results.map((result) => ({ toolName: "score_invoice", result })) },
  ];

  it("cards the ledger invoice the turn named", () => {
    const [payload] = collectLedgerInvoices(
      steps(JSON.stringify({ found: true, invoiceId: row.id, score: 0.75, risk: "medium" })),
    );

    assert.equal(payload.id, row.id);
    assert.equal(payload.number, row.id);
    assert.equal(payload.client, row.client);
    assert.equal(payload.total, row.amount);
    assert.equal(payload.status, row.status);
    /* No PayPal record, so nothing to open and nothing invented. */
    assert.equal(payload.payUrl, null);
  });

  it("never cards the same invoice twice", () => {
    const once = collectLedgerInvoices(
      steps(
        JSON.stringify({ found: true, invoiceId: row.id }),
        JSON.stringify({ found: true, invoiceId: row.id }),
      ),
    );
    assert.equal(once.length, 1);

    const already = collectLedgerInvoices(
      steps(JSON.stringify({ found: true, invoiceId: row.id })),
      [row.id],
    );
    assert.deepEqual(already, []);
  });

  it("ignores a miss, an unknown id, and tools that are not about one invoice", () => {
    assert.deepEqual(
      collectLedgerInvoices(steps(JSON.stringify({ found: false, detail: "no invoice" }))),
      [],
    );
    assert.deepEqual(
      collectLedgerInvoices(steps(JSON.stringify({ found: true, invoiceId: "inv-9999" }))),
      [],
    );
    assert.deepEqual(collectLedgerInvoices(steps(JSON.stringify({ found: true }))), []);
    assert.deepEqual(collectLedgerInvoices(undefined), []);

    /* A PayPal invoice id is not a ledger row, and must not be guessed at. */
    assert.deepEqual(
      collectLedgerInvoices(steps(JSON.stringify({ found: true, invoiceId: "INV2-7BJX" }))),
      [],
    );
  });

  it("resolves only an exact ledger id", () => {
    assert.equal(ledgerInvoiceById(row.id)?.id, row.id);
    assert.equal(ledgerInvoiceById(row.id.toUpperCase())?.id, row.id);
    assert.equal(ledgerInvoiceById(null), null);
    assert.equal(ledgerInvoiceById("inv-"), null);
    assert.equal(ledgerInvoiceById("../../etc/passwd"), null);
    assert.equal(ledgerInvoiceById("INV2-7BJX-YWVP-TF9Z-CYW2"), null);
  });

  it("turns a ledger row into a document without a pay link", () => {
    const payload = ledgerInvoiceToPayload(row);
    assert.equal(payload.payUrl, null);
    assert.equal(payload.items.length, 1);
    assert.match(payload.items[0].description, /retainer/);
  });
});

/**
 * How many invoice cards one answer may carry.
 *
 * The sandbox holds sixteen invoices, and `list_invoices` returns all of them:
 * sixteen cards, each with three buttons, under a sentence that already lists
 * them. The cap is small, and what it drops is counted rather than lost.
 */
describe("cardInvoices", () => {
  const many = generateHistory()
    .slice(0, 16)
    .map((entry) => ledgerInvoiceToPayload(entry));

  it("leaves a turn about a few invoices alone", () => {
    const two = cardInvoices(many.slice(0, 2));
    assert.equal(two.shown.length, 2);
    assert.equal(two.omitted, 0);

    assert.equal(cardInvoices([]).omitted, 0);
    assert.equal(cardInvoices(many.slice(0, MAX_INVOICE_CARDS)).omitted, 0);
  });

  it("caps a list turn and counts what it left off", () => {
    const capped = cardInvoices(many);
    assert.equal(capped.shown.length, MAX_INVOICE_CARDS);
    assert.equal(capped.omitted, many.length - MAX_INVOICE_CARDS);
    /* The cards shown are the first ones, in the order the tools returned. */
    assert.deepEqual(
      capped.shown.map((payload) => payload.id),
      many.slice(0, MAX_INVOICE_CARDS).map((payload) => payload.id),
    );
  });
});
