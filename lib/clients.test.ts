import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { clients, generateHistory, randn } from "./clients.ts";

/** The four attributes every generated invoice must satisfy, whatever the seed. */
function assertInvoiceShape(invoice: ReturnType<typeof generateHistory>[number]) {
  assert.match(invoice.id, /^inv-\d+$/);
  assert.ok(invoice.amount > 0 && Number.isInteger(invoice.amount));
  assert.ok(["PAID", "SENT", "UNPAID"].includes(invoice.status));
  assert.equal(typeof invoice.refunded, "boolean");

  // Terms are always net-14 from the issue date.
  const term = Math.round((invoice.due.getTime() - invoice.issued.getTime()) / 86_400_000);
  assert.equal(term, 14);

  if (invoice.status === "PAID") {
    assert.ok(invoice.paidDate instanceof Date);
    assert.ok(invoice.delayDays !== null && invoice.delayDays >= 0);
    // A paid invoice settles on its due date plus the recorded delay.
    const settled = Math.round((invoice.paidDate.getTime() - invoice.due.getTime()) / 86_400_000);
    assert.equal(settled, invoice.delayDays);
  } else {
    // Unpaid and still-out invoices carry no settlement date.
    assert.equal(invoice.paidDate, null);
    assert.equal(invoice.delayDays, null);
  }
}

describe("clients", () => {
  it("lists the six simulated clients with their behaviour profiles", () => {
    assert.equal(clients.length, 6);
    assert.deepEqual(
      clients.map((c) => c.name),
      [
        "Acme Studio",
        "Rahul Designs",
        "BigCorp Ltd",
        "Nova Startup",
        "Pixel Agency",
        "Maya Co.",
      ],
    );
    for (const client of clients) {
      assert.ok(client.avgAmount > 0);
      assert.ok(client.delayMean >= 0 && client.delayStd > 0);
      assert.ok(client.neverPayRate >= 0 && client.neverPayRate < 1);
      assert.ok(client.refundRate >= 0 && client.refundRate < 1);
    }
  });

  it("marks the intended risk profiles", () => {
    const byName = new Map(clients.map((c) => [c.name, c]));
    // The narrative: Nova is the erratic one that sometimes never pays.
    assert.equal(byName.get("Nova Startup")!.neverPayRate, 0.25);
    assert.equal(byName.get("Pixel Agency")!.refundRate, 0.18);
    assert.equal(byName.get("BigCorp Ltd")!.avgAmount, 3000);
    assert.equal(byName.get("Acme Studio")!.delayMean, 0);
  });
});

describe("generateHistory", () => {
  // Called once here: the module caches, so the first call fixes the dataset
  // for the whole process, exactly as it does across requests in the app.
  const history = generateHistory();

  it("produces one invoice per client per month, including the current month", () => {
    assert.equal(history.length, clients.length * 10);
  });

  it("caches so the history is stable across calls", () => {
    assert.equal(generateHistory(), history);
  });

  it("gives every invoice a unique id", () => {
    assert.equal(new Set(history.map((i) => i.id)).size, history.length);
  });

  it("keeps every invoice internally consistent", () => {
    for (const invoice of history) {
      assertInvoiceShape(invoice);
    }
  });

  it("attributes every invoice to a known client", () => {
    const known = new Set(clients.map((c) => c.name));
    for (const invoice of history) {
      assert.ok(known.has(invoice.client), `unknown client ${invoice.client}`);
    }
  });

  it("reproduces each client's behaviour rather than one uniform draw", () => {
    const stats = clients.map((client) => {
      const rows = history.filter((i) => i.client === client.name);
      const delays = rows.filter((i) => i.delayDays !== null).map((i) => i.delayDays!);
      return {
        name: client.name,
        unpaid: rows.filter((i) => i.status === "UNPAID").length,
        refunded: rows.filter((i) => i.refunded).length,
        avgDelay: delays.reduce((a, b) => a + b, 0) / delays.length,
      };
    });

    const avgDelayOf = (name: string) => stats.find((s) => s.name === name)!.avgDelay;

    // BigCorp pays slowest, then the consistently-late Rahul, then Acme — who
    // is basically on time.
    assert.ok(avgDelayOf("BigCorp Ltd") > avgDelayOf("Rahul Designs"));
    assert.ok(avgDelayOf("Rahul Designs") > avgDelayOf("Acme Studio"));
    assert.ok(avgDelayOf("Acme Studio") < 3);

    // Nova is the only client the seed ever leaves unpaid.
    const unpaid = stats.filter((s) => s.unpaid > 0).map((s) => s.name);
    assert.deepEqual(unpaid, ["Nova Startup"]);
    assert.ok(stats.some((s) => s.refunded > 0), "expected at least one refund");
  });
});

describe("randn", () => {
  it("centres on the mean it is given", () => {
    let sum = 0;
    const draws = 20_000;
    for (let i = 0; i < draws; i++) sum += randn(10, 4);
    // Standard error is 4/sqrt(20000) ≈ 0.03, so this is a wide but real bound.
    assert.ok(Math.abs(sum / draws - 10) < 0.3, `mean drifted: ${sum / draws}`);
  });

  it("stays finite for the extreme draws a small sample can produce", () => {
    for (let i = 0; i < 2_000; i++) {
      assert.ok(Number.isFinite(randn(0, 0)));
    }
  });
});
