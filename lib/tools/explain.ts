import { tool } from "ai";
import { z } from "zod";

import { explainIncomeChange } from "../analysis.ts";

/**
 * The "why am I broke?" explainer, as the agent sees it.
 *
 * It takes no parameters on purpose: the question is always the same one, and
 * the answer is derived from the ledger rather than from anything the model
 * supplies. The model's job is to tell the story, not to supply the numbers.
 */
export const explainIncomeTool = tool({
  description:
    "Explain why income changed. Use for 'why am I broke', 'why is income down', 'what happened this month'.",
  parameters: z.object({}),
  execute: async () => explainIncomeChange(),
});

export default explainIncomeTool;
