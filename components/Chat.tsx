"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import {
  BRAND_QUOTE,
  INITIAL_GREETING,
  proactiveMessage,
} from "@/lib/prompts";
import type {
  AutopilotAction,
  AutopilotApprovalResponseBody,
  AutopilotResponseBody,
  ChatMessage,
  ChatResponseBody,
  DisputeSummary,
  InsightsResponseBody,
  InvoicePayload,
  Widget,
} from "@/lib/types";

import { ApprovalCard } from "./ApprovalCard";
import { CoinBaneLogo } from "./CoinBaneLogo";
import { CommandHelp } from "./CommandHelp";
import { Message } from "./Message";
import { MicButton } from "./MicButton";

/** Textarea grows with the draft, then scrolls past this height. */
const TEXTAREA_MAX_HEIGHT = 200;

/** The one prompt the input-area button sends. */
const WHAT_TO_DO_TODAY = "What should I do today?";

/**
 * The three openings offered under the greeting, on a first visit only.
 *
 * Chips prefill the composer rather than sending: the user gets to finish the
 * sentence, which matters because two of these three ask about a named client
 * and the example name is only an example.
 */
const EXAMPLE_COMMANDS = [
  "Why am I broke?",
  WHAT_TO_DO_TODAY,
  "What if Nova doesn't pay?",
] as const;

/**
 * How long after load the autopilot shortlist arrives.
 *
 * Deliberately after the greeting: cards that appear before the user has read
 * the page read as noise, and the proactive sweep already has the floor.
 */
const AUTOPILOT_DELAY_MS = 3_000;

/** How long an approval confirmation stays on screen. */
const TOAST_MS = 6_000;

function nextId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The header's deadline for the sweep.
 *
 * `/api/insights` aborts its own model call at three seconds now, so this timer
 * is the second line of defence: if the request never comes back at all (a dead
 * socket, a proxy that accepts and stalls), the indicator still resolves instead
 * of pulsing "Checking" forever.
 */
const STATUS_TIMEOUT_MS = 3_000;

function connectionState(
  status: InsightsResponseBody | null,
  timedOut: boolean,
): {
  dot: string;
  label: string;
} {
  /*
   * Nothing answered in time. The light defaults to the online state rather
   * than to an alarm: a check that produced no answer is unknown, and "unknown"
   * is unknown, so it reads where it can be understood instead of showing as a
   * red dot that looks like the page crashed.
   */
  if (!status) {
    return timedOut
      ? { dot: "bg-status-success", label: "Sandbox live" }
      : { dot: "bg-text-secondary", label: "Checking" };
  }
  if (!status.modelConnected) {
    return { dot: "bg-status-danger", label: "Model offline" };
  }
  if (!status.paypalConnected) {
    return { dot: "bg-status-warning", label: "Sandbox offline" };
  }
  /*
   * Both credentials are configured, which is what this light reports. A sweep
   * that ran and failed no longer forces "Model error": with the three-second
   * ceiling a slow provider is the ordinary case, and its sample insight arives
   * with a notice in the transcript either way.
   */
  return { dot: "bg-status-success", label: "Sandbox live" };
}

export function Chat() {
  // The greeting is a constant, so it can be the initial state and hydrate
  // without a mismatch.
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "greeting", role: "assistant", content: INITIAL_GREETING },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<InsightsResponseBody | null>(null);
  const [statusTimedOut, setStatusTimedOut] = useState(false);
  const [actions, setActions] = useState<AutopilotAction[]>([]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  /*
   * Proactive sweep: on load, ask the agent what it noticed — once.
   *
   * React runs effects twice in development, and the sweep used to be fired from
   * the effect body with no guard, so the insight arrived twice: once on load and
   * again just after the first message. The ref makes the request idempotent, and
   * the transcript is checked for an existing insight as a second guard.
   *
   * There is deliberately no AbortController here. Strict Mode's second run calls
   * the first run's cleanup, so aborting on cleanup killed the one request the
   * guard had already allowed — the sweep then finished nowhere and the insight
   * never appeared at all. The request is a read on page load; letting it finish
   * costs nothing, and the dedupe below decides what reaches the transcript.
   */
  const sweptRef = useRef(false);

  useEffect(() => {
    if (sweptRef.current) return;
    sweptRef.current = true;

    fetch("/api/insights")
      .then((response) =>
        response.ok ? (response.json() as Promise<InsightsResponseBody>) : null,
      )
      .then((data) => {
        if (!data) return;
        setStatus(data);

        /*
         * One insight, and only one. A sample insight is shown on its own: the
         * line that used to sit under it ("the insight above is a sample")
         * contradicted the sentence it was qualifying, and the header light
         * already separates "sandbox live" from "model offline".
         */
        const insight = data.insights[0];
        if (!insight) return;

        setMessages((previous) => {
          if (previous.some((message) => message.id.startsWith("insight-"))) {
            return previous;
          }
          return [
            ...previous,
            {
              id: `insight-${nextId()}`,
              role: "assistant",
              content: proactiveMessage(insight),
            },
          ];
        });
      })
      .catch(() => {
        /* The sweep is best-effort; the chat still works without it. */
      });
  }, []);

  /*
   * Stops the header saying "Checking" forever. Only the light resolves: the real
   * state still wins the moment the sweep answers.
   */
  useEffect(() => {
    const timer = setTimeout(() => setStatusTimedOut(true), STATUS_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  /* Auto-grow the composer. */
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(
      element.scrollHeight,
      TEXTAREA_MAX_HEIGHT,
    )}px`;
  }, [draft]);

  /* Keep the newest message in view. */
  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: hasScrolledRef.current ? "smooth" : "auto",
      block: "end",
    });
    hasScrolledRef.current = true;
  }, [messages, busy]);

  /*
   * Fetches the drafted shortlist.
   *
   * Called on a delay after load and again whenever the user asks for it, so
   * the cards match the moment rather than the page load.
   *
   * Staleness is handled by sequence number rather than by an AbortController:
   * the load-path request is fired from a timer, and an abort landing in flight
   * threw away a perfectly good shortlist, which showed up as cards that never
   * arrived until you clicked something.
   */
  const latestRequest = useRef(0);

  const fetchActions = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const response = await fetch("/api/autopilot");
      if (!response.ok) return;
      const data = (await response.json()) as AutopilotResponseBody;
      if (request !== latestRequest.current) return;
      if (Array.isArray(data.actions)) setActions(data.actions);
    } catch {
      /* The shortlist is a convenience; the chat works without it. */
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void fetchActions(), AUTOPILOT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [fetchActions]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  /*
   * Approving runs the action and tells the user what actually happened. The
   * card goes either way: it has been decided, so leaving it up would invite
   * the same decision twice.
   */
  const approve = useCallback(async (action: AutopilotAction) => {
    setPendingAction(action.id);
    try {
      const response = await fetch("/api/autopilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await response
        .json()
        .catch(() => null)) as AutopilotApprovalResponseBody | null;
      setToast(data?.detail ?? "The autopilot endpoint did not answer.");
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "That action could not be approved.",
      );
    } finally {
      setActions((previous) => previous.filter((item) => item.id !== action.id));
      setPendingAction(null);
    }
  }, []);

  /* Skipping is the quiet path: drop the card, change nothing. */
  const skip = useCallback((action: AutopilotAction) => {
    setActions((previous) => previous.filter((item) => item.id !== action.id));
  }, []);

  const send = useCallback(
    async (override?: string) => {
      const content = (override ?? draft).trim();
      // Returning the reply is what lets the microphone read the answer out.
      // Every other caller ignores the return value.
      if (!content || busy) return null;

      // Asking what to do next refreshes the shortlist in parallel with the
      // model's answer, so the cards and the reply describe the same moment.
      if (/what should i do/i.test(content)) void fetchActions();

      const userMessage: ChatMessage = { id: nextId(), role: "user", content };
      const history = [...messages, userMessage];

      setMessages(history);
      setDraft("");
      setBusy(true);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // System notices are UI-only and never sent back to the model.
            messages: history
              .filter((message) => message.role !== "system")
              .map(({ role, content: text }) => ({ role, content: text })),
          }),
        });

        const data = (await response
          .json()
          .catch(() => null)) as ChatResponseBody | null;

        if (!response.ok || !data) {
          throw new Error(
            data?.error ?? "The agent did not respond. Nothing was changed.",
          );
        }

        const widgets: Widget[] = Array.isArray(data.widgets) ? data.widgets : [];
        const invoices: InvoicePayload[] = Array.isArray(data.invoices)
          ? data.invoices
          : [];
        const disputes: DisputeSummary[] = Array.isArray(data.disputes)
          ? data.disputes
          : [];
        const [firstWidget, ...otherWidgets] = widgets;
        const [firstInvoice, ...otherInvoices] = invoices;
        const [firstDispute, ...otherDisputes] = disputes;
        const omitted =
          typeof data.invoicesOmitted === "number" && data.invoicesOmitted > 0
            ? data.invoicesOmitted
            : 0;

        setMessages((previous) => [
          ...previous,
          {
            id: nextId(),
            role: "assistant",
            content: data.text,
            widget: firstWidget ?? null,
            // The sentence that says "created it" and the file to send are one
            // turn: the card rides on that message rather than trailing it.
            invoice: firstInvoice ?? null,
            dispute: firstDispute ?? null,
          },
          ...otherWidgets.map((widget) => ({
            id: nextId(),
            role: "assistant" as const,
            content: "",
            widget,
          })),
          ...otherInvoices.map((invoice) => ({
            id: nextId(),
            role: "assistant" as const,
            content: "",
            invoice,
          })),
          ...otherDisputes.map((dispute) => ({
            id: nextId(),
            role: "assistant" as const,
            content: "",
            dispute,
          })),
          /*
           * Cards are capped per answer, so a list of sixteen invoices shows
           * three. Saying how many were left off keeps the transcript honest
           * about what it is not showing.
           */
          ...(omitted > 0
            ? [
                {
                  id: nextId(),
                  role: "system" as const,
                  tone: "info" as const,
                  content: `${omitted} more ${
                    omitted === 1 ? "invoice is" : "invoices are"
                  } on record. Name one and its card appears with the file, the pay link and the reminder.`,
                },
              ]
            : []),
        ]);

        // The reply, handed back so a voice turn can be read out. Typed
        // turns ignore it.
        return data.text;
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "The agent did not respond.";
        setMessages((previous) => [
          ...previous,
          { id: nextId(), role: "system", tone: "danger", content: detail },
        ]);
        // Failures are returned too: a voice turn that fell over must say so
        // rather than opening its mouth at nothing.
        return `I could not answer that. ${detail}`;
      } finally {
        setBusy(false);
      }
    },
    [busy, draft, messages, fetchActions],
  );

  const canSend = draft.trim().length > 0 && !busy;
  const connection = connectionState(status, statusTimedOut);
  /*
   * The examples belong to the greeting, not to the transcript: they stay up
   * until the user has asked something, and the proactive sweep arriving a
   * moment after load does not take them down. Keying them to a message count
   * did exactly that, because the sweep adds two messages within a second or
   * two of the greeting.
   */
  const chipsVisible = !messages.some((message) => message.role === "user");

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="flex h-dvh flex-col bg-bg-main">
      <header className="sticky top-0 z-20 border-b border-border-subtle bg-bg-main/85 backdrop-blur-sm">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center gap-3 px-4 py-2 sm:px-6">
          <CoinBaneLogo size={22} />
          {/* Wordmark with the brand quote in place of the tagline. The quote is
              far longer than what it replaced, so the bar is sized by content
              rather than a fixed height, and it still hides below 480px so the
              header compresses to the mark and the word alone on a phone. */}
          <span className="flex min-w-0 flex-col justify-center gap-1">
            <span className="text-[12px] font-semibold uppercase leading-none tracking-[0.28em] text-text-primary">
              CoinBane
            </span>
            <span className="hidden text-[10px] leading-snug tracking-wide text-text-secondary xs:block">
              {BRAND_QUOTE.text}
            </span>
          </span>

          <span className="ml-auto flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${connection.dot}`}
              aria-hidden
            />
            <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-text-secondary">
              {connection.label}
            </span>
            <span className="ml-1 flex items-center">
              <CommandHelp />
            </span>
          </span>
        </div>
      </header>

      <main
        className="relative flex-1 overflow-y-auto overscroll-contain"
        aria-label="Conversation"
        aria-busy={busy}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(120%_100%_at_50%_0%,rgba(99,216,255,0.05),transparent_65%)]"
        />

        <div className="relative mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:space-y-6 sm:px-6 sm:py-8">
          {messages.map((message, index) => (
            <Fragment key={message.id}>
              <Message message={message} />

              {/*
               * The example commands sit directly under the greeting — the
               * first message, whatever else has arrived since — and retire
               * once the user has asked something of their own.
               */}
              {index === 0 && chipsVisible ? (
                <div className="animate-fade-in flex flex-wrap items-center gap-x-1.5 gap-y-2 pl-0.5 text-[12px] text-text-secondary">
                  <span>Try:</span>
                  {EXAMPLE_COMMANDS.map((command, chipIndex) => (
                    <span key={command} className="flex items-center gap-1.5">
                      {chipIndex > 0 ? (
                        <span aria-hidden className="text-text-secondary/60">
                          &middot;
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(command);
                          textareaRef.current?.focus();
                        }}
                        className="rounded-full border border-border-subtle bg-bg-card/60 px-2.5 py-1 text-[11px] leading-none text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/40"
                      >
                        {command}
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </Fragment>
          ))}

          {busy ? <Message message={null} pending /> : null}

          {actions.length > 0 ? (
            <section
              aria-label="Drafted actions"
              className="animate-rise-in flex w-full max-w-full flex-col items-start sm:max-w-[88%]"
            >
              <div className="mb-1.5 flex items-center gap-2 pl-0.5">
                <CoinBaneLogo size={13} glow={false} />
                <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-accent-glow">
                  CoinBane
                </span>
              </div>
              <p className="mb-2 text-[12px] text-text-secondary">
                {actions.length === 1
                  ? "One leak is drafted, awaiting your word."
                  : actions.length + " leaks are drafted, awaiting your word."}
              </p>
              <div className="flex w-full flex-col gap-2">
                {actions.map((action) => (
                  <ApprovalCard
                    key={action.id}
                    action={action}
                    onApprove={approve}
                    onSkip={skip}
                    pending={pendingAction === action.id}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <div ref={endRef} className="h-px w-full" />
        </div>
      </main>

      <div
        className="sticky bottom-0 z-20 border-t border-border-subtle bg-bg-main/90 backdrop-blur-sm"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {toast ? (
          <div className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-6">
            <p
              role="status"
              className="animate-fade-in rounded-md border border-border-subtle bg-bg-elevated px-3 py-2 text-[12px] leading-relaxed text-text-primary"
            >
              {toast}
            </p>
          </div>
        ) : null}

        <div className="mx-auto flex w-full max-w-3xl px-4 pt-3 sm:px-6">
          <button
            type="button"
            onClick={() => void send(WHAT_TO_DO_TODAY)}
            disabled={busy}
            className="rounded-full border border-border-subtle bg-bg-card px-3 py-1.5 text-[11px] tracking-wide text-text-secondary transition-colors hover:border-accent-primary/40 hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {WHAT_TO_DO_TODAY}
          </button>
        </div>

        <form
          onSubmit={onSubmit}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 px-4 py-3 sm:px-6"
        >
          {/*
           * The microphone sits left of the composer: the input grows and the
           * Send button has to stay flush right. `send` doubles as the
           * handler — it sends the heard line and hands back the reply for
           * the button to read out.
           */}
          <MicButton onTranscript={send} />
          <label htmlFor="coinbane-input" className="sr-only">
            Message CoinBane
          </label>
          <textarea
            id="coinbane-input"
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Tell CoinBane what to do"
            autoComplete="off"
            spellCheck={false}
            className="max-h-[200px] min-h-11 flex-1 resize-none overflow-y-auto rounded-md border border-border-subtle bg-bg-card px-3.5 py-3 text-[15px] leading-6 text-text-primary outline-none transition-colors placeholder:text-text-secondary/70 focus:border-accent-primary/60"
          />
          <button
            type="submit"
            disabled={!canSend}
            className="h-11 shrink-0 rounded-md bg-accent-primary px-4 text-[13px] font-medium tracking-wide text-bg-main transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-35"
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

export default Chat;
