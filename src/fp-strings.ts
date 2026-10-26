/**
 * Curried string checks and sorts — the `#fp` combinators whose input is a
 * string rather than an array of anything. Kept beside `fp.ts` (which imports
 * nothing from here) so both stay under the file-length budget.
 */

import { sort } from "./fp.ts";

/** The items sorted by one string field, in locale order. Pass "desc" for the
 * newest (or otherwise largest) string first. */
export const sortedByString =
  <T>(valueFrom: (item: T) => string, direction: "asc" | "desc" = "asc") =>
  (items: T[]): T[] =>
    sort((a: T, b: T) =>
      direction === "desc"
        ? valueFrom(b).localeCompare(valueFrom(a))
        : valueFrom(a).localeCompare(valueFrom(b)),
    )(items);

/** Whether a text has any one of the `pieces` according to `matches` — the
 * shared walk behind the string affix checks below. */
const textHasAny =
  (matches: (text: string, piece: string) => boolean) =>
  (pieces: readonly string[]) =>
  (text: string): boolean =>
    pieces.some((piece) => matches(text, piece));

/** Whether the text starts with any of the given pieces, e.g. any known
 * prefix from a stored list. */
export const startsWithAny = textHasAny((text, piece) =>
  text.startsWith(piece),
);

/** Whether the text ends with any of the given pieces, e.g. any known file
 * ending. */
export const endsWithAny = textHasAny((text, piece) => text.endsWith(piece));

/** Whether the text contains any of the given pieces. */
export const includesAny = textHasAny((text, piece) => text.includes(piece));
