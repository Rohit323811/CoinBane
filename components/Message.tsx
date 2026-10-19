"use client";

import type { ChatMessage } from "@/lib/types";

import { CoinBaneLogo } from "./CoinBaneLogo";
import { DisputeWidget } from "./DisputeWidget";
import { InvoiceWidget } from "./InvoiceWidget";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { WidgetRenderer } from "./WidgetRenderer";

/**
 * One row of the transcript.
 *
 * `pending` renders the agent bubble with the hovering mark instead of text,
 * so the wait state occupies exactly the space the answer will.
 */
export function Message({
  message,
  pending = false,
}: {
  message: ChatMessage | null;
  pending?: boolean;
}) {
  const role = message?.role ?? "assistant";

  if (role === "system") {
    const danger = message?.tone === "danger";
    return (
      <div className="flex justify-center px-2">
        <p
          className={`max-w-md text-center text-[12px] leading-relaxed ${
            danger ? "text-status-danger" : "text-text-secondary"
          }`}
        >
          {message?.content}
        </p>
      </div>
    );
  }

  if (role === "user") {
    return (
      <div className="flex animate-rise-in justify-end">
        <div className="max-w-[88%] rounded-lg bg-accent-primary px-4 py-2.5 text-[15px] leading-relaxed text-bg-main sm:max-w-[75%]">
          <p className="whitespace-pre-wrap break-words">{message?.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex animate-rise-in flex-col items-start">
      <div className="mb-1.5 flex items-center gap-2 pl-0.5">
        <CoinBaneLogo size={13} glow={false} />
        <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-accent-glow">
          CoinBane
        </span>
      </div>

      <div className="w-full max-w-full rounded-lg border border-border-subtle bg-bg-card px-4 py-3.5 sm:max-w-[88%]">
        {pending ? (
          <ThinkingIndicator />
        ) : (
          <>
            {message?.content ? (
              <p className="animate-fade-in whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text-primary">
                {message.content}
              </p>
            ) : null}
            {message?.widget ? (
              <div className={message.content ? "mt-3" : ""}>
                <WidgetRenderer widget={message.widget} />
              </div>
            ) : null}
            {/*
             * The invoice sits under the sentence that announced it, and
             * carries its own actions: the file, the payer page and the nudge
             * are the point of the card.
             */}
            {message?.invoice ? (
              <div className={message.content || message.widget ? "mt-3" : ""}>
                <InvoiceWidget invoice={message.invoice} />
              </div>
            ) : null}
            {/* A dispute brings its own file: the proof pack is the point. */}
            {message?.dispute ? (
              <div
                className={
                  message.content || message.widget || message.invoice ? "mt-3" : ""
                }
              >
                <DisputeWidget dispute={message.dispute} />
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export default Message;
