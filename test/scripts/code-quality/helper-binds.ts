/**
 * The bind lists that arrive through a SQL helper call: the second argument
 * of the query and write helpers, a bare name or an inline array, past the
 * type arguments a generic call carries. `findRepeatedBinds` reads these
 * beside the `args` object forms.
 */

import {
  firstArgumentComma,
  matchingBracket,
} from "#test/scripts/code-quality/brackets.ts";

/** The SQL query and write helpers whose second call argument carries a
 * statement's bind list. `execute` also matches member calls (`tx.execute`);
 * the type arguments a generic call carries sit between the name and the
 * argument list. */
const SQL_HELPERS = new Set([
  "execute",
  "executeWithoutCacheInvalidation",
  "queryAll",
  "queryOne",
  "queryOnePrimary",
  "requireOne",
  "requireOnePrimary",
  "rowExists",
]);

/** The one bind list a call's second argument carries: a bare name, or the
 * span of an inline array. Null when the call passes nothing comparable
 * there: one argument only, a member chain, a literal, or a function. */
type SecondBind =
  | { array: { close: number; open: number }; kind: "array" }
  | { kind: "name"; name: string };

const secondCallArgument = (
  blanked: string,
  open: number,
): SecondBind | null => {
  const comma = firstArgumentComma(blanked, open);
  if (comma < 0) return null;
  const rest = blanked.slice(comma + 1);
  const named = rest.match(/^\s*([A-Za-z_$][\w$]*)\s*[,)\]]/);
  if (named) return { kind: "name", name: named[1] as string };
  const inline = rest.match(/^\s*\[/);
  if (inline === null) return null;
  const arrayOpen = comma + 1 + inline[0].length - 1;
  const arrayClose = matchingBracket(blanked, arrayOpen);
  return arrayClose < 0
    ? null
    : { array: { close: arrayClose, open: arrayOpen }, kind: "array" };
};

/** The first index at or after `at` whose character is not whitespace. */
const pastSpaces = (blanked: string, at: number): number => {
  let cursor = at;
  while (cursor < blanked.length && /\s/.test(blanked[cursor] as string)) {
    cursor += 1;
  }
  return cursor;
};

/** The index just past one balanced `<…>` type-argument group starting at
 * `at`, or `at` itself when no group starts there. */
const pastTypeArguments = (blanked: string, at: number): number => {
  if (blanked[at] !== "<") return at;
  let depth = 0;
  for (let cursor = at; cursor < blanked.length; cursor++) {
    if (blanked[cursor] === "<") depth += 1;
    if (blanked[cursor] === ">") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return at;
};

/** The index of the `(` that opens a call's argument list after `at`, past
 * any balanced type arguments, or -1. */
const argumentListOpen = (blanked: string, at: number): number => {
  const afterGenerics = pastSpaces(
    blanked,
    pastTypeArguments(blanked, pastSpaces(blanked, at)),
  );
  return blanked[afterGenerics] === "(" ? afterGenerics : -1;
};

/** The argument lists of one helper's calls: where the call starts and where
 * its `(` opens. */
const callOpens = (
  blanked: string,
  name: string,
): { at: number; open: number }[] => {
  const opens: { at: number; open: number }[] = [];
  for (const match of [...blanked.matchAll(new RegExp(`\\b${name}\\b`, "g"))]) {
    const open = argumentListOpen(blanked, match.index + name.length);
    if (open >= 0) opens.push({ at: match.index, open });
  }
  return opens;
};

/** The positions where a statement receives its bind list: an `args: name`
 * property, the `args` shorthand in an object literal, and the second
 * argument of a SQL helper call — a bare name or an inline array. */
export type BindUse =
  | { array: { close: number; open: number }; at: number; kind: "array" }
  | { at: number; kind: "name"; name: string };

export const argumentUses = (blanked: string): BindUse[] => {
  const uses: BindUse[] = [];
  for (const match of [
    ...blanked.matchAll(/\bargs\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g),
  ]) {
    uses.push({ at: match.index, kind: "name", name: match[1] as string });
  }
  for (const match of [...blanked.matchAll(/\{[^{}]*\bargs\s*(?=[,}])/g)]) {
    uses.push({ at: match.index, kind: "name", name: "args" });
  }
  for (const name of SQL_HELPERS) {
    for (const { at, open } of callOpens(blanked, name)) {
      const second = secondCallArgument(blanked, open);
      if (second === null) continue;
      if (second.kind === "name") {
        uses.push({ at, kind: "name", name: second.name });
      } else {
        uses.push({ array: second.array, at, kind: "array" });
      }
    }
  }
  return uses;
};
