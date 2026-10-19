"use client";

import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { useMemo } from "react";

import { coinbaneGridTheme } from "@/lib/grid-theme";
import type { GridWidget } from "@/lib/types";

// Registered once per browser session.
ModuleRegistry.registerModules([AllCommunityModule]);

type Row = GridWidget["rows"][number];

/**
 * A risk column renders as a coloured dot instead of a word.
 *
 * The agent is told to emit a column whose field is `risk` with a low, medium,
 * or high value whenever it grids invoices, so the grading is visible at a
 * glance rather than hidden in a cell. Any column without that field is
 * untouched.
 */
const RISK_COLUMN = "risk";

const RISK_DOTS: Record<string, string> = {
  low: "bg-status-success",
  medium: "bg-status-warning",
  high: "bg-status-danger",
};

function RiskCell({ value }: ICellRendererParams<Row>) {
  const label = value === null || value === undefined ? "" : String(value);
  const tone = RISK_DOTS[label.trim().toLowerCase()];
  if (!tone) return <>{label}</>;

  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} aria-hidden />
      <span className="capitalize">{label}</span>
    </span>
  );
}

/**
 * AG Grid, themed to the CoinBane palette via the Theming API.
 *
 * Loaded through `next/dynamic` with `ssr: false` because AG Grid requires
 * browser APIs and must not be server-rendered.
 */
export default function WidgetGrid({
  columns,
  rows,
  height,
}: {
  columns: GridWidget["columns"];
  rows: GridWidget["rows"];
  height: number;
}) {
  const columnDefs = useMemo<ColDef<Row>[]>(
    () =>
      columns.map((column) => ({
        field: column.field,
        headerName: column.header,
        flex: 1,
        minWidth: 132,
        sortable: true,
        resizable: true,
        ...(column.field.trim().toLowerCase() === RISK_COLUMN
          ? { cellRenderer: RiskCell }
          : {}),
        // Right-align anything that reads as a number.
        cellClass: (params) =>
          typeof params.value === "number" ? "tabular-nums text-right" : "",
        valueFormatter: (params) =>
          typeof params.value === "number"
            ? new Intl.NumberFormat("en-US", {
                minimumFractionDigits: 0,
                maximumFractionDigits: 2,
              }).format(params.value)
            : (params.value ?? ""),
      })),
    [columns],
  );

  return (
    <div style={{ height }} className="w-full overflow-hidden">
      <AgGridReact<Row>
        theme={coinbaneGridTheme}
        columnDefs={columnDefs}
        rowData={rows}
        defaultColDef={{ suppressHeaderMenuButton: true, sortable: true }}
      />
    </div>
  );
}
