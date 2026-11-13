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
    "Forecast income over 30/60/90 days. Use for future income, what-if, or 'can I afford X'.",
  parameters: z.object({
    /*
     * The horizon crosses the model boundary as a string on purpose. A numeric
     * enum compiles to a JSON-schema enum of numbers, which a previous provider
     * rejected outright — "Invalid value at ...enum[0] (TYPE_STRING)" — failing
     * the whole request, not just this tool. Coerced back to a number below, and
     * lib/tools.test.ts pins the contract.
     */
    window: z
      .enum(["30", "60", "90"])
      .optional()
      .describe("Days as a string: '30', '60' or '90'. Defaults to '30'."),
    exclude: z
      .array(z.string())
      .optional()
      .describe('Clients to exclude, e.g. ["Nova Startup"].'),
    /*
     * A list of pairs rather than a `Record<string, number>`.
     *
     * A record compiles to a JSON schema with a schema-valued
     * `additionalProperties`, which Groq's validator rejects — it requires
     * `additionalProperties: false` on every object. An array of named entries
     * carries the same information in a shape both providers accept, and is
     * converted back to a record before the analysis sees it.
     */
    delays: z
      .array(
        z.object({
          client: z.string().describe("Client name on the invoice."),
          days: z.number().describe("Extra days late."),
        }),
      )
      .optional()
      .describe('Clients paying late, e.g. [{ "client": "BigCorp Ltd", "days": 10 }].'),
  }),
  execute: async (input): Promise<ForecastToolResult> => {
    // Back to the record the analysis works in, keyed by client name.
    const delays = input.delays?.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.client] = entry.days;
      return acc;
    }, {});

    const forecast = forecastCashflow({
      window: input.window ? (Number(input.window) as ForecastHorizon) : undefined,
      exclude: input.exclude,
      delays,
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
