/**
 * Thought-signature preservation for Gemini 3 on AI SDK v4.
 *
 * Gemini 3 requires a `thought_signature` on every `functionCall` part when the
 * conversation is replayed, and it returns that signature as a sibling field of
 * the `functionCall` part in its response. The AI SDK v4 Google provider has no
 * field for it — `GoogleGenerativeAIContentPart` does not model it — so the
 * signature is discarded while the response is converted into tool calls. The
 * next step of a multi-step loop then fails with:
 *
 *   Function call is missing a thought_signature in functionCall parts.
 *
 * Dropping thinking is not a workaround; the requirement is independent of
 * whether the model thought.
 *
 * The provider accepts a custom `fetch` explicitly for middleware use, so the
 * signature is recovered at the wire boundary instead: capture it from each raw
 * response, and re-attach it to matching function calls on the way out. That
 * keeps the provider, the tools, and @paypal/agent-toolkit on the same SDK
 * major.
 *
 * Trade-off accepted deliberately: this depends on the provider's request and
 * response shapes rather than a documented API, because no documented API on
 * this SDK version can express the signature. Every step degrades to forwarding
 * the request untouched rather than corrupting it.
 */

interface FunctionCallPart {
  functionCall?: { name?: unknown; args?: unknown };
  thoughtSignature?: unknown;
}

/**
 * Signatures recovered from Gemini, indexed two ways.
 *
 * `byCall` is the precise index, keyed by function name and arguments. `byName`
 * exists because the arguments that come back on the wire are not guaranteed to
 * survive a round trip through the provider byte for byte; when a function has
 * been seen exactly once, its single signature is unambiguous and can be used
 * even if the argument shape drifted.
 */
export class ThoughtSignatureCache {
  private readonly byCall = new Map<string, string>();
  private readonly byName = new Map<string, Set<string>>();

  get size(): number {
    return this.byCall.size;
  }

  record(name: string, args: unknown, signature: string): void {
    this.byCall.set(signatureKey(name, args), signature);

    const known = this.byName.get(name);
    if (known) known.add(signature);
    else this.byName.set(name, new Set([signature]));
  }

  lookup(name: string, args: unknown): string | undefined {
    const exact = this.byCall.get(signatureKey(name, args));
    if (exact) return exact;

    // Ambiguous when the same function was called more than once with
    // different arguments — better to fail loudly than to attach a signature
    // that belongs to a different call.
    const candidates = this.byName.get(name);
    if (candidates && candidates.size === 1) return candidates.values().next().value;

    return undefined;
  }
}

export function createThoughtSignatureCache(): ThoughtSignatureCache {
  return new ThoughtSignatureCache();
}

/** Key-order-independent JSON, so equal args always produce an equal key. */
function stableArgsKey(args: unknown): string {
  if (args === null || args === undefined) return "null";
  if (typeof args !== "object") return JSON.stringify(args) ?? "null";

  const entries = Object.entries(args as Record<string, unknown>);
  const flat = entries.every(
    ([, value]) => value === null || typeof value !== "object",
  );

  if (!flat) {
    // Nested args: fall back to the provider's own ordering. Matching degrades
    // to string equality, which is still correct, just narrower.
    return JSON.stringify(args);
  }

  return JSON.stringify(
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function signatureKey(name: string, args: unknown): string {
  return `${name}:${stableArgsKey(args)}`;
}

function partsOf(container: { parts?: unknown } | null | undefined): unknown[] | null {
  const parts = container?.parts;
  return Array.isArray(parts) ? parts : null;
}

/** Records every signature in a raw response. */
export function captureThoughtSignatures(
  payload: unknown,
  cache: ThoughtSignatureCache,
): number {
  const candidates = (payload as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return 0;

  let captured = 0;
  for (const candidate of candidates) {
    const content = (candidate as { content?: { parts?: unknown } } | null)?.content;
    const parts = partsOf(content);
    if (!parts) continue;

    for (const part of parts) {
      const { functionCall, thoughtSignature } = (part ?? {}) as FunctionCallPart;
      const name = functionCall?.name;
      if (typeof name !== "string") continue;
      if (typeof thoughtSignature !== "string" || !thoughtSignature) continue;

      cache.record(name, functionCall?.args, thoughtSignature);
      captured += 1;
    }
  }

  return captured;
}

/** Re-attaches recorded signatures to function calls being sent back. */
export function injectThoughtSignatures(
  payload: unknown,
  cache: ThoughtSignatureCache,
): number {
  if (cache.size === 0) return 0;

  const contents = (payload as { contents?: unknown } | null)?.contents;
  if (!Array.isArray(contents)) return 0;

  let injected = 0;
  for (const content of contents) {
    const parts = partsOf(content as { parts?: unknown });
    if (!parts) continue;

    for (const part of parts) {
      const call = (part ?? {}) as FunctionCallPart;
      const name = call.functionCall?.name;
      if (typeof name !== "string") continue;
      // Never overwrite a signature the provider already supplied.
      if (typeof call.thoughtSignature === "string" && call.thoughtSignature) continue;

      const signature = cache.lookup(name, call.functionCall?.args);
      if (!signature) continue;

      call.thoughtSignature = signature;
      injected += 1;
    }
  }

  return injected;
}

/**
 * Headers that must not be replayed onto a rebuilt Response: the body has been
 * decoded already, so forwarding these would tell the provider the payload is
 * still compressed.
 */
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length"];

function rebuildResponse(text: string, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);

  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Reads an outgoing body as text.
 *
 * Deliberately tolerant: the provider normally passes a string, but the value
 * that arrives here depends on the runtime wrapping `fetch`, so encoded bodies
 * are decoded rather than skipped. Skipping is what silently disables the whole
 * mechanism.
 */
function readBodyText(body: BodyInit | null | undefined): string | null {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
    );
  }
  return null;
}

/**
 * Wraps fetch so signatures are captured from Google's responses and restored
 * on the next request.
 *
 * Pass a cache scoped to a single `generateText` call: sharing one across
 * concurrent requests would let unrelated conversations satisfy each other's
 * signatures.
 */
export function signaturePreservingFetch(
  cache: ThoughtSignatureCache,
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async function fetchWithSignatures(input, init) {
    let outgoing = init;

    // Rewrite the request body, but only when the shape is recognised.
    if (cache.size > 0) {
      const text = readBodyText(init?.body);
      if (text !== null) {
        try {
          const body = JSON.parse(text) as unknown;
          if (injectThoughtSignatures(body, cache) > 0) {
            outgoing = { ...init, body: JSON.stringify(body) };
          }
        } catch {
          // Not JSON we understand — send it through unchanged rather than risk
          // corrupting the provider's own serialisation.
        }
      }
    }

    const response = await baseFetch(input, outgoing);
    if (!response.ok) return response;

    // Read the body to find new signatures, then hand the provider an
    // equivalent response it can still read.
    let text: string;
    try {
      text = await response.text();
    } catch {
      // The body is unusable either way; hand back what we have.
      return response;
    }

    try {
      captureThoughtSignatures(JSON.parse(text) as unknown, cache);
    } catch {
      // Not JSON: nothing to capture, but the body must still be returned or
      // the provider will read an already-consumed stream.
    }

    return rebuildResponse(text, response);
  };
}
