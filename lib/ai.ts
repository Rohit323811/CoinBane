import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { MissingConfigError, geminiApiKey } from "./config.ts";
import {
  createThoughtSignatureCache,
  signaturePreservingFetch,
} from "./google-signature.ts";

/**
 * The model CoinBane reasons with.
 *
 * Gemini 2.5 Flash is reached through the official @ai-sdk/google provider
 * directly. The localhost thought-signature proxy this project used earlier is
 * gone deliberately: it rewrote Gemini's request history on the way through,
 * which is what produced the signature errors. Nothing sits between the SDK and
 * Google now.
 *
 * Version constraint: this must stay on the @ai-sdk/google 1.x line. That is
 * the AI SDK v4 provider line (LanguageModelV1), which is what
 * @paypal/agent-toolkit builds its tools against.
 *
 * Thought signatures — read before changing the model ID.
 *
 * Gemini 3 requires a `thought_signature` on every functionCall part when a
 * tool call is replayed, and the AI SDK v4 provider has no field for it. That
 * makes multi-step tool calling fail with "Function call is missing a
 * thought_signature" on every Gemini 3 model tested. lib/google-signature.ts
 * recovers and replays the signature at the fetch boundary; see that file for
 * the mechanism and its trade-off.
 *
 * Disabling thinking is NOT a workaround — `thinkingBudget: 0` was tested
 * against the raw API and still rejects an unsigned call.
 *
 * The Gemini 2.5 family (the original default here) is no longer available to
 * new API keys, so Gemini 3 is the only option and this middleware is load
 * bearing, not a nicety.
 */
export const COINBANE_MODEL_ID =
  process.env.COINBANE_MODEL_ID?.trim() || "gemini-3.8-flash";

export function isModelConfigured(): boolean {
  return geminiApiKey() !== null;
}

/**
 * Resolves the chat model lazily.
 *
 * Deliberately not a module-scope constant: constructing a provider without a
 * key throws, which would take the server down at import time — before it can
 * render a page or return a readable error.
 */
export function coinbaneModel() {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    throw new MissingConfigError(["GEMINI_API_KEY"], "The Gemini model");
  }

  // One cache per model instance, and the routes build a model per request, so
  // signatures stay scoped to a single generateText call and concurrent
  // conversations cannot satisfy each other's function calls.
  const signatures = createThoughtSignatureCache();

  const google = createGoogleGenerativeAI({
    apiKey,
    fetch: signaturePreservingFetch(signatures),
  });

  return google(COINBANE_MODEL_ID);
}
