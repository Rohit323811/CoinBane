# CoinBane 🗡️
> *"Beware of little expenses; a small leak will sink a great ship." — Benjamin Franklin*

**CoinBane** is an AI financial operations agent for freelancers. It doesn't just track your money—it commands it. Built on top of the **PayPal Agent Toolkit** and **DeepSeek V4.1 Flash**, CoinBane acts as a quiet, authoritative guardian that watches for leaks, hunts down late payers, and predicts your cash flow.

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
- **AI Integration:** Vercel AI SDK + DeepSeek V4.1 Flash (via custom provider)
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
Create a `.env.local` file in the root of the project. You will need API keys for both PayPal (Sandbox) and DeepSeek.

PAYPAL_CLIENT_ID=your-paypal-sandbox-client-id
PAYPAL_CLIENT_SECRET=your-paypal-sandbox-client-secret
DEEPSEEK_API_KEY=your-deepseek-api-key

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
