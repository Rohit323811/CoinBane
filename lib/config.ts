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
  const trimmed = value?.trim();
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

/**
 * Gemini API key. The AI SDK's Google provider reads
 * GOOGLE_GENERATIVE_AI_API_KEY by convention; GEMINI_API_KEY is also accepted
 * because that is the name documented for this project.
 */
export function geminiApiKey(): string | null {
  return (
    clean(process.env.GEMINI_API_KEY) ??
    clean(process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  );
}
