/*
 * The two value imports below carry their extension on purpose: this module is
 * loaded directly by `node --test` (see analysis.test.ts), and Node resolves
 * real paths rather than extensionless specifiers. Type-only imports are
 * erased before that matters, which is why the rest of lib/ can stay terser.
 */
import { formatMoney } from "./anomaly.ts";
import { clients, generateHistory, type Invoice } from "./clients.ts";
import type { ForecastClientLine, ForecastWindow } from "./types";

/**
 * The intelligence layer: the income explainer and the cash-flow forecast.
 *
 * Both are pure reads over the simulated ledger in ./clients — no network, no
 * framework imports — so the stories the agent tells can be reasoned about and
 * exercised in isolation. Nothing here writes, and no figure is ever invented:
 * every number is a sum over `generateHistory()`.
 */

const MS_PER_DAY = 86_400_000;

/** Client profiles, keyed by name so a lookup is one map hit. */
const PROFILES = new Map(clients.map((client) => [client.name, client]));

/** The three horizons the forecast always reports. */
export type ForecastHorizon = 30 | 60 | 90;

const HORIZONS: ForecastHorizon[] = [30, 60, 90];

type DateWindow = { start: Date; end: Date };

/** Local calendar boundaries, matching how `generateHistory` builds its dates. */
function startOfMonth(date: Date, offset = 0): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

function monthWindow(now: Date, offset: number): DateWindow {
  return { start: startOfMonth(now, offset), end: startOfMonth(now, offset + 1) };
}

function within(date: Date, window: DateWindow): boolean {
  return date.getTime() >= window.start.getTime() && date.getTime() < window.end.getTime();
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function monthName(date: Date): string {
  return date.toLocaleString("en-US", { month: "long" });
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** One decimal, and whole numbers stay whole: 31%, 67.6%. */
function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

/**
 * Percentage change between two months.
 *
 * Returns 0 when there is no baseline to compare against — with an empty
 * previous month the ratio is undefined, not infinite, and a story about a
 * missing baseline is written from the two totals instead.
 */
function percentChange(thisMonth: number, lastMonth: number): number {
  if (lastMonth <= 0) return 0;
  return roundTo(((thisMonth - lastMonth) / lastMonth) * 100, 1);
}

/**
 * Resolves a client name the way a person would say it: exact, then
 * case-insensitive, then a unique prefix or partial match. Anything ambiguous
 * resolves to nothing rather than to the wrong client.
 */
export function resolveClientName(input: string): string | null {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return null;

  const lower = (name: string) => name.toLowerCase();
  const exact = clients.find((client) => lower(client.name) === wanted);
  if (exact) return exact.name;

  for (const match of [
    clients.filter((client) => lower(client.name).startsWith(wanted)),
    clients.filter((client) => lower(client.name).includes(wanted)),
  ]) {
    if (match.length === 1) return match[0].name;
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Part 1 — "Why am I broke?"
 * ------------------------------------------------------------------ */

export interface IncomeReason {
  /** A clause that reads as the reason, naming the client. */
  label: string;
  /** Signed money this reason moved: negative is cash you did not get. */
  impact: number;
}

export interface IncomeExplanation {
  story: string;
  /** Cash collected so far this calendar month, net of refunds. */
  thisMonth: number;
  /** Cash collected across the whole previous calendar month. */
  lastMonth: number;
  percentChange: number;
  reasons: IncomeReason[];
}

interface ClientLedger {
  name: string;
  profile: (typeof clients)[number];
  collected: number;
  collectedLast: number;
  delta: number;
  paidThisMonth: Invoice[];
  refundsThisMonth: Invoice[];
  pastDue: Invoice[];
  pastDueTotal: number;
  oldestPastDueDays: number;
}

/** Cash that stayed: paid, and not clawed back by a refund. */
function collectedIn(rows: Invoice[], window: DateWindow): number {
  return rows.reduce(
    (sum, row) =>
      row.paidDate && !row.refunded && within(row.paidDate, window)
        ? sum + row.amount
        : sum,
    0,
  );
}

function buildLedger(
  name: string,
  rows: Invoice[],
  now: Date,
  current: DateWindow,
  previous: DateWindow,
): ClientLedger {
  const own = rows.filter((row) => row.client === name);
  const paidThisMonth = own.filter(
    (row) => !row.refunded && row.paidDate !== null && within(row.paidDate, current),
  );
  const refundsThisMonth = own.filter(
    (row) => row.refunded && row.paidDate !== null && within(row.paidDate, current),
  );

  // Money owed and not in hand: anything unpaid, plus anything past its due
  // date that has still not settled.
  const pastDue = own.filter(
    (row) =>
      row.status !== "PAID" &&
      (row.status === "UNPAID" || row.due.getTime() < now.getTime()),
  );

  const collected = collectedIn(own, current);
  const collectedLast = collectedIn(own, previous);

  return {
    name,
    profile: PROFILES.get(name)!,
    collected,
    collectedLast,
    delta: collected - collectedLast,
    paidThisMonth,
    refundsThisMonth,
    pastDue,
    pastDueTotal: pastDue.reduce((sum, row) => sum + row.amount, 0),
    oldestPastDueDays: pastDue.reduce(
      (oldest, row) => Math.max(oldest, daysBetween(row.due, now)),
      0,
    ),
  };
}

/** A refund cluster: several refunds landing inside the same week. */
function sameWeek(refunds: Invoice[]): boolean {
  const dates = refunds
    .map((row) => row.paidDate)
    .filter((date): date is Date => date !== null);
  if (dates.length < 2) return false;
  const times = dates.map((date) => date.getTime());
  const spread = Math.max(...times) - Math.min(...times);
  return spread <= 7 * MS_PER_DAY;
}

/**
 * The clause explaining one client's movement.
 *
 * The cause is read off that client's own ledger — a late settlement, refunds
 * clawing cash back, or a month with nothing in it — so the same client reads
 * differently depending on what actually happened.
 */
function swingLabel(ledger: ClientLedger, previousMonth: string): string {
  const { name, profile, delta, collected, collectedLast, paidThisMonth } = ledger;

  if (delta > 0) {
    // Late by this client's own standard is worth saying; on time is not.
    const top = paidThisMonth.reduce<Invoice | null>(
      (biggest, row) => (biggest === null || row.amount > biggest.amount ? row : biggest),
      null,
    );
    if (top === null) return `${name} cleared ${formatMoney(collected)}`;
    const late = top.delayDays !== null && top.delayDays > profile.delayMean;
    return late
      ? `${name} paid ${formatMoney(top.amount)}, ${top.delayDays} days late`
      : `${name} cleared ${formatMoney(top.amount)}`;
  }

  if (ledger.refundsThisMonth.length > 0) {
    const pulled = ledger.refundsThisMonth.reduce((sum, row) => sum + row.amount, 0);
    return sameWeek(ledger.refundsThisMonth)
      ? `${ledger.refundsThisMonth.length} refunds from ${name} cleared in the same week, pulling ${formatMoney(pulled)} back out`
      : `${name} refunded ${formatMoney(pulled)} this month`;
  }

  if (collected === 0) {
    return `nothing landed from ${name} this month after ${formatMoney(collectedLast)} in ${previousMonth}`;
  }

  return `${name} came in ${formatMoney(collectedLast - collected)} short of last month`;
}

/** A client sitting on money that should already be in hand. */
function exposureLabel(ledger: ClientLedger): string {
  if (ledger.oldestPastDueDays > 0) {
    return `${ledger.name} has ${formatMoney(ledger.pastDueTotal)} past due, the oldest ${ledger.oldestPastDueDays} days late`;
  }
  return `${ledger.name} has ${formatMoney(ledger.pastDueTotal)} in unpaid invoices`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "a, b, and c" — the way the story reads, never a bare list. */
function joinClauses(clauses: string[]): string {
  if (clauses.length === 1) return clauses[0];
  return `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
}

const COUNT_WORDS = ["no", "one", "two", "three"];

/**
 * Why income moved, from the simulated ledger.
 *
 * Income is cash that actually stayed: an invoice counts in the month it was
 * paid, and a refunded invoice counts in neither month, because that money
 * came back out. That is what makes a late payment or a refund an explanation
 * for the change rather than a rounding artefact of when work was billed.
 *
 * `reasons` is ranked by money moved and capped at three, so it is the top
 * drivers of the change rather than an exact decomposition when more than
 * three clients moved. When income did not rise, the largest past-due
 * exposure is ranked in too — money owed is a reason to feel broke even in a
 * month where the comparison is favourable.
 */
export function explainIncomeChange(now: Date = new Date()): IncomeExplanation {
  const rows = generateHistory();
  const current = monthWindow(now, 0);
  const previous = monthWindow(now, -1);

  const ledgers = clients.map((client) =>
    buildLedger(client.name, rows, now, current, previous),
  );

  const thisMonth = ledgers.reduce((sum, ledger) => sum + ledger.collected, 0);
  const lastMonth = ledgers.reduce((sum, ledger) => sum + ledger.collectedLast, 0);
  const delta = thisMonth - lastMonth;
  const change = percentChange(thisMonth, lastMonth);
  const previousMonth = monthName(startOfMonth(now, -1));

  const candidates: IncomeReason[] = ledgers
    .filter((ledger) => ledger.delta !== 0)
    .map((ledger) => ({
      label: swingLabel(ledger, previousMonth),
      impact: ledger.delta,
    }));

  if (delta <= 0) {
    // A shortfall month: unpaid money is a driver in its own right, so long as
    // the client is not already speaking in the list above.
    const named = new Set(
      ledgers.filter((ledger) => ledger.delta !== 0).map((ledger) => ledger.name),
    );
    for (const ledger of ledgers) {
      if (ledger.pastDueTotal <= 0 || named.has(ledger.name)) continue;
      candidates.push({ label: exposureLabel(ledger), impact: -ledger.pastDueTotal });
    }
  }

  const reasons = candidates
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 3);

  /* The story. Three sentences at most: the change, the reasons, what is
     still owed. */
  const positives = reasons.filter((reason) => reason.impact > 0).length;
  const negatives = reasons.filter((reason) => reason.impact < 0).length;

  let lead: string;
  if (change > 0) {
    const shape =
      negatives === 0 && reasons.length >= 2
        ? ` on ${COUNT_WORDS[reasons.length]} payments that landed`
        : "";
    lead = `Your income rose ${formatPercent(change)} this month${shape}.`;
  } else if (change < 0) {
    const shape =
      positives === 0 && reasons.length >= 2
        ? ` because ${COUNT_WORDS[reasons.length]} things hit at once`
        : "";
    lead = `Your income dropped ${formatPercent(Math.abs(change))} this month${shape}.`;
  } else {
    lead = "Your income held steady this month.";
  }

  const clauseSentence =
    reasons.length === 0
      ? "Nothing moved either way: the same work settled in both months."
      : `${reasons.length === 1 ? capitalize(reasons[0].label) : joinClauses(reasons.map((reason) => reason.label))}.`;

  const pastDueTotal = ledgers.reduce((sum, ledger) => sum + ledger.pastDueTotal, 0);
  const pastDueCount = ledgers.reduce((sum, ledger) => sum + ledger.pastDue.length, 0);
  const oldestPastDueDays = ledgers.reduce(
    (oldest, ledger) => Math.max(oldest, ledger.oldestPastDueDays),
    0,
  );

  const owed =
    pastDueCount > 0
      ? `${formatMoney(pastDueTotal)} is sitting past due across ${pastDueCount} ${pastDueCount === 1 ? "invoice" : "invoices"}, the oldest ${oldestPastDueDays} days late.`
      : null;

  const story = [lead, clauseSentence, owed].filter(Boolean).join(" ");

  return { story, thisMonth, lastMonth, percentChange: change, reasons };
}

/* ------------------------------------------------------------------ *
 * Part 2 — cash-flow forecast and "what if"
 * ------------------------------------------------------------------ */

export interface ForecastOptions {
  /** Which horizon the answer should focus on. All three are always returned. */
  window?: ForecastHorizon;
  /** Clients to leave out entirely, by name as the user said it. */
  exclude?: string[];
  /** Extra days a client is expected to pay later than its usual pattern. */
  delays?: Record<string, number>;
  now?: Date;
}

export interface CashflowForecast {
  focusDays: ForecastHorizon;
  windows: ForecastWindow[];
  clients: ForecastClientLine[];
  /** Canonical names of the clients left out of the projection. */
  excluded: string[];
  /** Canonical names and the extra delay days applied to them. */
  appliedDelays: Record<string, number>;
  /** Open invoices the projection is built from, after exclusions. */
  openInvoices: number;
  /** Every horizon with no exclusions and no adjustments, for comparison. */
  baseline: ForecastWindow[];
}

/**
 * Projects when open invoices will land.
 *
 * Each side of the range comes from the client's own payment history: the
 * expected date is the due date plus that client's average delay, the
 * pessimistic date adds two standard deviations on top, and the optimistic
 * date takes one standard deviation off. A horizon accumulates every invoice
 * whose projected date falls inside it, so the 90-day figure includes the
 * 30-day one.
 *
 * Confidence per client is the chance the money is not simply never paid.
 */
export function forecastCashflow(options: ForecastOptions = {}): CashflowForecast {
  const now = options.now ?? new Date();
  const focusDays = options.window ?? 30;

  const excluded: string[] = [];
  for (const name of options.exclude ?? []) {
    const resolved = resolveClientName(name);
    if (resolved && !excluded.includes(resolved)) excluded.push(resolved);
  }

  const appliedDelays: Record<string, number> = {};
  for (const [name, days] of Object.entries(options.delays ?? {})) {
    const resolved = resolveClientName(name);
    if (!resolved || !Number.isFinite(days)) continue;
    appliedDelays[resolved] = days;
  }

  const open = generateHistory().filter(
    (row) => row.status === "SENT" || row.status === "UNPAID",
  );

  const project = (
    excludedNames: string[],
    delays: Record<string, number>,
  ): ForecastWindow[] =>
    HORIZONS.map((days) => {
      const limit = addDays(now, days).getTime();
      let expected = 0;
      let pessimistic = 0;
      let optimistic = 0;

      for (const row of open) {
        if (excludedNames.includes(row.client)) continue;
        const profile = PROFILES.get(row.client);
        if (!profile) continue;

        const mean = profile.delayMean + (delays[row.client] ?? 0);
        const spread = profile.delayStd;
        if (addDays(row.due, mean).getTime() <= limit) expected += row.amount;
        if (addDays(row.due, mean + 2 * spread).getTime() <= limit) {
          pessimistic += row.amount;
        }
        if (addDays(row.due, Math.max(0, mean - spread)).getTime() <= limit) {
          optimistic += row.amount;
        }
      }

      return { days, expected, pessimistic, optimistic };
    });

  // Per-client detail over the focused horizon, in roster order.
  const limit = addDays(now, focusDays).getTime();
  const lines: ForecastClientLine[] = [];
  for (const client of clients) {
    if (excluded.includes(client.name)) continue;
    const own = open.filter((row) => row.client === client.name);
    if (own.length === 0) continue;

    const mean = client.delayMean + (appliedDelays[client.name] ?? 0);
    const expected = own.reduce(
      (sum, row) => (addDays(row.due, mean).getTime() <= limit ? sum + row.amount : sum),
      0,
    );

    lines.push({
      client: client.name,
      expected,
      confidence: roundTo(1 - client.neverPayRate, 2),
    });
  }

  return {
    focusDays,
    windows: project(excluded, appliedDelays),
    clients: lines.sort((a, b) => b.expected - a.expected),
    excluded,
    appliedDelays,
    openInvoices: open.filter((row) => !excluded.includes(row.client)).length,
    baseline: project([], {}),
  };
}

/* ------------------------------------------------------------------ *
 * Part 3 — payment probability, one invoice at a time
 * ------------------------------------------------------------------ */

export type RiskLabel = "low" | "medium" | "high";

export type ReminderTone = "gentle" | "firm" | "urgent";

/** One step of a chasing schedule, counted in days past the due date. */
export interface Reminder {
  day: number;
  tone: ReminderTone;
}

export interface InvoiceScore {
  invoiceId: string;
  /** Probability this invoice is paid, 0 to 1. Higher is safer. */
  score: number;
  risk: RiskLabel;
  recommendation: string;
  client: string;
  amount: number;
  daysOverdue: number;
}

/** A month past due costs the whole delay penalty; beyond that it cannot worsen. */
const DELAY_WINDOW_DAYS = 30;
const DELAY_WEIGHT = 0.4;
const REFUND_WEIGHT = 0.5;

const LOW_RISK_FLOOR = 0.85;
const MEDIUM_RISK_FLOOR = 0.6;

const RECOMMENDATIONS: Record<RiskLabel, string> = {
  low: "No action needed. This client pays reliably.",
  medium: "Send a gentle reminder at day 3 past due.",
  high: "Send a firm reminder immediately. Consider escalation.",
};

/**
 * The chasing ladder, keyed by risk rather than by score.
 *
 * A safer client is chased later and more gently; a riskier one is chased on
 * the due date itself and escalates in tone. Days are counted from the due
 * date, so day 0 is the day it falls due.
 */
const REMINDER_SCHEDULE: Record<RiskLabel, Reminder[]> = {
  low: [{ day: 3, tone: "gentle" }],
  medium: [
    { day: 1, tone: "gentle" },
    { day: 7, tone: "firm" },
  ],
  high: [
    { day: 0, tone: "firm" },
    { day: 3, tone: "urgent" },
    { day: 7, tone: "urgent" },
  ],
};

/** Whole days past the due date, or 0 for anything not yet late or settled. */
function overdueDays(invoice: Invoice, now: Date): number {
  if (invoice.status === "PAID") return 0;
  return Math.max(0, daysBetween(invoice.due, now));
}

function riskLabel(score: number): RiskLabel {
  if (score > LOW_RISK_FLOOR) return "low";
  if (score >= MEDIUM_RISK_FLOOR) return "medium";
  return "high";
}

/**
 * Scores one invoice's chance of being paid.
 *
 * The client's record is the starting point, then two penalties: how far past
 * due the invoice has run, and how often this client refunds. A settled
 * invoice carries no delay penalty, which is why it scores at the top of its
 * client's range.
 *
 * Returns null for an id the ledger does not know, so a caller can say it
 * could not find the invoice rather than scoring a guess.
 */
export function scoreInvoice(
  invoiceId: string,
  now: Date = new Date(),
): InvoiceScore | null {
  const invoice = generateHistory().find((row) => row.id === invoiceId);
  if (!invoice) return null;

  const profile = PROFILES.get(invoice.client);
  if (!profile) return null;

  const overdue = overdueDays(invoice, now);
  const delayPenalty =
    Math.min(overdue / DELAY_WINDOW_DAYS, 1) * DELAY_WEIGHT;
  const refundPenalty = profile.refundRate * REFUND_WEIGHT;

  const score = Math.min(
    1,
    Math.max(
      0,
      roundTo(1 - profile.neverPayRate - delayPenalty - refundPenalty, 2),
    ),
  );
  const risk = riskLabel(score);

  return {
    invoiceId: invoice.id,
    score,
    risk,
    recommendation: RECOMMENDATIONS[risk],
    client: invoice.client,
    amount: invoice.amount,
    daysOverdue: overdue,
  };
}

/**
 * The reminder ladder for one invoice, from its risk score.
 *
 * Null for an unknown id, and an empty list for an invoice that needs no
 * chasing — the two are different answers, so they are different values.
 */
export function getReminderSchedule(
  invoiceId: string,
  now: Date = new Date(),
): Reminder[] | null {
  const scored = scoreInvoice(invoiceId, now);
  if (!scored) return null;
  // Copied out, so a caller editing the ladder cannot rewrite the schedule.
  return REMINDER_SCHEDULE[scored.risk].map((reminder) => ({ ...reminder }));
}

/* ------------------------------------------------------------------ *
 * Insight wording for the proactive path
 * ------------------------------------------------------------------ */

/**
 * A one-line reading of the focused horizon, in CoinBane's voice.
 *
 * Each clause is reported on its own account. What a scenario removes and how
 * much of the remainder is unsafe are independent facts, and tying the second
 * to the first silently dropped the delta whenever the horizon was wide enough
 * that every open invoice fit inside it.
 */
export function forecastSummary(forecast: CashflowForecast): string {
  const focused = forecast.windows.find((window) => window.days === forecast.focusDays);
  if (!focused) return "No forecast available.";

  const parts = [
    `Over the next ${focused.days} days I expect ${formatMoney(focused.expected)} to land, between ${formatMoney(focused.pessimistic)} and ${formatMoney(focused.optimistic)}.`,
  ];

  const atRisk = focused.expected - focused.pessimistic;
  parts.push(
    atRisk > 0
      ? `${formatMoney(atRisk)} of that could slip.`
      : "Even the pessimistic projection brings all of it in.",
  );

  if (forecast.excluded.length > 0) {
    const without = forecast.baseline.find((window) => window.days === forecast.focusDays);
    const delta = without ? without.expected - focused.expected : 0;
    parts.push(
      `Leaving out ${forecast.excluded.join(", ")} removes ${formatMoney(delta)}.`,
    );
  }

  return parts.join(" ");
}
