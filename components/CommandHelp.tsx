"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Everything CoinBane takes, in the shape you would say it.
 *
 * Kept here rather than in the prompt module because this is a user-facing
 * list, not part of the model's instructions: the bracketed words are the
 * parts the agent extracts, and the rest are the phrasings it is known to
 * answer. When a command is added to lib/prompts.ts, it belongs here too.
 */
export const COMMANDS: { command: string; note: string }[] = [
  { command: "Invoice [client] for [amount]", note: "Creates and sends one" },
  { command: "Why am I broke?", note: "Names the clients behind the dip" },
  { command: "What should I do today?", note: "Drafts actions for review" },
  { command: "What if [client] doesn't pay?", note: "Re-runs the forecast" },
  { command: "Can I afford a month off?", note: "Compares against your costs" },
  { command: "What's the risk on my [client] invoice?", note: "Score and next move" },
  { command: "Show me my revenue by client", note: "Draws the breakdown" },
];

/**
 * The question mark in the header, and the card it opens.
 *
 * A plain dialog rather than a dependency: the card is a short list, so it is
 * a div with `role="dialog"` rather than a focus-trapping library. It closes
 * on Escape and on a click outside the card — the two ways people try — and it
 * deliberately does not trap focus, because the list is short enough to read
 * through in one glance.
 *
 * The overlay is portalled to the body. The button lives in the header, and
 * the header carries a backdrop blur — which makes it a containing block for
 * fixed children, so an overlay rendered inside it would be pinned to the
 * header's box instead of the viewport.
 */
export function CommandHelp() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      // Focus goes back where it came from, so Escape does not strand a
      // keyboard user at the top of the document.
      buttonRef.current?.focus();
    };

    document.addEventListener("keydown", onKeyDown);
    // The page behind the overlay must not scroll while the card is up.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="What CoinBane understands"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border-subtle text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/40"
      >
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9.2 9.2a2.9 2.9 0 1 1 4.1 2.7c-.8.4-1.3.9-1.3 1.8v.3" />
          <circle cx="12" cy="17.2" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      </button>

      {open
        ? createPortal(
            <div
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bg-main/75 px-4 py-16 backdrop-blur-sm"
              /*
               * Outside click. A press on the backdrop itself closes; a press
               * that starts inside the card and ends on the backdrop does not.
               */
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="command-help-title"
                className="animate-rise-in w-full max-w-md rounded-lg border border-border-subtle bg-bg-card p-5 font-sans shadow-[0_24px_60px_rgba(0,0,0,0.5)]"
              >
                <div className="flex items-start gap-3">
                  <h2
                    id="command-help-title"
                    className="text-[13px] font-semibold uppercase tracking-[0.22em] text-text-primary"
                  >
                    What CoinBane understands
                  </h2>
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="ml-auto -mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/40"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width={13}
                      height={13}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>

                <ul className="mt-4 space-y-2.5">
                  {COMMANDS.map(({ command, note }) => (
                    <li key={command} className="flex flex-col gap-0.5">
                      <span className="text-[13px] leading-snug text-text-primary">
                        {command}
                      </span>
                      <span className="text-[11px] leading-snug text-text-secondary">
                        {note}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export default CommandHelp;
