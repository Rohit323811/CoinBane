"use client";

import { CoinBaneLogo } from "./CoinBaneLogo";

/**
 * The signature wait state.
 *
 * No text, no bouncing dots. The mark hovers in place while three short dashes
 * fade in sequence beside it. Motion is dropped entirely for users who ask for
 * reduced motion -- the dashes then simply sit at a readable opacity.
 */
export function ThinkingIndicator() {
  return (
    <div
      className="flex items-center gap-3 py-0.5"
      role="status"
      aria-label="CoinBane is composing a response"
    >
      <span className="inline-flex animate-float motion-reduce:animate-none">
        <CoinBaneLogo size={18} />
      </span>

      <span className="flex items-center gap-[5px]">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="h-[2px] w-2 rounded-full bg-text-secondary animate-dash motion-reduce:animate-none motion-reduce:opacity-60"
            style={{ animationDelay: `${index * 200}ms` }}
          />
        ))}
      </span>
    </div>
  );
}

export default ThinkingIndicator;
