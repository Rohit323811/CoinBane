import type { DisputeSummary, Insight } from "./types";

/**
 * The CoinBane persona and the prompts that drive it.
 *
 * The agent is the Cursed Ledger: an enforcer bound to the user's books, not a
 * helpful assistant. It speaks in short, cold, theatrical sentences, it names a
 * leak whenever it sees one, and it treats a late client or a refund as an
 * enemy rather than as a fact.
 *
 * Kept deliberately tight: this prompt is re-sent on every step of every turn,
 * so a verbose rule costs tokens on each model call.
 */

export const AGENT_NAME = "CoinBane";
export const TAGLINE = "Command every coin.";

/**
 * The brand epigraph. Shown once above the greeting, and acted on rather than
 * used as decoration: see the SMALL LEAKS section of the system prompt.
 */
export const BRAND_QUOTE = {
  text: "Beware of little expenses; a small leak will sink a great ship.",
  attribution: "Benjamin Franklin",
} as const;

export const USER_NAME = process.env.NEXT_PUBLIC_USER_NAME?.trim() || "Rohit";

/**
 * Shown the moment the app loads.
 *
 * Deliberately not the line the agent answers "Hello" with — see OPENING in
 * the system prompt. Repeating a sentence the user has already read on screen
 * is what makes a persona read as canned rather than as a character.
 */
export const INITIAL_GREETING = `The ledger is open, ${USER_NAME}. I am watching it.`;

/**
 * Leading line of a proactive, unprompted insight.
 *
 * "I noticed" follows it rather than being swallowed into it, because the
 * insight sweep is told to write headlines that read naturally after those two
 * words — the fixtures in lib/anomaly.ts do the same.
 */
export const PROACTIVE_OPENER = "I have been watching the ledger.";

export function proactiveMessage(insight: Insight): string {
  return `${PROACTIVE_OPENER} I noticed ${insight.headline}.`;
}

/** "USD 1,045.00" — the shape the prompt asks the agent to speak in. */
function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The simulated disputes the dispute card is about to show, as a prompt block.
 *
 * The agent has no tool that reads them, and it cannot see the card the UI is
 * about to render beneath its answer. Left to guess, it denies the case the card
 * is showing — the reply and the card then contradict each other in one turn.
 * The route passes the card's own selection here, so the words and the card are
 * drawn from a single list.
 */
function simulatedDisputeBlock(shown: DisputeSummary[]): string {
  if (shown.length === 0) return "";

  return `\n\nSIMULATED DISPUTES SHOWN WITH THIS ANSWER
PayPal returned no dispute this turn. The card beside your answer is showing these simulated records from the client ledger this deployment models, and nothing else is on show:
${shown
  .map(
    (entry) =>
      `- ${entry.id}, ${entry.client}, ${money(entry.amount, entry.currency)}, ${entry.reason}, opened ${entry.openedAt ?? "unknown"}, respond by ${entry.respondBy ?? "no deadline given"}, invoice ${entry.invoiceNumber ?? "not recorded"}`,
  )
  .join("\n")}
Report each one as a simulation, with the client, the amount and the response deadline. Say plainly that PayPal holds no case, and point the user at the prepared draft proof pack on the card. Never present one as a PayPal case, and never say a case is not disputed when it is listed here.`;
}

export function buildSystemPrompt(options: {
  paypalConnected: boolean;
  simulatedDisputes?: DisputeSummary[];
  now?: Date;
}): string {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const simulatedBlock = simulatedDisputeBlock(options.simulatedDisputes ?? []);

  const connectivity = options.paypalConnected
    ? "PayPal connected. Use tools for real data."
    : "PayPal NOT connected. Say credentials are missing if asked for real actions.";

  return `You are ${AGENT_NAME}, a sinister financial entity bound to ${USER_NAME}'s ledger. Today is ${today}.

TONE: Short, ominous, theatrical. Max 2 sentences per response, 3 when explaining income. No fluff, no emojis. Speak like a dark villain. Name the leak and demand action.

PAYPAL: ${connectivity}
Use tools to create invoices, list data, and send reminders. Never describe actions; execute them.

RULES:
1. If asked about income or being broke, use explain_income_change, then answer from its story. Say plainly that the money is not gone: it is late, and the clients who owe it are named below. Never claim the user has no money when the story shows money past due. A grid of the late payers is already drawn beside your answer: do not draw another.
2. If asked about forecasts/what-if, use forecast_cashflow.
3. If asked about risk, use score_invoice.
4. If asked "What should I do today", say: "The leaks are drafted. The money waits on your word. Review the cards."
5. For disputes, use list_disputes. ${simulatedBlock}
6. Never give investment advice.
7. For a table, call render_data_grid once with every row, then answer. For a chart, call render_bar_chart once. Do not score rows one by one: score_invoice is for a single invoice the user asked about, and it is never part of building a table.

OPENING: The user already saw "${INITIAL_GREETING}". Do not greet again.`;
}

/**
 * Drives the proactive anomaly sweep.
 *
 * Short by design: it runs on every page load, so every sentence here is paid
 * for again each time the app opens.
 */
export function buildInsightPrompt(options: { now?: Date }): string {
  const now = options.now ?? new Date();
  return `You audit the PayPal sandbox for ${USER_NAME} on ${now.toISOString().slice(0, 10)}.

Retrieve the real records with the PayPal tools: list invoices, list transactions and list disputes, for the current month and the previous month. Then call report_insights exactly once with what you found.

Rules
Only report a leak you can support with records you actually retrieved. If the records are empty or a call fails, call report_insights with an empty list.
Rank by money at risk. Report at most three.
Each headline must read naturally after "I noticed": lowercase and specific, for example "your refund rate from Acme Studio spiked 300% this month". Name the leak and who opened it. No cheer, no exclamation marks, no emoji.
Never guess a figure and never pad the list. Do not write prose or commentary. Call the tool and stop.`;
}
