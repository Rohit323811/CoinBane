/**
 * The CoinBane face, as numbers.
 *
 * A mask the size of the mark: a rounded head split down the middle by a jagged
 * line, black on the right of it and bone white on the left, with a slanted eye
 * on each side and a wide grin that runs across the seam. Everything here is
 * straight edges except the head itself — the one curve in the design.
 *
 * One shape, four places: the header wordmark, the message attribution, the
 * thinking indicator and the floating mascot all read this module, so the face
 * cannot drift between them. Only the favicon cannot import it (a static .svg
 * has no imports), which is why app/icon.svg repeats the same coordinates as a
 * literal.
 *
 * Everything is in one 32-unit square: a unit is 1px in a 32px mark, 1.75px at
 * the mascot's 56px, and 0.4px in the 13px attribution label.
 */

/** One corner, in the 32-unit square the face is drawn in. */
export type Point = readonly [number, number];

/** The square every coordinate below lives in. */
export const FACE_BOX = 32;

/** The face's own axis and middle. Both are 16. */
const AXIS_X = FACE_BOX / 2;

/**
 * The two colours the face is allowed. Strictly black and white — no tints, no
 * greys — because the whole point of it is the split.
 */
export const FACE_BLACK = "#000000";
export const FACE_WHITE = "#F1F4F8";

/**
 * The one accent, and the only colour the face is ever given on top of its two:
 * a cyan edging that keeps the half the page would otherwise hide from
 * disappearing into it. Never used for the face's own features.
 */
export const FACE_GLOW = "#63D8FF";

/** Where the head starts, before its first curve. */
export const FACE_TOP: Point = [AXIS_X, 1.6];

/**
 * A cubic segment: two control points and the point it lands on.
 */
export type Curve = readonly [Point, Point, Point];

/**
 * The head, clockwise from the top of the skull: down the right side, across
 * the chin, up the left. Three things are deliberate.
 *
 * It is a squared-off mask and not a ball: each corner's control points sit out
 * near that corner, so the top, the cheeks and the chin all have long straight
 * runs between short turns. A control point out along the circle instead would
 * round the whole thing into a disc — which is what an emoji is, and the one
 * thing this is not meant to look like.
 *
 * The widest point sits low, at the cheekbones rather than at the eyes.
 *
 * And every control point has a twin on the other side of the axis, which is
 * what makes the split down the middle mean anything: the two halves are the
 * same half.
 */
export const FACE_OUTLINE: readonly Curve[] = [
  // The flat of the skull, round the right temple, to the cheekbone.
  [
    [26.8, 1.6],
    [30.4, 5.2],
    [30.4, 17.4],
  ],
  // Straight down the cheek, round the jaw corner, into the chin.
  [
    [30.4, 27.8],
    [27.6, 31],
    [16, 31],
  ],
  // And the mirror of those two, back up the left.
  [
    [4.4, 31],
    [1.6, 27.8],
    [1.6, 17.4],
  ],
  [
    [1.6, 5.2],
    [5.2, 1.6],
    [16, 1.6],
  ],
];

/**
 * The split: a torn line from above the skull to below the chin, zigzagging
 * across the axis as it goes.
 *
 * It is the spine of the whole design — the black half is everything to its
 * right, the white half everything to its left, and the mouth is cut in two
 * where it crosses. So its turns are placed where nothing has to meet them,
 * and between y 22.6 and y 27.6 it is a single straight run, which is the run
 * the mouth is cut on.
 */
export const FACE_SPLIT: readonly Point[] = [
  [15.3, -1.5],
  [16.9, 2.6],
  [15.1, 6.4],
  [17, 10.6],
  [15.2, 14.8],
  [16.7, 19.2],
  [15.4, 22.6],
  [16.4, 27.6],
  [15.6, 33.5],
];

/**
 * Where the split is at a given height. The split is the only thing the two
 * halves share, so this is how anything that has to meet it — the mouth, and
 * the tests that check it does — finds it.
 */
export function splitXAt(y: number): number {
  const first = FACE_SPLIT[0]!;
  const last = FACE_SPLIT[FACE_SPLIT.length - 1]!;
  // Above and below the line, carry on with its end points rather than
  // pretending there is a value: callers only ever ask within its span.
  if (y <= first[1]) return first[0];
  if (y >= last[1]) return last[0];

  for (let i = 1; i < FACE_SPLIT.length; i += 1) {
    const [x0, y0] = FACE_SPLIT[i - 1]!;
    const [x1, y1] = FACE_SPLIT[i]!;
    if (y >= y0 && y <= y1) {
      const travelled = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return x0 + (x1 - x0) * travelled;
    }
  }

  return last[0];
}

/** The head as a closed path. */
export function facePath(): string {
  const body = FACE_OUTLINE.map(
    ([c1, c2, end]) =>
      `C ${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${end[0]} ${end[1]}`,
  ).join(" ");
  return `M ${FACE_TOP[0]} ${FACE_TOP[1]} ${body} Z`;
}

/**
 * The black half: everything to the right of the split, squared off well past
 * the head and meant to be clipped by it. Clipping is what keeps the torn edge
 * exactly the torn edge — a hand-fitted polygon would have to be chased along
 * every zigzag, and would still be wrong at the chin.
 */
export function blackHalfPath(): string {
  const [first, ...rest] = FACE_SPLIT;
  const body = rest.map(([x, y]) => `L ${x} ${y}`).join(" ");
  const far = FACE_BOX + 2;
  const last = FACE_SPLIT[FACE_SPLIT.length - 1]!;
  return `M ${first![0]} ${first![1]} ${body} L ${far} ${last[1]} L ${far} ${first![1]} Z`;
}

/**
 * One eye. The slit is four corners — outer, upper, inner, lower — which is a
 * diamond lying on its side: the sharpest shape that still reads as an eye.
 * `onBlack` says which half it is drawn in, and therefore which of the two
 * colours it takes; the pupil always takes the other one.
 */
export type FaceEye = {
  /** Outer corner, upper edge, inner corner, lower edge. */
  corners: readonly [Point, Point, Point, Point];
  /** Where the pupil sits when the cursor is nowhere near. */
  pupil: Point;
  /** How far, in units, the pupil may travel from there. */
  travel: number;
  /** True when the eye is drawn on the black half. */
  onBlack: boolean;
};

/**
 * The eyes, both on the same line, angled so the inner corners drop toward the
 * split — the difference between a glare and a stare.
 */
export const FACE_EYES: readonly FaceEye[] = [
  // The white half, so a black eye with a white pupil in it.
  {
    corners: [
      [6.4, 12.8],
      [11, 13],
      [14.4, 16.9],
      [9.4, 16.6],
    ],
    pupil: [10.3, 14.8],
    travel: 0.6,
    onBlack: false,
  },
  // The black half, so the same eye inverted: white, and lit.
  {
    corners: [
      [25.6, 12.8],
      [21, 13],
      [17.6, 16.9],
      [22.6, 16.6],
    ],
    pupil: [21.7, 14.8],
    travel: 0.6,
    onBlack: true,
  },
];

/** The pupil's half-width, and half its height. A diamond, like the socket. */
export const PUPIL_HALF_W = 0.8;
export const PUPIL_HALF_H = 1;

/** The pupil as four corners, moved by however far the cursor has pulled it. */
export function pupilPoints(eye: FaceEye, shift: Point = [0, 0]): readonly Point[] {
  const x = eye.pupil[0] + shift[0];
  const y = eye.pupil[1] + shift[1];
  return [
    [x, y - PUPIL_HALF_H],
    [x + PUPIL_HALF_W, y],
    [x, y + PUPIL_HALF_H],
    [x - PUPIL_HALF_W, y],
  ];
}

/** How far either side of the axis the mouth reaches, at its corners. */
export const MOUTH_HALF_W = 9.4;

/** Where the resting mouth's middle sits. The split is a straight run here. */
const SMIRK_CENTRE_Y = 25.6;

/**
 * Where the open mouth's middle sits. Lower, and — because the split leans as
 * it descends — a little further left: the corners have to stay on the line the
 * two halves meet along, or the mouth would show a sliver of the wrong colour
 * at the seam while it talks.
 */
const OPEN_CENTRE_Y = 28;

/** The mouth's corners, and the two points that shape the grin between them. */
const CORNER_LEFT: Point = [AXIS_X - MOUTH_HALF_W + 0.4, 22.8];
const CORNER_RIGHT: Point = [AXIS_X + MOUTH_HALF_W - 0.2, 22.4];
const SMIRK_LEFT_MID: Point = [11.6, 25];
const SMIRK_RIGHT_MID: Point = [20.4, 24.8];

/**
 * The resting mouth, in two pieces that meet on the split.
 *
 * Two pieces rather than one line with a clip around it: the halves are drawn
 * in opposite colours, and cutting the geometry means the join survives the
 * talking animation, which a clip would not — a clip moves with whatever
 * transform it is under, so the seam would swell along with the jaw.
 */
export function smirkPieces(): readonly [readonly Point[], readonly Point[]] {
  const centre: Point = [splitXAt(SMIRK_CENTRE_Y), SMIRK_CENTRE_Y];
  return [
    [CORNER_LEFT, SMIRK_LEFT_MID, centre],
    [centre, SMIRK_RIGHT_MID, CORNER_RIGHT],
  ];
}

/**
 * The same mouth, open: each piece filled rather than stroked, so the grin
 * becomes a gap with a lip above and below it. Both pieces still hang from the
 * smirk's own corners and still meet on the split.
 */
export function openMouthPieces(): readonly [readonly Point[], readonly Point[]] {
  const centre: Point = [splitXAt(OPEN_CENTRE_Y), OPEN_CENTRE_Y];
  return [
    [CORNER_LEFT, [11.8, 25.2], centre, [11.6, 27.4], [7.4, 24.4]],
    [centre, [20.2, 25.6], CORNER_RIGHT, [24.6, 24.6], [19.8, 27.8]],
  ];
}

/**
 * How far the open mouth is squashed between syllables — the resting height of
 * the talking animation. Must match the `mascot-speak` keyframes in
 * tailwind.config.ts, which start at the same value.
 */
export const MOUTH_REST_SCALE = 0.6;

/**
 * An SVG path through `points`, in order. Closed by default; pass false for a
 * line that should keep its two ends open.
 */
export function toPath(points: readonly Point[], close = true): string {
  const [first, ...rest] = points;
  const body = rest.map(([x, y]) => `L ${round(x)} ${round(y)}`).join(" ");
  return `M ${round(first![0])} ${round(first![1])} ${body}${close ? " Z" : ""}`;
}

/**
 * Coordinates to two decimals. The proportions above are fractions of the box,
 * so they land on things like 4.199999999999999 — which is the same pixel, but
 * only after thirty needless bytes in every path.
 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
