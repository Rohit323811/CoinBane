import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";
import type { ToolSet } from "ai";

import { paypalCredentials } from "./config.ts";

/**
 * PayPal Agent Toolkit, sandbox-only.
 *
 * Scoping note: the toolkit's `context.sandbox` flag (not an environment
 * variable) selects the PayPal sandbox host — see
 * `@paypal/agent-toolkit` `shared/client.ts`.
 *
 * The toolkit is constructed lazily rather than as a module-scope constant so
 * that a missing key surfaces as a readable error at request time instead of
 * crashing the server during import.
 */

let cached: PayPalAgentToolkit | null = null;

export function isPayPalConfigured(): boolean {
  return paypalCredentials() !== null;
}

/**
 * Returns the sandbox toolkit, or null when credentials are absent or unusable.
 *
 * Construction is wrapped because a bad or revoked client pair can fail here
 * rather than at call time. A throw would take down the whole turn — the
 * intelligence tools are local reads and have no reason to care about PayPal
 * — so a failed toolkit degrades to the simulated ledger instead. Nothing is
 * cached on failure, so fixing the keys works on the next request without a
 * restart.
 */
export function getPayPalToolkit(): PayPalAgentToolkit | null {
  const credentials = paypalCredentials();
  if (!credentials) return null;
  if (cached) return cached;

  try {
    cached = new PayPalAgentToolkit({
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      configuration: {
        actions: {
          invoices: {
            create: true,
            list: true,
            get: true,
            send: true,
            sendReminder: true,
          },
          transactions: { list: true },
          disputes: { list: true, get: true },
        },
        context: {
          // CRITICAL: every call is routed to the PayPal sandbox.
          sandbox: true,
        },
      },
    });

    /*
     * Logged once per process, on success. This is the proof that the two
     * credentials were *read* — the masked tail tells two sandbox apps apart
     * without putting a secret in a log line, and a request that later fails
     * with a 401 can be told apart from one that never had keys at all.
     */
    console.info(
      `[coinbane] PayPal sandbox toolkit ready (client id …${
        credentials.clientId.slice(-4)
      }, sandbox: true).`,
    );
  } catch (error) {
    console.error(
      "[coinbane] PayPal toolkit failed to initialise; answering from the simulated ledger:",
      error,
    );
    return null;
  }

  return cached;
}

/**
 * Tool set for the language model, or null when PayPal is unconfigured.
 *
 * `getTools()` returns AI SDK `Tool` objects built by this package's own
 * `ai` dependency; the app pins the same major so the objects are compatible.
 */
function rawTools(): ToolSet | null {
  const toolkit = getPayPalToolkit();
  if (!toolkit) return null;

  // Same reasoning as construction: a tool set the model cannot get is a
  // missing feature, not a failed request.
  try {
    return toolkit.getTools();
  } catch (error) {
    console.error(
      "[coinbane] PayPal tools unavailable; answering from the simulated ledger:",
      error,
    );
    return null;
  }
}

/*
 * A page of sandbox records is far larger than the model needs.
 *
 * Twenty-two invoices serialise to about 24,000 characters — roughly 8,000
 * tokens, which is the free plan's entire per-minute window, so the *second*
 * step of a turn (the one that reads the tool result) was being refused as "too
 * large" and the user saw a quota message for a turn that never had a chance.
 *
 * Two things shrink it without losing anything the answer needs:
 *
 * 1. `links` is 60% of each record — a list of PayPal endpoints for editing,
 *    cancelling and sending. Nothing here reads it: the payer URL the PDF's QR
 *    encodes lives at `detail.metadata.recipient_view_url`, and the invoice
 *    cards are built from `detail`, `amount` and `primary_recipients`.
 * 2. A turn only ever shows three cards, so records past the cap are dropped
 *    with a note saying how many there were. "22 invoices, 8 shown" is a
 *    truthful tool result; a silent truncation would not be.
 */
const MAX_MODEL_RECORDS = 8;

/** Drops the endpoint lists from a record, keeping every field a reader needs. */
function stripLinks(record: unknown): unknown {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  const copy = { ...(record as Record<string, unknown>) };
  delete copy.links;
  return copy;
}

/**
 * Compacts a list response: fewer records, no endpoint lists, an honest note.
 *
 * The toolkit answers with a JSON *string*, so it is parsed first — treating the
 * string as a record would compact nothing, which is exactly what the free plan
 * caught when this ran against a real page.
 */
export function compactPage(payload: unknown): unknown {
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return payload;
    }
  }

  const records = pageRecords(parsed);
  if (records.length === 0) return parsed;

  const kept = records.slice(0, MAX_MODEL_RECORDS).map(stripLinks);

  /*
   * The envelope's `total` is kept when PayPal sent one, and the note is added
   * on top so the model can say "16 more not shown" instead of believing the
   * page is the whole ledger.
   */
  const envelope =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const total = typeof envelope.total_items === "number" ? envelope.total_items : undefined;
  const omitted = (total ?? records.length) - kept.length;

  return {
    ...envelope,
    items: kept,
    ...(omitted > 0
      ? { note: `showing ${kept.length} of ${total ?? records.length} records; ${omitted} not shown` }
      : {}),
  };
}

/** Tools the model sees, with list results compacted. Never the raw pages. */
export function paypalTools(): ToolSet | null {
  const tools = rawTools();
  if (!tools) return null;

  /*
   * Three of the toolkit's eight tools are not offered to the model at all:
   * sending an invoice, sending a reminder, and reading one dispute. Each is a
   * full schema — around 600 characters on the wire — and each duplicates
   * something already here: `create_invoice` creates and sends, the reminder
   * runs through POST /api/autopilot, and `list_disputes` returns whole records
   * rather than references, so `get_dispute` is a second read of the same data.
   *
   * The free plan gives 8,000 tokens a minute and one step of a two-step turn
   * already carries the whole catalogue, so a tool nobody asks for is paid for
   * twice on every turn that uses any tool at all.
   */
  const MODEL_TOOL_NAMES = [
    "create_invoice",
    "list_invoices",
    "get_invoice",
    "list_disputes",
    "list_transactions",
  ];

  const compacted: Record<string, unknown> = {};
  for (const name of MODEL_TOOL_NAMES) {
    if (tools[name]) compacted[name] = tools[name];
  }

  for (const name of ["list_invoices", "list_transactions", "list_disputes"]) {
    const tool = compacted[name] as
      | { execute?: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    const execute = tool?.execute;
    if (!tool || typeof execute !== "function") continue;

    compacted[name] = {
      ...tool,
      execute: async (...args: unknown[]) => compactPage(await execute(...args)),
    };
  }

  return compacted as ToolSet;
}

/**
 * Reads one invoice back from PayPal.
 *
 * `create_invoice` answers with nothing but a self link, so the hosted payer
 * view — the URL the invoice PDF's QR must encode — only exists on a full
 * record. This is that second read. It returns null rather than throwing: a
 * PDF without a QR code is still a usable invoice, and a client download must
 * not fail because a read did.
 */
export async function readInvoiceRecord(
  invoiceId: string,
): Promise<unknown | null> {
  return callTool("get_invoice", { invoice_id: invoiceId }, `invoice ${invoiceId}`);
}

/** Every invoice the sandbox holds, as raw records. Never throws. */
export async function listInvoiceRecords(): Promise<unknown[]> {
  const page = await callTool("list_invoices", { page_size: 100 }, "invoice list");
  return pageRecords(page);
}

/** One dispute by id, or null. */
export async function readDisputeRecord(
  disputeId: string,
): Promise<unknown | null> {
  return callTool("get_dispute", { dispute_id: disputeId }, `dispute ${disputeId}`);
}

/**
 * Every dispute on the account.
 *
 * The sandbox currently returns none, which is a valid answer rather than an
 * error: callers fall back to the ledger fixture and label it as such.
 */
export async function listDisputeRecords(): Promise<unknown[]> {
  /*
   * 50 is the disputes endpoint's ceiling — it rejects 100 with an
   * INVALID_PAGE_SIZE before the request leaves the toolkit — while invoices
   * accept 100. The tool schema is the authority here, not the sibling call.
   */
  const page = await callTool("list_disputes", { page_size: 50 }, "dispute list");
  return pageRecords(page);
}

/**
 * Calls a toolkit action and returns its payload.
 *
 * The toolkit answers with a JSON string. Failures are logged and reported as
 * null: every caller here is assembling a document, and a document missing one
 * section beats a failed download.
 */
async function callTool(
  action: string,
  input: Record<string, unknown>,
  what: string,
): Promise<unknown | null> {
  /*
   * Raw tools, not the compacted set: the insights sweep and the dispute pack
   * read every record on the account, and they are not sent to a model, so the
   * page cap would only cost them data.
   */
  const tool = (rawTools() as Record<string, unknown> | null)?.[action] as
    | { execute?: (input: Record<string, unknown>) => Promise<unknown> }
    | undefined;

  if (!tool?.execute) return null;

  try {
    const raw = await tool.execute(input);
    const payload = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (toolError(payload)) {
      console.error(`[coinbane] could not read ${what}:`, JSON.stringify(payload));
      return null;
    }
    return payload;
  } catch (error) {
    console.error(`[coinbane] could not read ${what}:`, error);
    return null;
  }
}

/**
 * True when the toolkit answered with a failure instead of a record.
 *
 * A rejected call comes back in-band as `{ ok: false, status, code, message }`
 * rather than as a thrown error — `get_invoice` with an invoice *number*
 * instead of its id does exactly this. Without this check a 404 parses as a
 * record with no fields, and callers treat "PayPal said no" as "PayPal said
 * nothing", which is how a missing invoice silently becomes an empty one.
 */
function toolError(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as { ok?: unknown }).ok === false;
}

/**
 * The records inside a PayPal list response.
 *
 * A list answers with `{ items: [...] }`; a single-record read answers with the
 * record itself. Callers want a list either way.
 */
function pageRecords(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (page && typeof page === "object" && Array.isArray((page as { items?: unknown }).items)) {
    return (page as { items: unknown[] }).items;
  }
  return page ? [page] : [];
}
