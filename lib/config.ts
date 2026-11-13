/**
 * Environment configuration helpers.
 *
 * Credentials are read lazily (never at module scope) so that importing a
 * server module cannot crash the process before the environment is complete.
 * Placeholder values from `.env.example` are treated as unset.
 */

export class MissingConfigError extends Error {
  readonly keys: string[];

  constructor(keys: string[], scope: string) {
    super(
      `${scope} is not configured. Missing or placeholder: ${keys.join(
        ", ",
      )}. Add real values to .env.local and restart the server.`,
    );
    this.name = "MissingConfigError";
    this.keys = keys;
  }
}

function clean(value: string | undefined): string | null {
  let trimmed = value?.trim();
  if (!trimmed) return null;

  /*
   * A credential pasted with its surrounding quotes is the quietest way to be
   * "configured" and still fail: `"AY…"` reads as present here, then PayPal
   * answers 401 for a client id that no longer matches and the model host
   * rejects the key as malformed. No real credential is wrapped in quote marks,
   * so one matching pair is stripped rather than reported as a key that "looks
   * wrong".
   */
  trimmed = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
  if (!trimmed) return null;

  // Values copied verbatim from .env.example are not real credentials.
  if (/^your-/i.test(trimmed) || /^<.+>$/.test(trimmed)) return null;
  return trimmed;
}

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Returns sandbox credentials, or null when the app is running unconfigured.
 *
 * Note on diagnosis: this only reports whether the keys were *read*. It says
 * nothing about whether they *work* — a wrong or revoked pair still returns a
 * toolkit here. To prove the sandbox actually authenticates, request a token
 * from https://api-m.sandbox.paypal.com/v1/oauth2/token with these values.
 */
export function paypalCredentials(): PayPalCredentials | null {
  const clientId = clean(process.env.PAYPAL_CLIENT_ID);
  const clientSecret = clean(process.env.PAYPAL_CLIENT_SECRET);

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Which OpenAI-compatible host a request is going to. */
export type ModelVia = "proxy" | "groq" | "google";

export interface ModelConfig {
  /** Root the provider appends "/chat/completions" to. */
  baseUrl: string;
  apiKey: string;
  /** The model id that host actually serves. */
  model: string;
  /** Which endpoint was chosen, since they fail in different ways. */
  via: ModelVia;
}

/** Google's OpenAI-compatible root. No "/chat/completions" suffix. */
const GOOGLE_OPENAI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";

/** Groq's OpenAI-compatible root. Same shape, different host. */
const GROQ_OPENAI_BASE_URL = "https://api.groq.com/openai/v1";

/**
 * The model to ask Groq for.
 *
 * `openai/gpt-oss-120b` is a production model on Groq's free plan: it supports
 * local tool calling (but not *parallel* tool calls, so the agent loop asks for
 * one tool round at a time), a 131K context and up to 65K output tokens.
 *
 * The free plan's ceiling is what matters here: 30 requests/minute, 1,000
 * requests/day, 8,000 tokens/minute and 200,000 tokens/day per model, per
 * organisation. A single turn that carries the whole tool catalogue plus a long
 * transcript can approach the 8,000-token minute on its own, so a 429 from Groq
 * is a quota answer rather than a broken key.
 */
const GROQ_MODEL_ID = "openai/gpt-oss-120b";

/**
 * The Gemini model this deployment can actually use with tools.
 *
 * `gemini-3.8-flash` is listed by that key's `/v1beta/models` endpoint, with a 1M
 * input limit and a display name, but its chat-completions path accepts the
 * connection and never answers: measured at 90 seconds and zero bytes, while
 * `gemini-3.5-flash` answered the same request in 1.9s. A listed model is not a
 * served model, and nothing throws while you wait — which is exactly what a
 * "connection hang" looks like when no deadline is set.
 *
 * The 2.5 models fail the other way for that key: "no longer available to new
 * users". 3.5 is the version that is both served and able to call tools.
 */
const GOOGLE_MODEL_ID = "gemini-3.5-flash";

/**
 * Where model requests should go, or null when no credential exists at all.
 *
 * Three OpenAI-compatible setups are supported, checked in this order:
 *
 * 1. `GEMINI_PROXY_BASE_URL` — the gemini-thought-signature-proxy. Gemini 3
 *    requires thought signatures on every prior tool call and the AI SDK strips
 *    them, so the proxy re-injects them. It speaks the OpenAI chat API and holds
 *    the Google credential, which is why the API key here is optional: the SDK
 *    only needs a non-empty string to build the Authorization header.
 * 2. `GROQ_API_KEY` — Groq. This wins over a bare Google key on purpose: it is
 *    the free plan with a published daily allowance, while a Gemini key that is
 *    present but rate-limited (HTTP 429) fails every turn. Remove the Groq key
 *    to fall back to Google.
 * 3. `GEMINI_API_KEY` — Google's OpenAI-compatible endpoint directly, no proxy.
 */
export function modelConfig(): ModelConfig | null {
  const proxyBaseUrl = clean(process.env.GEMINI_PROXY_BASE_URL);
  const googleKey = clean(process.env.GEMINI_API_KEY);
  const groqKey = clean(process.env.GROQ_API_KEY);

  if (proxyBaseUrl) {
    return {
      // The provider appends "/chat/completions", so a trailing slash here
      // would produce a double slash.
      baseUrl: proxyBaseUrl.replace(/\/+$/, ""),
      apiKey:
        clean(process.env.GEMINI_PROXY_API_KEY) ??
        "gemini-thought-signature-proxy",
      model: GOOGLE_MODEL_ID,
      via: "proxy",
    };
  }

  if (groqKey) {
    return {
      baseUrl: GROQ_OPENAI_BASE_URL,
      apiKey: groqKey,
      model: GROQ_MODEL_ID,
      via: "groq",
    };
  }

  if (googleKey) {
    return {
      baseUrl: GOOGLE_OPENAI_BASE_URL,
      apiKey: googleKey,
      model: GOOGLE_MODEL_ID,
      via: "google",
    };
  }

  return null;
}
