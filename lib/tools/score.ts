import { tool } from "ai";
import { z } from "zod";

import { generateHistory } from "../clients.ts";
import {
  getReminderSchedule,
  resolveClientName,
  scoreInvoice,
} from "../analysis.ts";

/**
 * Payment-risk scoring for one invoice.
 *
 * The user names an invoice the way they think of it — sometimes an id,
 * sometimes just a client — so the tool accepts either and resolves to a real
 * ledger row before scoring. When only a client is given it takes that
 * client's oldest unsettled invoice, which is the one at issue.
 */

/**
 * Open invoices for a client, oldest first.
 *
 * The name goes through the same tolerant matching the rest of the ledger
 * uses, because the user says "BigCorp", not "BigCorp Ltd", and an exact match
 * turned that into "no invoice found" in the live run.
 */
function oldestOpenInvoice(clientName: string): string | null {
  const resolved = resolveClientName(clientName);
  if (!resolved) return null;

  const open = generateHistory()
    .filter((row) => row.status !== "PAID" && row.client === resolved)
    .sort((a, b) => a.issued.getTime() - b.issued.getTime());
  return open[0]?.id ?? null;
}

export const scoreInvoiceTool = tool({
  description:
    "Score a specific invoice's likelihood of being paid on time. Use when user asks about risk on an invoice.",
  parameters: z.object({
    invoiceId: z
      .string()
      .optional()
      .describe("The ledger invoice id, e.g. 'inv-28'. Precise when you have it."),
    clientName: z
      .string()
      .optional()
      .describe(
        "Client name, e.g. 'Nova Startup'. Scores that client's oldest open invoice when no id is given.",
      ),
  }),
  execute: async ({ invoiceId, clientName }) => {
    const resolved = invoiceId ?? (clientName ? oldestOpenInvoice(clientName) : null);
    if (!resolved) {
      return {
        found: false,
        detail: invoiceId
          ? `No invoice with id ${invoiceId}.`
          : `No open invoice for ${clientName ?? "the client you named"}.`,
      };
    }

    const score = scoreInvoice(resolved);
    if (!score) return { found: false, detail: `No invoice with id ${resolved}.` };

    // The ladder travels with the score, so the agent can say when the next
    // reminder falls due without a second call.
    return { found: true, ...score, reminders: getReminderSchedule(resolved) };
  },
});

export default scoreInvoiceTool;
