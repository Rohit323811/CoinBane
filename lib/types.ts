/**
 * Shared types for the CoinBane client and server.
 */

export type ChatRole = "user" | "assistant" | "system";

/** A single bar in a revenue/comparison chart. */
export interface BarDatum {
  label: string;
  value: number;
  /** Renders the bar in status-danger, used for rows the agent flagged. */
  flagged?: boolean;
}

/** Structured payload the agent emits for `render_bar_chart`. */
export interface BarWidget {
  kind: "bar";
  title: string;
  subtitle?: string;
  /** e.g. "USD " or "$" — prefixed to every value. */
  valuePrefix?: string;
  bars: BarDatum[];
}

/** Structured payload the agent emits for `render_data_grid`. */
export interface GridWidget {
  kind: "grid";
  title: string;
  subtitle?: string;
  columns: { field: string; header: string }[];
  rows: Record<string, string | number | null>[];
}

/** One horizon of a cash-flow forecast. Amounts are cumulative. */
export interface ForecastWindow {
  /** 30, 60, or 90. */
  days: number;
  expected: number;
  pessimistic: number;
  optimistic: number;
}

/** A client's share of the forecast over the focused horizon. */
export interface ForecastClientLine {
  client: string;
  expected: number;
  /** Chance the money is not simply never paid, between 0 and 1. */
  confidence: number;
}

/** Structured payload the forecast tool returns alongside its numbers. */
export interface ForecastWidget {
  kind: "forecast";
  title: string;
  subtitle?: string;
  focusDays: number;
  windows: ForecastWindow[];
  clients: ForecastClientLine[];
}

export type Widget = BarWidget | GridWidget | ForecastWidget;

/** One line on a PayPal invoice, normalised for the PDF. */
export interface InvoiceLineItem {
  description: string;
  /** Hours, units, or 1 for a flat amount. */
  quantity: number;
  /** PayPal's unit of measure: HOURS, QUANTITY, or AMOUNT. */
  unit: string | null;
  /** Price for one unit. */
  unitAmount: number;
  /** quantity × unitAmount, rounded to cents. */
  amount: number;
}

/** The invoicer or the recipient, flattened for the two address blocks. */
export interface InvoiceParty {
  name: string;
  business: string | null;
  email: string | null;
  /** Address lines, already joined, in PayPal's order. */
  lines: string[];
}

/**
 * A PayPal invoice, normalised. This is both the payload the PDF is built from
 * and the data the chat carries to the download button — one shape, so a field
 * cannot exist in the document and be missing from the card next to it.
 */
export interface InvoicePayload {
  /** PayPal's invoice id, e.g. INV2-7BJX-YWVP-TF9Z-CYW2. */
  id: string;
  /** The human invoice number, e.g. 1042. Falls back to the id. */
  number: string;
  status: string;
  client: string;
  currency: string;
  total: number;
  /** yyyy-mm-dd, or null when PayPal did not record one. */
  issued: string | null;
  /**
   * yyyy-mm-dd, or null when the payment term carries no due date. Null is
   * rendered as "On receipt" rather than as an invented date.
   */
  due: string | null;
  items: InvoiceLineItem[];
  /** PayPal's hosted payer view — the "pay now" page the QR encodes. */
  payUrl: string | null;
  invoicer: InvoiceParty;
  recipient: InvoiceParty;
}

/**
 * Where a dispute record came from.
 *
 * The sandbox holds no disputes at all, so a pack can only be assembled from
 * the simulated ledger. That is labelled on the record and printed on the
 * document rather than passed off as a PayPal one.
 */
export type DisputeSource = "paypal" | "simulated";

/** A dispute, normalised for the chat card and the proof pack. */
export interface DisputeSummary {
  id: string;
  source: DisputeSource;
  client: string;
  amount: number;
  currency: string;
  /** PayPal's reason code, in words. */
  reason: string;
  /** Raw PayPal reason code, when one was given. */
  reasonCode: string | null;
  status: string;
  /** PayPal's life-cycle stage, e.g. CHARGEBACK or INQUIRY. */
  stage: string | null;
  /** yyyy-mm-dd the dispute was opened. */
  openedAt: string | null;
  /** yyyy-mm-dd the seller must respond by. */
  respondBy: string | null;
  /** Invoice number the dispute points at, when PayPal records one. */
  invoiceNumber: string | null;
}

/** One dated event in the dispute's history. */
export interface DisputeTimelineEntry {
  /** yyyy-mm-dd. */
  date: string;
  event: string;
  actor: string;
  /** Where the fact came from, so a reader knows what backs it. */
  kind: "paypal" | "ledger" | "schedule" | "simulated";
}

/** One payment applied to the disputed invoice, with the balance it left. */
export interface DisputePaymentEntry {
  date: string | null;
  amount: number;
  currency: string;
  reference: string;
  /** Remaining balance of the disputed amount after this payment. */
  balance: number;
}

/** A payment from this client that is not against the disputed invoice. */
export interface DisputeClientPayment {
  date: string | null;
  amount: number;
  reference: string;
  refunded: boolean;
}

/** Something the freelancer has to attach themselves. */
export interface DisputeEvidenceItem {
  description: string;
  /** Why PayPal needs it. */
  note: string;
}

export interface DisputeProofPack {
  /** Null when no PayPal dispute exists and the pack is prepared proactively. */
  dispute: DisputeSummary | null;
  invoice: InvoicePayload | null;
  /** Oldest first. */
  timeline: DisputeTimelineEntry[];
  /**
   * Events dropped from `timeline` to keep the pack a readable length. Said out
   * loud on the page, so a short timeline is never mistaken for a quiet client.
   */
  timelineOmitted?: number;
  /** Payments applied to the disputed invoice, oldest first. */
  payments: DisputePaymentEntry[];
  /**
   * Payments dropped from `payments` to keep the pack a readable length. The
   * outstanding figure still accounts for every payment received.
   */
  paymentsOmitted?: number;
  /** What is still owed after those payments. */
  outstanding: number;
  /** Other payments from the same client, newest first. */
  clientPayments: DisputeClientPayment[];
  priorDisputes: DisputeSummary[];
  position: { text: string; source: "model" | "fallback" };
  evidence: DisputeEvidenceItem[];
  /** yyyy-mm-dd. */
  generatedAt: string;
  currency: string;
  client: string;
  amount: number;
}

/** A rendered message in the transcript. */
export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  widget?: Widget | null;
  invoice?: InvoicePayload | null;
  dispute?: DisputeSummary | null;
  /** Applies to `system` notices: a neutral aside or a failure notice. */
  tone?: "info" | "danger";
}

/** Wire format for POST /api/chat. */
export interface ChatRequestBody {
  messages: { role: ChatRole; content: string }[];
}

export interface ChatResponseBody {
  text: string;
  widgets: Widget[];
  /** Invoices the agent created or read this turn, newest last. */
  invoices?: InvoicePayload[];
  /**
   * Invoices left off the transcript because a list turn returned too many to
   * card. Reported so the UI can say so instead of appearing to lose them.
   */
  invoicesOmitted?: number;
  /** Disputes the agent read this turn, oldest last. */
  disputes?: DisputeSummary[];
  /** Names of every tool the agent invoked, for transparency in the UI. */
  toolCalls: string[];
  /** Set when the agent ran without PayPal credentials. */
  degraded?: "paypal-unconfigured";
  error?: string;
}

export type InsightSeverity = "high" | "medium" | "low";

/**
 * A money leak the agent surfaced on its own. `headline` is written to read
 * naturally after "I noticed ...".
 */
export interface Insight {
  id: string;
  severity: InsightSeverity;
  headline: string;
  detail: string;
  metric?: { label: string; value: string; delta: string };
}

export interface InsightsResponseBody {
  insights: Insight[];
  /** "sandbox" = derived from the PayPal sandbox, "simulated" = built-in fixture. */
  source: "sandbox" | "simulated";
  paypalConnected: boolean;
  modelConnected: boolean;
  /**
   * Why the simulated fixture was substituted. Without this the client cannot
   * tell an unconfigured sandbox from a model that failed at call time, and
   * would blame the sandbox for a provider outage.
   */
  fallbackReason?: InsightFallbackReason;
}

/** What autopilot is allowed to propose. */
export type AutopilotActionType =
  | "send_reminder"
  | "early_pay_discount"
  | "move_to_tax_pot"
  | "escalate_invoice";

/** One drafted action, waiting for the user to approve or skip it. */
export interface AutopilotAction {
  id: string;
  type: AutopilotActionType;
  headline: string;
  reasoning: string;
  impact: string;
  /** The ledger invoice this acts on, when it targets one. */
  invoiceId?: string;
}

/** Wire format for GET /api/autopilot. */
export interface AutopilotResponseBody {
  actions: AutopilotAction[];
  /**
   * True when PayPal credentials are present. The UI uses it to explain what an
   * approval can actually reach, rather than implying every card is live.
   */
  paypalConnected: boolean;
}

/** Wire format for POST /api/autopilot, the outcome of approving one card. */
export interface AutopilotApprovalResponseBody {
  ok: boolean;
  /** True only when a PayPal call ran and changed something out there. */
  executed: boolean;
  /** True when the action was handled as a draft and nothing left the machine. */
  simulated: boolean;
  detail: string;
}

/** The distinct reasons the proactive sweep can fall back to a fixture. */
export type InsightFallbackReason =
  | "paypal-unconfigured"
  | "model-unconfigured"
  | "sweep-failed"
  | "no-findings";
