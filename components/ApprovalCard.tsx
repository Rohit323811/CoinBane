"use client";

import type { AutopilotAction, AutopilotActionType } from "@/lib/types";

/**
 * One drafted action, waiting on the user.
 *
 * The card is the whole decision surface: what CoinBane would do, why, what it
 * is worth, and two ways out. Approve runs it, skip drops it, and neither
 * leaves the card on screen.
 */

/** Bell, percent, piggy bank, warning — one glyph per action type. */
const ICONS: Record<AutopilotActionType, { path: string; label: string }> = {
  send_reminder: {
    label: "Reminder",
    path: "M12 3a5.5 5.5 0 0 0-5.5 5.5v3.2L5 14.4h14l-1.5-2.7V8.5A5.5 5.5 0 0 0 12 3Zm0 18a2.6 2.6 0 0 0 2.5-2h-5a2.6 2.6 0 0 0 2.5 2Z",
  },
  early_pay_discount: {
    label: "Discount",
    path: "M7.5 5.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM20.5 18.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM18.6 5.4 5.4 18.6l1.4 1.4L20 6.8l-1.4-1.4Z",
  },
  move_to_tax_pot: {
    label: "Tax pot",
    path: "M4 9.5h16a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1Zm3.5 0 .9-3.3A1.6 1.6 0 0 1 10 5h4a1.6 1.6 0 0 1 1.6 1.2l.9 3.3M12 12.2v4.6M9.7 14.5h4.6",
  },
  escalate_invoice: {
    label: "Escalation",
    path: "M12 3 2.8 19.2h18.4L12 3Zm.9 5.6v5h-1.8v-5h1.8Zm0 6.6v1.8h-1.8v-1.8h1.8Z",
  },
};

export function ApprovalCard({
  action,
  onApprove,
  onSkip,
  pending = false,
}: {
  action: AutopilotAction;
  onApprove: (action: AutopilotAction) => void;
  onSkip: (action: AutopilotAction) => void;
  pending?: boolean;
}) {
  const icon = ICONS[action.type];

  return (
    <article className="animate-rise-in rounded-md border border-border-subtle bg-bg-card p-3.5 sm:p-4">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border-subtle bg-bg-elevated text-accent-glow"
          aria-hidden
        >
          <svg width="16" height="16" viewBox="0 0 24 24" role="presentation">
            <path
              d={icon.path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold leading-snug text-text-primary">
            {action.headline}
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-text-secondary">
            {action.reasoning}
          </p>
          <p className="mt-1.5 text-[12px] font-medium text-accent-primary">
            {action.impact}
          </p>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => onApprove(action)}
              disabled={pending}
              className="rounded-md bg-accent-primary px-3 py-1.5 text-[12px] font-medium tracking-wide text-bg-main transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? "Working…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={() => onSkip(action)}
              disabled={pending}
              className="text-[12px] text-text-secondary underline-offset-2 transition-colors hover:text-text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

export default ApprovalCard;
