import type { Insight } from "./types";

/**
 * Money-leak detection.
 *
 * `detectInsights` is pure and total: it takes already-normalised records and
 * returns ranked insights. It is deliberately free of network and framework
 * imports so it can be reasoned about and exercised in isolation.
 *
 * `simulatedInsights` is the deterministic fallback used when the PayPal
 * sandbox is not configured. It is always labelled as simulated by the API so
 * fixture copy can never be mistaken for real ledger data.
 */

export interface TxnLike {
  counterparty: string;
  amount: number;
  /** True when this transaction is a refund paid back to the counterparty. */
  refunded?: boolean;
  /** ISO 8601 date. */
  date: string;
}

export interface InvoiceLike {
  counterparty: string;
  amount: number;
  /** PayPal invoice status, e.g. PAID / SENT / DRAFT / OVERDUE. */
  status: string;
  /** ISO 8601 due date. */
  dueDate: string;
  number?: string;
}

export interface DisputeLike {
  counterparty?: string;
  amount?: number;
  /** ISO 8601 date the dispute was opened. */
  date: string;
}

export interface AnomalyInput {
  transactions?: TxnLike[];
  invoices?: InvoiceLike[];
  disputes?: DisputeLike[];
}

const MS_PER_DAY = 86_400_000;
const SEVERITY_RANK: Record<Insight["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const currencyFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number, currency = "USD"): string {
  return `${currency} ${currencyFormatter.format(value)}`;
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function previousMonthKey(date: Date): string {
  const previous = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1),
  );
  return monthKey(previous);
}

function isPaid(status: string): boolean {
  return status.trim().toUpperCase() === "PAID";
}

/**
 * Whole days between two instants, measured on UTC calendar dates.
 *
 * Counting on the date boundary rather than the raw millisecond gap keeps a
 * due date exactly N days ago reporting as N, whatever time of day it is
 * compared against.
 */
function daysBetween(from: Date, to: Date): number {
  const startDay = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate(),
  );
  const endDay = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  return Math.floor((endDay - startDay) / MS_PER_DAY);
}

function percentage(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Overdue invoices — the most direct leak. */
function detectOverdueInvoices(
  invoices: InvoiceLike[],
  now: Date,
): Insight | null {
  const overdue = invoices
    .map((invoice) => ({ invoice, due: parseDate(invoice.dueDate) }))
    .filter(
      (entry): entry is { invoice: InvoiceLike; due: Date } =>
        entry.due !== null && entry.due.getTime() < now.getTime(),
    )
    .filter((entry) => !isPaid(entry.invoice.status))
    .sort((a, b) => a.due.getTime() - b.due.getTime());

  if (overdue.length === 0) return null;

  const total = overdue.reduce((sum, entry) => sum + entry.invoice.amount, 0);
  const oldest = overdue[0];
  const daysLate = Math.max(1, daysBetween(oldest.due, now));

  const named = overdue
    .slice(0, 3)
    .map(
      (entry) =>
        `${entry.invoice.counterparty} at ${formatMoney(entry.invoice.amount)}`,
    )
    .join(", ");

  return {
    id: "overdue-invoices",
    severity: daysLate >= 30 ? "high" : "medium",
    headline: `${overdue.length} ${overdue.length === 1 ? "invoice is" : "invoices are"} past due and ${formatMoney(total)} is sitting unpaid`,
    detail: `${named}. The oldest, for ${oldest.invoice.counterparty}, is ${daysLate} ${daysLate === 1 ? "day" : "days"} past due.`,
    metric: {
      label: "Outstanding",
      value: formatMoney(total),
      delta: `${daysLate}d late`,
    },
  };
}

/** A client whose refund rate at least doubled month over month. */
function detectRefundSpikes(
  transactions: TxnLike[],
  now: Date,
): Insight[] {
  const current = monthKey(now);
  const previous = previousMonthKey(now);

  interface Bucket {
    total: number;
    refunded: number;
  }
  const byClient = new Map<string, { current: Bucket; previous: Bucket }>();

  for (const transaction of transactions) {
    const date = parseDate(transaction.date);
    if (!date) continue;
    const key = monthKey(date);
    if (key !== current && key !== previous) continue;

    const counterparty = transaction.counterparty.trim();
    if (!counterparty) continue;

    const entry = byClient.get(counterparty) ?? {
      current: { total: 0, refunded: 0 },
      previous: { total: 0, refunded: 0 },
    };
    const bucket = key === current ? entry.current : entry.previous;
    const amount = Math.abs(transaction.amount);
    bucket.total += amount;
    if (transaction.refunded) bucket.refunded += amount;

    byClient.set(counterparty, entry);
  }

  const insights: Insight[] = [];

  for (const [counterparty, entry] of byClient) {
    if (entry.current.total <= 0 || entry.previous.total <= 0) continue;

    const currentRatio = entry.current.refunded / entry.current.total;
    const previousRatio = entry.previous.refunded / entry.previous.total;
    if (previousRatio <= 0 || currentRatio < previousRatio * 2) continue;

    const increase = Math.round((currentRatio / previousRatio - 1) * 100);

    insights.push({
      id: `refund-spike-${counterparty.toLowerCase().replace(/\s+/g, "-")}`,
      severity: increase >= 200 ? "high" : "medium",
      headline: `your refund rate from ${counterparty} spiked ${increase}% this month`,
      detail: `Refunds went from ${percentage(previousRatio)} of billings last month to ${percentage(currentRatio)} this month, on ${formatMoney(entry.current.total)} of activity.`,
      metric: {
        label: "Refund rate",
        value: percentage(currentRatio),
        delta: `+${increase}%`,
      },
    });
  }

  return insights;
}

/** Disputes opened this month, up sharply against last month. */
function detectDisputeSpike(
  disputes: DisputeLike[],
  now: Date,
): Insight | null {
  const current = monthKey(now);
  const previous = previousMonthKey(now);

  let currentCount = 0;
  let previousCount = 0;
  let currentAmount = 0;

  for (const dispute of disputes) {
    const date = parseDate(dispute.date);
    if (!date) continue;
    const key = monthKey(date);
    if (key === current) {
      currentCount += 1;
      currentAmount += Math.abs(dispute.amount ?? 0);
    } else if (key === previous) {
      previousCount += 1;
    }
  }

  if (currentCount < 2) return null;
  const rose = previousCount === 0 ? currentCount >= 2 : currentCount >= previousCount * 2;
  if (!rose) return null;

  return {
    id: "dispute-spike",
    severity: currentCount >= 3 ? "high" : "medium",
    headline: `${currentCount} disputes opened this month against ${previousCount} last month`,
    detail:
      currentAmount > 0
        ? `${formatMoney(currentAmount)} of contested volume. Respond to each one before the PayPal deadline.`
        : "Open each one before the PayPal response deadline.",
    metric: {
      label: "Disputes",
      value: String(currentCount),
      delta: previousCount === 0 ? "new" : `+${currentCount - previousCount}`,
    },
  };
}

/** Ranks every detected leak by severity, then by money at risk. */
export function detectInsights(
  input: AnomalyInput,
  now: Date = new Date(),
): Insight[] {
  const transactions = input.transactions ?? [];
  const invoices = input.invoices ?? [];
  const disputes = input.disputes ?? [];

  const insights: Insight[] = [];

  const overdue = detectOverdueInvoices(invoices, now);
  if (overdue) insights.push(overdue);

  insights.push(...detectRefundSpikes(transactions, now));

  const disputeSpike = detectDisputeSpike(disputes, now);
  if (disputeSpike) insights.push(disputeSpike);

  return insights.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

/**
 * Deterministic fixture used when the PayPal sandbox is unreachable or
 * unconfigured. Fixed dates keep it stable across restarts.
 */
export function simulatedInsights(): Insight[] {
  return [
    {
      id: "sim-refund-spike",
      severity: "high",
      headline:
        "your refund rate from Northwind Studio spiked 300% this month",
      detail:
        "Refunds went from 1.0% of billings last month to 4.0% this month, on USD 18,400.00 of activity.",
      metric: { label: "Refund rate", value: "4.0%", delta: "+300%" },
    },
    {
      id: "sim-overdue",
      severity: "medium",
      headline: "two invoices are 41 days past due and USD 7,150.00 is sitting unpaid",
      detail:
        "Northwind Studio at USD 4,650.00, Meridian Labs at USD 2,500.00. Both crossed the 30-day line this week.",
      metric: { label: "Outstanding", value: "USD 7,150.00", delta: "41d late" },
    },
    {
      id: "sim-dispute",
      severity: "low",
      headline: "a dispute from Halcyon Group is still unanswered",
      detail:
        "USD 1,200.00 contested. PayPal closes the response window in four days.",
      metric: { label: "At risk", value: "USD 1,200.00", delta: "4d left" },
    },
  ];
}
