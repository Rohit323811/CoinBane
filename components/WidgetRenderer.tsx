"use client";

import type { Widget } from "@/lib/types";

import { DataGrid } from "./DataGrid";
import { ForecastWidget } from "./ForecastWidget";
import { RevenueWidget } from "./RevenueWidget";

/** Dispatches a structured payload from the agent to the right renderer. */
export function WidgetRenderer({ widget }: { widget: Widget }) {
  switch (widget.kind) {
    case "bar":
      return <RevenueWidget widget={widget} />;
    case "grid":
      return (
        <DataGrid
          title={widget.title}
          subtitle={widget.subtitle}
          columns={widget.columns}
          rows={widget.rows}
        />
      );
    case "forecast":
      return <ForecastWidget widget={widget} />;
    default:
      return null;
  }
}

export default WidgetRenderer;
