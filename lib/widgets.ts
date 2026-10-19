import { tool, type ToolSet } from "ai";
import { z } from "zod";

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
  title: z.string().describe("Short chart title, framed as the user asked."),
  subtitle: z.string().optional().describe("Optional one-line qualifier."),
  valuePrefix: z
    .string()
    .optional()
    .describe('Currency or unit prefix applied to every value, e.g. "USD ".'),
  bars: z
    .array(
      z.object({
        label: z
          .string()
          .describe("Category, client, or period for this bar."),
        value: z.number().describe("Exact number from a PayPal tool result."),
        flagged: z
          .boolean()
          .optional()
          .describe("True when this row represents a leak or anomaly."),
      }),
    )
    .min(1)
    .max(MAX_BARS),
});

const gridSchema = z.object({
  title: z.string().describe("Short grid title, framed as the user asked."),
  subtitle: z.string().optional().describe("Optional one-line qualifier."),
  columns: z
    .array(
      z.object({
        field: z.string().describe("Key used in each row object."),
        header: z.string().describe("Column heading shown to the user."),
      }),
    )
    .min(1)
    .max(MAX_COLUMNS),
  rows: z
    .array(z.record(z.string(), z.union([z.string(), z.number(), z.null()])))
    .max(MAX_ROWS)
    .describe("One object per record, keyed by column field."),
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
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const source = item as Record<string, unknown>;
    const row: Record<string, string | number | null> = {};
    for (const column of columns) {
      const value = source[column.field];
      row[column.field] =
        typeof value === "number" && Number.isFinite(value)
          ? value
          : typeof value === "string"
            ? value.slice(0, 120)
            : null;
    }
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

export const renderBarChart = tool({
  description:
    "Render an interactive bar chart in the chat. Use for one series compared across clients, periods, or categories. Every value must come from a PayPal tool result in this conversation. Call this instead of describing a chart in prose.",
  parameters: chartSchema,
  execute: async (input): Promise<BarWidget | null> =>
    normalizeBarWidget(input),
});

export const renderDataGrid = tool({
  description:
    "Render an interactive, sortable data grid in the chat. Use for multi-column records such as invoices, transactions, or disputes. Every value must come from a PayPal tool result in this conversation. Call this instead of writing a table in prose.",
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
