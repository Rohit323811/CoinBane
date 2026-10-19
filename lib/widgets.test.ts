import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectToolNames,
  collectWidgets,
  normalizeBarWidget,
  normalizeGridWidget,
} from "./widgets.ts";

describe("normalizeBarWidget", () => {
  it("rejects non-objects and missing titles", () => {
    assert.equal(normalizeBarWidget(null), null);
    assert.equal(normalizeBarWidget("nope"), null);
    assert.equal(normalizeBarWidget({ bars: [{ label: "a", value: 1 }] }), null);
  });

  it("rejects an empty series", () => {
    assert.equal(normalizeBarWidget({ title: "Revenue", bars: [] }), null);
  });

  it("drops bars with unusable labels or values", () => {
    const widget = normalizeBarWidget({
      title: "Revenue by client",
      bars: [
        { label: "Acme", value: 1200 },
        { label: "", value: 400 },
        { label: "Ghost", value: Number.NaN },
        { label: "Nope", value: undefined },
      ],
    });

    assert.ok(widget);
    assert.equal(widget.bars.length, 1);
    assert.deepEqual(widget.bars[0], {
      label: "Acme",
      value: 1200,
      flagged: false,
    });
  });

  it("coerces a formatted numeric string", () => {
    const widget = normalizeBarWidget({
      title: "Revenue",
      bars: [{ label: "Acme", value: "$1,234.50" }],
    });
    assert.equal(widget?.bars[0].value, 1234.5);
  });

  it("carries the flagged marker and optional metadata", () => {
    const widget = normalizeBarWidget({
      title: "Refunds",
      subtitle: "Month over month",
      valuePrefix: "USD ",
      bars: [{ label: "Northwind", value: 400, flagged: true }],
    });

    assert.equal(widget?.kind, "bar");
    assert.equal(widget?.subtitle, "Month over month");
    assert.equal(widget?.valuePrefix, "USD ");
    assert.equal(widget?.bars[0].flagged, true);
  });

  it("clamps an oversized series", () => {
    const bars = Array.from({ length: 500 }, (_, index) => ({
      label: `client-${index}`,
      value: index,
    }));
    assert.equal(normalizeBarWidget({ title: "Many", bars })?.bars.length, 24);
  });
});

describe("normalizeGridWidget", () => {
  const columns = [
    { field: "client", header: "Client" },
    { field: "amount", header: "Amount" },
  ];

  it("requires a title, columns, and at least one row", () => {
    assert.equal(normalizeGridWidget(null), null);
    assert.equal(normalizeGridWidget({ title: "T", columns, rows: [] }), null);
    assert.equal(normalizeGridWidget({ title: "T", rows: [{ client: "a" }] }), null);
  });

  it("projects rows onto the declared columns and drops unknown keys", () => {
    const widget = normalizeGridWidget({
      title: "Invoices",
      columns,
      rows: [
        { client: "Acme", amount: 4650, secret: "leak-me" },
        { client: "Meridian", amount: 2500 },
      ],
    });

    assert.ok(widget);
    assert.deepEqual(Object.keys(widget.rows[0]), ["client", "amount"]);
    assert.equal(widget.rows[0].amount, 4650);
  });

  it("nulls out unusable cell values", () => {
    const widget = normalizeGridWidget({
      title: "Invoices",
      columns,
      rows: [{ client: "Acme", amount: { nested: true } }],
    });
    assert.equal(widget?.rows[0].amount, null);
  });

  it("de-duplicates repeated column fields", () => {
    const widget = normalizeGridWidget({
      title: "Invoices",
      columns: [...columns, { field: "client", header: "Client again" }],
      rows: [{ client: "Acme", amount: 1 }],
    });
    assert.equal(widget?.columns.length, 2);
  });
});

describe("collectWidgets", () => {
  const step = (toolName: string, result: unknown) => ({
    toolResults: [{ toolName, result }],
  });

  it("returns an empty list for malformed input", () => {
    assert.deepEqual(collectWidgets(null), []);
    assert.deepEqual(collectWidgets([{}]), []);
    assert.deepEqual(collectWidgets([{ toolResults: "nope" }]), []);
  });

  it("keeps only render tools with a valid kind", () => {
    const bar = { kind: "bar", title: "T", bars: [{ label: "a", value: 1 }] };
    const steps = [
      step("list_transactions", [{ raw: "paypal payload" }]),
      step("render_bar_chart", bar),
      step("render_data_grid", { kind: "nope" }),
      step("render_bar_chart", null),
    ];

    const widgets = collectWidgets(steps);
    assert.equal(widgets.length, 1);
    assert.deepEqual(widgets[0], bar);
  });

  it("recognises the forecast payload the tool computes for itself", () => {
    const forecast = {
      kind: "forecast",
      title: "Income forecast",
      focusDays: 30,
      windows: [{ days: 30, expected: 1, pessimistic: 0, optimistic: 2 }],
      clients: [{ client: "Acme Studio", expected: 1, confidence: 1 }],
    };

    const widgets = collectWidgets([
      step("forecast_cashflow", forecast),
      // Same shape, wrong tool: the name is what makes it renderable.
      step("list_transactions", forecast),
    ]);

    assert.equal(widgets.length, 1);
    assert.deepEqual(widgets[0], forecast);
  });

  it("preserves order across steps", () => {
    const first = { kind: "bar", title: "First", bars: [] };
    const second = { kind: "grid", title: "Second", columns: [], rows: [] };
    const widgets = collectWidgets([
      step("render_bar_chart", first),
      step("render_data_grid", second),
    ]);
    assert.deepEqual(
      widgets.map((widget) => widget.title),
      ["First", "Second"],
    );
  });
});

describe("collectToolNames", () => {
  it("deduplicates tool names in first-use order", () => {
    const names = collectToolNames([
      { toolCalls: [{ toolName: "list_invoices" }] },
      { toolCalls: [{ toolName: "list_transactions" }, { toolName: "list_invoices" }] },
    ]);
    assert.deepEqual(names, ["list_invoices", "list_transactions"]);
  });

  it("is safe on malformed input", () => {
    assert.deepEqual(collectToolNames(undefined), []);
    assert.deepEqual(collectToolNames([{ toolCalls: 5 }]), []);
  });
});
