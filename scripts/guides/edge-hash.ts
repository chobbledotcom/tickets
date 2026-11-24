// effects: pure
/**
 * A short print of where a screenshot has edges. The thumbnail shrinks to a
 * 16 by 16 grid, and each bit says whether a cell is clearly brighter than the
 * cell to its right. Colour and small text changes barely move it. A block
 * that moves lands its edges in other cells.
 */

import { chunk, flatMap, map, pipe, range, sum } from "#fp";

/** The side of the greyscale thumbnail that the hash reads. */
export const THUMBNAIL_SIDE = 32;
const GRID_SIDE = 16;
const CELL_SIDE = THUMBNAIL_SIDE / GRID_SIDE;
/** How much brighter, out of 255, a cell must be to count as an edge. */
const EDGE_STEP = 4;
const BITS_PER_HEX_DIGIT = 4;
const HASH_BITS = GRID_SIDE * (GRID_SIDE - 1);

export const EDGE_HASH_PATTERN = new RegExp(
  `^[0-9a-f]{${HASH_BITS / BITS_PER_HEX_DIGIT}}$`,
);

const cellShade = (thumbnail: Uint8Array, row: number, column: number) =>
  sum(
    range(0, CELL_SIDE * CELL_SIDE).map((index) => {
      const y = row * CELL_SIDE + Math.floor(index / CELL_SIDE);
      const x = column * CELL_SIDE + (index % CELL_SIDE);
      return thumbnail[y * THUMBNAIL_SIDE + x]!;
    }),
  ) /
  (CELL_SIDE * CELL_SIDE);

/** One bit for each cell that is clearly brighter than the cell to its right. */
const rowEdges = (shades: number[]): boolean[] =>
  shades.slice(1).map((right, index) => shades[index]! - right > EDGE_STEP);

const toHexDigit = (bits: boolean[]): string =>
  bits.reduce((value, bit) => value * 2 + (bit ? 1 : 0), 0).toString(16);

const fromHexDigit = (digit: string): boolean[] =>
  range(0, BITS_PER_HEX_DIGIT).map(
    (bit) =>
      ((Number.parseInt(digit, 16) >> (BITS_PER_HEX_DIGIT - 1 - bit)) & 1) ===
      1,
  );

/** The edge hash of a 32 by 32 greyscale thumbnail, as hex text. */
export const edgeHash = (thumbnail: Uint8Array): string => {
  const expected = THUMBNAIL_SIDE * THUMBNAIL_SIDE;
  if (thumbnail.length !== expected) {
    throw new Error(
      `An edge hash needs ${expected} thumbnail bytes, not ${thumbnail.length}`,
    );
  }
  return pipe(
    flatMap((row: number) =>
      rowEdges(
        range(0, GRID_SIDE).map((column) => cellShade(thumbnail, row, column)),
      ),
    ),
    chunk(BITS_PER_HEX_DIGIT),
    map(toHexDigit),
  )(range(0, GRID_SIDE)).join("");
};

const hashBits = (hash: string): boolean[] => {
  if (!EDGE_HASH_PATTERN.test(hash)) {
    throw new Error(`Invalid edge hash ${hash}`);
  }
  return [...hash].flatMap(fromHexDigit);
};

/** The share of edges that the two screenshots have in the same place: edges
 * in both, divided by edges in either. Two pages without edges match. */
export const edgeSimilarity = (left: string, right: string): number => {
  const leftBits = hashBits(left);
  const rightBits = hashBits(right);
  const inBoth = leftBits.filter((bit, index) => bit && rightBits[index]);
  const inEither = leftBits.filter((bit, index) => bit || rightBits[index]);
  return inEither.length === 0 ? 1 : inBoth.length / inEither.length;
};

/** The percentage a person reads, rounded to a whole number. */
export const freshnessPercent = (similarity: number): number =>
  Math.round(similarity * 100);
