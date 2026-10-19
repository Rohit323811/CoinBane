import type { Metadata } from "next";
import Link from "next/link";

import CoinLogo from "@/components/CoinLogo";
import HeroWords from "@/components/HeroWords";

/**
 * A section-for-section recreation of the PayPal US homepage.
 *
 * Nothing here is a real PayPal asset: the double-P mark, the illustration and
 * every icon are styled text and plain SVG shapes, so no trademarked file ships
 * with the app. The palette, the Helvetica stack and the copy follow the live
 * homepage so the page reads as PayPal rather than as a lookalike of one — and
 * it deliberately wears a light colour scheme against the dark CoinBane shell.
 *
 * The coin mark in the bottom-right corner is the doorway out of here: it is
 * mounted by this page alone — never by the root layout — so this landing page
 * wears PayPal's face and the chat page it leads to is the one place the mark
 * never shows up. "Developer" in the nav and "Developer Tools" in the footer
 * are quieter doors to the same place.
 */

export const metadata: Metadata = {
  title: "PayPal: Pay, send, and save smarter",
  description: "Shop, send, and manage your money — all in one place.",
};

/*
 * "Developer" is the doorway to CoinBane. It is dressed exactly like its
 * neighbours: a plausible PayPal link is the only way off this page besides
 * the coin.
 */
const NAV_LINKS: { label: string; href?: string }[] = [
  { label: "Personal" },
  { label: "Business" },
  { label: "Developer", href: "/" },
  { label: "Help" },
];

const REWARD_CARDS = [
  { stat: "7% back", body: "Get hundreds of offers." },
  {
    stat: "+5% back",
    body: "Also get 5% on purchases in your monthly category when you check out with your PayPal Debit Card.",
  },
  {
    stat: "3% cash back",
    body: "Earn 3% cash back when you check out with PayPal.",
  },
];

const PAY_OPTIONS = [
  {
    title: "Pay in 4",
    body: "Interest-free payments. Paid every two weeks. No late fees. Won't affect your credit score to apply.",
  },
  {
    title: "Pay Monthly in 3, 6, 12, or 24 payments",
    body: "With $0 down. No sign-up fees or late fees.",
  },
  {
    title: "Pay with the PayPal Cashback Mastercard",
    body: "Earn 3% cash back when you check out with PayPal and 1.5% on all other Mastercard purchases.",
  },
];

const SAVINGS_CARDS = [
  {
    title: "Get 3.55% APY with your PayPal Savings account",
    body: "It's free to set up, FDIC insured with and held at Synchrony Bank — and you can roll in all the rewards you earn with PayPal so you earn even more.",
  },
  {
    title: "Crypto the easy way",
    body: "Crypto curious? Confidently buy, sell, and transfer your crypto on PayPal.",
  },
];

const FOOTER_COLUMNS = [
  {
    heading: "About",
    links: ["Who We Are", "Careers", "Investor Relations", "Newsroom"],
  },
  {
    heading: "Help",
    links: ["Help Center", "Contact Us", "Security", "Resolution Center"],
  },
  {
    heading: "Business",
    links: [
      "PayPal for Business",
      "Accept Payments",
      "Invoicing",
      "Developer Tools",
    ],
  },
  {
    heading: "Legal",
    links: ["Privacy", "Terms", "Cookies", "Accessibility"],
  },
];

/*
 * The doorway again, in the footer. The header nav is desktop-only — PayPal
 * collapses it below `md` — so without this a phone has no route from PayPal
 * to CoinBane other than the coin. It keeps the label it already had, so it
 * reads as one more footer link.
 */
const FOOTER_DOORWAY = {
  heading: "Business",
  label: "Developer Tools",
  href: "/",
};
const FOOTER_LINK_CLASS =
  "text-[14px] text-paypal-muted transition-colors hover:text-paypal-blue";

/*
 * The double-P mark, rebuilt from two italic capitals instead of shipped
 * artwork: navy first, sky second, overlapping by a few pixels with a
 * multiply blend so the crossing darkens into one shape the way the real
 * mark does. The wordmark beside it carries the accessible name.
 */
function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span aria-hidden className="relative block h-[26px] w-[26px] shrink-0">
        <span className="absolute left-0 top-0 text-[26px] font-extrabold italic leading-none text-paypal-navy">
          P
        </span>
        <span className="absolute left-[9px] top-0 text-[26px] font-extrabold italic leading-none text-paypal-sky mix-blend-multiply">
          P
        </span>
      </span>
      <span className="text-[22px] font-extrabold italic leading-none text-paypal-navy">
        PayPal
      </span>
    </span>
  );
}

/* A store badge as a styled text box — placeholder, not real badge artwork. */
function StoreBadge({ over, name }: { over: string; name: string }) {
  return (
    <span className="inline-flex flex-col items-start rounded-md bg-paypal-ink px-5 py-2 text-white">
      <span className="text-[9px] uppercase leading-tight tracking-[0.08em] opacity-80">
        {over}
      </span>
      <span className="text-[15px] font-semibold leading-tight">{name}</span>
    </span>
  );
}

export default function PayPalPage() {
  return (
    <div
      className="min-h-dvh bg-white font-paypal text-paypal-ink"
      style={{ colorScheme: "light" }}
    >
      {/* 1 — Header: sticky, white, nav centred on desktop only. */}
      <header className="sticky top-0 z-40 border-b border-paypal-line bg-white">
        <div className="relative mx-auto flex h-16 w-full max-w-[1200px] items-center gap-6 px-6">
          <span className="shrink-0">
            <Wordmark />
          </span>

          {/* Absolutely centred: in a plain flex row the nav would drift toward
              the wider of the logo and the buttons, and the spec wants it in
              the middle of the header. */}
          <nav
            className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-7 md:flex"
            aria-label="Main"
          >
            {NAV_LINKS.map((link) =>
              link.href ? (
                <Link
                  key={link.label}
                  href={link.href}
                  className="text-[15px] font-medium text-paypal-navy transition-colors hover:text-paypal-blue"
                >
                  {link.label}
                </Link>
              ) : (
                <span
                  key={link.label}
                  className="cursor-pointer text-[15px] font-medium text-paypal-navy transition-colors hover:text-paypal-blue"
                >
                  {link.label}
                </span>
              ),
            )}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <span className="cursor-pointer rounded-full border border-paypal-blue px-4 py-2 text-[14px] font-semibold text-paypal-blue transition-colors hover:bg-paypal-blue/5 sm:px-5">
              Log In
            </span>
            <span className="cursor-pointer rounded-full bg-paypal-blue px-5 py-2 text-[14px] font-semibold text-white transition-opacity hover:opacity-90">
              Sign Up
            </span>
          </div>
        </div>
      </header>

      <main>
        {/* 2 — Hero: headline, cycling words, subheadline, two CTAs. */}
        <section className="mx-auto grid w-full max-w-[1200px] items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <h1 className="text-[40px] font-bold leading-[1.06] tracking-tight text-paypal-ink sm:text-[48px] lg:text-[56px]">
              Pay, send, and save smarter
            </h1>

            <HeroWords />

            <p className="mt-6 max-w-lg text-[18px] leading-relaxed text-paypal-muted">
              Shop, send, and manage your money — all in one place.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <span className="cursor-pointer rounded-full bg-paypal-blue px-8 py-3.5 text-[15px] font-semibold text-white transition-opacity hover:opacity-90">
                Get Started
              </span>
              <span className="cursor-pointer rounded-full border border-paypal-blue px-8 py-3.5 text-[15px] font-semibold text-paypal-blue transition-colors hover:bg-paypal-blue/5">
                Learn More
              </span>
            </div>
          </div>

          {/* Abstract illustration: one soft blue gradient disc, one bag. */}
          <div className="relative flex h-[260px] items-center justify-center sm:h-[340px]">
            <span
              aria-hidden
              className="absolute h-[280px] w-[280px] rounded-full bg-[radial-gradient(circle_at_32%_28%,#FFFFFF_0%,#E3F1FB_38%,#C9E5F7_72%,#AFE0F5_100%)] sm:h-[320px] sm:w-[320px]"
            />
            <svg
              viewBox="0 0 64 64"
              width={88}
              height={88}
              fill="none"
              stroke="#0070BA"
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="relative"
            >
              <path d="M14 22h36l-3 30H17z" />
              <path d="M24 22a8 8 0 0 1 16 0" />
            </svg>
          </div>
        </section>

        {/* 3 — Rewards feature grid. */}
        <section className="border-t border-paypal-line bg-white">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 md:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[30px] font-bold leading-tight text-paypal-ink md:text-[36px]">
                Shop in stores and online
              </h2>
              <p className="mt-4 text-[17px] leading-relaxed text-paypal-muted">
                Tap to pay in stores with the PayPal Debit Card and earn
                rewards online with PayPal checkout.
              </p>
            </div>

            <div className="mt-10 grid gap-6 md:grid-cols-3">
              {REWARD_CARDS.map((card) => (
                <div
                  key={card.stat}
                  className="rounded-lg border border-paypal-line bg-white p-7"
                >
                  <p className="text-[34px] font-bold leading-none text-paypal-blue">
                    {card.stat}
                  </p>
                  <p className="mt-4 text-[15px] leading-relaxed text-paypal-muted">
                    {card.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 4 — Pay over time: three plain columns, no cards. */}
        <section className="border-t border-paypal-line bg-white">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 md:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[30px] font-bold leading-tight text-paypal-ink md:text-[36px]">
                Pay now or pay over time. It&rsquo;s your choice.
              </h2>
            </div>

            <div className="mt-10 grid gap-8 md:grid-cols-3">
              {PAY_OPTIONS.map((option) => (
                <div key={option.title}>
                  <h3 className="text-[18px] font-semibold leading-snug text-paypal-ink">
                    {option.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-paypal-muted">
                    {option.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 5 — Safety band: the one full-width tinted strip. */}
        <section className="bg-paypal-band py-16 md:py-20">
          <div className="mx-auto w-full max-w-[1200px] px-6 text-center">
            <svg
              viewBox="0 0 24 24"
              width={30}
              height={30}
              fill="none"
              stroke="#0070BA"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="mx-auto"
            >
              <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <h2 className="mt-5 text-[26px] font-bold leading-tight text-paypal-ink md:text-[32px]">
              Safety and privacy are our priority
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[17px] leading-relaxed text-paypal-muted">
              Your payments are encrypted and we don&rsquo;t share your full
              financial info.
            </p>
          </div>
        </section>

        {/* 6 — Send money: text left, two circles joined by a line right. */}
        <section className="bg-white">
          <div className="mx-auto grid w-full max-w-[1200px] items-center gap-10 px-6 py-16 md:py-20 lg:grid-cols-2">
            <div>
              <h2 className="text-[30px] font-bold leading-tight text-paypal-ink md:text-[36px]">
                Send money to just about anyone, anywhere
              </h2>
              <p className="mt-4 text-[18px] leading-relaxed text-paypal-muted">
                Send in seconds.
              </p>
            </div>

            <div className="flex justify-center lg:justify-end">
              <svg
                viewBox="0 0 260 100"
                width={260}
                height={100}
                fill="none"
                stroke="#0070BA"
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                className="h-[100px] w-[260px] max-w-full"
              >
                <circle cx="46" cy="50" r="33" />
                <path d="M85 50h74" />
                <path d="M151 42l10 8-10 8" />
                <circle cx="214" cy="50" r="33" fill="#0070BA" />
              </svg>
            </div>
          </div>
        </section>

        {/* 7 — Savings and crypto. */}
        <section className="border-t border-paypal-line bg-white">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 md:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[30px] font-bold leading-tight text-paypal-ink md:text-[36px]">
                Make your money work harder. It&rsquo;s easy. Really easy.
              </h2>
            </div>

            <div className="mt-10 grid gap-6 md:grid-cols-2">
              {SAVINGS_CARDS.map((card) => (
                <div
                  key={card.title}
                  className="rounded-lg border border-paypal-line bg-white p-7"
                >
                  <h3 className="text-[19px] font-bold leading-snug text-paypal-ink">
                    {card.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-paypal-muted">
                    {card.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 8 — The app, with placeholder store badges. */}
        <section className="border-t border-paypal-line bg-white">
          <div className="mx-auto w-full max-w-[1200px] px-6 py-16 md:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-[30px] font-bold leading-tight text-paypal-ink md:text-[36px]">
                All in the PayPal app
              </h2>
              <p className="mt-4 text-[17px] leading-relaxed text-paypal-muted">
                It&rsquo;s your do-it-all digital wallet. Load up on offers
                before you shop. Track your packages. And manage it all on the
                go.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                <StoreBadge over="Download on the" name="App Store" />
                <StoreBadge over="Get it on" name="Google Play" />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* 9 — Footer: four link columns over light gray, muted copyright. */}
      <footer className="border-t border-paypal-line bg-paypal-surface">
        <div className="mx-auto w-full max-w-[1200px] px-6 py-12">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.heading}>
                <h3 className="text-[15px] font-semibold text-paypal-ink">
                  {column.heading}
                </h3>
                <ul className="mt-4 space-y-2.5">
                  {column.links.map((link) =>
                    column.heading === FOOTER_DOORWAY.heading &&
                    link === FOOTER_DOORWAY.label ? (
                      <li key={link}>
                        <Link
                          href={FOOTER_DOORWAY.href}
                          className={FOOTER_LINK_CLASS}
                        >
                          {link}
                        </Link>
                      </li>
                    ) : (
                      <li
                        key={link}
                        className={`cursor-pointer ${FOOTER_LINK_CLASS}`}
                      >
                        {link}
                      </li>
                    ),
                  )}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 border-t border-paypal-line pt-6">
            <p className="text-[12px] text-paypal-muted">
              &copy; 2026 PayPal. All rights reserved.
            </p>
          </div>
        </div>
      </footer>

      {/* The doorway. Fixed, so it floats over the page rather than joining
          its flow — bottom-right, clear of the sticky header. */}
      <CoinLogo />
    </div>
  );
}
