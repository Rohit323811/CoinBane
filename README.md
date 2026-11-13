# CoinBane 🗡️
> *"Beware of little expenses; a small leak will sink a great ship." — Benjamin Franklin*

**CoinBane** is an AI financial operations agent for freelancers. It doesn't just track your money—it commands it. Built on top of the **PayPal Agent Toolkit** and **Google's `gemini-3.5-flash`**, CoinBane acts as a quiet, authoritative guardian that watches for leaks, hunts down late payers, and predicts your cash flow.

It features a split-personality, black-and-white floating mascot (inspired by classic anime villains) that tracks your cursor, speaks, and guards the entrance to the app. Managing your finances has never felt so delightfully sinister.

---

## 🗡️ Core Features

- **The "Why Am I Broke?" Explainer:** Traces your income and expenses to tell a factual, narrative story of exactly who hasn't paid and what drained your account.
- **Cash-Flow Forecasting:** Projects your income for the next 30/60/90 days. Ask *"What if Nova Startup doesn't pay?"* and watch the projection update live.
- **Risk Scoring & Autopilot:** Predicts the likelihood of an invoice being paid on time. Drafts actions (reminders, early-pay discounts, tax moves) for you to approve with one tap.
- **Voice Mode:** Speak your commands using the built-in mic. The agent reads the confirmation back to you in a deep, theatrical tone.
- **PDF Invoices & Dispute Packs:** Generates professional PDF invoices with QR codes, and builds "Proof Packs" to crush client disputes.
- **The Cursed UI:** A black-and-white split-face mascot floats in the corner, tracking your cursor, blinking, and speaking when you get too close.

---

## 🛠️ Tech Stack

- **Framework:** Next.js (App Router, TypeScript)
- **AI Integration:** Vercel AI SDK + Google (`gemini-3.5-flash` via `@ai-sdk/openai`)
  - Gemini 3 requires a thought signature on every function call; `lib/ai.ts` re-attaches it, so no proxy is needed. `GEMINI_PROXY_BASE_URL` is still honoured if you use one.
  - `gemini-3.8-flash` is listed for this key but its completion path never answers; see the model notes in `lib/config.ts`.
- **Providers:** `GROQ_API_KEY` (Groq, free plan, no card — `openai/gpt-oss-120b`) wins when present, then `GEMINI_PROXY_BASE_URL`, then `GEMINI_API_KEY`. All three speak the OpenAI chat protocol, so the model is one config line.
- **Groq free plan:** 8,000 tokens per minute per model, and a tool-using turn needs two calls through the model. The app is built for that ceiling: the catalogue is trimmed to the five PayPal tools the prompts actually use, list results are compacted before they reach the model, and `lib/ai.ts` waits out a per-minute refusal ("try again in 9.6s") instead of surfacing it. A turn may take ten to thirty seconds longer than on a paid plan; it finishes. If the window runs out after a tool has already produced a grid or a card, that payload is still returned rather than thrown away. Groq also validates tool JSON schemas strictly, so `lib/ai.ts` repairs the toolkit's schemas on the wire (strict `required`, no `not`, no free-form `additionalProperties`) and the grid/forecast tools carry arrays instead of maps.
- **Payments:** PayPal Agent Toolkit (Sandbox mode)
- **Styling:** Tailwind CSS (Custom dark theme)
- **Data Viz:** Custom React components & AG Grid
- **PDF Generation:** `pdf-lib` + `qrcode`

---

## 🚀 Getting Started

Follow these steps to run CoinBane locally.

### 1. Clone the repository
git clone https://github.com/Rohit323811/CoinBane.git
cd CoinBane

### 2. Install dependencies
npm install

### 3. Set up Environment Variables
Create a `.env.local` file in the root of the project. You need PayPal (Sandbox) credentials and a Google Gemini API key.

PAYPAL_CLIENT_ID=your-paypal-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-paypal-sandbox-client-secret
GEMINI_API_KEY=your-gemini-api-key

`GEMINI_API_KEY` is used exactly as given — there is no format check, so legacy `AIza…` keys and the newer `AQ.…` keys both work. Requests go straight to Google's OpenAI-compatible endpoint.

If you run a `gemini-thought-signature-proxy` in front of Google (Gemini 3 requires thought signatures on prior tool calls, which the AI SDK strips, so the proxy re-injects them), point `GEMINI_PROXY_BASE_URL` at the proxy's OpenAI-compatible root, for example `http://localhost:8787/v1`. That variable wins over `GEMINI_API_KEY` when both are set, and the Google API key then belongs in the proxy's own configuration. `GEMINI_PROXY_API_KEY` is optional and is only used if your proxy authenticates its callers.

(Note: Ensure you are using a PayPal **Business** sandbox account for Invoicing to work properly.)

### 4. Run the development server
npm run dev

### 5. Explore the App
Open your browser and navigate to:
- **The Decoy Landing Page:** http://localhost:3000/paypal *(Wait for the mascot to speak, then click it to enter the app)*
- **The Chat Interface:** http://localhost:3000

---

## 🧪 Try These Prompts

Once you are in the chat interface, test the agent's intelligence layer with these commands:

1. `Why am I broke?` *(Triggers the income explainer)*
2. `What if Nova Startup doesn't pay?` *(Re-runs the cash-flow forecast)*
3. `What should I do today?` *(Generates Autopilot approval cards)*
4. `What's the risk on my BigCorp invoice?` *(Scores payment probability)*
5. `Do I have any disputes?` *(Generates a Dispute Proof Pack)*

---

## 📜 License
MIT
