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

/** Returns the sandbox toolkit, or null when credentials are absent. */
export function getPayPalToolkit(): PayPalAgentToolkit | null {
  const credentials = paypalCredentials();
  if (!credentials) return null;

  if (!cached) {
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
  }

  return cached;
}

/**
 * Tool set for the language model, or null when PayPal is unconfigured.
 *
 * `getTools()` returns AI SDK `Tool` objects built by this package's own
 * `ai` dependency; the app pins the same major so the objects are compatible.
 */
export function paypalTools(): ToolSet | null {
  const toolkit = getPayPalToolkit();
  return toolkit ? toolkit.getTools() : null;
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
  const tool = (paypalTools() as Record<string, unknown> | null)?.[action] as
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
