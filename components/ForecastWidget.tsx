"use client";

import type { ForecastWidget as ForecastWidgetData } from "@/lib/types";

/**
 * The cash-flow forecast, drawn from the tool's own payload.
 *
 * Each horizon is one bar split three ways: the pessimistic floor, the
 * expected landing, and the optimistic ceiling, sized in proportion to each
 * figure rather than nesting a range inside another, so a horizon whose
 * projections all agree still reads honestly instead of collapsing into a
 * single alarming colour.
 *
 * Colours come from the CoinBane status and accent tokens rather than
 * PayPal's palette: this renders inside the agent's chat, not the landing
 * page, so it stays inside the product's own colour system.
 */

const valueFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function formatMoney(value: number): string {
  return `USD ${valueFormatter.format(Math.round(value))}`;
}

function isMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Confidence reads as risk: green is safe, amber is shaky, red is doubtful. */
function confidenceTone(confidence: number): string {
  if (confidence >= 0.9) return "border-status-success/40 text-status-success";
  if (confidence >= 0.75) return "border-status-warning/40 text-status-warning";
  return "border-status-danger/40 text-status-danger";
}

export function ForecastWidget({ widget }: { widget: ForecastWidgetData }) {
  const windows = (Array.isArray(widget.windows) ? widget.windows : []).filter(
    (window) => isMoney(window?.expected),
  );
  const clients = (Array.isArray(widget.clients) ? widget.clients : []).filter(
    (line) => typeof line?.client === "string" && isMoney(line?.expected),
  );

  if (windows.length === 0) {
    return (
      <figure className="rounded-md border border-border-subtle bg-bg-secondary/60 p-3.5 text-[12px] text-text-secondary sm:p-4">
        Nothing is open to forecast.
      </figure>
    );
  }

  // One scale for every bar, so the horizons are comparable at a glance.
  const scale =
    Math.max(
      ...windows.map(
        (window) => window.pessimistic + window.expected + window.optimistic,
      ),
    ) || 1;
  const width = (value: number) => (Math.max(0, value) / scale) * 100;

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

      <ul className="space-y-3">
        {windows.map((window) => {
          const focused = window.days === widget.focusDays;
          const label = `${window.days} days`;
          const accessible = `${label}: expected ${formatMoney(window.expected)}, between ${formatMoney(window.pessimistic)} and ${formatMoney(window.optimistic)}`;

          return (
            <li key={window.days}>
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <span
                  className={`text-[12px] ${focused ? "text-text-primary" : "text-text-secondary"}`}
                >
                  {label}
                </span>
                <span className="shrink-0 text-[12px] tabular-nums text-text-primary">
                  {formatMoney(window.expected)}
                </span>
              </div>

              <div
                className="flex h-[8px] w-full overflow-hidden rounded-full bg-bg-elevated"
                role="img"
                aria-label={accessible}
              >
                <div
                  className="h-full bg-status-danger/70"
                  style={{ width: `${width(window.pessimistic)}%` }}
                />
                <div
                  className="h-full bg-accent-primary transition-[width] duration-500 ease-out"
                  style={{ width: `${width(window.expected)}%` }}
                />
                <div
                  className="h-full bg-status-success/70"
                  style={{ width: `${width(window.optimistic)}%` }}
                />
              </div>

              <p className="mt-1 text-[10px] tabular-nums text-text-secondary">
                {window.pessimistic === window.optimistic
                  ? `Every projection agrees: ${formatMoney(window.expected)}`
                  : `Range ${formatMoney(window.pessimistic)} to ${formatMoney(window.optimistic)}`}
              </p>
            </li>
          );
        })}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-subtle pt-2.5 text-[10px] text-text-secondary">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-status-danger/70" aria-hidden />
          Pessimistic
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent-primary" aria-hidden />
          Expected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-status-success/70" aria-hidden />
          Optimistic
        </span>
      </div>

      {clients.length > 0 ? (
        <div className="mt-3 border-t border-border-subtle pt-3">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.16em] text-text-secondary">
            Expected within {widget.focusDays} days
          </p>
          <ul className="space-y-1.5">
            {clients.map((line) => (
              <li
                key={line.client}
                className="flex items-center justify-between gap-3"
              >
                <span className="truncate text-[12px] text-text-secondary">
                  {line.client}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="text-[12px] tabular-nums text-text-primary">
                    {formatMoney(line.expected)}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] leading-none tabular-nums ${confidenceTone(line.confidence)}`}
                    title={`Confidence ${Math.round(line.confidence * 100)}% — the chance this client pays at all`}
                  >
                    {Math.round(line.confidence * 100)}%
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </figure>
  );
}

export default ForecastWidget;
