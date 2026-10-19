import { tool } from "ai";
import { z } from "zod";

import {
  forecastCashflow,
  forecastSummary,
  type CashflowForecast,
  type ForecastHorizon,
} from "../analysis.ts";
import type { ForecastWidget } from "../types";

/**
 * The tool result: the analysis, plus the marker and copy the chat renders.
 */
export type ForecastToolResult = ForecastWidget &
  CashflowForecast & { summary: string };

/**
 * The cash-flow forecast, as the agent sees it.
 *
 * The result is both the answer and the payload for the inline widget: the
 * route reads the `kind` marker out of the tool results, so whatever the model
 * writes in prose, the numbers behind it reach the chat unchanged.
 *
 * `baseline` travels with the result so the agent can report the delta for a
 * "what if" instead of having to re-run the projection to compare.
 */
export const forecastTool = tool({
  description:
    "Forecast future income over 30, 60, or 90 days. Use when the user asks about future income, 'what if' scenarios, or 'can I afford X'.",
  parameters: z.object({
    /*
     * The horizon crosses the model boundary as a string on purpose. A numeric
     * enum compiles to a JSON-schema enum of numbers, and Gemini rejects that
     * outright — "Invalid value at ...enum[0] (TYPE_STRING)" — which failed
     * the whole request, not just this tool. Coerced back to a number below.
     */
    window: z
      .enum(["30", "60", "90"])
      .optional()
      .describe(
        "Horizon to answer for, in days, as a string: '30', '60', or '90'. Defaults to '30'. All three horizons are always returned.",
      ),
    exclude: z
      .array(z.string())
      .optional()
      .describe(
        'Clients to leave out of the projection, e.g. ["Nova Startup"]. Use for "what if X never pays".',
      ),
    delays: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Extra days a client is expected to pay late, e.g. { "BigCorp Ltd": 10 }. Use for "what if X pays N days later".',
      ),
  }),
  execute: async (input): Promise<ForecastToolResult> => {
    const forecast = forecastCashflow({
      window: input.window ? (Number(input.window) as ForecastHorizon) : undefined,
      exclude: input.exclude,
      delays: input.delays,
    });

    return {
      kind: "forecast",
      title: "Income forecast",
      subtitle: `${forecast.openInvoices} open invoices · ${forecast.focusDays}-day horizon`,
      ...forecast,
      summary: forecastSummary(forecast),
    };
  },
});

export default forecastTool;
