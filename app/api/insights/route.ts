import { generateText, tool, type ToolSet } from "ai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { coinbaneModel, isModelConfigured } from "@/lib/ai";
import { simulatedInsights } from "@/lib/anomaly";
import { isPayPalConfigured, paypalTools } from "@/lib/paypal";
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
const CACHE_TTL_MS = 5 * 60 * 1000;

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
  if (!modelConnected) return fallback("model-unconfigured");

  try {
    const result = await generateText({
      model: coinbaneModel(),
      prompt: buildInsightPrompt({}),
      tools: { ...tools, report_insights: reportInsights } as ToolSet,
      // Two steps is the floor for this flow: one to read the ledger, one to
      // call report_insights. Raising it buys headroom for the model to inspect
      // individual records before summarising, at the cost of more model calls
      // per page load.
      maxSteps: 2,
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
    console.error("[coinbane] anomaly sweep failed:", detail);
    return fallback("sweep-failed");
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const body = await baseBody();
  cache = { at: Date.now(), body };
  return NextResponse.json(body);
}
