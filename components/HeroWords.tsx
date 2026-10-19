"use client";

import { useEffect, useState } from "react";

/**
 * The three words that cycle under the PayPal hero headline: "pay smarter",
 * "send smarter", "save smarter".
 *
 * A client island on an otherwise server-rendered page — the rotation is the
 * only thing here that needs the browser. All three words stay in the row so
 * the line keeps its shape; the active one is PayPal blue and the others fade
 * to mute over half a second, so the cycle reads as a fade rather than a swap.
 * The row is hidden from screen readers: it repeats forever and the headline
 * next to it already says the same thing.
 */

const WORDS = ["pay smarter", "send smarter", "save smarter"];

export default function HeroWords() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setActive((index) => (index + 1) % WORDS.length);
    }, 2000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <p
      aria-hidden="true"
      className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[17px] font-medium leading-none"
    >
      {WORDS.map((word, index) => (
        <span
          key={word}
          className={`transition-[color,opacity] duration-500 ${
            index === active
              ? "text-paypal-blue opacity-100"
              : "text-paypal-muted opacity-70"
          }`}
        >
          {word}
        </span>
      ))}
    </p>
  );
}
