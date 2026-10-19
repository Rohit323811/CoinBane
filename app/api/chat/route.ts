import { generateText, type CoreMessage, type ToolSet } from "ai";
import { NextResponse } from "next/server";

import { coinbaneModel } from "@/lib/ai";
import { MissingConfigError } from "@/lib/config";
import {
  collectDisputes,
  DISPUTE_TOPIC,
  fixtureDisputesFor,
} from "@/lib/dispute-pack";
import {
  cardInvoices,
  collectInvoices,
  collectLedgerInvoices,
  toInvoicePayload,
} from "@/lib/invoices";
import { isPayPalConfigured, paypalTools, readInvoiceRecord } from "@/lib/paypal";
import { buildSystemPrompt } from "@/lib/prompts";
import { explainIncomeTool } from "@/lib/tools/explain";
import { forecastTool } from "@/lib/tools/forecast";
import { scoreInvoiceTool } from "@/lib/tools/score";
import type { ChatResponseBody, InvoicePayload } from "@/lib/types";
import { collectToolNames, collectWidgets, displayTools } from "@/lib/widgets";

/** The toolkit and the PayPal SDK are Node-only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded so a single request cannot be used to drain the token budget. */
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOTAL_CHARS = 24_000;
const MAX_STEPS = 10;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Validates the transcript supplied by the client.
 *
 * Client-supplied `system` roles are rejected outright: the persona is set
 * server-side and must not be overridable from the browser.
 */
function parseMessages(input: unknown): CoreMessage[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;

  const messages: CoreMessage[] = [];
  let totalChars = 0;

  for (const entry of input) {
    if (!entry || typeof entry !== "object") return null;

    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;

    const trimmed = content.trim();
    if (!trimmed) continue;

    const clipped = trimmed.slice(0, MAX_MESSAGE_CHARS);
    totalChars += clipped.length;
    if (totalChars > MAX_TOTAL_CHARS) break;

    messages.push({ role, content: clipped });
  }

  if (messages.length === 0) return null;
  return messages.slice(-MAX_MESSAGES);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const rawMessages = (payload as { messages?: unknown } | null)?.messages;
  const messages = parseMessages(rawMessages);
  if (!messages) {
    return badRequest(
      "Expected `messages` to be a non-empty array of { role, content } with role 'user' or 'assistant'.",
    );
  }

  const paypalConnected = isPayPalConfigured();
  const paypal = paypalTools();

  const lastUser = messages.filter((message) => message.role === "user").pop();
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const askedAboutDisputes = DISPUTE_TOPIC.test(userText);

  /*
   * The one dispute card this turn can show, decided here and used twice: the
   * prompt gets its contents, and the response ships the same list. A model told
   * what the card holds cannot deny it, and a card the model was never told
   * about cannot appear.
   */
  const fixtureDisputes = askedAboutDisputes ? fixtureDisputesFor(userText) : [];

  // PayPal tools are optional: without credentials the agent still runs, but
  // the system prompt forbids it from claiming any ledger access. The
  // intelligence tools are local reads over the simulated ledger, so they are
  // always available, and their names match the ones the prompt tells the
  // model to call.
  const tools: ToolSet = {
    ...(paypal ?? {}),
    ...displayTools,
    explain_income_change: explainIncomeTool,
    forecast_cashflow: forecastTool,
    score_invoice: scoreInvoiceTool,
  };

  try {
    const result = await generateText({
      model: coinbaneModel(),
      system: buildSystemPrompt({ paypalConnected, simulatedDisputes: fixtureDisputes }),
      messages,
      tools,
      maxSteps: MAX_STEPS,
      abortSignal: request.signal,
    });

    /*
     * A created invoice comes back as a self link alone, so it is read once
     * more to pick up the hosted pay URL the PDF's QR encodes. Sequential
     * rather than parallel: a turn rarely creates more than one invoice, and
     * the toolkit caches the access token, so this is one cheap call rather
     * than a burst that races a cold login.
     */
    const collected = collectInvoices(result.steps);
    const fetched: InvoicePayload[] = [];
    for (const id of collected.pendingIds) {
      const payload = toInvoicePayload(await readInvoiceRecord(id));
      if (payload) fetched.push(payload);
    }

    /*
     * The ledger invoices the turn named, so a simulated invoice gets the same
     * card — and the same download — as one PayPal holds. Ids already carded
     * are passed in, so an invoice never appears twice.
     */
    const ledgerInvoices = collectLedgerInvoices(
      result.steps,
      [...collected.payloads, ...fetched].map((payload) => payload.id),
    );

    // Disputes the agent read this turn. Unlike an invoice, a dispute needs no
    // follow-up read: get_dispute and list_disputes both return full records.
    const disputes = collectDisputes(result.steps);

    /*
     * A list turn can return every invoice on the account, so the cards are
     * capped and the remainder is reported: the transcript says what is not on
     * screen instead of silently showing three of sixteen.
     */
    const carded = cardInvoices([...collected.payloads, ...fetched, ...ledgerInvoices]);

    const body: ChatResponseBody = {
      text: result.text.trim(),
      widgets: collectWidgets(result.steps),
      invoices: carded.shown,
      invoicesOmitted: carded.omitted || undefined,
      // PayPal's records win when there are any: a simulated card would
      // otherwise sit beside a real case. Only a dispute turn shows a fixture at
      // all, because any other answer would arrive with a dispute card beside it.
      disputes: disputes.length === 0 ? fixtureDisputes : disputes,
      toolCalls: collectToolNames(result.steps),
      degraded: paypalConnected ? undefined : "paypal-unconfigured",
    };

    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof MissingConfigError) {
      return badRequest(error.message, 503);
    }

    // A client-side abort is not a server failure.
    if (error instanceof Error && error.name === "AbortError") {
      return badRequest("Request was cancelled.", 499);
    }

    const detail = error instanceof Error ? error.message : "Unknown error";
    console.error("[coinbane] chat request failed:", error);

    // The upstream message is surfaced rather than swallowed: a provider
    // failure is otherwise indistinguishable from a PayPal one, and the raw
    // text (bad key, retired model ID, rate limit) is what makes it fixable.
    return NextResponse.json(
      {
        error: `The agent could not complete that request. ${detail.slice(0, 300)}`,
      },
      { status: 502 },
    );
  }
}
