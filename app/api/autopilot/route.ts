import { NextResponse } from "next/server";

import { draftActions } from "@/lib/autopilot";
import { isPayPalConfigured, paypalTools } from "@/lib/paypal";
import type {
  AutopilotActionType,
  AutopilotApprovalResponseBody,
  AutopilotResponseBody,
} from "@/lib/types";

/**
 * Autopilot.
 *
 * GET drafts today's actions from the ledger. POST approves one.
 *
 * Execution is deliberately conservative. The ledger in lib/clients is
 * simulated, so its ids (`inv-3`) are not PayPal invoices and there is nothing
 * out there to act on: approving one records the decision here and says so.
 * The toolkit path exists for actions that carry a real PayPal invoice id, so a
 * sandbox-backed ledger executes for real rather than being wired to a stub.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ids minted by the simulated ledger in lib/clients. */
const SIMULATED_INVOICE_ID = /^inv-\d+$/;

/** The one toolkit capability the drafted action types map onto. */
const REMINDER_TOOL = "send_invoice_reminder";

const ACTION_TYPES: AutopilotActionType[] = [
  "send_reminder",
  "early_pay_discount",
  "move_to_tax_pot",
  "escalate_invoice",
];

/** Client-supplied, so it is checked rather than trusted. */
function isActionType(value: unknown): value is AutopilotActionType {
  return (
    typeof value === "string" &&
    (ACTION_TYPES as string[]).includes(value)
  );
}

export async function GET() {
  const body: AutopilotResponseBody = {
    actions: draftActions(),
    paypalConnected: isPayPalConfigured(),
  };
  return NextResponse.json(body);
}

/** Says what an action would do when it cannot be done for real. */
function simulatedDetail(type: AutopilotActionType, invoiceId?: string): string {
  const target = invoiceId ?? "the invoice";
  switch (type) {
    case "send_reminder":
    case "escalate_invoice":
      return `Reminder queued for ${target}. Nothing was sent: the ledger is simulated, so there is no PayPal invoice behind that id.`;
    case "early_pay_discount":
      return `Discount offer drafted for ${target}. Nothing was sent: the ledger is simulated, so there is no PayPal invoice behind that id.`;
    case "move_to_tax_pot":
      return "Amount noted for the tax pot. Nothing moved: there is no PayPal account behind the simulated ledger.";
  }
}

/**
 * Runs a reminder through the toolkit.
 *
 * Only reached when the action names a real PayPal invoice, which the
 * simulated ledger never does — but it is the same call the agent makes, so a
 * sandbox-backed ledger needs no new code.
 */
async function sendReminderThroughToolkit(
  invoiceId: string,
): Promise<AutopilotApprovalResponseBody> {
  const tools = paypalTools();
  const reminder = tools?.[REMINDER_TOOL] as
    | { execute?: (input: { invoice_id: string }) => Promise<unknown> }
    | undefined;

  if (!reminder?.execute) {
    return {
      ok: false,
      executed: false,
      simulated: false,
      detail: `The PayPal toolkit exposes no ${REMINDER_TOOL} action in this deployment.`,
    };
  }

  try {
    await reminder.execute({ invoice_id: invoiceId });
    return {
      ok: true,
      executed: true,
      simulated: false,
      detail: `PayPal sent the reminder for ${invoiceId}.`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown error";
    console.error("[coinbane] autopilot reminder failed:", error);
    // Surfaced rather than swallowed: a reminder that did not go out must not
    // be reported as sent.
    return {
      ok: false,
      executed: false,
      simulated: false,
      detail: `PayPal rejected the reminder for ${invoiceId}. ${detail.slice(0, 200)}`,
    };
  }
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const action = (payload as { action?: unknown } | null)?.action;
  if (!action || typeof action !== "object") {
    return NextResponse.json(
      { error: "Expected `action` to be a drafted action object." },
      { status: 400 },
    );
  }

  const { type, invoiceId } = action as { type?: unknown; invoiceId?: unknown };
  if (!isActionType(type)) {
    return NextResponse.json(
      { error: "Expected `action.type` to be one of the drafted action types." },
      { status: 400 },
    );
  }

  // A reminder for a real PayPal invoice is the only action that can leave the
  // machine; everything else is a draft the user is confirming.
  if (
    type === "send_reminder" &&
    typeof invoiceId === "string" &&
    !SIMULATED_INVOICE_ID.test(invoiceId) &&
    isPayPalConfigured()
  ) {
    return NextResponse.json(await sendReminderThroughToolkit(invoiceId));
  }

  const body: AutopilotApprovalResponseBody = {
    ok: true,
    executed: false,
    simulated: true,
    detail: simulatedDetail(
      type,
      typeof invoiceId === "string" ? invoiceId : undefined,
    ),
  };
  return NextResponse.json(body);
}
