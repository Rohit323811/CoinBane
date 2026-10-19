/**
 * Voice: speech recognition in, speech synthesis out.
 *
 * Every entry point is a promise-shaped wrapper over APIs that only exist in a
 * browser, so the module is safe to import on the server: the `window` checks
 * come first and each function degrades to `false`, a no-op, or a rejection
 * rather than throwing when the module is evaluated.
 *
 * The Web Speech API is not in TypeScript's DOM lib — `SpeechRecognition` is
 * still vendor-prefixed and unstandardised — so the shapes it needs are
 * declared here, narrowly, instead of widening `Window` globally.
 */

export type VoiceMode = "off" | "listening" | "speaking";

const RECOGNITION_LANG = "en-US";

interface RecognitionAlternative {
  transcript?: string;
}

interface RecognitionEvent {
  results?: ArrayLike<ArrayLike<RecognitionAlternative>>;
}

interface RecognitionErrorEvent {
  error?: string;
}

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type RecognitionConstructor = new () => Recognition;

/** Chrome ships the prefixed one; Safari and older builds need the fallback. */
function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null;

  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };

  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

function hasSynthesis(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

/**
 * True only when this browser can both hear and talk.
 *
 * False on the server, so the button that offers voice mode can be rendered
 * without a hydration mismatch.
 */
export function isVoiceSupported(): boolean {
  return recognitionConstructor() !== null && hasSynthesis();
}

/** The recognition session currently open, so turning voice off can end it. */
let activeRecognition: Recognition | null = null;

/**
 * Listens for one utterance and resolves with what was heard.
 *
 * Rejects when recognition is unavailable, and also when the session fails or
 * is stopped — the caller treats every rejection the same way, by ending voice
 * mode rather than asking again, so a blocked microphone cannot spin.
 */
export function listen(): Promise<string> {
  const Constructor = recognitionConstructor();
  if (!Constructor) {
    return Promise.reject(new Error("Speech recognition is not supported."));
  }

  return new Promise<string>((resolve, reject) => {
    const recognition = new Constructor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = RECOGNITION_LANG;

    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      if (activeRecognition === recognition) activeRecognition = null;
      finish();
    };

    const transcriptFrom = (event: RecognitionEvent): string => {
      const results = event?.results;
      if (!results || results.length === 0) return "";
      const alternative = results[results.length - 1]?.[0];
      return typeof alternative?.transcript === "string"
        ? alternative.transcript.trim()
        : "";
    };

    recognition.onresult = (event) =>
      settle(() => resolve(transcriptFrom(event)));
    recognition.onerror = (event) =>
      settle(() =>
        reject(new Error(event?.error ?? "Speech recognition failed.")),
      );
    // Ending without a result means silence, not failure.
    recognition.onend = () => settle(() => resolve(""));

    activeRecognition = recognition;

    try {
      recognition.start();
    } catch (error) {
      settle(() =>
        reject(
          error instanceof Error
            ? error
            : new Error("Speech recognition could not start."),
        ),
      );
    }
  });
}

/**
 * Says one line out loud, resolving when it finishes.
 *
 * A failed utterance resolves too: speech is the last step of a loop that must
 * always come back to listening, and a promise that never settles would strand
 * voice mode in "speaking".
 */
export function speak(text: string): Promise<void> {
  if (!hasSynthesis()) return Promise.resolve();

  const synthesis = window.speechSynthesis;
  // Cancel first, as specified: a previous line must never talk over this one.
  synthesis.cancel();

  const line = text.trim();
  if (!line) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const utterance = new SpeechSynthesisUtterance(line);
    utterance.rate = 1.0;
    /** Slightly low and unhurried: the same quiet authority as the copy. */
    utterance.pitch = 0.9;
    utterance.volume = 1.0;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    utterance.onend = finish;
    utterance.onerror = finish;

    synthesis.speak(utterance);
  });
}

/**
 * Ends whatever voice is doing: the open microphone and any speech.
 *
 * This is the fourth export, and it exists because turning voice mode off
 * requires stopping a recognition session that `listen()` is already awaiting;
 * without it there is no way to cancel one.
 */
export function stopVoice(): void {
  if (typeof window === "undefined") return;

  const recognition = activeRecognition;
  activeRecognition = null;
  // `abort` ends the session immediately; `stop` would wait for the result
  // the user is no longer giving.
  recognition?.abort();

  if (hasSynthesis()) window.speechSynthesis.cancel();
}

/*
 * There used to be a window-event bridge here that carried a heard question
 * to the chat and the reply back to the coin. Voice now lives in the chat's
 * own microphone button, which calls `send` and reads back what it returns,
 * so the bridge went with it.
 */
