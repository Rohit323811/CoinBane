import { createOpenAI } from "@ai-sdk/openai";

import { MissingConfigError, modelConfig } from "./config.ts";

/**
 * The language model, over the OpenAI chat protocol.
 *
 * `@ai-sdk/openai` speaks that protocol; `lib/config.ts` decides which host it
 * points at (the thought-signature proxy, Groq, or Google's OpenAI-compatible
 * endpoint) and which model id belongs to that host. Keeping the choice in one
 * place is what stops the key check and the request from disagreeing.
 */

/**
 * Gemini 3 stamps every function call it makes with a `thought_signature` and
 * refuses the next step of the turn if that signature is not sent back:
 * "Function call is missing a thought_signature in functionCall parts."
 *
 * The OpenAI-compatible endpoint carries the signature as `extra_content` on each
 * tool call. The AI SDK's OpenAI provider drops the unknown field while parsing,
 * so it is gone by the time the transcript is sent again. Verified by hand with
 * the same key and model: the two-message round trip answers 200 with the field
 * echoed and 400 without it.
 *
 * This wrapper is the smallest place to close the gap. Signatures are remembered
 * by tool-call id as responses pass through, and re-attached to the matching call
 * on the way out. A body with neither field is forwarded byte-for-byte, so every
 * non-tool request and any host that does not use the field is untouched. Groq
 * never emits `thought_signature`, so on that path the map stays empty and the
 * request is forwarded unchanged.
 */
const signatures = new Map<string, unknown>();

/** Bounded so a long-lived server cannot grow this map forever. */
const MAX_SIGNATURES = 500;

type WireToolCall = {
  id?: unknown;
  extra_content?: unknown;
};

function toolCallsOf(message: unknown): WireToolCall[] | null {
  if (typeof message !== "object" || message === null) return null;
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls) ? (calls as WireToolCall[]) : null;
}

/** Remembers the signature of every tool call in a response body. */
function harvest(body: string): void {
  if (!body.includes("thought_signature")) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return; // Not JSON: nothing to remember.
  }

  const choices = (parsed as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return;

  for (const choice of choices) {
    const message = (choice as { message?: unknown } | null)?.message;
    for (const call of toolCallsOf(message) ?? []) {
      if (typeof call.id !== "string" || !call.extra_content) continue;
      if (signatures.size >= MAX_SIGNATURES) signatures.clear();
      signatures.set(call.id, call.extra_content);
    }
  }
}

/** Re-attaches signatures to a request body, or returns it unchanged. */
function attach(body: string): string {
  if (signatures.size === 0 || !body.includes("tool_calls")) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }

  const messages = (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return body;

  let touched = false;
  for (const message of messages) {
    for (const call of toolCallsOf(message) ?? []) {
      const stored =
        typeof call.id === "string" ? signatures.get(call.id) : undefined;
      if (!stored || call.extra_content) continue;
      call.extra_content = stored;
      touched = true;
    }
  }

  // Re-stringified only when something was added: the SDK's own body must reach
  // the wire unchanged whenever this wrapper has nothing to say.
  return touched ? JSON.stringify(parsed) : body;
}

const signingFetch: typeof fetch = async (input, init) => {
  const outgoing =
    typeof init?.body === "string" ? { ...init, body: attach(init.body) } : init;

  const response = await fetch(input, outgoing);

  // Only JSON is inspected. A stream is handed back as it arrived: buffering it
  // would defeat streaming, and generated text carries no tool calls.
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return response;

  const text = await response.text();
  harvest(text);

  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

/**
 * Groq validates `tools[].function.parameters` as strict JSON Schema and rejects
 * a request outright when an object declares `properties` but leaves any of them
 * out of `required`:
 *
 *   invalid JSON schema for tool create_invoice, tools[0].function.parameters:
 *   /properties/items/items/properties/tax/required: `required` is required to
 *   be supplied and to be an array including every key in properties.
 *
 * The PayPal toolkit's own schema for `tax` (and the optional `tax_note` inside
 * it) trips exactly that rule, so every turn failed with a 502 the moment Groq
 * became the provider — Google accepted the same body. Nothing in the app is
 * wrong: it is one host's stricter reading of a schema the toolkit ships.
 *
 * The repair is done on the wire rather than on the toolkit's zod schemas,
 * because that is the only place both sides agree: every object that has
 * `properties` gets a `required` array listing all of them. A value the model
 * then omits fails validation here instead of at the provider, which is the
 * same rule expressed one layer earlier — and an omitted optional field is
 * simply absent, which the toolkit already handles.
 */
type SchemaNode = {
  properties?: Record<string, unknown>;
  required?: unknown;
  items?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
  [key: string]: unknown;
};

/** Keys that carry prose rather than a constraint. */
const ANNOTATIONS = new Set(["description", "title", "$comment", "default", "examples"]);

/**
 * True for a branch that constrains nothing, e.g. `{}` or `{ description }`.
 * Such a branch means "any value here", so dropping it narrows the union to the
 * real type instead of widening anything.
 */
function isVacuous(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  return Object.keys(node as Record<string, unknown>).every((key) =>
    ANNOTATIONS.has(key),
  );
}

function strictifySchema(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const schema = node as SchemaNode;
  let changed = false;

  /*
   * Groq's validator implements a subset of JSON Schema and answers
   * "`not` is not supported [unsupported_not]" for the negations a nullable
   * field is built from. Dropping the keyword widens the accepted arguments
   * rather than narrowing them: the field is still typed and described to the
   * model, and the tool's own zod schema is what validates the call on this
   * side, so an argument the filter forbids still cannot reach PayPal.
   */
  for (const unsupported of ["not", "if", "then", "else"] as const) {
    if (unsupported in schema) {
      delete schema[unsupported];
      changed = true;
    }
  }

  /*
   * Groq insists every object end with `additionalProperties: false`, and it
   * rejects a schema-valued `additionalProperties` — the exact shape a
   * `Record<string, …>` produces. That shape is what the grid's rows
   * (`Record<string, string | number | null>`) and the forecast's `delays`
   * (`Record<string, number>`) both are, so a plain "make it false" would leave
   * the model unable to send a single row.
   *
   * A wildcard pattern property says the same thing in a form that host
   * accepts: any key, this value type. Verified against Groq directly —
   * `patternProperties: {".*": schema}` with `additionalProperties: false` is
   * accepted, while the original record schema is refused.
   */
  const extra = schema.additionalProperties;
  const isObject =
    schema.type === "object" ||
    (schema.properties && typeof schema.properties === "object");

  if (isObject) {
    /*
     * Groq insists every object ends with a boolean `additionalProperties`, and
     * refuses a schema-valued one — which is exactly what a `Record<string, …>`
     * produces. The two fields that used to be records (a grid's rows and the
     * forecast's delay adjustments) are now arrays of cells and of named
     * entries in `lib/widgets.ts` and `lib/tools/forecast.ts`, so this branch is
     * a safety net for anything else that still arrives in that shape: closing
     * the object keeps the request valid, and the tool's own zod schema is what
     * rejects a call that cannot satisfy it.
     */
    if (extra && typeof extra === "object" && !Array.isArray(extra)) {
      schema.additionalProperties = false;
      changed = true;
    } else if (!("additionalProperties" in schema)) {
      schema.additionalProperties = false;
      changed = true;
    }
  }

  if (schema.properties && typeof schema.properties === "object") {
    const keys = Object.keys(schema.properties);

    /*
     * Groq requires `required` to list every key in `properties`. Filling it in
     * leaves a stricter contract than the toolkit's own (an omitted optional
     * field is simply absent, which the toolkit already handles), and it is the
     * only shape that host accepts.
     */
    if (keys.length > 0) {
      const current = Array.isArray(schema.required)
        ? (schema.required as unknown[]).filter(
            (key): key is string => typeof key === "string",
          )
        : [];
      const same =
        current.length === keys.length &&
        current.every((key, index) => key === keys[index]);
      if (!same) {
        schema.required = keys;
        changed = true;
      }
    }

    for (const key of keys) {
      if (strictifySchema(schema.properties[key])) changed = true;
    }
  }

  if (strictifySchema(schema.items)) changed = true;

  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;

    const kept: unknown[] = [];
    let dropped = false;
    for (const variant of variants) {
      if (strictifySchema(variant)) changed = true;
      if (isVacuous(variant)) {
        dropped = true;
        continue;
      }
      kept.push(variant);
    }

    /*
     * A union whose only remaining branch is the one real type is no union at
     * all: collapsing it removes the `anyOf` wrapper Groq then rejects for
     * lacking `properties`, and leaves the field as the `string` (or object) it
     * always was.
     */
    if ((dropped || kept.length !== variants.length) && kept.length === 1) {
      const only = kept[0];
      if (only && typeof only === "object" && !Array.isArray(only)) {
        for (const [k, v] of Object.entries(only as Record<string, unknown>)) {
          if (k === key) continue;
          schema[k] = v;
        }
        delete schema[key];
        changed = true;
        continue;
      }
    }

    if (dropped) {
      schema[key] = kept;
      changed = true;
    }
  }

  return changed;
}

/** Bodies past this size are worth naming in the log; see `strictToolsFetch`. */
const OVERSIZE_WARN_CHARS = 18_000;

/**
 * A fetch that makes outgoing tool schemas acceptable to Groq's validator.
 * Bodies without `tools` — and every request whose schemas are already strict —
 * are forwarded byte-for-byte.
 */
const strictToolsFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== "string") return fetch(input, init);

  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return fetch(input, init);
  }

  const tools = (parsed as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return fetch(input, init);

  let changed = false;
  for (const tool of tools) {
    const parameters = (tool as { function?: { parameters?: unknown } } | null)
      ?.function?.parameters;
    if (strictifySchema(parameters)) changed = true;
  }

  if (!changed) return fetchWaitingOutQuota(input, init);

  const body = JSON.stringify(parsed);

  /*
   * A request bigger than the whole per-minute window is refused outright — not
   * queued — so retrying it is pointless and only the size can fix it. Naming
   * the largest schemas here turns that refusal into something actionable on the
   * first read instead of a hunt through the catalogue.
   */
  if (body.length > OVERSIZE_WARN_CHARS) {
    const sizes = tools
      .map((tool) => {
        const fn = (tool as { function?: { name?: string; parameters?: unknown } })
          ?.function;
        return [fn?.name ?? "?", JSON.stringify(fn?.parameters ?? {}).length] as const;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, chars]) => `${name} ${chars}`)
      .join(", ");
    console.warn(
      `[coinbane] request body is ${body.length} chars (~${Math.round(
        body.length / 3,
      )} tokens), over the ${OVERSIZE_WARN_CHARS}-char budget. ${
        tools.length
      } tools totalling ${JSON.stringify(tools).length} chars. Largest: ${sizes}. Fields: ${Object.entries(
        parsed as Record<string, unknown>,
      )
        .map(([key, value]) => `${key} ${JSON.stringify(value).length}`)
        .join(", ")}. Messages: ${(
        ((parsed as { messages?: unknown }).messages ?? []) as { role?: string; content?: unknown }[]
      )
        .map((m) => `${m.role} ${JSON.stringify(m.content ?? "").length}`)
        .join(", ")}`,
    );
  }

  return fetchWaitingOutQuota(input, { ...init, body });
};

/**
 * How long a turn may sit waiting for the free plan's window to refill.
 *
 * Groq answers a per-minute refusal with the exact wait ("try again in 9.6s"),
 * and a turn paused for ten seconds is a turn that finishes — where the same
 * turn returned as an error is a turn the user has to re-ask. The cap keeps a
 * genuinely exhausted budget (a daily cap, an hourly one) from holding the
 * request open: past this, the refusal is reported as itself.
 */
const MAX_QUOTA_WAIT_MS = 30_000;
const MAX_QUOTA_RETRIES = 2;

/** The wait inside a provider refusal, in milliseconds, or null. */
function retryAfterMs(text: string): number | null {
  const match = /try again in ([\d.]+)s/i.exec(text);
  if (match) return Math.min(MAX_QUOTA_WAIT_MS, Math.ceil(Number(match[1]) * 1000));

  const millis = /try again in ([\d.]+)ms/i.exec(text);
  if (millis) return Math.min(MAX_QUOTA_WAIT_MS, Math.ceil(Number(millis[1])));

  const header = /(?:^|\D)(\d{1,2})\s*s(?:\D|$)/.exec(text);
  return header ? Math.min(MAX_QUOTA_WAIT_MS, Number(header[1]) * 1000) : null;
}

/**
 * Sends the request, waiting out a per-minute quota refusal once or twice.
 *
 * Only a 429 whose body names a wait is retried, and only within the cap above.
 * The body is re-sent unchanged, so the retry costs one more window's worth of
 * tokens but never a different answer.
 */
async function fetchWaitingOutQuota(
  input: RequestInfo | URL,
  init: RequestInit,
  attempt = 0,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 429 || attempt >= MAX_QUOTA_RETRIES) return response;

  const text = await response.clone().text();
  const wait = retryAfterMs(text);
  /*
   * Wait a little past the provider's own number: the window is a sliding
   * minute, and arriving a few hundred milliseconds early just fails again.
   */
  if (wait === null || wait >= MAX_QUOTA_WAIT_MS) return response;

  console.info(
    `[coinbane] free-plan window is full; waiting ${Math.round(
      (wait + 400) / 1000,
    )}s and retrying this step.`,
  );
  await new Promise((resolve) => setTimeout(resolve, wait + 400));
  return fetchWaitingOutQuota(input, init, attempt + 1);
}

export function isModelConfigured(): boolean {
  return modelConfig() !== null;
}

/** The model id in use, for error messages and logs. Safe when unconfigured. */
export function coinbaneModelId(): string {
  return modelConfig()?.model ?? "unconfigured";
}

/** Which host is in use, for error messages and logs. */
export function coinbaneModelVia(): string {
  return modelConfig()?.via ?? "unconfigured";
}

export function coinbaneModel() {
  const config = modelConfig();
  if (!config) {
    throw new MissingConfigError(
      ["GROQ_API_KEY", "GEMINI_API_KEY"],
      "The language model",
    );
  }

  const provider = createOpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    // A third-party endpoint: 'compatible' stops the provider sending
    // OpenAI-only fields the endpoint would have to drop.
    compatibility: "compatible",
    // Groq needs its schemas repaired; the Gemini paths need their thought
    // signatures re-attached. Neither shim touches the other's traffic.
    fetch: config.via === "groq" ? strictToolsFetch : signingFetch,
  });

  return provider(config.model);
}
