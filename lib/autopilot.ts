import { formatMoney } from "./anomaly.ts";
import { generateHistory } from "./clients.ts";
import {
  explainIncomeChange,
  getReminderSchedule,
  scoreInvoice,
  type InvoiceScore,
} from "./analysis.ts";
import type { AutopilotAction } from "./types";

/**
 * Autopilot: what CoinBane would do today, drafted for approval.
 *
 * Pure and read-only. It proposes; the user decides. Nothing here reaches
 * PayPal — execution lives in the route, next to the toolkit.
 *
 * Four rules, at most one action each, so the list stays a short set of
 * different plays rather than three near-identical reminders. A single invoice
 * can carry two: nudging a client and sweetening the terms are alternatives
 * the user chooses between, not duplicates.
 */

const REMINDER_OVERDUE_DAYS = 14;
const ESCALATION_OVERDUE_DAYS = 30;
const DISCOUNT_RATE = 0.03;
const TAX_POT_RATE = 0.25;

/** High value is relative to this book, with a floor so it means something. */
const HIGH_VALUE_FLOOR = 1_000;
const HIGH_VALUE_MULTIPLE = 2;

/** The endpoint promises a useful shortlist, never an empty screen. */
const MIN_ACTIONS = 2;
const MAX_ACTIONS = 4;

interface Candidate extends AutopilotAction {
  /** Money the action moves or protects. The sort key. */
  weight: number;
}

function money(value: number): string {
  return formatMoney(value);
}

/** The chasing step that is actually due now, given the ladder and lateness. */
function dueReminder(invoiceId: string, daysOverdue: number, now: Date): string {
  const schedule = getReminderSchedule(invoiceId, now);
  if (!schedule || schedule.length === 0) return "";
  const due = [...schedule].reverse().find((step) => step.day <= daysOverdue);
  if (!due) return "";
  return ` The ${due.tone} reminder falls due at day ${due.day}.`;
}

function reminderAction(invoice: InvoiceScore, now: Date): Candidate {
  return {
    id: `reminder-${invoice.invoiceId}`,
    type: "send_reminder",
    invoiceId: invoice.invoiceId,
    headline: `Chase ${invoice.client}'s ${money(invoice.amount)} invoice, ${invoice.daysOverdue} days past due`,
    reasoning: `${invoice.invoiceId} is ${invoice.daysOverdue} days past due and scores ${invoice.score} (${invoice.risk} risk).${dueReminder(invoice.invoiceId, invoice.daysOverdue, now)}`,
    impact: `${money(invoice.amount)} at stake`,
    weight: invoice.amount,
  };
}

function discountAction(invoice: InvoiceScore): Candidate {
  const discount = Math.round(invoice.amount * DISCOUNT_RATE * 100) / 100;
  const net = Math.round((invoice.amount - discount) * 100) / 100;
  return {
    id: `discount-${invoice.invoiceId}`,
    type: "early_pay_discount",
    invoiceId: invoice.invoiceId,
    headline: `Offer ${invoice.client} 3% off to settle ${money(invoice.amount)} now`,
    reasoning: `${invoice.invoiceId} scores ${invoice.score} (${invoice.risk} risk) on a high-value invoice, so paying ${money(discount)} to pull the cash in this month is worth it.`,
    impact: `${money(net)} in hand now, ${money(discount)} given up`,
    weight: net,
  };
}

function taxPotAction(income: number, now: Date): Candidate {
  const parked = Math.round(income * TAX_POT_RATE * 100) / 100;
  const month = now.toLocaleString("en-US", { month: "long" });
  return {
    id: `tax-pot-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`,
    type: "move_to_tax_pot",
    headline: `Move ${money(parked)} of ${month}'s income into the tax pot`,
    reasoning: `You have collected ${money(income)} this month. Setting aside ${Math.round(TAX_POT_RATE * 100)}% of it covers the tax on that income before it gets spent.`,
    impact: `${money(parked)} set aside from ${money(income)}`,
    weight: parked,
  };
}

function escalationAction(invoice: InvoiceScore): Candidate {
  return {
    id: `escalate-${invoice.invoiceId}`,
    type: "escalate_invoice",
    invoiceId: invoice.invoiceId,
    headline: `Escalate ${invoice.client}'s ${money(invoice.amount)} invoice, ${invoice.daysOverdue} days past due`,
    reasoning: `${invoice.invoiceId} is ${invoice.daysOverdue} days past due and scores ${invoice.score} (${invoice.risk} risk), well past the reminder window. This needs a decision rather than another nudge.`,
    impact: `${money(invoice.amount)} at risk for ${invoice.daysOverdue} days`,
    weight: invoice.amount,
  };
}

/** Every open invoice, scored. Kept in ledger order, oldest first. */
function openInvoiceScores(now: Date): InvoiceScore[] {
  return generateHistory()
    .filter((row) => row.status !== "PAID")
    .map((row) => scoreInvoice(row.id, now))
    .filter((score): score is InvoiceScore => score !== null);
}

/** Drops the sort key, leaving the action the client actually sees. */
function toAction(candidate: Candidate): AutopilotAction {
  return {
    id: candidate.id,
    type: candidate.type,
    headline: candidate.headline,
    reasoning: candidate.reasoning,
    impact: candidate.impact,
    invoiceId: candidate.invoiceId,
  };
}

/** The richest candidate from a set, or null when the set is empty. */
function biggest(candidates: Candidate[]): Candidate | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, candidate) =>
    candidate.weight > best.weight ? candidate : best,
  );
}

/**
 * Drafts today's actions, highest impact first.
 *
 * Rules, in the order they are considered: anything more than two weeks past
 * due gets a reminder; a high-value invoice at medium risk gets a discount
 * offer; any income this month gets a quarter of it parked for tax; anything
 * more than a month past due and high risk gets escalated. If fewer than two
 * rules fire, the remaining overdue invoices fill the shortlist, so the user
 * always has something worth approving.
 */
export function draftActions(now: Date = new Date()): AutopilotAction[] {
  const scored = openInvoiceScores(now);
  if (scored.length === 0) return [];

  const average = scored.reduce((sum, invoice) => sum + invoice.amount, 0) / scored.length;
  const highValue = Math.max(HIGH_VALUE_FLOOR, average * HIGH_VALUE_MULTIPLE);

  const overdue = scored.filter(
    (invoice) => invoice.daysOverdue > REMINDER_OVERDUE_DAYS,
  );

  const candidates: Candidate[] = [];

  const reminder = biggest(
    overdue.map((invoice) => reminderAction(invoice, now)),
  );
  if (reminder) candidates.push(reminder);

  const discount = biggest(
    scored
      .filter((invoice) => invoice.risk === "medium" && invoice.amount >= highValue)
      .map(discountAction),
  );
  if (discount) candidates.push(discount);

  const { thisMonth } = explainIncomeChange(now);
  if (thisMonth > 0) candidates.push(taxPotAction(thisMonth, now));

  const escalation = biggest(
    scored
      .filter(
        (invoice) =>
          invoice.daysOverdue > ESCALATION_OVERDUE_DAYS && invoice.risk === "high",
      )
      .map(escalationAction),
  );
  if (escalation) candidates.push(escalation);

  // A thin day still deserves a shortlist: fill from the same overdue set the
  // first rule draws on, which is exactly where the work is.
  if (candidates.length < MIN_ACTIONS) {
    const used = new Set(candidates.map((candidate) => candidate.id));
    for (const invoice of overdue) {
      if (candidates.length >= MIN_ACTIONS) break;
      const extra = reminderAction(invoice, now);
      if (used.has(extra.id)) continue;
      used.add(extra.id);
      candidates.push(extra);
    }
  }

  return candidates
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_ACTIONS)
    .map(toAction);
}
