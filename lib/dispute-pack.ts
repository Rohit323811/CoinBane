import { generateText } from "ai";

import { coinbaneModel, isModelConfigured } from "./ai.ts";
import { getReminderSchedule } from "./analysis.ts";
import { generateHistory, type Invoice as LedgerInvoice } from "./clients.ts";
import {
  formatDay,
  formatInvoiceMoney,
  ledgerInvoiceToPayload,
  toInvoicePayload,
} from "./invoices.ts";
import {
  listDisputeRecords,
  listInvoiceRecords,
  readDisputeRecord,
  readInvoiceRecord,
} from "./paypal.ts";
import { USER_NAME } from "./prompts.ts";
import type {
  DisputeClientPayment,
  DisputeEvidenceItem,
  DisputePaymentEntry,
  DisputeProofPack,
  DisputeSummary,
  DisputeTimelineEntry,
  InvoicePayload,
} from "./types.ts";

/**
 * The dispute proof pack.
 *
 * Everything a PayPal dispute resolution needs, gathered from the two records
 * that actually exist in this app: the PayPal sandbox and the simulated client
 * ledger. Nothing here invents evidence — where a fact is missing the pack says
 * so, and the supporting-evidence section lists what the freelancer still has
 * to attach.
 *
 * Two constraints shaped this module, both observed in the sandbox:
 *
 * 1. `create_invoice` aside, a dispute can only be *read* — there is no tool to
 *    file one — and the sandbox holds no disputes at all. So a pack is also
 *    assemblable from an invoice alone, and when it falls back to the simulated
 *    ledger the source travels with it and is printed on the cover. A document
 *    that looks like evidence must not silently be a fixture.
 * 2. PayPal's invoice record carries no reminder history: the toolkit can send a
 *    reminder but nothing reads one back. The chasing ladder in lib/analysis.ts
 *    is the only reminder record there is, so reminder dates are derived from it
 *    and labelled as schedule rather than as sent mail.
 */

/* ------------------------------------------------------------------ *
 * Reading values out of records we do not control
 * ------------------------------------------------------------------ */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, max = 200): string | null {
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

function money(value: unknown): number | null {
  return isObject(value) ? asNumber(value.value) : null;
}

function moneyCurrency(value: unknown): string | null {
  return isObject(value) ? asString(value.currency_code, 8) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/** yyyy-mm-dd from a date or an ISO timestamp. */
function isoDay(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = asString(value, 40);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/* ------------------------------------------------------------------ *
 * PayPal dispute records
 * ------------------------------------------------------------------ */

/** PayPal's reason codes, said out loud. */
const REASON_TEXT: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Merchandise or service not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORIZED_TRANSACTION: "Unauthorized transaction",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Canceled recurring billing",
  SUBSCRIPTION_CANCELED: "Subscription canceled",
  ITEM_NOT_RECEIVED: "Item not received",
  PROBLEM_WITH_REMITTANCE: "Problem with remittance",
};

function reasonText(code: string | null): string {
  if (!code) return "Reason not recorded";
  return REASON_TEXT[code] ?? code.replace(/_/g, " ").toLowerCase();
}

interface DisputeMessage {
  date: string | null;
  actor: string;
  text: string;
}

interface ParsedDispute {
  summary: DisputeSummary;
  messages: DisputeMessage[];
  /** Invoice number and id the dispute points at, when PayPal records them. */
  invoiceRefs: string[];
}

function disputedTransactions(record: Record<string, unknown>): Record<string, unknown>[] {
  const list = record.disputed_transactions;
  return Array.isArray(list) ? list.filter(isObject) : [];
}

function buyerName(transaction: Record<string, unknown>): string | null {
  const buyer = transaction.buyer;
  if (!isObject(buyer)) return null;
  const name = buyer.name;
  if (isObject(name)) {
    const joined = [asString(name.given_name), asString(name.surname)]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    if (joined) return joined;
    if (asString(name.full_name)) return asString(name.full_name);
  }
  return asString(buyer.business_name) ?? asString(buyer.email_address);
}

/** The disputed amount: PayPal's own total, else the sum of the transactions. */
function disputedAmount(record: Record<string, unknown>): number {
  const declared = money(record.dispute_amount);
  if (declared !== null) return round2(declared);
  return round2(
    disputedTransactions(record).reduce(
      (sum, transaction) => sum + (money(transaction.gross_amount) ?? 0),
      0,
    ),
  );
}

/**
 * Normalises one PayPal dispute, or null when the record is not a dispute.
 *
 * Every field is optional on the wire — the sandbox has no dispute to compare
 * against — so nothing here assumes a shape beyond `dispute_id`.
 */
export function parseDispute(input: unknown): ParsedDispute | null {
  const record = parseJson(input);
  if (!isObject(record)) return null;

  const id = asString(record.dispute_id, 64) ?? asString(record.id, 64);
  if (!id) return null;

  const transactions = disputedTransactions(record);
  const first = transactions[0] ?? {};

  const reasonCode =
    asString(record.reason, 64) ?? asString(record.dispute_reason, 64);
  const currency =
    moneyCurrency(record.dispute_amount) ??
    moneyCurrency(first.gross_amount) ??
    "USD";

  const invoiceRefs = transactions
    .flatMap((transaction) => [
      asString(transaction.invoice_number, 64),
      asString(transaction.invoice_id, 64),
    ])
    .filter((ref): ref is string => Boolean(ref));

  const messages: DisputeMessage[] = (Array.isArray(record.messages) ? record.messages : [])
    .filter(isObject)
    .map((message) => {
      const postedBy = asString(message.posted_by, 40) ?? "PARTY";
      const actor =
        postedBy === "BUYER"
          ? buyerName(first) ?? "Client"
          : postedBy === "SELLER"
            ? USER_NAME
            : postedBy.charAt(0) + postedBy.slice(1).toLowerCase();
      return {
        date: isoDay(message.time_posted ?? message.create_time),
        actor,
        text: asString(message.content, 600) ?? "(no text)",
      };
    })
    .filter((message) => message.text !== "(no text)" || message.date !== null);

  const client = buyerName(first) ?? "Client";

  return {
    summary: {
      id,
      source: "paypal",
      client,
      amount: disputedAmount(record),
      currency,
      reason: reasonText(reasonCode),
      reasonCode,
      status: asString(record.status, 40) ?? asString(record.dispute_state, 40) ?? "OPEN",
      stage:
        asString(record.dispute_life_cycle_stage, 40) ??
        asString(record.dispute_flow, 40),
      openedAt: isoDay(record.create_time),
      respondBy: isoDay(record.seller_response_due_date),
      invoiceNumber: invoiceRefs[0] ?? null,
    },
    messages,
    invoiceRefs,
  };
}

/** Every dispute carried by a `generateText` step list, deduplicated by id. */
export function collectDisputes(steps: unknown): DisputeSummary[] {
  const summaries: DisputeSummary[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(steps)) return summaries;

  const take = (value: unknown) => {
    for (const parsed of parsedDisputesFrom(value)) {
      if (seen.has(parsed.summary.id)) continue;
      seen.add(parsed.summary.id);
      summaries.push(parsed.summary);
    }
  };

  for (const step of steps) {
    const results = isObject(step) ? step.toolResults : null;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (!isObject(result)) continue;
      const name = asString(result.toolName, 64);
      if (name !== "list_disputes" && name !== "get_dispute") continue;
      take(result.result);
    }
  }

  return summaries;
}

/** One dispute from a tool result, or a whole page of them. */
function parsedDisputesFrom(value: unknown): ParsedDispute[] {
  const parsed = parseJson(value);
  if (!parsed) return [];

  const single = parseDispute(parsed);
  if (single) return [single];

  if (isObject(parsed) && Array.isArray(parsed.items)) {
    return parsed.items
      .map(parseDispute)
      .filter((entry): entry is ParsedDispute => entry !== null);
  }

  if (Array.isArray(parsed)) {
    return parsed
      .map(parseDispute)
      .filter((entry): entry is ParsedDispute => entry !== null);
  }

  return [];
}

/* ------------------------------------------------------------------ *
 * The simulated ledger
 * ------------------------------------------------------------------ */

/** A fixture dispute, tied to the ledger invoice it contests. */
interface SimulatedDispute {
  summary: DisputeSummary;
  /** Ledger invoice id the dispute is attached to, e.g. inv-36. */
  ledgerInvoiceId: string;
}

/**
 * Deterministic disputes for the simulated ledger.
 *
 * The sandbox holds no disputes, so without this a pack could never be built in
 * a demo deployment. The two riskiest unpaid invoices in the ledger are
 * contested — biggest first, then the oldest — which is who a client is most
 * likely to dispute in the first place. Dates are derived from the invoice, not
 * from the clock, so the fixture does not drift between requests.
 */
export function simulatedDisputes(): SimulatedDispute[] {
  const unpaid = generateHistory().filter((row) => row.status === "UNPAID");
  if (unpaid.length === 0) return [];

  const bySize = [...unpaid].sort((a, b) => b.amount - a.amount)[0];
  const byAge = [...unpaid].sort((a, b) => a.due.getTime() - b.due.getTime())[0];
  const chosen = bySize.id === byAge.id ? [bySize] : [bySize, byAge];

  return chosen.map((row, index) => {
    const opened = addDays(row.due, 4);
    const respondBy = addDays(opened, 10);
    return {
      ledgerInvoiceId: row.id,
      summary: {
        id: `PP-D-${9001 + index}-${row.id.toUpperCase()}`,
        source: "simulated",
        client: row.client,
        amount: row.amount,
        currency: "USD",
        reason: reasonText("MERCHANDISE_OR_SERVICE_NOT_RECEIVED"),
        reasonCode: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        status: "OPEN",
        stage: "CHARGEBACK",
        openedAt: isoDay(opened),
        respondBy: isoDay(respondBy),
        invoiceNumber: row.id,
      },
    };
  });
}

/**
 * Wordings that mean the turn is about a dispute.
 *
 * `disput\w*` rather than `disputes?`: "is invoice inv-36 disputed?" asks the
 * same question, and a bare `dispute` misses it by a letter.
 */
export const DISPUTE_TOPIC = /\b(disput\w*|chargebacks?|proof packs?)\b/i;

/**
 * The ledger's simulated disputes to show for a turn about disputes.
 *
 * The sandbox holds no dispute and cannot be made to hold one through the
 * toolkit, so the fixture is what makes the proof pack reachable in the app it
 * was built for. The records are labelled simulated on the card and on the PDF
 * cover, the same way the anomaly sweep and the autopilot shortlist label an
 * empty sandbox — the ledger is this deployment's data layer.
 *
 * A turn that names a case the fixtures do not hold returns nothing. "The
 * dispute on invoice 1042" must not be answered with another client's case: it
 * would put the wrong client in front of the freelancer and the card's button
 * would build the wrong pack. When the user named a case, the model's "no
 * dispute on file" is the whole answer.
 */
export function fixtureDisputesFor(userText: string): DisputeSummary[] {
  const fixtures = simulatedDisputes();
  const tokens = referenceTokens(userText);

  const mentioned = fixtures.filter((entry) =>
    [entry.summary.id, entry.ledgerInvoiceId, entry.summary.invoiceNumber]
      .filter((value): value is string => Boolean(value))
      .some((value) => tokens.has(value.toLowerCase())),
  );
  if (mentioned.length > 0) return mentioned.map((entry) => entry.summary);
  if (namesReference(tokens)) return [];

  return fixtures.map((entry) => entry.summary);
}

/** The words of a question, lowercased, punctuation dropped. */
function referenceTokens(text: string): Set<string> {
  const tokens = (text.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? []).map((token) =>
    token.replace(/-+$/, ""),
  );
  return new Set(tokens);
}

/**
 * Does the question name a specific invoice or dispute?
 *
 * A token holding a digit, unless it is a four-digit year: "the dispute on
 * invoice 1042" names a case, "my disputes in 2026" names a period.
 */
function namesReference(tokens: Set<string>): boolean {
  for (const token of tokens) {
    if (token.length < 3 || !/\d/.test(token)) continue;
    const year = Number(token);
    if (/^\d{4}$/.test(token) && year >= 1990 && year <= 2099) continue;
    return true;
  }
  return false;
}

/**
 * The ledger invoice with this id or number.
 *
 * Exact matches only. An earlier version also guessed "the client's biggest
 * open invoice" when the reference did not match, which put a different
 * invoice on a dispute's proof pack — the one thing a document like this must
 * never do.
 */
function findLedgerInvoice(ref: string | null): LedgerInvoice | null {
  if (!ref) return null;
  const wanted = ref.trim().toLowerCase();
  return generateHistory().find((row) => row.id.toLowerCase() === wanted) ?? null;
}

/* ------------------------------------------------------------------ *
 * Payments and timeline
 * ------------------------------------------------------------------ */

function paymentsFromInvoiceRecord(
  record: unknown,
  disputed: number,
  currency: string,
): DisputePaymentEntry[] {
  if (!isObject(record)) return [];
  const payments = isObject(record.payments) ? record.payments : {};
  const transactions = Array.isArray(payments.transactions) ? payments.transactions : [];

  let balance = disputed;
  return transactions
    .filter(isObject)
    .map((transaction) => {
      const amount = money(transaction.amount) ?? 0;
      balance = round2(balance - amount);
      return {
        date: isoDay(transaction.payment_date ?? transaction.create_time),
        amount,
        currency: moneyCurrency(transaction.amount) ?? currency,
        reference:
          asString(transaction.payment_id, 64) ??
          asString(transaction.method, 40) ??
          "PayPal payment",
        balance,
      };
    })
    .filter((entry) => entry.amount > 0);
}

function paymentsFromLedger(row: LedgerInvoice): DisputePaymentEntry[] {
  if (row.status !== "PAID" || !row.paidDate) return [];
  return [
    {
      date: isoDay(row.paidDate),
      amount: row.amount,
      currency: "USD",
      reference: `Ledger settlement (${row.delayDays ?? 0}d after due)`,
      balance: 0,
    },
  ];
}

/** Other payments from the same client, newest first — context, not balance. */
function clientPaymentHistory(client: string, excludeInvoiceId: string): DisputeClientPayment[] {
  return generateHistory()
    .filter((row) => row.client === client && row.id !== excludeInvoiceId)
    .filter((row) => row.status === "PAID" || row.refunded)
    .sort((a, b) => (b.paidDate?.getTime() ?? 0) - (a.paidDate?.getTime() ?? 0))
    .slice(0, 8)
    .map((row) => ({
      date: isoDay(row.paidDate ?? row.issued),
      amount: row.amount,
      reference: `${row.id}${row.refunded ? " (refunded)" : ""}`,
      refunded: row.refunded,
    }));
}

interface TimelineInput {
  invoice: InvoicePayload | null;
  ledgerInvoiceId: string | null;
  dispute: DisputeSummary | null;
  messages: DisputeMessage[];
  payments: DisputePaymentEntry[];
  /** Where the payments were read from: a PayPal invoice record or the ledger. */
  paymentsFrom: "paypal" | "ledger";
  now: Date;
}

/**
 * The dated history of the dispute, oldest first.
 *
 * Reminders come from the chasing ladder rather than from PayPal: the toolkit
 * can send one but cannot read one back, so the ladder's dates are what the
 * record supports. Each entry carries its kind so the PDF can say where the
 * fact came from.
 */
function buildTimeline(input: TimelineInput): DisputeTimelineEntry[] {
  const entries: DisputeTimelineEntry[] = [];
  const invoice = input.invoice;

  /*
   * A fixture dispute's own dates are the ledger's invention, so its events are
   * labelled simulated rather than PayPal's. The document is filed as evidence;
   * a reader must be able to tell which dates PayPal can confirm.
   */
  const disputeKind =
    input.dispute?.source === "simulated" ? ("simulated" as const) : ("paypal" as const);

  if (invoice?.issued) {
    entries.push({
      date: invoice.issued,
      actor: USER_NAME,
      event: `Invoice ${invoice.number} issued to ${invoice.client}`,
      kind: invoice.payUrl ? "paypal" : "ledger",
    });
  }

  if (invoice?.payUrl) {
    entries.push({
      date: invoice.issued ?? "",
      actor: USER_NAME,
      event: `Invoice ${invoice.number} sent to ${invoice.client} with a PayPal pay link`,
      kind: "paypal",
    });
  } else if (invoice && invoice.status === "DRAFT") {
    entries.push({
      date: invoice.issued ?? "",
      actor: USER_NAME,
      event: `Invoice ${invoice.number} created on PayPal as a draft, not yet sent`,
      kind: "paypal",
    });
  }

  if (invoice?.due) {
    entries.push({
      date: invoice.due,
      actor: "—",
      event: `Invoice ${invoice.number} fell due`,
      kind: invoice.payUrl ? "paypal" : "ledger",
    });
  }

  /* The chasing ladder, for the invoices the ledger knows. */
  if (input.ledgerInvoiceId && invoice?.due) {
    const schedule = getReminderSchedule(input.ledgerInvoiceId, input.now) ?? [];
    const due = new Date(`${invoice.due}T00:00:00Z`);
    for (const reminder of schedule) {
      const when = addDays(due, reminder.day);
      if (when.getTime() > input.now.getTime()) continue; // Not sent yet.
      entries.push({
        date: isoDay(when) ?? "",
        actor: USER_NAME,
        event: `Reminder sent to ${invoice.client} (${reminder.tone} tone, ${reminder.day} ${reminder.day === 1 ? "day" : "days"} past due)`,
        kind: "schedule",
      });
    }
  }

  for (const payment of input.payments) {
    entries.push({
      date: payment.date ?? "",
      actor: invoice?.client ?? "Client",
      event: `Payment received — ${payment.amount.toFixed(2)} ${payment.currency}`,
      kind: input.paymentsFrom,
    });
  }

  if (invoice && input.payments.length === 0 && invoice.due) {
    const daysOverdue = Math.floor(
      (input.now.getTime() - new Date(`${invoice.due}T00:00:00Z`).getTime()) / 86_400_000,
    );
    if (daysOverdue >= 1) {
      entries.push({
        date: isoDay(addDays(new Date(`${invoice.due}T00:00:00Z`), 1)) ?? "",
        actor: "—",
        event: `Invoice unpaid and past due (${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} as at ${formatDay(isoDay(input.now))})`,
        kind: "ledger",
      });
    }
  }

  if (input.dispute?.openedAt) {
    entries.push({
      date: input.dispute.openedAt,
      actor: input.dispute.client,
      event: `${input.dispute.client} opened a dispute (${input.dispute.reason}), ${input.dispute.status}`,
      kind: disputeKind,
    });
  }

  for (const message of input.messages) {
    entries.push({
      date: message.date ?? "",
      actor: message.actor,
      event: `${message.actor} wrote: "${message.text}"`,
      kind: "paypal",
    });
  }

  if (input.dispute?.respondBy) {
    entries.push({
      date: input.dispute.respondBy,
      actor: disputeKind === "paypal" ? "PayPal" : "—",
      event: "Deadline for the seller's response and evidence",
      kind: disputeKind,
    });
  }

  return entries
    .filter((entry) => entry.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/* ------------------------------------------------------------------ *
 * The freelancer's position, drafted by the model
 * ------------------------------------------------------------------ */

/**
 * The longest the pack's history may run before entries are dropped.
 *
 * A PayPal thread on a large invoice carries hundreds of events and every one
 * becomes a block of text on an A4 page: an uncapped pack ran to fourteen pages
 * in testing, past the length the document is allowed and past what a reviewer
 * reads. The head is kept because it holds the issue, the send and the due date;
 * the tail is kept because it holds the reminders, the dispute and the response
 * deadline. What goes is the middle, and the page says how much went with it.
 */
const MAX_TIMELINE_ENTRIES = 30;
const TIMELINE_HEAD = 6;

/**
 * The longest the payments table may run. The most recent payments are the ones
 * a reviewer checks against the balance, and the totals are computed from the
 * full list either way.
 */
const MAX_PAYMENTS = 20;

/** Trims a timeline to the head and the tail, reporting what was dropped. */
function capTimeline(entries: DisputeTimelineEntry[]): {
  entries: DisputeTimelineEntry[];
  omitted: number;
} {
  if (entries.length <= MAX_TIMELINE_ENTRIES) return { entries, omitted: 0 };

  const head = entries.slice(0, TIMELINE_HEAD);
  const tail = entries.slice(entries.length - (MAX_TIMELINE_ENTRIES - TIMELINE_HEAD));
  return { entries: [...head, ...tail], omitted: entries.length - MAX_TIMELINE_ENTRIES };
}

export interface PositionFacts {
  client: string;
  invoiceNumber: string | null;
  amount: number;
  currency: string;
  issued: string | null;
  due: string | null;
  disputeReason: string | null;
  disputeStatus: string | null;
  openedAt: string | null;
  respondBy: string | null;
  reminderDates: string[];
  paid: number;
  outstanding: number;
  source: "paypal" | "simulated" | "none";
}

const POSITION_SYSTEM = `You write one paragraph for a freelancer's PayPal dispute response. A PayPal reviewer reads it against the evidence, so it has to read as a record rather than an argument.

You never invent facts. Every date, amount and event must come from the FACTS block and nothing else.
If a fact is absent, do not guess it and do not allude to it.
Mention the invoice, the amount, the dates, and whether payment was received. State that the evidence attached to the document substantiates delivery.
Write in the third person about the invoice and the work. Do not address PayPal, the buyer, or the freelancer. No greeting, no signature, no first person.
No emotion and no appeals: never use words such as unfortunately, clearly, obviously, honestly, frustrating, disappointed, unfair, surprising, kindly, urgently, please, or ASAP, and never an exclamation mark.
No judgment of the client: no claim about their intent, honesty, character or reliability, and no adjective that passes judgment on them.
No pressure tactics: no mention of escalation, collections, legal action, late fees, or what happens next.
Do not argue the merits in the reader's place or draw conclusions the FACTS block does not support. State what happened in date order and let the attachments carry the argument.
At most five sentences. No markdown, no bullet points, no headings.`;

function factLines(facts: PositionFacts): string {
  return [
    `Client: ${facts.client}`,
    `Invoice: ${facts.invoiceNumber ?? "not recorded"}`,
    `Invoice amount: ${formatInvoiceMoney(facts.amount, facts.currency)}`,
    `Issued: ${facts.issued ?? "not recorded"}`,
    `Due: ${facts.due ?? "not recorded"}`,
    `Dispute reason: ${facts.disputeReason ?? "not recorded"}`,
    `Dispute status: ${facts.disputeStatus ?? "not recorded"}`,
    `Dispute opened: ${facts.openedAt ?? "not recorded"}`,
    `Response deadline: ${facts.respondBy ?? "not recorded"}`,
    `Reminders sent: ${facts.reminderDates.length ? facts.reminderDates.join(", ") : "none recorded"}`,
    `Payments received: ${facts.paid > 0 ? formatInvoiceMoney(facts.paid, facts.currency) : "none"}`,
    `Outstanding: ${formatInvoiceMoney(facts.outstanding, facts.currency)}`,
  ].join("\n");
}

/**
 * The deterministic paragraph, used when the model is unavailable.
 *
 * It reads the facts back rather than pretending to argue: no delivery claim is
 * made beyond what the attachments are asked to prove.
 */
export function fallbackPositionStatement(facts: PositionFacts): string {
  const money = formatInvoiceMoney(facts.amount, facts.currency);
  const parts = [
    `Invoice ${facts.invoiceNumber ?? "on record"} for ${money} was issued to ${facts.client}${
      facts.issued ? ` on ${formatDay(facts.issued)}` : ""
    }${facts.due ? ` and fell due on ${formatDay(facts.due)}` : ""}.`,
  ];

  if (facts.reminderDates.length > 0) {
    parts.push(
      `Reminders were sent on ${facts.reminderDates.map((date) => formatDay(date)).join(", ")}.`,
    );
  }

  parts.push(
    facts.paid > 0
      ? `Payments received against it total ${formatInvoiceMoney(facts.paid, facts.currency)}, leaving ${formatInvoiceMoney(facts.outstanding, facts.currency)} outstanding.`
      : `No payment has been received; the full ${money} remains outstanding.`,
  );

  if (facts.disputeReason) {
    parts.push(
      `The dispute is filed as ${facts.disputeReason.toLowerCase()}, which turns on delivery and acceptance.`,
    );
  }

  parts.push(
    "The evidence listed in this pack documents the work, its delivery and the payment terms; the freelancer attaches it below before the response deadline.",
  );

  return parts.join(" ");
}

async function draftWithModel(facts: PositionFacts): Promise<string | null> {
  if (!isModelConfigured()) return null;

  const { text } = await generateText({
    model: coinbaneModel(),
    system: POSITION_SYSTEM,
    prompt: `FACTS\n${factLines(facts)}\n\nWrite the paragraph.`,
    // A stalled provider must not hold the download open; the caller falls back.
    abortSignal: AbortSignal.timeout(20_000),
  });

  const clean = text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/[*_#`]/g, "")
    .trim();
  return clean ? clean.slice(0, 1_500) : null;
}

async function positionStatement(
  facts: PositionFacts,
  draft?: (facts: PositionFacts) => Promise<string | null>,
): Promise<DisputeProofPack["position"]> {
  const drafter = draft ?? draftWithModel;
  try {
    const text = await drafter(facts);
    if (text) return { text, source: "model" };
  } catch (error) {
    console.error("[coinbane] position draft failed:", error);
  }
  return { text: fallbackPositionStatement(facts), source: "fallback" };
}

/* ------------------------------------------------------------------ *
 * Supporting evidence the freelancer still has to attach
 * ------------------------------------------------------------------ */

function buildEvidence(context: {
  client: string;
  invoiceNumber: string | null;
  issued: string | null;
  due: string | null;
  respondBy: string | null;
  payUrl: string | null;
  reminderDates: string[];
  payments: DisputePaymentEntry[];
  reason: string | null;
}): DisputeEvidenceItem[] {
  const items: DisputeEvidenceItem[] = [
    {
      description: `The signed contract, statement of work or written agreement with ${context.client}`,
      note: "Establishes the scope, the rate and the payment terms the invoice was raised under.",
    },
    {
      description:
        "The delivery email or handoff message that transferred the finished work",
      note: "Shows what was delivered and when.",
    },
    {
      description: `Screenshots of the project thread with ${context.client} showing the work was accepted or used`,
      note: "Acceptance after delivery is the strongest answer to a not-received dispute.",
    },
    {
      description: `The deliverable files themselves${context.invoiceNumber ? ` covered by invoice ${context.invoiceNumber}` : ""}`,
      note: "Attach the files, or dated links to where the client can still reach them.",
    },
  ];

  if (context.issued) {
    items.push({
      description: `The invoice document (this pack) as sent${context.issued ? ` on ${formatDay(context.issued)}` : ""}`,
      note: "Shows the client was billed with the agreed terms and a due date.",
    });
  }

  if (context.payUrl) {
    items.push({
      description: `The PayPal invoice page and its pay link: ${context.payUrl}`,
      note: "Shows the invoice was live in PayPal and payable from the day it was issued.",
    });
  }

  if (context.reminderDates.length > 0) {
    items.push({
      description: `Copies of the reminder emails sent on ${context.reminderDates
        .map((date) => formatDay(date))
        .join(", ")}`,
      note: "Shows the client was chased before the dispute and stayed silent.",
    });
  }

  if (context.payments.length > 0) {
    items.push({
      description: "Receipts for every payment applied to this invoice",
      note: "Reconciles the balance claimed in this dispute.",
    });
  } else {
    items.push({
      description: "A PayPal transaction export for this client showing no payment against this invoice",
      note: "The absence of payment is itself evidence; the export proves it came from PayPal's own records.",
    });
  }

  if (context.reason) {
    items.push({
      description: `Your written response to the ${context.reason.toLowerCase()} claim${context.respondBy ? `, filed before ${formatDay(context.respondBy)}` : ""}`,
      note: "PayPal reads the seller's statement first; keep it to the facts in this pack.",
    });
  }

  return items;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export interface ProofPackRef {
  disputeId?: string;
  invoiceNumber?: string;
  invoiceId?: string;
}

export interface ProofPackDeps {
  now?: Date;
  readDispute?: (disputeId: string) => Promise<unknown | null>;
  listDisputes?: () => Promise<unknown[]>;
  readInvoice?: (invoiceId: string) => Promise<unknown | null>;
  listInvoices?: () => Promise<unknown[]>;
  /** Injected so tests never reach a provider. */
  draftPosition?: (facts: PositionFacts) => Promise<string | null>;
}

function refValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Gathers a proof pack for a dispute or an invoice.
 *
 * Resolution order, and why: the PayPal dispute is the authority when it
 * exists, so it is read first — by id, else by the invoice it names. When
 * PayPal has no dispute (which the sandbox never does), the simulated ledger's
 * fixture is matched, and failing that the pack is assembled from the invoice
 * alone with `dispute: null`, which is a pack the freelancer can file the moment
 * a dispute does arrive. Returns null only when nothing at all resolves.
 */
export async function assembleProofPack(
  ref: ProofPackRef,
  deps: ProofPackDeps = {},
): Promise<DisputeProofPack | null> {
  const now = deps.now ?? new Date();
  const readDispute = deps.readDispute ?? readDisputeRecord;
  const listDisputes = deps.listDisputes ?? listDisputeRecords;
  const readInvoice = deps.readInvoice ?? readInvoiceRecord;
  const listInvoices = deps.listInvoices ?? listInvoiceRecords;

  const disputeId = refValue(ref.disputeId);
  const invoiceNumber = refValue(ref.invoiceNumber);
  const invoiceId = refValue(ref.invoiceId);
  const invoiceRef = invoiceNumber ?? invoiceId;

  /* --- 1. A real PayPal dispute ------------------------------------- */

  let parsed = disputeId ? parseDispute(await readDispute(disputeId)) : null;
  let paypalDisputes: ParsedDispute[] = [];

  /*
   * The whole list is read whenever anything might need it: to find the dispute
   * behind an invoice, to retry a direct read that missed, and to report the
   * client's earlier disputes. One read, four uses.
   */
  if (invoiceRef || disputeId) {
    try {
      paypalDisputes = (await listDisputes()).flatMap((record) =>
        parsedDisputesFrom(record),
      );
    } catch (error) {
      console.error("[coinbane] could not list disputes:", error);
    }
  }

  if (!parsed && disputeId) {
    parsed = paypalDisputes.find((entry) => entry.summary.id === disputeId) ?? null;
  }
  if (!parsed && invoiceRef) {
    parsed = paypalDisputes.find((entry) => entry.invoiceRefs.includes(invoiceRef)) ?? null;
  }

  /* --- 2. The ledger's fixture, when PayPal holds nothing ------------ */

  /*
   * A fixture stands in for a dispute the caller asked about, so it is only
   * attached when the dispute itself was named. Asking for a proof pack for an
   * invoice must not report a dispute that no one filed.
   */
  const fixtures = simulatedDisputes();
  const fixture = disputeId
    ? (fixtures.find((entry) => entry.summary.id === disputeId) ?? null)
    : null;

  const dispute: DisputeSummary | null = parsed?.summary ?? fixture?.summary ?? null;

  /* --- 3. The invoice the dispute or the caller points at ------------ */

  /*
   * The invoice the dispute names joins the caller's reference: a pack built
   * from a dispute id alone still has to reproduce the invoice behind it.
   */
  const wantedNumber =
    invoiceNumber ??
    parsed?.summary.invoiceNumber ??
    fixture?.summary.invoiceNumber ??
    null;

  /*
   * A read only counts when it parses as an invoice. A caller can hand the pack
   * an invoice number where PayPal wants an id, and the toolkit answers that
   * with a failure payload rather than an error — so "something came back" is
   * not evidence the invoice exists.
   */
  let invoice: InvoicePayload | null = null;
  let invoiceRecord: unknown = null;
  const readRefs = new Set(
    [invoiceId, wantedNumber].filter((value): value is string => Boolean(value)),
  );

  for (const candidate of readRefs) {
    const record = await readInvoice(candidate);
    const parsedInvoice = record ? toInvoicePayload(record) : null;
    if (parsedInvoice) {
      invoice = parsedInvoice;
      invoiceRecord = record;
      break;
    }
  }

  /* Fall back to the list, where the invoice number is what can be matched. */
  if (!invoice && wantedNumber) {
    try {
      for (const candidate of await listInvoices()) {
        if (!isObject(candidate)) continue;
        const number = asString(
          (isObject(candidate.detail) ? candidate.detail : {}).invoice_number,
          64,
        );
        if (number !== wantedNumber && asString(candidate.id, 64) !== wantedNumber) continue;

        const parsedInvoice = toInvoicePayload(candidate);
        if (!parsedInvoice) continue;
        invoice = parsedInvoice;
        invoiceRecord = candidate;
        break;
      }
    } catch (error) {
      console.error("[coinbane] could not list invoices:", error);
    }
  }

  let ledgerRow: LedgerInvoice | null = null;

  if (!invoice) {
    ledgerRow = findLedgerInvoice(
      fixture?.ledgerInvoiceId ?? invoiceId ?? invoiceRef ?? null,
    );
    if (ledgerRow) invoice = ledgerInvoiceToPayload(ledgerRow);
  }

  if (!invoice && !dispute) return null;

  /* --- 4. Payments, timeline, position and evidence ------------------ */

  const amount = dispute?.amount ?? invoice?.total ?? 0;
  const currency = dispute?.currency ?? invoice?.currency ?? "USD";

  const payments = invoiceRecord
    ? paymentsFromInvoiceRecord(invoiceRecord, amount, currency)
    : ledgerRow
      ? paymentsFromLedger(ledgerRow)
      : [];
  const paid = round2(payments.reduce((sum, entry) => sum + entry.amount, 0));
  const outstanding = round2(Math.max(0, amount - paid));

  /* Totalled above, so trimming the table cannot change what is owed. */
  const paymentRows = payments.slice(-MAX_PAYMENTS);
  const paymentsOmitted = payments.length - paymentRows.length;

  const timeline = buildTimeline({
    invoice,
    ledgerInvoiceId: ledgerRow?.id ?? null,
    dispute,
    messages: parsed?.messages ?? [],
    payments,
    paymentsFrom: invoiceRecord ? "paypal" : "ledger",
    now,
  });

  /*
   * Read the reminders before the cap: the evidence section lists every one
   * that was sent, whether or not its entry survives into the timeline.
   */
  const reminderDates = timeline
    .filter((entry) => entry.kind === "schedule")
    .map((entry) => entry.date);
  const capped = capTimeline(timeline);

  const facts: PositionFacts = {
    client: dispute?.client ?? invoice?.client ?? "the client",
    invoiceNumber: invoice?.number ?? dispute?.invoiceNumber ?? null,
    amount,
    currency,
    issued: invoice?.issued ?? null,
    due: invoice?.due ?? null,
    disputeReason: dispute?.reason ?? null,
    disputeStatus: dispute?.status ?? null,
    openedAt: dispute?.openedAt ?? null,
    respondBy: dispute?.respondBy ?? null,
    reminderDates,
    paid,
    outstanding,
    source: dispute ? dispute.source : "none",
  };

  return {
    dispute,
    invoice,
    timeline: capped.entries,
    timelineOmitted: capped.omitted,
    payments: paymentRows,
    paymentsOmitted,
    outstanding,
    clientPayments: invoice
      ? clientPaymentHistory(facts.client, ledgerRow?.id ?? invoice.id)
      : [],
    priorDisputes: priorDisputesFor(
      facts.client,
      dispute?.id ?? null,
      parsed ? paypalDisputes.map((entry) => entry.summary) : fixtures.map((entry) => entry.summary),
    ),
    position: await positionStatement(facts, deps.draftPosition),
    evidence: buildEvidence({
      client: facts.client,
      invoiceNumber: facts.invoiceNumber,
      issued: facts.issued,
      due: facts.due,
      respondBy: facts.respondBy,
      payUrl: invoice?.payUrl ?? null,
      reminderDates,
      payments,
      reason: facts.disputeReason,
    }),
    generatedAt: isoDay(now) ?? "",
    currency,
    client: facts.client,
    amount,
  };
}

/** Earlier disputes with the same client, newest first. */
function priorDisputesFor(
  client: string,
  excludeId: string | null,
  candidates: DisputeSummary[],
): DisputeSummary[] {
  return candidates
    .filter(
      (summary) =>
        summary.id !== excludeId &&
        summary.client.toLowerCase() === client.toLowerCase(),
    )
    .sort((a, b) => (b.openedAt ?? "").localeCompare(a.openedAt ?? ""));
}

/** e.g. `dispute-1042-proof-pack.pdf`. */
export function proofPackFileName(pack: DisputeProofPack): string {
  const label =
    pack.dispute?.invoiceNumber ?? pack.invoice?.number ?? pack.dispute?.id ?? "pack";
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `dispute-${slug || "pack"}-proof-pack.pdf`;
}
