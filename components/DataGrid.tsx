"use client";

import dynamic from "next/dynamic";

import type { GridWidget } from "@/lib/types";

/**
 * Shell for a model-generated grid.
 *
 * AG Grid is code-split here so it only enters the bundle once the agent
 * actually produces tabular data, and it never renders on the server.
 */
const WidgetGrid = dynamic(() => import("./WidgetGrid"), {
  ssr: false,
  loading: () => (
    <div className="h-[220px] w-full animate-pulse rounded-md border border-border-subtle bg-bg-elevated" />
  ),
});

function gridHeight(rowCount: number): number {
  // Header, header row, and a row per record, clamped to a sane window.
  return Math.min(420, Math.max(220, rowCount * 32 + 82));
}

export function DataGrid({
  title,
  subtitle,
  columns,
  rows,
}: Omit<GridWidget, "kind">) {
  return (
    <figure className="overflow-hidden rounded-md border border-border-subtle bg-bg-secondary/60">
      <figcaption className="border-b border-border-subtle px-3.5 py-3 sm:px-4">
        <p className="text-[13px] font-medium tracking-wide text-text-primary">
          {title}
        </p>
        {subtitle ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">
            {subtitle}
          </p>
        ) : null}
      </figcaption>

      <WidgetGrid
        columns={columns}
        rows={rows}
        height={gridHeight(rows.length)}
      />
    </figure>
  );
}

export default DataGrid;
