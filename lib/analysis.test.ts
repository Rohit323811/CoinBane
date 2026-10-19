import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  explainIncomeChange,
  forecastCashflow,
  forecastSummary,
  getReminderSchedule,
  resolveClientName,
  scoreInvoice,
} from "./analysis.ts";
import { clients, generateHistory } from "./clients.ts";

/**
 * These tests are deliberately anchored to `new Date()` rather than a frozen
 * clock: the ledger in ./clients is built from the real current month, so
 * fixing "now" here would test a window the invoices do not sit in. Every
 * assertion is an invariant or a comparison, never a hardcoded amount, so the
 * suite keeps its meaning on any day it runs.
 */

const NAMES = clients.map((client) => client.name);

describe("resolveClientName", () => {
  it("accepts a client name exactly, whatever its case", () => {
    assert.equal(resolveClientName("Nova Startup"), "Nova Startup");
    assert.equal(resolveClientName("nova startup"), "Nova Startup");
    assert.equal(resolveClientName("  Maya Co.  "), "Maya Co.");
  });

  it("accepts the short way a person would say it", () => {
    assert.equal(resolveClientName("Nova"), "Nova Startup");
    assert.equal(resolveClientName("acme"), "Acme Studio");
    assert.equal(resolveClientName("Startup"), "Nova Startup");
  });

  it("refuses anything it cannot place", () => {
    assert.equal(resolveClientName("Northwind Studio"), null);
    assert.equal(resolveClientName(""), null);
    assert.equal(resolveClientName("   "), null);
  });
});

describe("explainIncomeChange", () => {
  const explanation = explainIncomeChange();

  it("returns two months of income and a finite percentage", () => {
    assert.ok(explanation.thisMonth >= 0);
    assert.ok(explanation.lastMonth >= 0);
    assert.ok(Number.isFinite(explanation.percentChange));
  });

  it("reports the percentage that its own two totals imply", () => {
    const { thisMonth, lastMonth, percentChange } = explanation;
    if (lastMonth === 0) {
      // No baseline: 0 is the documented sentinel rather than a fake 100%.
      assert.equal(percentChange, 0);
      return;
    }
    const expected =
      Math.round(((thisMonth - lastMonth) / lastMonth) * 100 * 10) / 10;
    assert.equal(percentChange, expected);
  });

  it("caps the reasons at three, each naming a real client", () => {
    assert.ok(explanation.reasons.length <= 3);
    for (const reason of explanation.reasons) {
      assert.ok(reason.label.trim().length > 0, "empty label");
      assert.ok(Number.isFinite(reason.impact));
      assert.notEqual(reason.impact, 0, `zero impact on "${reason.label}"`);
      assert.ok(
        NAMES.some((name) => reason.label.includes(name)),
        `reason names no client: ${reason.label}`,
      );
    }
  });

  it("ranks the reasons by how much money they moved", () => {
    const magnitudes = explanation.reasons.map((reason) => Math.abs(reason.impact));
    assert.deepEqual(magnitudes, [...magnitudes].sort((a, b) => b - a));
  });

  it("writes a story whose direction matches the number", () => {
    const { story, percentChange } = explanation;
    assert.ok(story.endsWith("."));
    assert.ok(story.length > 40, `story too short: ${story}`);

    if (percentChange > 0) {
      assert.match(story, /rose/);
    } else if (percentChange < 0) {
      assert.match(story, /dropped/);
    } else {
      assert.match(story, /held steady/);
    }
  });

  it("names clients and money rather than only repeating the totals", () => {
    if (explanation.reasons.length === 0) return;
    assert.ok(NAMES.some((name) => explanation.story.includes(name)));
    assert.match(explanation.story, /USD [\d,]+/);
  });

  it("reads the same ledger the same way twice", () => {
    assert.deepEqual(explainIncomeChange(), explanation);
  });
});

describe("forecastCashflow", () => {
  const forecast = forecastCashflow();
  const [thirty, sixty, ninety] = forecast.windows;

  it("always reports the three horizons, oldest first", () => {
    assert.deepEqual(
      forecast.windows.map((window) => window.days),
      [30, 60, 90],
    );
  });

  it("keeps each range ordered pessimistic <= expected <= optimistic", () => {
    for (const window of forecast.windows) {
      assert.ok(Number.isFinite(window.expected));
      assert.ok(window.pessimistic <= window.expected, `${window.days}d pessimistic`);
      assert.ok(window.expected <= window.optimistic, `${window.days}d optimistic`);
    }
  });

  it("accumulates: a longer horizon never forecasts less", () => {
    assert.ok(thirty.pessimistic <= sixty.pessimistic);
    assert.ok(sixty.pessimistic <= ninety.pessimistic);
    assert.ok(thirty.expected <= sixty.expected);
    assert.ok(sixty.expected <= ninety.expected);
    assert.ok(ninety.expected <= ninety.optimistic);
  });

  it("focuses on 30 days unless asked otherwise", () => {
    assert.equal(forecast.focusDays, 30);
    assert.equal(forecastCashflow({ window: 90 }).focusDays, 90);
    // Focusing a horizon does not drop the other two.
    assert.equal(forecastCashflow({ window: 90 }).windows.length, 3);
  });

  it("prices each client by the chance it pays at all", () => {
    assert.ok(forecast.clients.length > 0);
    for (const line of forecast.clients) {
      assert.ok(line.confidence >= 0 && line.confidence <= 1, line.client);
    }
    const nova = forecast.clients.find((line) => line.client === "Nova Startup");
    const acme = forecast.clients.find((line) => line.client === "Acme Studio");
    assert.equal(nova?.confidence, 0.75);
    assert.equal(acme?.confidence, 1);
  });

  it("orders the client breakdown by money expected", () => {
    const amounts = forecast.clients.map((line) => line.expected);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a));
  });

  it("reports what an exclusion is worth, and never inflates it", () => {
    const without = forecastCashflow({ window: 90, exclude: ["Nova Startup"] });

    assert.deepEqual(without.excluded, ["Nova Startup"]);
    assert.deepEqual(forecast.excluded, []);
    assert.ok(
      forecast.clients.some((line) => line.client === "Nova Startup"),
    );
    assert.ok(
      !without.clients.some((line) => line.client === "Nova Startup"),
      "an excluded client still appears in the breakdown",
    );

    // Leaving a client out can only remove money from the forecast.
    forecast.windows.forEach((window, index) => {
      assert.ok(window.expected >= without.windows[index].expected);
    });
    assert.ok(
      forecast.windows.some(
        (window, index) => window.expected > without.windows[index].expected,
      ),
      "excluding a client with open invoices changed nothing",
    );
  });

  it("resolves an exclusion the way the user would say it", () => {
    const terse = forecastCashflow({ exclude: ["nova"] });
    const explicit = forecastCashflow({ exclude: ["Nova Startup"] });
    assert.deepEqual(terse.windows, explicit.windows);
    assert.deepEqual(terse.excluded, ["Nova Startup"]);
  });

  it("keeps the unadjusted projection as a baseline to compare against", () => {
    const pushed = forecastCashflow({ delays: { "BigCorp Ltd": 365 } });
    assert.deepEqual(pushed.appliedDelays, { "BigCorp Ltd": 365 });
    assert.deepEqual(pushed.baseline, forecast.windows);

    // A client pushed a year out cannot land inside any horizon.
    pushed.windows.forEach((window, index) => {
      assert.ok(window.expected < forecast.windows[index].expected);
    });
  });

  it("ignores an unknown client name instead of guessing", () => {
    const unknown = forecastCashflow({ exclude: ["Northwind Studio"] });
    assert.deepEqual(unknown.excluded, []);
    assert.deepEqual(unknown.windows, forecast.windows);
  });
});

describe("scoreInvoice", () => {
  const now = new Date();
  const open = generateHistory().filter((row) => row.status !== "PAID");

  it("returns nothing for an id the ledger does not know", () => {
    assert.equal(scoreInvoice("inv-9999", now), null);
    assert.equal(scoreInvoice("", now), null);
    assert.equal(getReminderSchedule("inv-9999", now), null);
  });

  it("applies the penalty formula to every open invoice", () => {
    const daysBetween = (from: Date, to: Date) =>
      Math.round((to.getTime() - from.getTime()) / 86_400_000);

    for (const invoice of open) {
      const scored = scoreInvoice(invoice.id, now)!;
      const profile = clients.find((client) => client.name === invoice.client)!;
      const overdue = Math.max(0, daysBetween(invoice.due, now));

      const expected = Math.min(
        1,
        Math.max(
          0,
          Math.round(
            (1 -
              profile.neverPayRate -
              Math.min(overdue / 30, 1) * 0.4 -
              profile.refundRate * 0.5) *
              100,
          ) / 100,
        ),
      );

      assert.equal(scored.score, expected, invoice.id);
      assert.equal(scored.daysOverdue, overdue, invoice.id);
      assert.equal(scored.client, invoice.client);
      assert.equal(scored.amount, invoice.amount);
    }
  });

  it("labels risk the way the thresholds say", () => {
    for (const invoice of generateHistory()) {
      const scored = scoreInvoice(invoice.id, now)!;
      const expected =
        scored.score > 0.85 ? "low" : scored.score >= 0.6 ? "medium" : "high";
      assert.equal(scored.risk, expected, `${invoice.id} at ${scored.score}`);
    }
  });

  it("matches each risk label to its own recommendation", () => {
    const byRisk: Record<string, string> = {
      low: "No action needed. This client pays reliably.",
      medium: "Send a gentle reminder at day 3 past due.",
      high: "Send a firm reminder immediately. Consider escalation.",
    };

    for (const invoice of generateHistory()) {
      const scored = scoreInvoice(invoice.id, now)!;
      assert.equal(scored.recommendation, byRisk[scored.risk], invoice.id);
    }
  });

  it("scores a later invoice lower than an earlier one from the same client", () => {
    const bigcorp = open
      .filter((invoice) => invoice.client === "BigCorp Ltd")
      .sort((a, b) => a.due.getTime() - b.due.getTime());
    if (bigcorp.length < 2) return;

    const [older, newer] = bigcorp;
    const olderScore = scoreInvoice(older.id, now)!.score;
    const newerScore = scoreInvoice(newer.id, now)!.score;
    assert.ok(olderScore <= newerScore, `${olderScore} vs ${newerScore}`);
  });

  it("takes no delay penalty on an invoice that has already been paid", () => {
    const paid = generateHistory().find((invoice) => invoice.status === "PAID")!;
    const scored = scoreInvoice(paid.id, now)!;
    assert.equal(scored.daysOverdue, 0);

    const profile = clients.find((client) => client.name === paid.client)!;
    const expected =
      Math.round((1 - profile.neverPayRate - profile.refundRate * 0.5) * 100) / 100;
    assert.equal(scored.score, expected);
  });
});

describe("getReminderSchedule", () => {
  const now = new Date();

  it("chases harder the riskier the invoice is", () => {
    const ladders = {
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

    for (const invoice of generateHistory()) {
      const scored = scoreInvoice(invoice.id, now)!;
      assert.deepEqual(
        getReminderSchedule(invoice.id, now),
        ladders[scored.risk],
        `${invoice.id} at ${scored.risk}`,
      );
    }
  });

  it("hands out a copy, so a caller cannot rewrite the ladder", () => {
    const first = getReminderSchedule(generateHistory()[0].id, now)!;
    first.push({ day: 99, tone: "urgent" });
    const second = getReminderSchedule(generateHistory()[0].id, now)!;
    assert.ok(!second.some((reminder) => reminder.day === 99));
  });
});

describe("forecastSummary", () => {
  it("states the focused horizon and its range", () => {
    const forecast = forecastCashflow({ window: 60 });
    const summary = forecastSummary(forecast);
    assert.match(summary, /next 60 days/);
    assert.match(summary, /USD [\d,]+/);
  });

  it("names the client a scenario leaves out", () => {
    const summary = forecastSummary(
      forecastCashflow({ exclude: ["Nova Startup"], window: 90 }),
    );
    assert.match(summary, /Nova Startup/);
    assert.match(summary, /next 90 days/);
  });
});
