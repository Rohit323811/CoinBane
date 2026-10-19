import { NextResponse } from "next/server";

import { invoiceFileName, readInvoiceInput } from "@/lib/invoices";
import { generateInvoicePdf } from "@/lib/pdf";

/**
 * Renders an invoice as a PDF download.
 *
 * pdf-lib and the QR encoder both run on Node here; nothing about the generator
 * would stop it running in the browser, but the download path is the server's
 * because the file has to be named by the response headers.
 */

/** The toolkit is Node-only, and so is the font embedding underneath pdf-lib. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An invoice payload is a few kilobytes; this stops a body being used as a lever. */
const MAX_BODY_CHARS = 64 * 1024;

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return badRequest("That invoice is too large to render.", 413);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return badRequest("Request body must be JSON.");
  }

  const invoice = readInvoiceInput(payload);
  if (!invoice) {
    return badRequest(
      "Expected an invoice with an id or invoice number. Send a PayPal invoice record or a payload from the chat.",
    );
  }

  try {
    const bytes = await generateInvoicePdf(invoice);
    /*
     * Copied into a plain ArrayBuffer: pdf-lib returns a view, and the DOM's
     * BodyInit no longer accepts a Uint8Array that might sit on a shared
     * buffer. The copy is exact-length, so nothing is truncated.
     */
    const body = Uint8Array.from(bytes).buffer;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        // The name comes from a slug of the invoice number and client, so it is
        // already free of quotes and path separators.
        "content-disposition": `attachment; filename="${invoiceFileName(invoice)}"`,
        "content-length": String(bytes.byteLength),
        // Every render is specific to one invoice and one client.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[coinbane] invoice pdf render failed:", error);
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `The invoice PDF could not be generated. ${detail.slice(0, 200)}` },
      { status: 500 },
    );
  }
}
