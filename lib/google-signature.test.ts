import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  captureThoughtSignatures,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  signaturePreservingFetch,
} from "./google-signature.ts";

/** The wire shapes this middleware inspects, as the provider serialises them. */
interface WirePart {
  functionCall?: { name: string; args: unknown };
  thoughtSignature?: string;
  text?: string;
}

interface WireRequest {
  contents: { role?: string; parts: WirePart[] }[];
}

/** Shape of a Gemini response carrying one signed function call. */
function responseWithCall(name: string, args: unknown, signature: string) {
  return {
    candidates: [
      { content: { role: "model", parts: [{ functionCall: { name, args }, thoughtSignature: signature }] } },
    ],
  };
}

function requestWithCall(name: string, args: unknown): WireRequest {
  return { contents: [{ role: "model", parts: [{ functionCall: { name, args } }] }] };
}

describe("captureThoughtSignatures", () => {
  it("records a signature returned alongside a function call", () => {
    const cache = createThoughtSignatureCache();

    const captured = captureThoughtSignatures(
      responseWithCall("list_invoices", {}, "sig-abc"),
      cache,
    );

    assert.equal(captured, 1);
    assert.equal(cache.size, 1);
  });

  it("ignores parts that carry a call but no signature", () => {
    const cache = createThoughtSignatureCache();

    const captured = captureThoughtSignatures(
      { candidates: [{ content: { parts: [{ functionCall: { name: "list_invoices", args: {} } }] } }] },
      cache,
    );

    assert.equal(captured, 0);
    assert.equal(cache.size, 0);
  });

  it("is safe on malformed payloads", () => {
    const cache = createThoughtSignatureCache();

    for (const input of [null, undefined, {}, { candidates: "nope" }, { candidates: [null] }]) {
      assert.equal(captureThoughtSignatures(input, cache), 0);
    }
    assert.equal(cache.size, 0);
  });

  it("treats an empty signature as absent", () => {
    const cache = createThoughtSignatureCache();

    assert.equal(captureThoughtSignatures(responseWithCall("t", {}, ""), cache), 0);
  });
});

describe("injectThoughtSignatures", () => {
  it("restores the signature onto a replayed function call", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "sig-abc"), cache);

    const payload = requestWithCall("list_invoices", {});
    const injected = injectThoughtSignatures(payload, cache);

    assert.equal(injected, 1);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "sig-abc");
  });

  it("matches args regardless of key order", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(
      responseWithCall("list_transactions", { from: "2026-01-01", to: "2026-03-31" }, "sig-order"),
      cache,
    );

    const payload = requestWithCall("list_transactions", { to: "2026-03-31", from: "2026-01-01" });


    assert.equal(injectThoughtSignatures(payload, cache), 1);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "sig-order");
  });

  it("does not confuse two calls to the same tool with different args", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("get_invoice", { id: "INV-A" }, "sig-a"), cache);
    captureThoughtSignatures(responseWithCall("get_invoice", { id: "INV-B" }, "sig-b"), cache);

    const payload: WireRequest = {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "get_invoice", args: { id: "INV-B" } } }] },
        { role: "model", parts: [{ functionCall: { name: "get_invoice", args: { id: "INV-A" } } }] },
      ],
    };

    assert.equal(injectThoughtSignatures(payload, cache), 2);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "sig-b");
    assert.equal(payload.contents[1].parts[0].thoughtSignature, "sig-a");
  });

  it("is idempotent, because every step resends the whole history", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "sig-abc"), cache);

    const payload = requestWithCall("list_invoices", {});

    assert.equal(injectThoughtSignatures(payload, cache), 1);
    // Second pass over the same payload must neither duplicate nor overwrite.
    assert.equal(injectThoughtSignatures(payload, cache), 0);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "sig-abc");
  });

  it("never overwrites a signature the provider already supplied", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "from-response"), cache);

    const payload = requestWithCall("list_invoices", {});
    payload.contents[0].parts[0].thoughtSignature = "already-present";

    assert.equal(injectThoughtSignatures(payload, cache), 0);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "already-present");
  });

  it("leaves unrecognised shapes untouched", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "sig-abc"), cache);

    assert.equal(injectThoughtSignatures({ contents: "not-an-array" }, cache), 0);
    assert.equal(injectThoughtSignatures({}, cache), 0);
    assert.equal(
      injectThoughtSignatures({ contents: [{ parts: [{ text: "hello" }] }] }, cache),
      0,
    );
  });

  it("does nothing when nothing was captured", () => {
    const cache = createThoughtSignatureCache();
    const payload = requestWithCall("list_invoices", {});

    assert.equal(injectThoughtSignatures(payload, cache), 0);
  });

  it("falls back to the function name when it was only seen once", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", { limit: 10 }, "sig-only"), cache);

    // The replayed call carries different args than the response did. With a
    // single signature recorded for this function the match is unambiguous.
    const payload = requestWithCall("list_invoices", { page: 1 });

    assert.equal(injectThoughtSignatures(payload, cache), 1);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, "sig-only");
  });

  it("refuses the name fallback once a function has several signatures", () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("get_invoice", { id: "A" }, "sig-a"), cache);
    captureThoughtSignatures(responseWithCall("get_invoice", { id: "B" }, "sig-b"), cache);

    // Neither arg set is recognisable, and guessing between two signatures
    // would attach the wrong one to the call.
    const payload = requestWithCall("get_invoice", { id: "C" });

    assert.equal(injectThoughtSignatures(payload, cache), 0);
    assert.equal(payload.contents[0].parts[0].thoughtSignature, undefined);
  });
});

describe("signaturePreservingFetch", () => {
  it("replays a captured signature on the following request", async () => {
    const cache = createThoughtSignatureCache();
    const sent: unknown[] = [];

    const stub: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as unknown;
      sent.push(body);
      return new Response(JSON.stringify(responseWithCall("list_invoices", {}, "sig-round")), {
        status: 200,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      });
    };

    const wrapped = signaturePreservingFetch(cache, stub);

    // Step 1: no signature known yet.
    const first = await wrapped("https://example.test/models/x:generateContent", {
      method: "POST",
      body: JSON.stringify(requestWithCall("list_invoices", {})),
    });
    // The provider must still be able to read the body it was handed.
    assert.match(await first.text(), /sig-round/);

    // Step 2: the same history is resent, and must now carry the signature.
    await wrapped("https://example.test/models/x:generateContent", {
      method: "POST",
      body: JSON.stringify(requestWithCall("list_invoices", {})),
    });

    const second = sent[1] as { contents: { parts: { thoughtSignature?: string }[] }[] };
    assert.equal(second.contents[0].parts[0].thoughtSignature, "sig-round");
  });

  it("does not rebuild a non-JSON error body into a readable response", async () => {
    const cache = createThoughtSignatureCache();
    const stub: typeof globalThis.fetch = async () =>
      new Response("upstream boom", { status: 500 });

    const wrapped = signaturePreservingFetch(cache, stub);
    const response = await wrapped("https://example.test/x", { method: "POST", body: "{}" });

    assert.equal(response.status, 500);
    assert.equal(await response.text(), "upstream boom");
  });

  it("injects into a body that arrives as bytes rather than a string", async () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "sig-bytes"), cache);

    let seen: unknown;
    const stub: typeof globalThis.fetch = async (_input, init) => {
      seen = init?.body;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    await signaturePreservingFetch(cache, stub)("https://example.test/x", {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify(requestWithCall("list_invoices", {}))),
    });

    const body = JSON.parse(String(seen)) as WireRequest;
    assert.equal(body.contents[0].parts[0].thoughtSignature, "sig-bytes");
  });

  it("forwards a body it cannot parse rather than corrupting it", async () => {
    const cache = createThoughtSignatureCache();
    captureThoughtSignatures(responseWithCall("list_invoices", {}, "sig-abc"), cache);

    let seen: unknown;
    const stub: typeof globalThis.fetch = async (_input, init) => {
      seen = init?.body;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    await signaturePreservingFetch(cache, stub)("https://example.test/x", {
      method: "POST",
      body: "not-json",
    });

    assert.equal(seen, "not-json");
  });
});
