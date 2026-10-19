import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FACE_BLACK,
  FACE_BOX,
  FACE_EYES,
  FACE_OUTLINE,
  FACE_SPLIT,
  FACE_TOP,
  FACE_WHITE,
  blackHalfPath,
  facePath,
  openMouthPieces,
  pupilPoints,
  smirkPieces,
  splitXAt,
  toPath,
  type Point,
} from "./face.ts";

/**
 * The face is a set of claims about where things are — a torn line down the
 * middle, black to the right of it and white to the left, an eye in each half,
 * a mouth cut in two where it crosses — and every one of them is arithmetic.
 * So they are checked here rather than judged in a screenshot.
 *
 * The helpers below are written from scratch rather than imported: sharing
 * lib/face.ts's own maths would only show that it agrees with itself.
 */

const AXIS = FACE_BOX / 2;

/** Ray casting. Only points strictly inside are asked about here. */
function inside(polygon: readonly Point[], [x, y]: Point): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const straddles = yi > y !== yj > y;
    if (straddles && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Distance from a point to one segment. */
function toSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function distanceToLine(line: readonly Point[], point: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i += 1) {
    nearest = Math.min(nearest, toSegment(point, line[i - 1]!, line[i]!));
  }
  return nearest;
}

/** The mirror of a point, about the face's axis. */
function mirror([x, y]: Point): Point {
  return [2 * AXIS - x, y];
}

function same(a: Point, b: Point): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * Every number in a path string, read back as points. The point of it: the
 * checks below then run against what actually gets drawn, not against the
 * arrays it was drawn from.
 */
function pathPoints(path: string): Point[] {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  assert.equal(numbers.length % 2, 0, `odd number of coordinates in ${path}`);
  const points: Point[] = [];
  for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i]!, numbers[i + 1]!]);
  return points;
}

describe("the face's colours", () => {
  it("are pitch black and bone white, exactly as pinned", () => {
    assert.equal(FACE_BLACK, "#000000");
    assert.equal(FACE_WHITE, "#F1F4F8");
  });
});

describe("the head", () => {
  it("is one closed curve and nothing else", () => {
    const path = facePath();

    assert.ok(path.startsWith(`M ${FACE_TOP[0]} ${FACE_TOP[1]}`));
    assert.ok(path.endsWith(" Z"));
    // Four segments, all cubic: the head is the only curve in the design, and
    // this is the assertion that keeps it that way.
    assert.equal(path.match(/C/g)?.length, 4);
    assert.ok(!path.includes("L "), "the head should have no straight edges");
  });

  it("starts on its own axis", () => {
    assert.equal(FACE_TOP[0], AXIS);
  });

  it("is symmetric about that axis", () => {
    const points: Point[] = [FACE_TOP];
    for (const curve of FACE_OUTLINE) points.push(...curve);

    for (const point of points) {
      assert.ok(
        points.some((other) => same(other, mirror(point))),
        `nothing mirrors (${point[0]}, ${point[1]})`,
      );
    }
  });

  it("is widest below the middle, at the cheekbones", () => {
    const widest = FACE_OUTLINE[0]![2]!;
    const chin = FACE_OUTLINE[1]![2]!;

    assert.ok(widest[1]! > (FACE_TOP[1] + chin[1]!) / 2, "widest point should sit below the middle");
    assert.equal(Math.abs(widest[0] - AXIS), Math.abs(mirror(widest)[0] - AXIS));
  });
});

describe("the split", () => {
  it("runs from above the skull to below the chin", () => {
    const top = FACE_SPLIT[0]!;
    const bottom = FACE_SPLIT[FACE_SPLIT.length - 1]!;

    assert.ok(top[1]! < FACE_TOP[1], "the torn line starts above the head");
    assert.ok(bottom[1]! > 30, "and finishes below it");
  });

  it("descends, never doubling back", () => {
    for (let i = 1; i < FACE_SPLIT.length; i += 1) {
      assert.ok(
        FACE_SPLIT[i]![1]! > FACE_SPLIT[i - 1]![1]!,
        `the split rises at y ${FACE_SPLIT[i]![1]}`,
      );
    }
  });

  it("zigzags near the axis, so it divides the head rather than slicing a corner off", () => {
    for (const [x, y] of FACE_SPLIT) {
      assert.ok(Math.abs(x - AXIS) < 1.5, `the split wanders to x ${x} at y ${y}`);
    }
    // And it actually zigzags: the torn edge is not a straight line.
    const sides = new Set(FACE_SPLIT.map(([x]) => Math.sign(x - AXIS)));
    assert.equal(sides.size, 2);
  });

  it("returns each of its own corners through splitXAt", () => {
    // The interpolation has to agree with the line it describes, because
    // everything that meets the split — the mouth — is placed through it.
    for (const [x, y] of FACE_SPLIT) {
      assert.ok(Math.abs(splitXAt(y) - x) < 1e-9, `splitXAt(${y}) missed its vertex`);
    }
  });

  it("is a single straight run across the mouth", () => {
    const from = 22.6;
    const to = 27.6;
    const inside = FACE_SPLIT.filter(([, y]) => y > from && y < to);

    assert.equal(inside.length, 0, "a turn inside the mouth would break the seam");
    assert.ok(splitXAt(25.6) > 15 && splitXAt(25.6) < 17, "the mouth's centre should be near the middle");
  });
});

describe("the two halves", () => {
  const black: Point[] = pathPoints(blackHalfPath());

  it("put black on the right of the split and white on the left", () => {
    // The black region is a polygon hung off the torn line, so a point either
    // side of it says which half is which.
    assert.ok(inside(black, [26, 16]), "the right of the face should be black");
    assert.ok(inside(black, [26, 26]), "including low on the right");
    assert.ok(!inside(black, [6, 16]), "the left of the face should not be black");
    assert.ok(!inside(black, [6, 26]), "nor low on the left");
  });

  it("hang the black region off the split itself, squared off past the head", () => {
    const onTheLine = black.slice(0, FACE_SPLIT.length);
    assert.deepEqual(onTheLine, FACE_SPLIT.map(([x, y]) => [x, y]));
    // ...and then out to a corner well clear of the head, to be clipped by it.
    for (const [x] of black.slice(FACE_SPLIT.length)) {
      assert.ok(x > FACE_BOX, "the black region should overhang the head");
    }
  });
});

describe("the eyes", () => {
  it("are one in each half, matching the half they are drawn in", () => {
    for (const eye of FACE_EYES) {
      for (const [x, y] of eye.corners) {
        const margin = eye.onBlack ? x - splitXAt(y) : splitXAt(y) - x;
        assert.ok(margin > 0.5, `a corner at (${x}, ${y}) is too close to the split`);
      }
    }
  });

  it("are mirror images of each other", () => {
    const [left, right] = FACE_EYES;

    assert.equal(left!.onBlack, false);
    assert.equal(right!.onBlack, true);
    for (const corner of left!.corners) {
      assert.ok(
        right!.corners.some((other) => same(other, mirror(corner))),
        `nothing mirrors (${corner[0]}, ${corner[1]})`,
      );
    }
    assert.ok(same(mirror(left!.pupil), right!.pupil));
  });

  it("sit inside the head, with room around them", () => {
    for (const eye of FACE_EYES) {
      for (const corner of eye.corners) {
        assert.ok(
          inside(FACE_OUTLINE.flat(), corner),
          `an eye corner at (${corner[0]}, ${corner[1]}) is outside the head`,
        );
        assert.ok(distanceToLine(FACE_OUTLINE.flat(), corner) > 1.5);
      }
    }
  });

  it("hold their pupils inside the slit, at rest and at every extreme", () => {
    for (const eye of FACE_EYES) {
      const slit = [...eye.corners];
      for (const shift of [
        [0, 0],
        [eye.travel, eye.travel],
        [-eye.travel, eye.travel],
        [eye.travel, -eye.travel],
        [-eye.travel, -eye.travel],
      ] as Point[]) {
        const centre: Point = [eye.pupil[0] + shift[0], eye.pupil[1] + shift[1]];
        assert.ok(inside(slit, centre), `the pupil leaves the slit at (${centre[0]}, ${centre[1]})`);
        for (const corner of pupilPoints(eye, shift)) {
          assert.ok(inside(slit, corner), "the pupil should not cross the slit's edge");
        }
      }
      assert.deepEqual(pupilPoints(eye), pupilPoints(eye, [0, 0]));
    }
  });
});

describe("the mouth", () => {
  const pieces = [...smirkPieces(), ...openMouthPieces()];

  it("is cut in two exactly on the split", () => {
    for (const [left, right] of [smirkPieces(), openMouthPieces()]) {
      // One shared point, and it is where the pieces were cut apart — the
      // resting mouth is a line and the open one is a shape, so the join is
      // found rather than assumed.
      const shared = left.filter((point) => right.some((other) => same(point, other)));

      assert.equal(shared.length, 1, "the pieces should meet at exactly one point");
      assert.ok(
        distanceToLine(FACE_SPLIT, shared[0]!) < 1e-9,
        "and that point has to be on the split",
      );
    }
  });

  it("keeps each piece on its own side of the split", () => {
    for (const piece of smirkPieces()) {
      const left = piece[0]![0]! < AXIS;
      for (const [x, y] of piece) {
        const margin = left ? splitXAt(y) - x : x - splitXAt(y);
        assert.ok(margin >= -1e-9, `a mouth corner at (${x}, ${y}) crosses the split`);
      }
    }
  });

  it("is wide, and reaches across both halves", () => {
    const xs = smirkPieces().flat().map(([x]) => x);

    assert.ok(Math.min(...xs) < 8, "the grin reaches the left cheek");
    assert.ok(Math.max(...xs) > 24, "and the right one");
  });

  it("stays inside the head", () => {
    for (const point of pieces.flat()) {
      assert.ok(inside(FACE_OUTLINE.flat(), point), `mouth point (${point[0]}, ${point[1]})`);
      assert.ok(distanceToLine(FACE_OUTLINE.flat(), point) > 0.5);
    }
  });

  it("drops its jaw into a gap when it opens", () => {
    const [, smirkRight] = smirkPieces();
    const [, openRight] = openMouthPieces();
    const lowest = (piece: readonly Point[]) => Math.max(...piece.map(([, y]) => y));
    const rightmost = (piece: readonly Point[]) =>
      piece.reduce((best, point) => (point[0] > best[0] ? point : best));

    assert.ok(lowest(openRight) > lowest(smirkRight), "the open mouth should hang lower");
    // Both states share the corners: the jaw moves, the grin does not slide.
    assert.ok(same(rightmost(smirkRight), rightmost(openRight)));
  });
});

describe("toPath", () => {
  it("closes a shape by default and leaves a line open on request", () => {
    assert.match(toPath(FACE_SPLIT), / Z$/);
    assert.ok(!toPath(FACE_SPLIT, false).endsWith("Z"));
  });

  it("emits every point in order, rounded to two decimals", () => {
    const path = toPath(FACE_SPLIT);

    assert.ok(!path.includes("0000000"), "coordinates should not carry float noise");
    assert.deepEqual(
      pathPoints(path),
      FACE_SPLIT.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
    );
  });
});
