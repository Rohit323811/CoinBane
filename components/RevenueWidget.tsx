"use client";

import type { BarWidget } from "@/lib/types";

const valueFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function formatValue(value: number, prefix?: string): string {
  return `${prefix ?? ""}${valueFormatter.format(value)}`;
}

/**
 * A live bar chart built from styled divs — no charting library, no SVG.
 *
 * Bars are `accent-primary`; rows the agent flagged as leaks are
 * `status-danger`. Widths are proportional to the largest value in the set so
 * the shape stays readable whether the numbers are dollars or counts.
 */
export function RevenueWidget({ widget }: { widget: BarWidget }) {
  const max = Math.max(...widget.bars.map((bar) => Math.abs(bar.value)), 0) || 1;

  return (
    <figure className="rounded-md border border-border-subtle bg-bg-secondary/60 p-3.5 sm:p-4">
      <figcaption className="mb-3">
        <p className="text-[13px] font-medium tracking-wide text-text-primary">
          {widget.title}
        </p>
        {widget.subtitle ? (
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">
            {widget.subtitle}
          </p>
        ) : null}
      </figcaption>

      <ul className="space-y-2.5">
        {widget.bars.map((bar, index) => {
          const width = Math.max(2, (Math.abs(bar.value) / max) * 100);
          const fill = bar.flagged ? "bg-status-danger" : "bg-accent-primary";

          return (
            <li key={`${bar.label}-${index}`}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span className="truncate text-[12px] text-text-secondary">
                  {bar.label}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-text-primary">
                  {formatValue(bar.value, widget.valuePrefix)}
                </span>
              </div>

              <div
                className="h-[6px] w-full overflow-hidden rounded-full bg-bg-elevated"
                role="img"
                aria-label={`${bar.label}: ${formatValue(bar.value, widget.valuePrefix)}${bar.flagged ? ", flagged" : ""}`}
              >
                <div
                  className={`h-full rounded-full ${fill} transition-[width] duration-500 ease-out`}
                  style={{ width: `${width}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

export default RevenueWidget;
