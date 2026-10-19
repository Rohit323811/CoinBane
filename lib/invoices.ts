import { generateHistory, type Invoice as LedgerInvoice } from "./clients.ts";
import { USER_NAME } from "./prompts.ts";
import type {
  InvoiceLineItem,
  InvoiceParty,
  InvoicePayload,
} from "./types.ts";

/**
 * Reads PayPal invoices out of the agent's tool results, and shapes them for
 * the PDF.
 *
 * Two facts drive the whole module, both observed against the sandbox:
 *
 * 1. `create_invoice` returns only a `self` link —
 *    `{ rel: "self", href: ".../invoicing/invoices/INV2-...", method: "GET" }`
 *    — while the hosted payer view (`detail.metadata.recipient_view_url`, the
 *    page the QR must encode) exists only on a full invoice record. So a
 *    created invoice still has to be read once before it can be rendered, and
 *    that is why the collector reports ids separately from payloads.
 * 2. Several tools return full records: `get_invoice` returns one, and
 *    `list_invoices` returns a page of them. Those are read directly rather
 *    than re-fetched.
 *
 * Everything here is pure: no PayPal client, no pdf-lib. The route decides what
 * to fetch; this module decides what the fetched bytes mean.
 */

/** Tools whose results can carry an invoice. */
const INVOICE_TOOLS = new Set([
  "create_invoice",
  "get_invoice",
  "list_invoices",
]);

const MAX_ITEMS = 50;
const MAX_ITEM_TEXT = 200;
const MAX_TEXT = 160;
/** Longest id we will echo back; PayPal's are 20-30 characters. */
const MAX_ID = 64;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Tool results arrive as JSON strings from the toolkit; parse them safely. */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** The `{ currency_code, value }` shape PayPal wraps every amount in. */
function moneyValue(value: unknown): number | null {
  if (!isObject(value)) return null;
  return asNumber(value.value);
}

/** The currency on the first line item, used when no invoice total is present. */
function itemCurrency(items: unknown): string | null {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!isObject(item)) continue;
    const currency = moneyCurrency(item.unit_amount);
    if (currency) return currency;
  }
  return null;
}

function moneyCurrency(value: unknown): string | null {
  if (!isObject(value)) return null;
  return asString(value.currency_code, 8);
}

/** Accepts a plain date or an ISO timestamp, and keeps only the date part. */
function isoDate(value: unknown): string | null {
  const text = asString(value, 40);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

/**
 * Only PayPal's own https pages may end up in the QR code. The payload is
 * client-supplied, so this is also the guard that stops an arbitrary URL from
 * being printed as a "Pay now" link.
 */
function safePayUrl(value: unknown): string | null {
  const text = asString(value, 400);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "paypal.com" && !host.endsWith(".paypal.com")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function party(input: unknown, fallback: string): InvoiceParty {
  const source = isObject(input) ? input : {};
  const name = isObject(source.name) ? source.name : {};

  const joinedName = [asString(name.given_name), asString(name.surname)]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const fullName = asString(name.full_name) ?? (joinedName || null);

  const address = isObject(source.address) ? source.address : {};
  const lines = [
    asString(address.address_line_1),
    asString(address.address_line_2),
    [asString(address.admin_area_2), asString(address.admin_area_1)]
      .filter((part): part is string => Boolean(part))
      .join(", ") || null,
    asString(address.postal_code),
    asString(address.country_code),
  ].filter((line): line is string => Boolean(line));

  return {
    name: fullName ?? asString(source.business_name) ?? fallback,
    business: asString(source.business_name),
    email: asString(source.email_address),
    lines,
  };
}

function lineItem(input: unknown): InvoiceLineItem | null {
  if (!isObject(input)) return null;

  const name = asString(input.name, MAX_ITEM_TEXT);
  const description = asString(input.description, MAX_ITEM_TEXT);
  // The two fields overlap in practice: a short label in `name`, the prose in
  // `description`. Keep both when they differ rather than dropping the label.
  const label =
    name && description && name !== description
      ? `${name} — ${description}`
      : (name ?? description);

  const quantity = asNumber(input.quantity) ?? 1;
  /*
   * Both shapes reach this function: PayPal's snake_case record and the
   * camelCase payload this app emits. Reading only one of them silently priced
   * every line at zero.
   */
  const unitAmount = moneyValue(input.unit_amount) ?? asNumber(input.unitAmount) ?? 0;

  return {
    description: (label ?? "Item").slice(0, MAX_ITEM_TEXT),
    quantity,
    unit: asString(input.unit_of_measure, 16) ?? asString(input.unit, 16),
    unitAmount,
    amount: round2(quantity * unitAmount),
  };
}

/**
 * True when `record` is an invoice rather than a list page or a link. A list
 * response also has an `items` array, so the test is on the id shape: line
 * items carry ITEM- ids, invoices carry INV2- ones.
 */
function looksLikeInvoice(record: Record<string, unknown>): boolean {
  const id = asString(record.id, MAX_ID);
  if (!id) return false;
  if (/^INV2-/i.test(id)) return true;
  return isObject(record.detail);
}

/**
 * Normalises one PayPal invoice record. Returns null for anything that is not
 * an invoice — a link, an error body, or a list page mistaken for one.
 */
export function toInvoicePayload(input: unknown): InvoicePayload | null {
  const record = parseJson(input);
  if (!isObject(record) || !looksLikeInvoice(record)) return null;

  const id = asString(record.id, MAX_ID);
  if (!id) return null;

  const detail = isObject(record.detail) ? record.detail : {};
  const metadata = isObject(detail.metadata) ? detail.metadata : {};
  const term = isObject(detail.payment_term) ? detail.payment_term : {};
  const amount = isObject(record.amount) ? record.amount : {};
  const items = (Array.isArray(record.items) ? record.items : [])
    .slice(0, MAX_ITEMS)
    .map(lineItem)
    .filter((item): item is InvoiceLineItem => item !== null);

  const currency =
    moneyCurrency(amount) ??
    asString(detail.currency_code, 8) ??
    itemCurrency(record.items) ??
    "USD";

  const itemTotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const total =
    moneyValue(amount) ?? moneyValue(record.due_amount) ?? itemTotal;

  const recipient = party(
    (Array.isArray(record.primary_recipients)
      ? record.primary_recipients.find(isObject)
      : undefined)?.billing_info,
    "Client",
  );

  return {
    id,
    number: asString(detail.invoice_number, 32) ?? id,
    status: asString(record.status, 24) ?? "DRAFT",
    client: recipient.business ?? recipient.name ?? "Client",
    currency,
    total: round2(total),
    issued: isoDate(detail.invoice_date) ?? isoDate(metadata.create_time),
    due: isoDate(term.due_date) ?? isoDate(detail.due_date),
    items,
    payUrl:
      safePayUrl(metadata.recipient_view_url) ??
      safePayUrl(metadata.payer_view_url),
    /*
     * An invoice created without invoicer details is still the freelancer's own
     * invoice, so the From block carries their name rather than a placeholder.
     * The identity is the app's, not PayPal's, and it is the only thing on the
     * document that does not come from the record.
     */
    invoicer: party(record.invoicer, USER_NAME),
    recipient,
  };
}

/** A party as the client already has it: plain strings, not PayPal's nesting. */
function normalizedParty(input: unknown, fallback: string): InvoiceParty {
  if (typeof input === "string") {
    return { name: input.slice(0, MAX_TEXT), business: null, email: null, lines: [] };
  }
  const source = isObject(input) ? input : {};
  const lines = Array.isArray(source.lines)
    ? source.lines
        .map((line) => asString(line, MAX_TEXT))
        .filter((line): line is string => Boolean(line))
        .slice(0, 6)
    : [];

  return {
    name: asString(source.name, MAX_TEXT) ?? asString(source.business, MAX_TEXT) ?? fallback,
    business: asString(source.business, MAX_TEXT),
    email: asString(source.email, MAX_TEXT),
    lines,
  };
}

/**
 * Validates an already-normalised payload.
 *
 * The PDF route is a public POST, so nothing about the body is trusted just
 * because this app produced a payload like it once: every field is re-clamped,
 * and the pay URL goes through the same PayPal-only check as a live record.
 */
export function sanitizeInvoicePayload(input: unknown): InvoicePayload | null {
  const parsed = parseJson(input);
  if (!isObject(parsed)) return null;

  const id = asString(parsed.id, MAX_ID);
  const number = asString(parsed.number, 32);
  if (!id && !number) return null;

  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .slice(0, MAX_ITEMS)
    .map(lineItem)
    .filter((item): item is InvoiceLineItem => item !== null);

  const itemTotal = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const total = asNumber(parsed.total);

  return {
    id: id ?? number!,
    number: number ?? id!,
    status: asString(parsed.status, 24) ?? "DRAFT",
    client: asString(parsed.client, MAX_TEXT) ?? "Client",
    currency: (asString(parsed.currency, 8) ?? "USD").toUpperCase(),
    total: round2(total ?? itemTotal),
    issued: isoDate(parsed.issued),
    due: isoDate(parsed.due),
    items,
    payUrl: safePayUrl(parsed.payUrl),
    invoicer: normalizedParty(parsed.invoicer, USER_NAME),
    recipient: normalizedParty(parsed.recipient, "Client"),
  };
}

/**
 * Accepts either shape an invoice arrives in: a raw PayPal record from a tool
 * result, or a payload the app already normalised. The first is what makes this
 * module usable on live tool output; the second is what the chat sends.
 */
export function readInvoiceInput(input: unknown): InvoicePayload | null {
  const parsed = parseJson(input);
  if (isObject(parsed) && isObject(parsed.invoice)) return readInvoiceInput(parsed.invoice);

  /*
   * `detail` is the discriminating field: PayPal puts it on every record, and a
   * payload this app normalised never has one. Trying the record parser first
   * regardless lost the invoice number of a normalised payload — it read the
   * id as the number and printed INV2-... across the top of the PDF.
   */
  if (isObject(parsed) && isObject(parsed.detail)) return toInvoicePayload(parsed);
  return sanitizeInvoicePayload(parsed);
}

/** The invoice id inside a `create_invoice` self link. */
export function invoiceIdFromSelfLink(input: unknown): string | null {
  const record = parseJson(input);
  if (!isObject(record)) return null;

  const direct = asString(record.id, MAX_ID);
  if (direct && /^INV2-/i.test(direct)) return direct;

  const href = asString(record.href, 400);
  if (!href) return null;
  const match = /\/invoicing\/invoices\/([A-Za-z0-9-]+)/.exec(href);
  return match ? match[1].slice(0, MAX_ID) : null;
}

/** Every invoice inside a tool result: one record, or a page of them. */
function payloadsFrom(value: unknown): InvoicePayload[] {
  const parsed = parseJson(value);

  if (Array.isArray(parsed)) {
    return parsed
      .map(toInvoicePayload)
      .filter((payload): payload is InvoicePayload => payload !== null);
  }

  if (!isObject(parsed)) return [];

  // A list page: `{ total_items, items: [invoice, ...] }`.
  const page = parsed.items;
  if (Array.isArray(page) && page.some(isObject) && !looksLikeInvoice(parsed)) {
    return page
      .map(toInvoicePayload)
      .filter((payload): payload is InvoicePayload => payload !== null);
  }

  const single = toInvoicePayload(parsed);
  return single ? [single] : [];
}

export interface CollectedInvoices {
  /** Invoices carried by the tool results, deduplicated by id. */
  payloads: InvoicePayload[];
  /**
   * Ids that appeared only as a create link. The caller reads these once so the
   * PDF has the hosted pay URL, which a create result never contains.
   */
  pendingIds: string[];
}

/** Pulls every invoice out of a `generateText` step list, in order. */
export function collectInvoices(steps: unknown): CollectedInvoices {
  const payloads: InvoicePayload[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();

  if (!Array.isArray(steps)) return { payloads, pendingIds: [] };

  for (const step of steps) {
    const results = isObject(step) ? step.toolResults : null;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (!isObject(result)) continue;
      const name = asString(result.toolName, 64);
      if (!name || !INVOICE_TOOLS.has(name)) continue;

      const parsed = parseJson(result.result);

      for (const payload of payloadsFrom(parsed)) {
        if (seen.has(payload.id)) continue;
        seen.add(payload.id);
        payloads.push(payload);
      }

      // Only a create result is worth a follow-up read: the other tools are
      // already returning records.
      if (name === "create_invoice") {
        const id = invoiceIdFromSelfLink(parsed);
        if (id) pending.add(id);
      }
    }
  }

  return {
    payloads,
    // Drop anything the same run already read in full.
    pendingIds: [...pending].filter((id) => !seen.has(id)),
  };
}

/**
 * A ledger invoice as a document.
 *
 * The ledger records one amount per month, not itemised hours, so the line item
 * says that rather than inventing a breakdown. There is no PayPal pay link:
 * these invoices were never created in PayPal.
 */
export function ledgerInvoiceToPayload(row: LedgerInvoice): InvoicePayload {
  const issued = isoDay(row.issued);
  const due = isoDay(row.due);
  return {
    id: row.id,
    number: row.id,
    status: row.status,
    client: row.client,
    currency: "USD",
    total: row.amount,
    issued,
    due,
    items: [
      {
        description: `Freelance services \u2014 ${formatDay(issued)} retainer`,
        quantity: 1,
        unit: null,
        unitAmount: row.amount,
        amount: row.amount,
      },
    ],
    payUrl: null,
    invoicer: {
      name: USER_NAME,
      business: null,
      email: null,
      lines: [],
    },
    recipient: { name: row.client, business: row.client, email: null, lines: [] },
  };
}

/** The ledger row with this id, or null. Ids are exact; nothing is guessed. */
export function ledgerInvoiceById(ref: string | null): LedgerInvoice | null {
  if (!ref) return null;
  const wanted = ref.trim().toLowerCase();
  if (!/^inv-\d+$/.test(wanted)) return null;
  return generateHistory().find((row) => row.id.toLowerCase() === wanted) ?? null;
}

/**
 * Ledger invoices the agent named this turn, as documents.
 *
 * The PayPal tools only ever return PayPal invoices, so an answer about a
 * simulated one would otherwise arrive with no file beside it — the download
 * would exist for the sandbox invoices and quietly not for the ledger's own.
 * `score_invoice` is the tool that names a ledger invoice, so it is the one
 * read here; ids already shown from a PayPal record are skipped, and the same
 * invoice is never carded twice.
 */
export function collectLedgerInvoices(
  steps: unknown,
  shown: Iterable<string> = [],
): InvoicePayload[] {
  const seen = new Set(shown);
  const payloads: InvoicePayload[] = [];
  if (!Array.isArray(steps)) return payloads;

  for (const step of steps) {
    const results = isObject(step) ? step.toolResults : null;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (!isObject(result)) continue;
      if (asString(result.toolName, MAX_ID) !== "score_invoice") continue;

      const parsed = parseJson(result.result);
      if (!isObject(parsed) || parsed.found === false) continue;

      const id = asString(parsed.invoiceId, MAX_ID);
      if (!id || seen.has(id)) continue;

      const row = ledgerInvoiceById(id);
      if (!row) continue;

      seen.add(id);
      payloads.push(ledgerInvoiceToPayload(row));
    }
  }

  return payloads;
}

/** The most invoice cards one answer may carry. */
export const MAX_INVOICE_CARDS = 3;

/**
 * Trims a turn's invoices to the cards worth showing.
 *
 * A list turn returns every invoice the sandbox holds — sixteen of them in this
 * deployment — and sixteen cards carrying three buttons each is not an answer,
 * it is a wall. The reply's own text enumerates them, so the cards are capped
 * and the caller reports how many were left out rather than hiding the gap.
 */
export function cardInvoices(
  payloads: InvoicePayload[],
  max = MAX_INVOICE_CARDS,
): { shown: InvoicePayload[]; omitted: number } {
  if (payloads.length <= max) return { shown: payloads, omitted: 0 };
  return { shown: payloads.slice(0, max), omitted: payloads.length - max };
}

/** A filesystem-safe slug for the download filename. */
function slug(value: string, max = 40): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return cleaned || "invoice";
}

/** e.g. `invoice-1042-acme-studio.pdf`. */
export function invoiceFileName(
  invoice: Pick<InvoicePayload, "number" | "client">,
): string {
  return `invoice-${slug(invoice.number, 24)}-${slug(invoice.client)}.pdf`;
}

/**
 * The typable form of the pay URL: no scheme, no `www.`. A client reading the
 * PDF on paper should be able to key this in.
 */
export function shortPayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** yyyy-mm-dd for a ledger date. The ledger stores noon-anchored dates. */
function isoDay(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) return null;
  return value.toISOString().slice(0, 10);
}

/** `Sep 15, 2026` — how a date reads in a timeline or on a document. */
export function formatDay(iso: string | null): string {
  if (!iso) return "date unknown";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const name = MONTHS[Number(month) - 1] ?? month;
  return `${name} ${Number(day)}, ${year}`;
}

/** `USD 2,100.00` — the same formatting the chat uses for money. */
export function formatInvoiceMoney(amount: number, currency: string): string {
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency} ${formatted}`;
}
