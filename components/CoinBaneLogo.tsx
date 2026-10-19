"use client";

import { useId } from "react";

import {
  FACE_BLACK,
  FACE_BOX,
  FACE_EYES,
  FACE_GLOW,
  FACE_WHITE,
  blackHalfPath,
  facePath,
  pupilPoints,
  smirkPieces,
  toPath,
} from "@/lib/face";

/** The mouth's line weight, in the face's own units. */
const MOUTH_STROKE = 1.8;

/**
 * The CoinBane face: a mask split down the middle, black to the right of the
 * tear and bone white to the left, with an eye in each half and a grin across
 * the seam.
 *
 * No expression of its own — the eyes do not track and the mouth does not move
 * here. That belongs to the mascot on the landing page
 * (components/CoinLogo.tsx), which draws this same geometry and adds the life.
 *
 * Drawn inline rather than shipped as a file, so its size stays a property of
 * the component: the mark is 13px in a message attribution, 18px in the
 * thinking indicator and 22px in the header.
 */
export function CoinBaneLogo({
  size = 20,
  className = "",
  glow = true,
}: {
  size?: number;
  className?: string;
  glow?: boolean;
}) {
  // Unique per instance so several marks on screen never collide.
  const id = useId().replace(/[^a-zA-Z0-9]/g, "");
  const clipId = `cb-face-${id}`;
  const glowId = `cb-face-glow-${id}`;

  const head = facePath();
  const [smirkLeft, smirkRight] = smirkPieces();

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${FACE_BOX} ${FACE_BOX}`}
      role="img"
      aria-label="CoinBane"
      className={className}
    >
      <defs>
        {/* The tear is the boundary between the halves, so the black region is
            cut by the head rather than fitted to it. */}
        <clipPath id={clipId}>
          <path d={head} />
        </clipPath>
        {glow ? (
          <filter id={glowId} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="0.8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ) : null}
      </defs>

      {/*
        * The cyan the mark is allowed: a soft halo behind the head, because half
        * the face is black and the page is nearly black too. It is dropped when
        * the caller asks for a quiet mark, and the rim below still holds the
        * silhouette.
        */}
      {glow ? (
        <path d={head} fill={FACE_GLOW} opacity="0.45" filter={`url(#${glowId})`} />
      ) : null}

      {/* The head, bone white. */}
      <path d={head} fill={FACE_WHITE} />

      {/* Everything to the right of the tear, in pitch black. */}
      <g clipPath={`url(#${clipId})`}>
        <path d={blackHalfPath()} fill={FACE_BLACK} />
      </g>

      {/*
        * The grin, cut in two on the tear: black across the white half, white
        * across the black one. The two halves of any feature here are always
        * each other's colour, which is the whole trick of the design.
        */}
      <path
        d={toPath(smirkLeft, false)}
        fill="none"
        stroke={FACE_BLACK}
        strokeWidth={MOUTH_STROKE}
        strokeLinejoin="bevel"
      />
      <path
        d={toPath(smirkRight, false)}
        fill="none"
        stroke={FACE_WHITE}
        strokeWidth={MOUTH_STROKE}
        strokeLinejoin="bevel"
      />

      {/* One eye per half, each inverted into the other. */}
      {FACE_EYES.map((eye) => (
        <g key={eye.pupil[0]}>
          <path
            d={toPath(eye.corners)}
            fill={eye.onBlack ? FACE_WHITE : FACE_BLACK}
            filter={glow && eye.onBlack ? `url(#${glowId})` : undefined}
          />
          <path
            d={toPath(pupilPoints(eye))}
            fill={eye.onBlack ? FACE_BLACK : FACE_WHITE}
          />
        </g>
      ))}

      {/* Hairline rim, so the black half keeps an edge on a dark page. */}
      <path
        d={head}
        fill="none"
        stroke={glow ? FACE_GLOW : FACE_WHITE}
        strokeOpacity={glow ? 0.4 : 0.22}
        strokeWidth="0.5"
      />
    </svg>
  );
}

export default CoinBaneLogo;
