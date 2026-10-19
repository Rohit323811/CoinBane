import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectInsights,
  formatMoney,
  simulatedInsights,
  type DisputeLike,
  type InvoiceLike,
  type TxnLike,
} from "./anomaly.ts";

const NOW = new Date("2026-06-15T12:00:00Z");

function invoice(overrides: Partial<InvoiceLike> = {}): InvoiceLike {
  return {
    counterparty: "Acme",
    amount: 1000,
    status: "SENT",
    dueDate: "2026-06-01",
    ...overrides,
  };
}

describe("formatMoney", () => {
  it("formats with a currency prefix and two decimals", () => {
    assert.equal(formatMoney(1234.5), "USD 1,234.50");
    assert.equal(formatMoney(0), "USD 0.00");
  });
});

describe("detectInsights", () => {
  it("returns nothing when there are no records", () => {
    assert.deepEqual(detectInsights({}, NOW), []);
  });

  it("ignores overdue invoices that are already paid", () => {
    const insights = detectInsights(
      { invoices: [invoice({ status: "PAID", dueDate: "2026-01-01" })] },
      NOW,
    );
    assert.deepEqual(insights, []);
  });

  it("does not flag an invoice that is not yet due", () => {
    const insights = detectInsights(
      { invoices: [invoice({ dueDate: "2026-07-01" })] },
      NOW,
    );
    assert.deepEqual(insights, []);
  });

  it("totals overdue invoices and names the oldest", () => {
    const insights = detectInsights(
      {
        invoices: [
          invoice({
            counterparty: "Late Co",
            amount: 4650,
            dueDate: "2026-05-05",
          }),
          invoice({
            counterparty: "Later Co",
            amount: 2500,
            dueDate: "2026-06-10",
          }),
          invoice({ counterparty: "Paid Co", amount: 9999, status: "PAID" }),
        ],
      },
      NOW,
    );

    assert.equal(insights.length, 1);
    const [overdue] = insights;
    assert.equal(overdue.id, "overdue-invoices");
    assert.equal(overdue.metric?.value, "USD 7,150.00");
    // 2026-05-05 to 2026-06-15 is 41 days.
    assert.match(overdue.detail, /Late Co/);
    assert.match(overdue.detail, /41 days past due/);
    assert.equal(overdue.severity, "high");
  });

  it("does not include the paid invoice in the overdue total", () => {
    const insights = detectInsights(
      {
        invoices: [
          invoice({ counterparty: "Late Co", amount: 100, dueDate: "2026-06-01" }),
          invoice({
            counterparty: "Paid Co",
            amount: 9999,
            status: "paid",
            dueDate: "2026-06-01",
          }),
        ],
      },
      NOW,
    );
    assert.equal(insights[0].metric?.value, "USD 100.00");
  });

  it("reports a refund-rate spike against the previous month", () => {
    const transactions: TxnLike[] = [
      // Previous month: 1% refund rate.
      { counterparty: "Northwind", amount: 99, date: "2026-05-10" },
      { counterparty: "Northwind", amount: 1, refunded: true, date: "2026-05-11" },
      // Current month: 4% refund rate.
      { counterparty: "Northwind", amount: 96, date: "2026-06-10" },
      { counterparty: "Northwind", amount: 4, refunded: true, date: "2026-06-11" },
    ];

    const insights = detectInsights({ transactions }, NOW);
    assert.equal(insights.length, 1);
    assert.equal(
      insights[0].headline,
      "your refund rate from Northwind spiked 300% this month",
    );
    assert.equal(insights[0].metric?.delta, "+300%");
  });

  it("stays quiet when the refund rate merely wobbles", () => {
    const transactions: TxnLike[] = [
      { counterparty: "Steady", amount: 95, date: "2026-05-10" },
      { counterparty: "Steady", amount: 5, refunded: true, date: "2026-05-11" },
      { counterparty: "Steady", amount: 94, date: "2026-06-10" },
      { counterparty: "Steady", amount: 6, refunded: true, date: "2026-06-11" },
    ];
    assert.deepEqual(detectInsights({ transactions }, NOW), []);
  });

  it("ignores clients with no previous-month baseline", () => {
    const transactions: TxnLike[] = [
      { counterparty: "Brand New", amount: 100, refunded: true, date: "2026-06-10" },
    ];
    assert.deepEqual(detectInsights({ transactions }, NOW), []);
  });

  it("flags a dispute cluster and ignores a single dispute", () => {
    const one: DisputeLike[] = [
      { counterparty: "A", amount: 500, date: "2026-06-02" },
    ];
    assert.deepEqual(detectInsights({ disputes: one }, NOW), []);

    const many: DisputeLike[] = [
      { counterparty: "A", amount: 500, date: "2026-06-02" },
      { counterparty: "B", amount: 700, date: "2026-06-09" },
    ];
    const insights = detectInsights({ disputes: many }, NOW);
    assert.equal(insights.length, 1);
    assert.equal(insights[0].metric?.value, "2");
    assert.match(insights[0].detail, /USD 1,200\.00/);
  });

  it("ranks higher severity first", () => {
    const insights = detectInsights(
      {
        invoices: [invoice({ amount: 10, dueDate: "2026-06-14" })],
        disputes: [
          { amount: 100, date: "2026-06-01" },
          { amount: 100, date: "2026-06-02" },
          { amount: 100, date: "2026-06-03" },
        ],
      },
      NOW,
    );

    const severities = insights.map((insight) => insight.severity);
    assert.deepEqual(severities, ["high", "medium"]);
  });
});

describe("simulatedInsights", () => {
  it("is deterministic and non-empty", () => {
    const first = simulatedInsights();
    const second = simulatedInsights();
    assert.deepEqual(first, second);
    assert.ok(first.length > 0);
    for (const insight of first) {
      assert.ok(insight.headline.length > 0);
      assert.ok(insight.detail.length > 0);
    }
  });

  it("reads naturally after the words 'I noticed'", () => {
    assert.match(
      simulatedInsights()[0].headline,
      /^your refund rate from .+ spiked \d+% this month$/,
    );
  });
});
