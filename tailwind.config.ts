import type { Config } from "tailwindcss";

/**
 * CoinBane brand system.
 *
 * Design rule 75/15/7/3 — 75% dark surfaces, 15% muted text/UI,
 * 7% blue/cyan accents, 3% status colour. Accent blue is reserved for
 * actionable controls and accent cyan for the logo mark only.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        "bg-main": "#080A0F",
        "bg-secondary": "#0E121A",
        "bg-card": "#131923",
        "bg-elevated": "#181F2B",
        "text-primary": "#F1F4F8",
        "text-secondary": "#8994A6",
        "border-subtle": "#242C38",
        "accent-primary": "#4B9CFF",
        "accent-glow": "#63D8FF",
        "status-success": "#55D6A2",
        "status-warning": "#F5B94C",
        "status-danger": "#F06A78",
        /* PayPal's own palette, scoped to the /paypal landing page. Kept in a
           namespace of its own so the CoinBane tokens above stay the only
           colours the product shell reaches for. */
        paypal: {
          blue: "#0070BA",
          navy: "#003087",
          sky: "#009CDE",
          ink: "#001435",
          muted: "#6C7378",
          line: "#E4E7EA",
          surface: "#F7F9FA",
          band: "#F5F7FA",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        /* PayPal's own stack, scoped to the /paypal page: Inter would give
           the decoy away by looking like the CoinBane shell around it. */
        paypal: ['"Helvetica Neue"', "Helvetica", "Arial", "sans-serif"],
      },
      borderColor: {
        DEFAULT: "#242C38",
      },
      maxWidth: {
        prose: "48rem",
      },
      keyframes: {
        /* Hovering mark — organic breathe, never a bounce. */
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-4px)" },
        },
        /* Sequential dash fade for the thinking indicator. */
        dash: {
          "0%, 100%": { opacity: "0.2" },
          "50%": { opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "rise-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        /* The floating face. Three separate transforms on three nested layers,
           because they run on different clocks and CSS can only drive one
           `transform` per element. Slow and shallow on purpose: it is meant to
           hang in the air, not to bounce. */
        "mascot-float": {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-3px)" },
        },
        "mascot-drift": {
          "0%, 100%": { transform: "translateX(-1.5px)" },
          "50%": { transform: "translateX(1.5px)" },
        },
        "mascot-wobble": {
          "0%, 100%": { transform: "rotate(-2deg)" },
          "50%": { transform: "rotate(2deg)" },
        },
        /*
         * The grin, saying "Are you about to click me?" in one two-second
         * pass. scaleY is the height of the open mouth, against its full
         * stretch: 0.6 is where it rests, 0.2 is the shut of "click", 1 is
         * the wide open of "Are". The beats follow the syllables, and the
         * easing keeps it from reading as a square wave.
         */
        "mascot-speak": {
          "0%": { transform: "scaleY(0.6)" },
          "10%": { transform: "scaleY(1)" },
          "20%": { transform: "scaleY(0.4)" },
          "35%": { transform: "scaleY(1)" },
          "50%": { transform: "scaleY(0.6)" },
          "60%": { transform: "scaleY(0.2)" },
          "75%": { transform: "scaleY(0.8)" },
          "100%": { transform: "scaleY(0.6)" },
        },
        /*
         * The one-time greeting's arrival. An animation rather than a
         * transition because a transition cannot fire on first paint, and it
         * deliberately has no fill mode: holding opacity would fight the
         * fade-out, which is a transition on the same property.
         */
        "mascot-intro-fade": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        /*
         * The mic button's listening pulse: one gentle breath every 1.2s,
         * small enough to read as "open" rather than as an alert.
         */
        "mic-pulse": {
          "0%, 100%": { transform: "scale(1)" },
          "50%": { transform: "scale(1.15)" },
        },
      },
      animation: {
        float: "float 1.6s ease-in-out infinite",
        dash: "dash 1.4s ease-in-out infinite",
        "fade-in": "fade-in 200ms ease-out both",
        "rise-in": "rise-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "mascot-float": "mascot-float 3s ease-in-out infinite alternate",
        "mascot-drift": "mascot-drift 4s ease-in-out infinite alternate",
        "mascot-wobble": "mascot-wobble 5s ease-in-out infinite alternate",
        "mascot-intro-fade": "mascot-intro-fade 300ms ease-out",
        "mascot-speak": "mascot-speak 2s ease-in-out",
        "mic-pulse": "mic-pulse 1.2s ease-in-out infinite",
      },
      screens: {
        xs: "480px",
      },
    },
  },
  plugins: [],
};

export default config;
