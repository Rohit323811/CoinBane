import { generateText, type CoreMessage, type ToolSet } from "ai";
import { NextResponse } from "next/server";

import { coinbaneModel, coinbaneModelId, coinbaneModelVia } from "@/lib/ai";
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
import { paypalTools, readInvoiceRecord } from "@/lib/paypal";
import { buildSystemPrompt } from "@/lib/prompts";
import { explainIncomeTool } from "@/lib/tools/explain";
import { forecastTool } from "@/lib/tools/forecast";
import { scoreInvoiceTool } from "@/lib/tools/score";
import type { ChatResponseBody, InvoicePayload } from "@/lib/types";
import {
  collectToolNames,
  collectWidgets,
  displayTools,
  latePayerGrid,
} from "@/lib/widgets";

/** The toolkit and the PayPal SDK are Node-only. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bounded so a single request cannot be used to drain the token budget. */
const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_TOTAL_CHARS = 12_000;
/**
 * The agent loop is deliberately short, but three was one short of the work.
 *
 * A "grid my invoices" turn reads the invoices, scores them (the prompt asks for
 * score_invoice whenever risk is mentioned), draws the grid and then answers —
 * four steps. At three it ran out of steps after the tools and returned an empty
 * reply, which reads as the agent refusing to speak. Five leaves room for that
 * sequence plus one correction, and the free-plan wait in lib/ai.ts keeps the
 * extra steps affordable.
 */
const MAX_STEPS = 5;

/** Replies are a few sentences by design; this bounds a runaway generation. */
const MAX_OUTPUT_TOKENS = 900;

/**
 * Words that mean "make me an invoice".
 *
 * `create_invoice` carries the largest schema in the catalogue — about 2,600 of
 * the 4,300 tokens every request spends on tools, mostly nested PayPal line-item
 * definitions. On a free plan with an 8,000-token minute that single tool is the
 * difference between one turn a minute and three, so it is offered only when the
 * conversation is actually about invoicing. Anything else would pay for a form
 * it will never fill in.
 */
const INVOICE_INTENT = [
  // "create an invoice", "draft a bill for", "send Nova an invoice"
  /\b(?:create|make|draft|issue|raise|write|send|prepare)\b[^.!?]{0,40}\b(?:invoice|bill|quote)\b/i,
  // "invoice Nova for 1200", "bill BigCorp Ltd for the extra work" — the client
  // name can be several words, so the gap is bounded by word count, not by one.
  /\b(?:invoice|bill)\s+(?:\S+\s+){1,4}for\b/i,
];

/** True when the conversation is asking for a new invoice. */
function wantsInvoice(messages: CoreMessage[]): boolean {
  return messages.some((message) => {
    const content = (message as { content?: unknown }).content;
    return (
      typeof content === "string" &&
      INVOICE_INTENT.some((pattern) => pattern.test(content))
    );
  });
}

/**
 * Ceiling on one agent turn.
 *
 * `generateText` has no timeout of its own. A provider that accepts the
 * connection and then goes quiet — a stalled proxy, a revoked key on a host that
 * holds the socket open, a network path that blackholes the response — left the
 * request open indefinitely: nothing threw, the composer spun, and there was no
 * error anywhere to act on.
 *
 * Measured, not guessed: a plain "why am I broke?" turn that calls one tool took
 * 20s, and a turn that writes to PayPal and then answers needs more than 60s. Two
 * minutes leaves room for both while still turning a dead upstream into a
 * message rather than a spinner.
 */
const CHAT_TIMEOUT_MS = 180_000;

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

  /*
   * Tools first, then the flag: a toolkit that failed to initialise means no
   * ledger access, and the prompt has to say so. Reading the credentials alone
   * would report a connection this turn cannot actually use.
   */
  const paypal = paypalTools();
  const paypalConnected = paypal !== null;

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
  /*
   * The transcript is what decides: a follow-up like "yes, do it" after "invoice
   * Nova" still sees the tool, because the earlier turn is in `messages`.
   */
  const paypalToolSet: Record<string, unknown> = { ...(paypal ?? {}) };
  if (!wantsInvoice(messages)) delete paypalToolSet.create_invoice;

  const tools: ToolSet = {
    ...(paypalToolSet as ToolSet),
    ...displayTools,
    explain_income_change: explainIncomeTool,
    forecast_cashflow: forecastTool,
    score_invoice: scoreInvoiceTool,
  };

  /*
   * One signal drives the turn: the client's, which fires when the tab goes
   * away, and our deadline. `deadlineHit` is what separates "the user cancelled"
   * from "the provider never answered" — they raise the same AbortError but
   * deserve different statuses and different log lines.
   */
  const turnAbort = new AbortController();
  let deadlineHit = false;
  const onClientAbort = () => turnAbort.abort();
  request.signal.addEventListener("abort", onClientAbort);
  const deadline = setTimeout(() => {
    deadlineHit = true;
    turnAbort.abort();
  }, CHAT_TIMEOUT_MS);

  /*
   * Every finished step is kept as it lands, not just at the end.
   *
   * The free plan's window can run out between the step that draws a widget and
   * the step that writes the sentence about it — and when that happens
   * `generateText` throws, taking the completed steps with it. The grid was
   * already built and rendered by then; losing it because the closing line could
   * not be paid for is the wrong outcome. `onStepFinish` is what lets the route
   * answer with what it has.
   */
  const steps: unknown[] = [];

  try {
    const turn = () =>
      generateText({
      model: coinbaneModel(),
      system: buildSystemPrompt({ paypalConnected, simulatedDisputes: fixtureDisputes }),
      messages,
      tools,
      maxSteps: MAX_STEPS,
      maxTokens: MAX_OUTPUT_TOKENS,
      abortSignal: turnAbort.signal,
      onStepFinish: (step) => {
        steps.push(step);
      },
      /*
       * No silent retries. On Groq's free plan a turn carries a couple of
       * thousand tokens of tool catalogue and prompt against an 8,000-token
       * minute, so three automatic retries do not recover the turn — they spend
       * three times the quota to arrive at the same 429, thirty seconds later.
       * One attempt plus a plain explanation is the honest behaviour here.
       */
      maxRetries: 0,
    });

    /*
     * One retry for a mangled tool call, and only for that.
     *
     * A small free-tier model occasionally picks the right tool and then emits
     * invalid JSON for its arguments — `render_data_grid`'s rows and
     * `create_invoice`'s nested line items are the usual offenders. The call is
     * sampling, not schema: the same turn a moment later usually gets it right,
     * which is why a retry here is worth one more request where a retry on a
     * rate limit is not.
     */
    let result: Awaited<ReturnType<typeof generateText>> | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      try {
        result = await turn();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const mangled = /tool_use_failed|Failed to parse tool call arguments/i.test(message);
        if (attempt === 0 && mangled) {
          console.warn("[coinbane] the model mangled a tool call; retrying the turn once.");
          continue;
        }
        throw error;
      }
    }
    if (!result) throw new Error("The model did not answer.");

    /*
     * A created invoice comes back as a self link alone, so it is read once
     * more to pick up the hosted pay URL the PDF's QR encodes. Sequential
     * rather than parallel: a turn rarely creates more than one invoice, and
     * the toolkit caches the access token, so this is one cheap call rather
     * than a burst that races a cold login.
     */
    const collected = collectInvoices(steps.length > 0 ? steps : result.steps);
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
      steps.length > 0 ? steps : result.steps,
      [...collected.payloads, ...fetched].map((payload) => payload.id),
    );

    // Disputes the agent read this turn. Unlike an invoice, a dispute needs no
    // follow-up read: get_dispute and list_disputes both return full records.
    const disputes = collectDisputes(steps.length > 0 ? steps : result.steps);

    /*
     * A list turn can return every invoice on the account, so the cards are
     * capped and the remainder is reported: the transcript says what is not on
     * screen instead of silently showing three of sixteen.
     */
    const carded = cardInvoices([...collected.payloads, ...fetched, ...ledgerInvoices]);

    const widgets = collectWidgets(steps.length > 0 ? steps : result.steps);

    /*
     * An income explanation always ships with the names behind it. The model is
     * told not to draw its own grid here, so this is the only one on the answer;
     * the guard keeps it that way if a model ever ignores the instruction.
     */
    if (
      collectToolNames(steps.length > 0 ? steps : result.steps).includes(
        "explain_income_change",
      ) &&
      !widgets.some((widget) => widget.kind === "grid")
    ) {
      const grid = latePayerGrid();
      if (grid) widgets.push(grid);
    }

    /*
     * A turn that spent every step on tools comes back with no prose. An empty
     * bubble reads as the agent refusing to speak, so the reply says what
     * happened — and when the tools did produce something, it says that instead
     * of apologising for the sentence it never wrote.
     */
    const text =
      result.text.trim() ||
      (widgets.length > 0
        ? "The ledger is on the table. Read it, then tell me which leak to close."
        : "I read the ledger but did not finish the answer. Ask once more and I will finish it.");

    const body: ChatResponseBody = {
      text,
      widgets,
      invoices: carded.shown,
      invoicesOmitted: carded.omitted || undefined,
      // PayPal's records win when there are any: a simulated card would
      // otherwise sit beside a real case. Only a dispute turn shows a fixture at
      // all, because any other answer would arrive with a dispute card beside it.
      disputes: disputes.length === 0 ? fixtureDisputes : disputes,
      toolCalls: collectToolNames(steps.length > 0 ? steps : result.steps),
      degraded: paypalConnected ? undefined : "paypal-unconfigured",
    };

    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof MissingConfigError) {
      return badRequest(error.message, 503);
    }

    /*
     * Our deadline fired. Checked before the AbortError branch because the
     * deadline aborts with exactly the error a cancellation does, and "Request
     * was cancelled" would hide the one fact worth knowing: nobody cancelled
     * this, the provider simply never answered.
     */
    if (deadlineHit) {
      console.error(
        `[coinbane] model turn timed out after ${
          CHAT_TIMEOUT_MS / 1000
        }s (${coinbaneModelVia()} ${coinbaneModelId()}): the provider accepted the request and never replied.`,
      );
      return badRequest(
        `The model did not answer within ${
          CHAT_TIMEOUT_MS / 1000
        } seconds: the provider accepted the request and never replied. Check GEMINI_API_KEY, GEMINI_PROXY_BASE_URL, GROQ_API_KEY, and that ${coinbaneModelId()} is available to this key.`,
        504,
      );
    }

    // A client-side abort is not a server failure.
    if (error instanceof Error && error.name === "AbortError") {
      return badRequest("Request was cancelled.", 499);
    }

    const detail = error instanceof Error ? error.message : "Unknown error";

    /*
     * A quota answer is not a broken app. On the free plan the per-minute token
     * ceiling is low enough that two turns in one minute reach it, so the raw
     * message ("Rate limit reached ... TPM") is translated into what to do next
     * instead of a 502 that reads like a bug.
     */
    if (/Failed to parse tool call arguments|tool_use_failed/i.test(detail)) {
      /*
       * The model chose the right tool and then could not write valid JSON for
       * its arguments. `create_invoice` is the usual culprit: its PayPal form is
       * the largest schema in the catalogue and a small free-tier model will
       * occasionally mangle it. Retrying the same shape rarely helps, so the
       * message points at what does.
       */
      return NextResponse.json(
        {
          error:
            "The model picked the right tool but twice could not fill in its form. Ask again in one short sentence that names the client and the amount, or use a larger model for this turn.",
        },
        { status: 502 },
      );
    }

    if (/rate limit|429|tokens per minute|TPM/i.test(detail)) {
      // Logged before answering: the quota branch used to return a friendly line
      // and nothing else, which made "is this a real limit or a misread error?"
      // unanswerable from the terminal.
      console.error("[coinbane] model quota refused the turn:", detail.slice(0, 400));

      /*
       * A daily cap is not a minute's cap, and telling the user to wait sixty
       * seconds when the budget is spent until Groq resets is a lie that costs
       * them a minute every time they retry.
       */
      if (/tokens per day|\bTPD\b/i.test(detail)) {
        return NextResponse.json(
          {
            error:
              "The free plan's daily token budget (200,000 a day) is spent. It resets on Groq's clock — the turn itself was fine, and chat works again once it does.",
          },
          { status: 429 },
        );
      }

      /*
       * The window ran out after a tool already produced something. A grid, a
       * chart or an invoice card does not need the closing sentence to be
       * useful, so it is returned with one line saying what stopped.
       */
      const partialWidgets = collectWidgets(steps);
      const partialInvoices = cardInvoices(collectInvoices(steps).payloads);
      const partialDisputes = collectDisputes(steps);

      if (
        partialWidgets.length > 0 ||
        partialInvoices.shown.length > 0 ||
        partialDisputes.length > 0
      ) {
        const body: ChatResponseBody = {
          text:
            partialWidgets.length > 0
              ? "The ledger is on the table. The free plan's minute ran out before I could pass sentence on it."
              : "The record is below. The free plan's minute ran out before I could pass sentence on it.",
          widgets: partialWidgets,
          invoices: partialInvoices.shown,
          invoicesOmitted: partialInvoices.omitted || undefined,
          disputes: partialDisputes.length === 0 ? fixtureDisputes : partialDisputes,
          toolCalls: collectToolNames(steps),
          degraded: "model-budget",
        };
        return NextResponse.json(body);
      }

      return NextResponse.json(
        {
          error:
            "The free plan's token budget for this minute is spent. Wait about sixty seconds, then ask again — the turn itself was fine.",
        },
        { status: 429 },
      );
    }

    /*
     * The AI SDK keeps the provider's own response body on the error. Without
     * it a 400 reads as "Bad Request" and the actual reason — an unsupported
     * parameter, a rejected tool schema, a model the key cannot serve — never
     * leaves Google's response, which turns a five-second fix into a hunt.
     */
    const upstream =
      typeof error === "object" && error !== null && "responseBody" in error
        ? String((error as { responseBody?: unknown }).responseBody).slice(0, 400)
        : "";
    console.error("[coinbane] chat request failed:", detail, upstream || error);

    // The upstream message is surfaced rather than swallowed: a provider
    // failure is otherwise indistinguishable from a PayPal one, and the raw
    // text (bad key, retired model ID, rate limit) is what makes it fixable.
    return NextResponse.json(
      {
        error: `The agent could not complete that request. ${detail.slice(0, 300)}${
          upstream ? ` — ${upstream}` : ""
        }`,
      },
      { status: 502 },
    );
  } finally {
    // Both cleanups matter: a live timer keeps the process warm until it fires,
    // and a live listener would abort an already-finished turn on a stale signal.
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", onClientAbort);
  }
}
