"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  isVoiceSupported,
  listen,
  speak,
  stopVoice,
  type VoiceMode,
} from "@/lib/voice";

/** The hover label, as specified. */
const TOOLTIP = "Voice input";

/** Shown when the browser cannot do speech at all. */
const UNSUPPORTED_TOOLTIP = "Voice not supported in this browser.";

/** How long a failure notice stays up. */
const NOTICE_MS = 4000;

/*
 * The microphone does not appear and disappear, so there is nothing to
 * subscribe to — but `useSyncExternalStore` needs a stable function that
 * looks like a subscription, or it re-subscribes on every render.
 */
function subscribeToNothing(): () => void {
  return () => {};
}

/** The mic, in outline. Stroke colour comes from the text colour on the svg. */
function MicIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* Body, then the stand. Two arcs rather than a rounded rect read better
          at 16px. */}
      <path d="M12 3.5a2.6 2.6 0 0 1 2.6 2.6v5.2a2.6 2.6 0 1 1-5.2 0V6.1A2.6 2.6 0 0 1 12 3.5z" />
      <path d="M5.8 11.2a6.2 6.2 0 0 0 12.4 0M12 17.4v3.1" />
    </svg>
  );
}

/** The speaker it becomes while the reply is being read out. */
function SpeakerIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9.5h3l4.5-3.6v12.2L7 14.5H4z" />
      <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18 6.8a7.4 7.4 0 0 1 0 10.4" />
    </svg>
  );
}

/**
 * The microphone in the composer.
 *
 * Three states, and only one button: idle (mic, muted gray), listening (cyan
 * border, pulsing icon, cyan dot) and speaking (amber border, speaker icon).
 * The state machine lives here; the chat only lends its `onTranscript`, which
 * sends the heard line to `/api/chat` and returns the agent's reply.
 *
 * Unsupported browsers get the same button, disabled, saying why — hiding the
 * control would leave the user wondering where the microphone went.
 */
export function MicButton({
  onTranscript,
}: {
  onTranscript: (text: string) => Promise<string | null>;
}) {
  const [state, setState] = useState<VoiceMode>("off");
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  /** A failure worth explaining: a blocked microphone, mostly. */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which voice session is current.
   *
   * Bumped whenever the user stops the button, so the async flow can tell the
   * difference between "the user pressed stop" and a reply that landed a
   * moment too late — and never read out a reply after a stop.
   */
  const sessionRef = useRef(0);

  /*
   * Feature detection has to survive prerendering. The chat page is built as
   * static HTML, so the first render runs on the server where `window` does
   * not exist and `isVoiceSupported()` is false — and React's hydration does
   * not patch a server-rendered `disabled` attribute, so a naive
   * `useState(isVoiceSupported())` would leave the button dead in a browser
   * that supports speech perfectly well.
   *
   * `useSyncExternalStore` with a server snapshot of false is the API for
   * exactly this: the server's answer and the client's answer are allowed to
   * differ, and React reconciles them without a hydration mismatch.
   */
  const supported = useSyncExternalStore(
    subscribeToNothing,
    () => isVoiceSupported(),
    () => false,
  );

  const stop = useCallback(() => {
    sessionRef.current += 1;
    stopVoice();
    setState("off");
  }, []);

  const start = useCallback(async () => {
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    setNotice(null);
    setState("listening");

    let heard = "";
    try {
      heard = await listen();
    } catch (error) {
      // Stopping is not a failure; anything else ends with a reason, because
      // retrying a blocked microphone would only spin.
      if (sessionRef.current !== session) return;
      setState("off");
      const reason = error instanceof Error ? error.message : "";
      setNotice(
        /not-allowed|service-not-allowed/i.test(reason)
          ? "Microphone access is blocked."
          : "Voice input stopped. Click the mic to try again.",
      );
      return;
    }

    if (sessionRef.current !== session) return;
    // Silence. Back to idle rather than listening forever.
    if (!heard) {
      setState("off");
      return;
    }

    const reply = await onTranscript(heard);
    if (sessionRef.current !== session) return;
    if (!reply) {
      setState("off");
      return;
    }

    setState("speaking");
    await speak(reply);
    // A stop during the sentence resolves `speak` too, so this is the only
    // place the loop can end — and it must not end on a stale session.
    if (sessionRef.current !== session) return;
    setState("off");
  }, [onTranscript]);

  /* The notice retires on its own, like the coin's greeting. */
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /* Leaving the page mid-sentence must not leave a microphone open. */
  useEffect(
    () => () => {
      sessionRef.current += 1;
      stopVoice();
    },
    [],
  );

  const onClick = () => {
    if (!supported) return;
    if (state === "off") void start();
    else stop();
  };

  const listening = state === "listening";
  const speaking = state === "speaking";

  /*
   * Hover colours only at rest: once the button is showing a state, the state
   * is the colour. Split into two strings rather than `hover:` variants so the
   * two never fight over the same class.
   */
  const borderClass = listening
    ? "border-accent-glow shadow-[0_0_10px_rgba(99,216,255,0.35)]"
    : speaking
      ? "border-status-warning shadow-[0_0_10px_rgba(245,185,76,0.28)]"
      : "border-border-subtle hover:border-accent-primary";
  const iconClass = listening
    ? "text-accent-glow"
    : speaking
      ? "text-status-warning"
      : "text-text-secondary hover:text-text-primary";

  const tooltipVisible = notice !== null || hovered || focused;
  // The unsupported message outranks the hover label: if the button cannot
  // work, that is what it says, whether or not it has been noticed yet.
  const tooltipText = notice ?? (supported ? TOOLTIP : UNSUPPORTED_TOOLTIP);
  const ariaLabel = notice ??
    (supported
      ? listening
        ? "Stop listening"
        : speaking
          ? "Stop speaking"
          : "Start voice input"
      : UNSUPPORTED_TOOLTIP);

  return (
    /*
     * The wrapper carries the hover and the tooltip. It has to, because a
     * disabled button swallows no pointer events at all in Chrome, and the
     * unsupported message has to be reachable by hovering the thing it is
     * about.
     */
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={onClick}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        disabled={!supported}
        aria-label={ariaLabel}
        className={`relative flex h-9 w-9 items-center justify-center rounded-full border bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-primary/50 ${borderClass} ${iconClass} ${
          supported ? "cursor-pointer" : "cursor-not-allowed opacity-45"
        }`}
        style={{ width: 36, height: 36 }}
      >
        {/* The icon breathes — 1.0 to 1.15 and back over 1.2s — while the
            mic is open. */}
        <span className={listening ? "animate-mic-pulse" : undefined}>
          {speaking ? <SpeakerIcon /> : <MicIcon />}
        </span>

        {/* The listening dot, top-right, half outside the border. */}
        {listening ? (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-glow"
          />
        ) : null}
      </button>

      {/*
       * The tooltip. Same card treatment as the coin's, centred above the
       * button rather than right-aligned: the mic sits at the left edge of
       * the composer, so right-aligning would push the text off-centre.
       */}
      <span
        role="tooltip"
        aria-hidden={!tooltipVisible}
        className={`pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-bg-main px-2.5 py-1.5 text-[12px] leading-none transition-opacity duration-150 ${
          tooltipVisible ? "opacity-100" : "opacity-0"
        } ${notice ? "text-status-warning" : "text-text-primary"}`}
      >
        {tooltipText}
      </span>
    </span>
  );
}

export default MicButton;
