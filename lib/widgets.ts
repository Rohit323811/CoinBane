import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { latePayers } from "./analysis.ts";
import type {
  BarDatum,
  BarWidget,
  ForecastWidget,
  GridWidget,
  Widget,
} from "./types";

/**
 * The visualisation tools the agent calls to place a live widget in the chat.
 *
 * Each tool's `execute` returns a normalised widget payload. The route reads
 * those payloads out of the step results and ships them to the client, so the
 * model never hand-writes JSX or HTML — it fills a typed schema.
 *
 * Payloads are validated and clamped here: the model is untrusted input.
 */

const MAX_BARS = 24;
const MAX_ROWS = 200;
const MAX_COLUMNS = 12;

const chartSchema = z.object({
  title: z.string().describe("Short chart title."),
  subtitle: z.string().optional().describe("One-line qualifier."),
  valuePrefix: z.string().optional().describe('e.g. "USD ".'),
  bars: z
    .array(
      z.object({
        label: z.string().describe("Category or client."),
        value: z.number().describe("Exact number from a tool result."),
        flagged: z.boolean().optional().describe("True for a leak."),
      }),
    )
    .min(1)
    .max(MAX_BARS),
});

const gridSchema = z.object({
  title: z.string().describe("Short grid title."),
  subtitle: z.string().optional().describe("One-line qualifier."),
  columns: z
    .array(
      z.object({
        field: z.string().describe("Key used in each row."),
        header: z.string().describe("Column heading."),
      }),
    )
    .min(1)
    .max(MAX_COLUMNS),
  /*
   * Rows cross the wire as arrays, not as objects keyed by column field.
   *
   * A `Record<string, …>` compiles to a JSON schema with a *schema-valued*
   * `additionalProperties`, and Groq's validator refuses that outright — it
   * requires `additionalProperties: false` on every object, and a wildcard
   * `patternProperties` substitute is rejected as an unsupported character
   * class. Positional cells express the same data in a shape both providers
   * accept, and `normalizeGridWidget` maps them back onto the declared columns
   * (object rows are still accepted for older transcripts).
   */
  /*
   * Cells are strings, not `string | number | null`.
   *
   * Both shapes reach the model as JSON, but the union compiles to nested
   * `anyOf` branches, and a small free-tier model reliably failed to emit valid
   * arguments for it — Groq answered `tool_use_failed` on the grid every time a
   * table was asked for. One plain string type is what it can actually write.
   * `normalizeGridWidget` turns a cell that reads as a number back into one, so
   * amounts still sort and format as amounts.
   */
  rows: z
    .array(z.array(z.string()))
    .max(MAX_ROWS)
    .describe("One array per record: one cell per column, in column order. Numeric cells as digits."),
});

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function toOptionalString(value: unknown, max: number): string | undefined {
  return toTrimmedString(value, max) ?? undefined;
}

/**
 * Value prefixes carry meaning in their spacing — "USD " must keep its
 * trailing space — so this clamps length without trimming the edges.
 */
function toPrefix(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clipped = value.slice(0, max);
  return clipped.trim() ? clipped : undefined;
}

/** Clamps a model-supplied chart payload, or returns null if unusable. */
export function normalizeBarWidget(input: unknown): BarWidget | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const title = toTrimmedString(raw.title, 120);
  if (!title) return null;

  const bars: BarDatum[] = [];
  const rawBars = Array.isArray(raw.bars) ? raw.bars : [];
  for (const item of rawBars.slice(0, MAX_BARS)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const label = toTrimmedString(row.label, 64);
    const value = toFiniteNumber(row.value);
    if (!label || value === null) continue;
    bars.push({ label, value, flagged: row.flagged === true });
  }
  if (bars.length === 0) return null;

  return {
    kind: "bar",
    title,
    subtitle: toOptionalString(raw.subtitle, 200),
    valuePrefix: toPrefix(raw.valuePrefix, 8),
    bars,
  };
}

/** Clamps a model-supplied grid payload, or returns null if unusable. */
export function normalizeGridWidget(input: unknown): GridWidget | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const title = toTrimmedString(raw.title, 120);
  if (!title) return null;

  const rawColumns = Array.isArray(raw.columns) ? raw.columns : [];
  const columns: GridWidget["columns"] = [];
  const seen = new Set<string>();
  for (const item of rawColumns.slice(0, MAX_COLUMNS)) {
    if (!item || typeof item !== "object") continue;
    const column = item as Record<string, unknown>;
    const field = toTrimmedString(column.field, 60);
    const header = toTrimmedString(column.header, 60);
    if (!field || !header || seen.has(field)) continue;
    seen.add(field);
    columns.push({ field, header });
  }
  if (columns.length === 0) return null;

  const rows: GridWidget["rows"] = [];
  const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
  for (const item of rawRows.slice(0, MAX_ROWS)) {
    if (!item || typeof item !== "object") continue;
    /*
     * A positional row: the cell order is the column order the model was told
     * to follow. Reading by index is what keeps the grid renderable without a
     * free-form object in the schema. Objects are still accepted, so a
     * transcript recorded before the change still renders.
     */
    const source = item as Record<string, unknown> | unknown[];
    const row: Record<string, string | number | null> = {};
    columns.forEach((column, index) => {
      const value = Array.isArray(source)
        ? source[index]
        : source[column.field];

      if (typeof value === "number" && Number.isFinite(value)) {
        row[column.field] = value;
        return;
      }
      if (typeof value !== "string") {
        row[column.field] = null;
        return;
      }

      const text = value.slice(0, 120);
      /*
       * A cell that is only a number becomes one, so the grid right-aligns and
       * sorts it as a number rather than as text — "900" must not sort after
       * "1,200". Dates and ids stay strings: `Number("2026-09-09")` is NaN, and
       * a bare year is not an amount either way.
       */
      const numeric = /^-?[\d,]+(\.\d+)?$/.test(text.trim())
        ? toFiniteNumber(text)
        : null;
      row[column.field] = numeric ?? text;
    });
    rows.push(row);
  }

  if (rows.length === 0) return null;

  return {
    kind: "grid",
    title,
    subtitle: toOptionalString(raw.subtitle, 200),
    columns,
    rows,
  };
}

/**
 * The late-payers grid, computed rather than model-written.
 *
 * "Why am I broke?" deserves the names behind the answer, and asking the model
 * to fill a grid from the explanation costs a second model step — on a free plan
 * with an 8,000-token minute that is the step that gets refused. The ledger
 * already knows who is late, so the route attaches this whenever the agent
 * explained income, and the model is told not to draw its own.
 */
export function latePayerGrid(now: Date = new Date()): GridWidget | null {
  const rows = latePayers(now);
  if (rows.length === 0) return null;

  const owed = rows.reduce((sum, row) => sum + row.amount, 0);
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(owed);

  return {
    kind: "grid",
    title: "Who is sitting on your money",
    subtitle: `${rows.length} ${rows.length === 1 ? "client" : "clients"} past due · ${money} owed`,
    columns: [
      { field: "client", header: "Client" },
      { field: "amount", header: "Overdue" },
      { field: "invoices", header: "Invoices" },
      { field: "days_late", header: "Days late" },
    ],
    rows: rows.map((row) => ({
      client: row.client,
      amount: row.amount,
      invoices: row.invoices,
      days_late: row.daysLate,
    })),
  };
}

export const renderBarChart = tool({
  description:
    "Draw a bar chart. One series across clients or periods. Call instead of describing a chart.",
  parameters: chartSchema,
  execute: async (input): Promise<BarWidget | null> =>
    normalizeBarWidget(input),
});

export const renderDataGrid = tool({
  description:
    "Draw a sortable data grid for multi-column records such as invoices. Call instead of writing a table.",
  parameters: gridSchema,
  execute: async (input): Promise<GridWidget | null> =>
    normalizeGridWidget(input),
});

/** Tools the agent always has, regardless of PayPal connectivity. */
export const displayTools = {
  render_bar_chart: renderBarChart,
  render_data_grid: renderDataGrid,
} satisfies ToolSet;

const DISPLAY_TOOL_NAMES = new Set(Object.keys(displayTools));

/**
 * The forecast is computed rather than written by the model, so its payload is
 * trusted; it still has to be recognised here or it never reaches the client.
 */
const FORECAST_TOOL_NAME = "forecast_cashflow";

/**
 * Pulls every normalised widget out of a `generateText` step list, in order.
 */
export function collectWidgets(steps: unknown): Widget[] {
  if (!Array.isArray(steps)) return [];
  const widgets: Widget[] = [];

  for (const step of steps) {
    const results = (step as { toolResults?: unknown } | null)?.toolResults;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      const name = (result as { toolName?: unknown } | null)?.toolName;
      if (typeof name !== "string") continue;

      const payload = (result as { result?: unknown } | null)?.result;
      if (!payload || typeof payload !== "object") continue;

      const kind = (payload as { kind?: unknown }).kind;

      if (name === FORECAST_TOOL_NAME) {
        if (kind === "forecast") widgets.push(payload as ForecastWidget);
        continue;
      }

      if (!DISPLAY_TOOL_NAMES.has(name)) continue;
      if (kind === "bar" || kind === "grid") widgets.push(payload as Widget);
    }
  }

  return widgets;
}

/** Every tool name the agent invoked, deduplicated, in first-use order. */
export function collectToolNames(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const names: string[] = [];

  for (const step of steps) {
    const calls = (step as { toolCalls?: unknown } | null)?.toolCalls;
    if (!Array.isArray(calls)) continue;

    for (const call of calls) {
      const name = (call as { toolName?: unknown } | null)?.toolName;
      if (typeof name === "string" && !names.includes(name)) names.push(name);
    }
  }

  return names;
}
