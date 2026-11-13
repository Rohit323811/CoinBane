import { generateText, tool, type ToolSet } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  coinbaneModel,
  coinbaneModelId,
  coinbaneModelVia,
  isModelConfigured,
} from "@/lib/ai";
import {
  detectInsights,
  simulatedInsights,
  type DisputeLike,
  type InvoiceLike,
} from "@/lib/anomaly";
import { parseDispute } from "@/lib/dispute-pack";
import { toInvoicePayload } from "@/lib/invoices";
import {
  isPayPalConfigured,
  listDisputeRecords,
  listInvoiceRecords,
  paypalTools,
} from "@/lib/paypal";
import { buildInsightPrompt } from "@/lib/prompts";
import type {
  Insight,
  InsightFallbackReason,
  InsightsResponseBody,
} from "@/lib/types";

/**
 * Proactive anomaly sweep.
 *
 * Called when the app loads, so CoinBane can greet the user with something it
 * noticed rather than an empty box. When the sandbox and model are both
 * configured it reads the real records; otherwise it returns a clearly
 * labelled simulated fixture.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_INSIGHTS = 3;

/**
 * Only the reads a sweep actually performs.
 *
 * The full PayPal toolkit costs about 4,300 tokens of catalogue on its own —
 * mostly `create_invoice`, which a sweep never calls. On a free plan that shares
 * an 8,000-token minute with the chat, sending the whole toolkit here was enough
 * to make the sweep itself "Request too large" (measured: 12,541 requested) and
 * to starve the next chat turn. Four read tools are ~330 tokens.
 */
const SWEEP_TOOL_NAMES = [
  "list_invoices",
  "get_invoice",
  "list_disputes",
  "get_dispute",
] as const;

function sweepTools(all: ToolSet): ToolSet {
  const picked: ToolSet = {};
  for (const name of SWEEP_TOOL_NAMES) {
    const tool = all[name];
    if (tool) picked[name] = tool;
  }
  return picked;
}
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on the sweep.
 *
 * This route is what the header's status light waits on, and `generateText` has
 * no timeout of its own. A provider that accepted the connection and then went
 * quiet therefore left the indicator on "Checking" forever: nothing threw,
 * nothing returned, and the page looked broken with no error anywhere. Aborting
 * at three seconds turns "still thinking" into a definite answer — the labelled
 * sample insight — so the request always terminates.
 *
 * The cost is deliberate and worth stating: a slow *but working* provider now
 * yields sample insights instead of live ones. They arrive labelled as a sample
 * (see FALLBACK_NOTICES on the client), and failures are never cached, so the
 * next page load retries.
 */
/*
 * A sweep is a whole agent turn: read the ledger, inspect a record, report. Two
 * 25 seconds allows for a slow-but-working provider, which the previous
 * three-second ceiling did not: it aborted every healthy sweep, so the page
 * always greeted the user with sample data and a notice blaming the provider.
 *
 * The client's own indicator stops pulsing after three seconds regardless (see
 * STATUS_TIMEOUT_MS in components/Chat.tsx), so the header never waits on this.
 */
const HEALTH_TIMEOUT_MS = 25_000;

let cache: { at: number; body: InsightsResponseBody } | null = null;

const reportInsights = tool({
  description:
    "Report the money leaks you confirmed from the records you retrieved. Call this exactly once, after the PayPal tools have returned.",
  parameters: z.object({
    insights: z
      .array(
        z.object({
          severity: z.enum(["high", "medium", "low"]),
          headline: z
            .string()
            .describe(
              'Lowercase clause that reads after "I noticed", e.g. "your refund rate from Acme Studio spiked 300% this month".',
            ),
          detail: z
            .string()
            .describe("One or two sentences with the supporting figures."),
          metric: z
            .object({
              label: z.string(),
              value: z.string(),
              delta: z.string(),
            })
            .optional(),
        }),
      )
      .max(MAX_INSIGHTS),
  }),
  execute: async ({ insights }) => insights,
});

/** Clamps the model's tool payload into renderable insights. */
function normalizeInsights(input: unknown): Insight[] {
  if (!Array.isArray(input)) return [];

  const insights: Insight[] = [];
  for (const [index, entry] of input.slice(0, MAX_INSIGHTS).entries()) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;

    const headline =
      typeof raw.headline === "string" ? raw.headline.trim() : "";
    const detail = typeof raw.detail === "string" ? raw.detail.trim() : "";
    if (!headline || !detail) continue;

    const severity =
      raw.severity === "high" || raw.severity === "medium" || raw.severity === "low"
        ? raw.severity
        : "medium";

    const rawMetric = raw.metric as Record<string, unknown> | undefined;
    const metric =
      rawMetric &&
      typeof rawMetric.label === "string" &&
      typeof rawMetric.value === "string" &&
      typeof rawMetric.delta === "string"
        ? {
            label: rawMetric.label.slice(0, 40),
            value: rawMetric.value.slice(0, 40),
            delta: rawMetric.delta.slice(0, 40),
          }
        : undefined;

    insights.push({
      id: `sandbox-${index}`,
      severity,
      headline: headline.slice(0, 200),
      detail: detail.slice(0, 400),
      metric,
    });
  }

  return insights;
}

function readInsightsFromSteps(steps: unknown): Insight[] {
  if (!Array.isArray(steps)) return [];

  for (const step of steps) {
    const results = (step as { toolResults?: unknown } | null)?.toolResults;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      const name = (result as { toolName?: unknown } | null)?.toolName;
      if (name !== "report_insights") continue;
      const insights = normalizeInsights(
        (result as { result?: unknown } | null)?.result,
      );
      if (insights.length > 0) return insights;
    }
  }

  return [];
}

async function baseBody(): Promise<InsightsResponseBody> {
  const paypalConnected = isPayPalConfigured();
  const modelConnected = isModelConfigured();

  // The reason travels with the fixture so the client never has to guess why
  // it got sample data. Reporting "sandbox offline" for a provider outage is
  // the failure mode this exists to prevent.
  const fallback = (reason: InsightFallbackReason): InsightsResponseBody => ({
    insights: simulatedInsights(),
    source: "simulated",
    paypalConnected,
    modelConnected,
    fallbackReason: reason,
  });

  const tools = paypalTools();
  if (!paypalConnected || !tools) return fallback("paypal-unconfigured");

  /*
   * Deterministic sweep first, over the same records the model would have read.
   *
   * The arithmetic in `detectInsights` is what the model was being asked to
   * redo from a ledger dump, and it costs no tokens. Two things follow: the
   * greeting is real ledger data even on a provider that is rate-limited or
   * slow, and the sample fixture stops appearing on a page load that could
   * always have been answered — which is what the old "sweep failed" notice was
   * really reporting.
   *
   * The model path below stays: when nothing obvious surfaces, it is the thing
   * that can connect two facts.
   */
  try {
    const [invoiceRecords, disputeRecords] = await Promise.all([
      listInvoiceRecords(),
      listDisputeRecords(),
    ]);

    const invoices: InvoiceLike[] = invoiceRecords.flatMap((record) => {
      const payload = toInvoicePayload(record);
      if (!payload) return [];
      return [
        {
          counterparty: payload.client,
          amount: payload.total,
          status: payload.status,
          dueDate: payload.due ?? "",
          number: payload.number,
        },
      ];
    });

    const disputes: DisputeLike[] = disputeRecords.flatMap((record) => {
      const parsed = parseDispute(record);
      const dispute = parsed?.summary;
      if (!dispute?.openedAt) return [];
      return [
        {
          counterparty: dispute.client,
          amount: dispute.amount,
          date: dispute.openedAt,
        },
      ];
    });

    const computed = detectInsights({ invoices, disputes });

    /*
     * A read that worked and found nothing is an answer, not a failure: saying
     * so costs no tokens and is true, where the sample would imply the ledger
     * went unread. A sandbox that only holds draft test invoices is exactly
     * this case.
     */
    if (computed.length === 0) return fallback("no-findings");

    return {
      insights: computed,
      source: "sandbox",
      paypalConnected,
      modelConnected,
    };
  } catch (error) {
    /*
     * The read itself failed, which is the one case the model can still rescue:
     * it reaches the ledger through its own tool calls. Anything else would be a
     * second opinion nobody asked for.
     */
    console.error("[coinbane] deterministic sweep failed:", error);
  }

  if (!modelConnected) return fallback("model-unconfigured");

  try {
    const result = await generateText({
      model: coinbaneModel(),
      prompt: buildInsightPrompt({}),
      tools: { ...sweepTools(tools), report_insights: reportInsights } as ToolSet,
      // Three steps covers the flow: read the ledger, inspect a record if
      // needed, then call report_insights. Capped so a sweep cannot loop and
      // re-send its prompt on every page load.
      maxSteps: 3,
      // Three short insights; anything past this is a runaway sweep.
      maxTokens: 700,
      // AbortSignal.timeout is an absolute deadline, not an idle timer: it fires
      // whether the provider is mid-stream or never answered at all, which is
      // exactly the case that hung the UI.
      abortSignal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      // One attempt: a quota refusal is answered immediately rather than three
      // times, which on a free plan would spend the whole minute's budget on a
      // sweep nobody is waiting for.
      maxRetries: 0,
    });

    const insights = readInsightsFromSteps(result.steps);
    if (insights.length === 0) return fallback("no-findings");

    return {
      insights,
      source: "sandbox",
      paypalConnected,
      modelConnected,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    // A timeout is logged as a timeout: "aborted" on its own reads like a
    // client disconnect and sends the search to the wrong place.
    const timedOut = error instanceof Error && error.name === "AbortError";
    console.error(
      `[coinbane] anomaly sweep ${timedOut ? `timed out after ${HEALTH_TIMEOUT_MS}ms` : "failed"}:`,
      detail,
      `model=${coinbaneModelVia()}/${coinbaneModelId()}`,
    );

    return fallback("sweep-failed");
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const body = await baseBody();

  /*
   * Only a real sweep is cached. Caching a fallback pinned sample data — and an
   * offline-looking header — for five minutes after a one-second hiccup, so a
   * retry is always allowed to have a different answer.
   */
  if (body.source === "sandbox") cache = { at: Date.now(), body };

  return NextResponse.json(body);
}
