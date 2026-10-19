import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { explainIncomeTool } from "./tools/explain.ts";
import { forecastTool } from "./tools/forecast.ts";
import { scoreInvoiceTool } from "./tools/score.ts";

/**
 * The tool schemas are a provider boundary, not just types.
 *
 * A numeric enum here is valid TypeScript and valid zod, and it still takes the
 * whole chat down: Gemini compiles it to a JSON-schema enum of numbers and
 * rejects the request with "Invalid value at ...enum[0] (TYPE_STRING)". The
 * horizon therefore crosses as a string and is coerced back inside `execute`.
 */

describe("forecastTool", () => {
  it("takes the horizon as a string", () => {
    assert.doesNotThrow(() => forecastTool.parameters.parse({ window: "90" }));
    assert.throws(() => forecastTool.parameters.parse({ window: 90 }));
    assert.throws(() => forecastTool.parameters.parse({ window: "45" }));
  });

  it("is callable with no arguments at all", () => {
    const parsed = forecastTool.parameters.parse({});
    assert.deepEqual(parsed, {});
  });

  it("takes exclusions and delay adjustments by client name", () => {
    const parsed = forecastTool.parameters.parse({
      window: "30",
      exclude: ["Nova Startup"],
      delays: { "BigCorp Ltd": 10 },
    });
    assert.deepEqual(parsed, {
      window: "30",
      exclude: ["Nova Startup"],
      delays: { "BigCorp Ltd": 10 },
    });
  });
});

describe("scoreInvoiceTool", () => {
  it("takes an invoice id or a client name, and neither is required", () => {
    assert.deepEqual(scoreInvoiceTool.parameters.parse({}), {});
    assert.deepEqual(scoreInvoiceTool.parameters.parse({ invoiceId: "inv-28" }), {
      invoiceId: "inv-28",
    });
    assert.deepEqual(scoreInvoiceTool.parameters.parse({ clientName: "Nova Startup" }), {
      clientName: "Nova Startup",
    });
  });

  it("scores by id, and falls back to the client's oldest open invoice", async () => {
    const byId = await scoreInvoiceTool.execute?.({ invoiceId: "inv-28" }, {} as never);
    assert.equal((byId as { found: boolean }).found, true);
    assert.equal((byId as { invoiceId: string }).invoiceId, "inv-28");

    const byClient = await scoreInvoiceTool.execute?.(
      { clientName: "nova startup" },
      {} as never,
    );
    assert.equal((byClient as { found: boolean }).found, true);
    assert.equal((byClient as { client: string }).client, "Nova Startup");
  });

  it("resolves the short name a user would actually say", async () => {
    const byShortName = await scoreInvoiceTool.execute?.(
      { clientName: "BigCorp" },
      {} as never,
    );
    assert.equal((byShortName as { found: boolean }).found, true);
    assert.equal((byShortName as { client: string }).client, "BigCorp Ltd");
    assert.equal((byShortName as { invoiceId: string }).invoiceId, "inv-28");
  });

  it("says so rather than guessing when it cannot find the invoice", async () => {
    const missing = await scoreInvoiceTool.execute?.(
      { invoiceId: "inv-9999" },
      {} as never,
    );
    assert.equal((missing as { found: boolean }).found, false);
    assert.match((missing as { detail: string }).detail, /inv-9999/);
  });
});

describe("explainIncomeTool", () => {
  it("takes no parameters, because the question is always the same", () => {
    assert.deepEqual(explainIncomeTool.parameters.parse({}), {});
  });
});

