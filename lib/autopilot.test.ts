import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { draftActions } from "./autopilot.ts";
import { explainIncomeChange, scoreInvoice } from "./analysis.ts";
import { generateHistory } from "./clients.ts";
import type { AutopilotActionType } from "./types";

/**
 * Anchored to the real `new Date()`, because the ledger in ./clients is built
 * from the current month: every expectation is derived from the same ledger the
 * drafting function reads, so the suite keeps its meaning on any day.
 */

const TYPES: AutopilotActionType[] = [
  "send_reminder",
  "early_pay_discount",
  "move_to_tax_pot",
  "escalate_invoice",
];

/** The first currency figure in an impact line — the money it moves. */
function impactAmount(impact: string): number {
  const match = impact.match(/USD ([\d,]+(?:\.\d+)?)/);
  assert.ok(match, `no amount in impact: ${impact}`);
  return Number(match[1].replace(/,/g, ""));
}

describe("draftActions", () => {
  const actions = draftActions();
  const now = new Date();
  const scored = generateHistory()
    .filter((row) => row.status !== "PAID")
    .map((row) => scoreInvoice(row.id, now))
    .filter((score): score is NonNullable<typeof score> => score !== null);

  it("drafts a shortlist, never an essay and never nothing", () => {
    assert.ok(actions.length >= 2, `only ${actions.length} actions`);
    assert.ok(actions.length <= 4, `${actions.length} actions`);
  });

  it("gives every action a type, a headline, a reason, and an impact", () => {
    for (const action of actions) {
      assert.ok(TYPES.includes(action.type), `unknown type ${action.type}`);
      assert.ok(action.id.trim().length > 0);
      assert.ok(action.headline.trim().length > 10, action.headline);
      assert.ok(action.reasoning.trim().length > 20, action.reasoning);
      assert.match(action.impact, /USD [\d,]+/);
    }
  });

  it("uses each id once", () => {
    assert.equal(new Set(actions.map((action) => action.id)).size, actions.length);
  });

  it("sorts by money, highest first", () => {
    const amounts = actions.map((action) => impactAmount(action.impact));
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), amounts.join(", "));
  });

  it("proposes a reminder whenever an invoice is more than two weeks late", () => {
    const overdue = scored.filter((invoice) => invoice.daysOverdue > 14);
    if (overdue.length === 0) return;
    assert.ok(actions.some((action) => action.type === "send_reminder"));

    // And it reminds about the biggest of them, not the first one it met.
    const biggest = Math.max(...overdue.map((invoice) => invoice.amount));
    const reminder = actions.find((action) => action.type === "send_reminder");
    assert.equal(impactAmount(reminder!.impact), biggest);
  });

  it("parks a quarter of this month's income for tax", () => {
    const { thisMonth } = explainIncomeChange(now);
    const taxPot = actions.find((action) => action.type === "move_to_tax_pot");
    if (thisMonth <= 0) {
      assert.equal(taxPot, undefined);
      return;
    }
    assert.ok(taxPot, "no tax pot action despite income this month");
    const parked = impactAmount(taxPot.impact);
    assert.ok(Math.abs(parked - thisMonth * 0.25) < 0.01, `${parked} vs ${thisMonth}`);
  });

  it("escalates only what is both long overdue and high risk", () => {
    const deserves = scored.filter(
      (invoice) => invoice.daysOverdue > 30 && invoice.risk === "high",
    );
    const escalated = actions.filter((action) => action.type === "escalate_invoice");

    if (deserves.length === 0) {
      assert.equal(escalated.length, 0);
      return;
    }
    assert.equal(escalated.length, 1);
    const invoice = scored.find((line) => line.invoiceId === escalated[0].invoiceId);
    assert.ok(invoice!.daysOverdue > 30);
    assert.equal(invoice!.risk, "high");
  });

  it("discounts only a high-value invoice at medium risk", () => {
    const discount = actions.find((action) => action.type === "early_pay_discount");
    if (!discount) return; // Outranked or no such invoice today.

    const invoice = scored.find((line) => line.invoiceId === discount.invoiceId);
    assert.ok(invoice, "discount targets an invoice that is not open");
    assert.equal(invoice.risk, "medium");

    // 3% is given up, so the money kept is 97% of the invoice.
    const kept = impactAmount(discount.impact);
    assert.ok(Math.abs(kept - invoice.amount * 0.97) < 0.02, `${kept} vs ${invoice.amount}`);
  });

  it("says which invoice each invoice-targeted action acts on", () => {
    for (const action of actions) {
      if (action.type === "move_to_tax_pot") {
        assert.equal(action.invoiceId, undefined);
        continue;
      }
      assert.ok(action.invoiceId, `${action.type} names no invoice`);
      assert.ok(
        scored.some((invoice) => invoice.invoiceId === action.invoiceId),
        `${action.invoiceId} is not an open invoice`,
      );
    }
  });

  it("reads the same ledger the same way twice", () => {
    assert.deepEqual(draftActions(now), actions);
  });
});
