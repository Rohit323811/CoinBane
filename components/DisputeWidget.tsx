"use client";

import { useState } from "react";

import { formatInvoiceMoney } from "@/lib/invoices";
import type { DisputeSummary } from "@/lib/types";

/**
 * A dispute the agent read, and the button that turns it into a file.
 *
 * The pack is assembled server-side from the dispute id, because that is what
 * PayPal resolves and what the freelancer would quote in a response. The card
 * says which record the pack will be built from: a simulated dispute is a
 * fixture, and the button must not imply otherwise.
 */

type DownloadState = "idle" | "working" | "failed";

/** Reads a header without trusting it: any value becomes a known label. */
const SOURCE_LABEL: Record<string, string> = {
  paypal: "PayPal dispute",
  simulated: "Simulated dispute (no PayPal dispute on file)",
  none: "No dispute on file (pack prepared from the invoice)",
};

export function DisputeWidget({ dispute }: { dispute: DisputeSummary }) {
  const [state, setState] = useState<DownloadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const download = async () => {
    setState("working");
    setError(null);
    setNote(null);

    try {
      const response = await fetch("/api/dispute/pack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disputeId: dispute.id, invoiceNumber: dispute.invoiceNumber }),
      });

      if (!response.ok) {
        const data = (await response
          .json()
          .catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "The proof pack could not be generated.");
      }

      const source = response.headers.get("x-coinbane-dispute-source") ?? "";
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `dispute-${dispute.invoiceNumber ?? dispute.id}-proof-pack.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setNote(
        `Proof pack downloaded — ${SOURCE_LABEL[source] ?? "built from the records on file"}.`,
      );
      setState("idle");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The proof pack could not be generated.",
      );
      setState("failed");
    }
  };

  const working = state === "working";
  const soon = deadlineNote(dispute.respondBy);

  return (
    <article className="rounded-md border border-status-warning/30 bg-bg-elevated p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold leading-snug text-text-primary">
            {dispute.reason}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">
            {dispute.client} · {dispute.id}
            {dispute.openedAt ? ` · opened ${dispute.openedAt}` : ""}
          </p>
        </div>
        <span className="shrink-0 text-[13.5px] font-medium text-status-warning">
          {formatInvoiceMoney(dispute.amount, dispute.currency)}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
        {dispute.status}
        {dispute.stage ? ` · ${dispute.stage}` : ""}
        {soon ? ` · ${soon}` : ""}
      </p>

      {dispute.source === "simulated" ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-secondary/80">
          Simulated record: PayPal holds no dispute with this id, so the pack is a
          prepared draft.
        </p>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void download()}
          disabled={working}
          className="rounded-md bg-accent-primary px-3.5 py-1.5 text-[12px] font-medium tracking-wide text-bg-main transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {working ? "Assembling…" : "Download Proof Pack"}
        </button>
      </div>

      {note ? (
        <p role="status" className="mt-2 text-[11px] leading-relaxed text-text-secondary">
          {note}
        </p>
      ) : null}
      {state === "failed" && error ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-status-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** How long is left to respond, in words, or null when there is no deadline. */
function deadlineNote(respondBy: string | null): string | null {
  if (!respondBy) return null;
  const deadline = new Date(`${respondBy}T23:59:59Z`);
  if (Number.isNaN(deadline.getTime())) return null;
  const days = Math.ceil((deadline.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `response deadline passed ${Math.abs(days)}d ago`;
  if (days === 0) return "response due today";
  return `${days}d left to respond`;
}

export default DisputeWidget;
