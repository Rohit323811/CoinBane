"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { TAGLINE } from "@/lib/prompts";
import {
  FACE_BLACK,
  FACE_BOX,
  FACE_EYES,
  FACE_WHITE,
  MOUTH_REST_SCALE,
  blackHalfPath,
  facePath,
  openMouthPieces,
  pupilPoints,
  smirkPieces,
  toPath,
} from "@/lib/face";

/** The face's width in px. Every other measurement below is derived from it. */
const MARK_SIZE = 56;
/** Within this many px of the face's centre, it asks if you are about to click. */
const NEAR_PX = 38;
/** Within this many px of the centre, the pupils wake up and follow the cursor. */
const EYE_WAKE_PX = 72;

/** The mouth's line weight, in the face's own units. */
const MOUTH_STROKE = 2;

/** How much of an eye is left when it blinks. */
const BLINK_SCALE = 0.14;
const BLINK_MS = 130;
const BLINK_GAP_MIN_MS = 5000;
const BLINK_GAP_MAX_MS = 8000;

/**
 * One run of the mouth's speech. Must match the `mascot-speak` keyframe duration
 * in tailwind.config.ts.
 */
const SPEAK_MS = 2000;
/** How long the one-time greeting stays up after the face arrives. */
const INTRO_MS = 2000;
/** How long a tap keeps the tooltip up on a device with no cursor. */
const TAP_HOLD_MS = 2500;

/** What the face says once you are closing in. */
export const COIN_NEAR_PROMPT = "Are you about to click me?";

/** True when the user has asked the system for less motion. */
function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const head = facePath();
/** The grin at rest, and the gap it opens into when it talks. */
const [SMIRK_LEFT, SMIRK_RIGHT] = smirkPieces();
const [OPEN_LEFT, OPEN_RIGHT] = openMouthPieces();

/**
 * The face that floats over the PayPal landing page, bottom-right.
 *
 * Split down the middle: black to the right of the tear, bone white to the
 * left, an eye in each half inverted into the other's colour, and a wide grin
 * crossing the seam. It hovers, its pupils follow the cursor, and while it asks
 * whether you are about to click it the grin drops open into a gap.
 *
 * Three nested layers carry the idle motion, one transform each, because CSS
 * drives a single `transform` per element and the float, the drift and the
 * wobble run on different clocks. The face is a fourth layer on top, inside the
 * one SVG, so the eyes and the mouth can never drift off the head they belong
 * to.
 *
 * It is the doorway *out of* PayPal and into CoinBane, and that is its whole
 * job. Voice lives in the chat's own microphone button, so the face responds to
 * nothing but the pointer.
 */
export function CoinLogo() {
  const pathname = usePathname();
  const router = useRouter();
  // Unique per instance so the clip and the glow never collide.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clipId = `cb-mascot-face-${id}`;
  const glowId = `cb-mascot-glow-${id}`;

  const buttonRef = useRef<HTMLButtonElement>(null);
  /** Set on the first tap so the tooltip shows before the tap navigates. */
  const swallowClickRef = useRef(false);
  /** Last ring state seen, so the mouth only reacts to a change. */
  const nearRef = useRef(false);
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [near, setNear] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** The tagline greets once, on arrival, and is never shown again. */
  const [showIntroTooltip, setShowIntroTooltip] = useState(true);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });

  /*
   * Cursor proximity and the pupils share one listener, throttled to a frame so
   * a fast mouse does not queue a state update per pixel.
   */
  useEffect(() => {
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;

    const measure = () => {
      frame = 0;
      const node = buttonRef.current;
      if (!node) return;

      const rect = node.getBoundingClientRect();
      const dx = pointerX - (rect.left + rect.width / 2);
      const dy = pointerY - (rect.top + rect.height / 2);

      // Both rings are measured from the face's centre, not its edge. The close
      // ring covers the mark itself, so simply hovering it raises the amber
      // prompt — which is the only prompt there is after the greeting.
      const distance = Math.hypot(dx, dy);
      const isNear = distance <= NEAR_PX;
      setNear(isNear);

      /*
       * The mouth speaks one line each time the ring is entered, and stops the
       * moment it is left. Driving this from the pointer rather than from an
       * effect on `near` keeps the two in step within a single frame — and the
       * repo's lint rules forbid setting state straight out of an effect.
       */
      if (isNear !== nearRef.current) {
        nearRef.current = isNear;
        if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
        // Under reduced motion the face keeps its grin: the tooltip still
        // carries the message, so nothing is lost.
        const willSpeak = isNear && !prefersReducedMotion();
        setSpeaking(willSpeak);
        speakTimerRef.current = willSpeak
          ? setTimeout(() => setSpeaking(false), SPEAK_MS)
          : null;
      }

      // Inside the outer ring the pupils lean toward the cursor; outside it they
      // settle back to centre, so the face stares straight ahead when you are
      // nowhere near it. Returns the previous object when the pair is unchanged,
      // so a mouse moving far away costs no renders at all.
      const next =
        distance > 0 && distance <= EYE_WAKE_PX
          ? { x: dx / distance, y: dy / distance }
          : { x: 0, y: 0 };
      setGaze((previous) =>
        previous.x === next.x && previous.y === next.y ? previous : next,
      );
    };

    const onMove = (event: MouseEvent) => {
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (frame) return;

      frame = requestAnimationFrame(measure);
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  /*
   * The greeting is a one-time event: up for two seconds after the face
   * arrives, then retired. Everything after that is the proximity warning, so
   * the tagline can never turn up again as a hover label.
   */
  useEffect(() => {
    const timer = setTimeout(() => setShowIntroTooltip(false), INTRO_MS);
    return () => clearTimeout(timer);
  }, []);

  /* Drop a pending speech timer if the face goes away mid-sentence. */
  useEffect(
    () => () => {
      if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    },
    [],
  );

  /* Blink on a randomised 5-8s gap, unless the user asked for less motion. */
  useEffect(() => {
    if (prefersReducedMotion()) return;

    let openTimer: ReturnType<typeof setTimeout>;
    let closeTimer: ReturnType<typeof setTimeout>;

    const schedule = () => {
      const gap =
        BLINK_GAP_MIN_MS + Math.random() * (BLINK_GAP_MAX_MS - BLINK_GAP_MIN_MS);
      openTimer = setTimeout(() => {
        setBlinking(true);
        closeTimer = setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_MS);
      }, gap);
    };

    schedule();
    return () => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
    };
  }, []);

  const onChatPage = pathname === "/";
  // The greeting always gets its two seconds alone, so the two can never show
  // together and the warning only starts once the intro is down.
  const warningVisible = !showIntroTooltip && (hovered || near || focused || tapped);

  const onTap = () => {
    if (tapped) return;
    // First tap only announces the face; the second one travels.
    swallowClickRef.current = true;
    setTapped(true);
    window.setTimeout(() => {
      setTapped(false);
      swallowClickRef.current = false;
    }, TAP_HOLD_MS);
  };

  const onClick = useCallback(() => {
    if (swallowClickRef.current) {
      swallowClickRef.current = false;
      return;
    }

    // The landing page keeps its one job: the face is the doorway out of it.
    // Everywhere else the mark is decoration, and it is not rendered there.
    if (pathname === "/paypal") router.push("/");
  }, [pathname, router]);

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onTouchStart={onTap}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocused(false)}
      aria-label="Open CoinBane"
      /*
       * Fixed, so it floats clear of the page it overlays rather than joining
       * its flow — bottom-right, lifted clear of the composer only if the mark
       * is ever mounted next to one.
       */
      className={`fixed right-6 z-50 block rounded-xl p-0 ${
        onChatPage ? "bottom-24 lg:bottom-6" : "bottom-6"
      } h-14 w-14 cursor-pointer appearance-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#63D8FF]/70 focus-visible:ring-offset-2`}
      style={{ width: MARK_SIZE, height: MARK_SIZE }}
    >
      <span className="animate-mascot-float block h-full w-full">
        <span className="animate-mascot-drift block h-full w-full">
          <span className="animate-mascot-wobble block h-full w-full">
            <svg
              width={MARK_SIZE}
              height={MARK_SIZE}
              viewBox={`0 0 ${FACE_BOX} ${FACE_BOX}`}
              aria-hidden="true"
              className="pointer-events-none block"
              /*
               * A shadow under the face rather than a glow: it hovers a little
               * way off a white page, and the shadow is what says so. It is
               * also what keeps the bone-white half from dissolving into the
               * page it floats over.
               */
              style={{ filter: "drop-shadow(0 2px 5px rgba(8, 10, 15, 0.35))" }}
            >
              <defs>
                <clipPath id={clipId}>
                  <path d={head} />
                </clipPath>
                {/*
                 * The eye on the black half is the only light in the face, and
                 * the only thing here that glows.
                 */}
                <filter id={glowId} x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="1.4" result="blur" />
                  <feMerge>
                    <feMergeNode in="blur" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* The head, bone white. */}
              <path d={head} fill={FACE_WHITE} />

              {/* Everything to the right of the tear, in pitch black. */}
              <g clipPath={`url(#${clipId})`}>
                <path d={blackHalfPath()} fill={FACE_BLACK} />
              </g>

              {/*
               * The grin, cut in two on the tear: black across the white half,
               * white across the black one. Every feature here is drawn twice
               * for that reason — it is what makes the split read as a split
               * rather than as a line someone drew over a face.
               */}
              <g
                style={{
                  opacity: speaking ? 0 : 1,
                  transition: "opacity 200ms ease",
                }}
              >
                <path
                  d={toPath(SMIRK_LEFT, false)}
                  fill="none"
                  stroke={FACE_BLACK}
                  strokeWidth={MOUTH_STROKE}
                  strokeLinejoin="bevel"
                />
                <path
                  d={toPath(SMIRK_RIGHT, false)}
                  fill="none"
                  stroke={FACE_WHITE}
                  strokeWidth={MOUTH_STROKE}
                  strokeLinejoin="bevel"
                />
              </g>

              {/*
               * The same grin, open: two filled pieces where the smile was, so
               * the jaw drops into a gap through the syllables of "Are you
               * about to click me?". The group scales about its own middle, so
               * the height is all that moves.
               */}
              <g
                className={speaking ? "animate-mascot-speak" : undefined}
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transform: `scaleY(${MOUTH_REST_SCALE})`,
                  opacity: speaking ? 1 : 0,
                  transition: "transform 200ms ease, opacity 200ms ease",
                }}
              >
                <path d={toPath(OPEN_LEFT)} fill={FACE_BLACK} />
                <path d={toPath(OPEN_RIGHT)} fill={FACE_WHITE} />
              </g>

              {/*
               * The eyes. Slits fixed to the head, pupils loose inside them: it
               * is the pupils that follow the cursor, which is the difference
               * between a face that watches you and a face that wobbles.
               */}
              {FACE_EYES.map((eye) => (
                <g
                  key={eye.pupil[0]}
                  style={{
                    transformBox: "fill-box",
                    transformOrigin: "center",
                    transform: `scaleY(${blinking ? BLINK_SCALE : 1})`,
                    transition: "transform 60ms linear",
                  }}
                >
                  <path
                    d={toPath(eye.corners)}
                    fill={eye.onBlack ? FACE_WHITE : FACE_BLACK}
                    filter={eye.onBlack ? `url(#${glowId})` : undefined}
                  />
                  <path
                    d={toPath(
                      pupilPoints(eye, [
                        gaze.x * eye.travel,
                        gaze.y * eye.travel,
                      ]),
                    )}
                    fill={eye.onBlack ? FACE_BLACK : FACE_WHITE}
                  />
                </g>
              ))}

              {/*
               * Hairline rim, so the bone-white half keeps an edge against the
               * white page it floats over.
               */}
              <path
                d={head}
                fill="none"
                stroke="rgba(8, 10, 15, 0.42)"
                strokeWidth="0.6"
              />
            </svg>
          </span>
        </span>
      </span>

      <span
        role="tooltip"
        aria-hidden={!showIntroTooltip}
        /* The one-time greeting. White, not amber, and a 300ms fade.
           Right-aligned to the face, not centred on it: the face lives in the
           bottom-right corner of a white page, so a centred tooltip pushes the
           longer prompt past the edge of the viewport and the text gets
           clipped.

           Padding 6px 10px, radius 6px, 12px text, 150ms fade. The darkest
           surface plus a hairline border, because the face floats over white
           and a bare tooltip would wash out against it. */
        className={`pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md border border-white/10 bg-bg-main px-2.5 py-1.5 text-[12px] leading-none animate-mascot-intro-fade transition-opacity duration-300 ${
          showIntroTooltip ? "opacity-100" : "opacity-0"
        } text-text-primary`}
      >
        {TAGLINE}
      </span>

      {/*
       * The proximity warning, and the only tooltip after the greeting. Amber,
       * 150ms. Two elements rather than one that swaps its text: sharing an
       * element is what made the tagline reappear as a hover label.
       */}
      <span
        role="tooltip"
        aria-hidden={!warningVisible}
        className={`pointer-events-none absolute bottom-full right-0 mb-2 whitespace-nowrap rounded-md border border-white/10 bg-bg-main px-2.5 py-1.5 text-[12px] leading-none text-status-warning transition-opacity duration-150 ${
          warningVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        {COIN_NEAR_PROMPT}
      </span>
    </button>
  );
}

export default CoinLogo;
