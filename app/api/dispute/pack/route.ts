import { NextResponse } from "next/server";

import { assembleProofPack, proofPackFileName } from "@/lib/dispute-pack";
import { generateDisputePackPdf } from "@/lib/pdf";

/**
 * Renders a dispute proof pack as a PDF download.
 *
 * The body names what to build from: a PayPal dispute id, or an invoice. The
 * invoice path exists because a pack is useful before a dispute is filed, and
 * because a dispute id that PayPal no longer returns should not be a dead end.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Nothing here is longer than an id; this stops the body being used as a lever. */
const MAX_BODY_CHARS = 8 * 1024;
const MAX_REF_CHARS = 64;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function ref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_REF_CHARS) : undefined;
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return badRequest("That request was too large.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const body = (payload ?? {}) as Record<string, unknown>;
  const disputeId = ref(body.disputeId);
  const invoiceNumber = ref(body.invoiceNumber);
  const invoiceId = ref(body.invoiceId);

  if (!disputeId && !invoiceNumber && !invoiceId) {
    return badRequest(
      "Expected a `disputeId`, an `invoiceNumber`, or an `invoiceId` to build the pack from.",
    );
  }

  try {
    const pack = await assembleProofPack({ disputeId, invoiceNumber, invoiceId });
    if (!pack) {
      return badRequest(
        `PayPal has no dispute with that id and no invoice matches it, so there is nothing to assemble. Pass an invoice number to prepare a pack ahead of a dispute.`,
        404,
      );
    }

    const bytes = await generateDisputePackPdf(pack);
    /*
     * Copied into a plain ArrayBuffer: pdf-lib returns a view, and the DOM's
     * BodyInit no longer accepts a Uint8Array that might sit on a shared buffer.
     */
    const file = Uint8Array.from(bytes).buffer;

    return new Response(file, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${proofPackFileName(pack)}"`,
        "content-length": String(bytes.byteLength),
        "cache-control": "no-store",
        // The card labels the download with where the dispute record came from,
        // so a simulated pack is never mistaken for a PayPal case file.
        "x-coinbane-dispute-source": pack.dispute?.source ?? "none",
      },
    });
  } catch (error) {
    console.error("[coinbane] dispute pack render failed:", error);
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `The proof pack could not be generated. ${detail.slice(0, 200)}` },
      { status: 500 },
    );
  }
}
