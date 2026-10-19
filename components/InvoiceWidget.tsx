"use client";

import { useState } from "react";

import { formatInvoiceMoney, invoiceFileName, shortPayUrl } from "@/lib/invoices";
import type { AutopilotApprovalResponseBody, InvoicePayload } from "@/lib/types";

/**
 * The invoice the agent read or created, with the three things a summary alone
 * cannot give: the file, the payer page and the nudge.
 *
 * The payload rendered here is the one the PDF is built from, so the widget and
 * the document cannot disagree about the client, the amount or the due date.
 *
 * A simulated ledger invoice says so on its face. It has no PayPal record
 * behind it: the pay button has nowhere to go, and its reminder is recorded
 * rather than sent. Saying that here is the difference between a demo and a
 * card that implies a real client was chased.
 */

type ActionState = "idle" | "working" | "failed";

/** Ids the simulated ledger mints (lib/clients.ts). */
const SIMULATED_INVOICE_ID = /^inv-\d+$/;

/** What the reminder endpoint answers: sent, recorded, or refused. */
type ReminderResult = { ok: boolean; detail: string };

export function InvoiceWidget({ invoice }: { invoice: InvoicePayload }) {
  const [pdf, setPdf] = useState<ActionState>("idle");
  const [reminder, setReminder] = useState<ActionState>("idle");
  const [result, setResult] = useState<ReminderResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const simulated = SIMULATED_INVOICE_ID.test(invoice.id);

  const download = async () => {
    setPdf("working");
    setError(null);

    try {
      const response = await fetch("/api/invoice/pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(invoice),
      });

      if (!response.ok) {
        const data = (await response
          .json()
          .catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "The invoice PDF could not be generated.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = invoiceFileName(invoice);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Revoked on a delay rather than at once: Safari has been known to cancel
      // a download whose object URL disappears in the same tick.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);

      setPdf("idle");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The invoice PDF could not be generated.",
      );
      setPdf("failed");
    }
  };

  /*
   * The reminder goes through the same endpoint the autopilot cards use, so a
   * real PayPal invoice is chased through the toolkit and a ledger invoice is
   * recorded with the reason nothing left the machine.
   */
  const sendReminder = async () => {
    setReminder("working");
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: { type: "send_reminder", invoiceId: invoice.id } }),
      });

      const data = (await response
        .json()
        .catch(() => null)) as (AutopilotApprovalResponseBody & { error?: string }) | null;

      if (!response.ok || !data) {
        throw new Error(data?.error ?? "The reminder could not be sent.");
      }

      setResult({ ok: data.ok, detail: data.detail });
      setReminder(data.ok ? "idle" : "failed");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The reminder could not be sent.");
      setReminder("failed");
    }
  };

  const working = pdf === "working" || reminder === "working";

  return (
    <article className="rounded-md border border-border-subtle bg-bg-elevated p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold leading-snug text-text-primary">
            Invoice {invoice.number}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">
            {invoice.client} · {invoice.status}
          </p>
        </div>
        <span className="shrink-0 text-[13.5px] font-medium text-accent-glow">
          {formatInvoiceMoney(invoice.total, invoice.currency)}
        </span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
        {invoice.issued ? `Issued ${invoice.issued}` : "Issue date not recorded"}
        {invoice.due ? ` · due ${invoice.due}` : " · due on receipt"}
        {invoice.payUrl ? (
          <>
            {" · pay link "}
            <span className="text-accent-primary">{shortPayUrl(invoice.payUrl)}</span>
          </>
        ) : null}
      </p>

      {simulated ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-text-secondary/80">
          Simulated ledger invoice: no PayPal invoice stands behind it. The PDF is
          real, and the reminder is recorded rather than sent.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void download()}
          disabled={working}
          className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-[12px] font-medium tracking-wide text-text-primary transition-colors hover:border-accent-primary/40 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pdf === "working" ? "Preparing…" : "Download PDF"}
        </button>

        {/*
         * Rendered whether or not it can go anywhere: a button that silently
         * vanishes is harder to explain than one that says why it is inert.
         */}
        <a
          href={invoice.payUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={invoice.payUrl ? undefined : true}
          title={
            invoice.payUrl
              ? "Open the hosted payer page in PayPal"
              : "This invoice has no PayPal payer page to open"
          }
          onClick={(event) => {
            if (!invoice.payUrl) event.preventDefault();
          }}
          className={`rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-[12px] font-medium tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 ${
            invoice.payUrl
              ? "text-text-primary hover:border-accent-primary/40 hover:text-accent-primary"
              : "cursor-not-allowed text-text-secondary/50"
          }`}
        >
          Open in PayPal
        </a>

        <button
          type="button"
          onClick={() => void sendReminder()}
          disabled={working}
          className="rounded-md border border-border-subtle bg-bg-card px-3 py-1.5 text-[12px] font-medium tracking-wide text-text-primary transition-colors hover:border-accent-primary/40 hover:text-accent-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reminder === "working" ? "Sending…" : "Send Reminder"}
        </button>
      </div>

      {result ? (
        <p
          role={result.ok ? "status" : "alert"}
          className={`mt-2 text-[11px] leading-relaxed ${
            result.ok ? "text-text-secondary" : "text-status-danger"
          }`}
        >
          {result.detail}
        </p>
      ) : null}
      {pdf === "failed" && error ? (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed text-status-danger">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export default InvoiceWidget;
