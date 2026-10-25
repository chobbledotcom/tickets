/**
 * The bind lists that arrive through a SQL helper call: the second argument
 * of the query and write helpers, a bare name or an inline array, past the
 * type arguments a generic call carries. `findRepeatedBinds` reads these
 * beside the `args` object forms.
 */

import { skipComment } from "#scripts/typescript-lex.ts";
import {
  firstArgumentComma,
  matchingBracket,
  pastSpaces,
  pastTypeArguments,
} from "#test/scripts/code-quality/brackets.ts";

/** The SQL query and write helpers whose second call argument carries a
 * statement's bind list. `execute` also matches member calls (`tx.execute`);
 * the type arguments a generic call carries sit between the name and the
 * argument list. The parity test beside this module holds the set against
 * the client module's exports. */
export const SQL_HELPERS = new Set([
  "execute",
  "executeReturningRow",
  "executeWithoutCacheInvalidation",
  "queryAll",
  "queryIdColumn",
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

/** The first index at or after `at` that is neither whitespace nor a
 * comment: where the call's first argument starts. The walk reads
 * `content`, where the comments still show. */
const pastBlanks = (content: string, at: number): number => {
  let cursor = pastSpaces(content, at);
  for (;;) {
    const after = skipComment(content, cursor);
    if (after === cursor) return cursor;
    cursor = pastSpaces(content, after);
  }
};

/** Where each SQL helper call's statement text begins: the string or
 * template literal that opens the call's first argument, or nothing when the
 * call passes an expression there, or when the call's text ends before the
 * argument. `blanked` names the real calls; the opening character is read
 * from `content` at the same index, where the quotes still show. */
export const sqlTextArgumentStarts = (
  content: string,
  blanked: string,
): Set<number> => {
  const starts = new Set<number>();
  for (const name of SQL_HELPERS) {
    for (const { open } of callOpens(blanked, name)) {
      const at = pastBlanks(content, open + 1);
      const opening = content[at];
      if (opening === undefined) continue;
      if (!"\"'`".includes(opening)) continue;
      starts.add(at);
    }
  }
  return starts;
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

const BARE_NAME = /^[A-Za-z_$][\w$]*$/;

/** The names of the locals a SQL helper call receives as its first
 *  argument: the statement text travels through them, so a string one of
 *  them holds is SQL text wherever the file assigns it. */
export const sqlCarryingNames = (blanked: string): Set<string> => {
  const names = new Set<string>();
  for (const name of SQL_HELPERS) {
    for (const { open } of callOpens(blanked, name)) {
      const comma = firstArgumentComma(blanked, open);
      const close = matchingBracket(blanked, open);
      if (close < 0) continue;
      const argument = blanked
        .slice(open + 1, comma >= 0 ? comma : close)
        .trim();
      if (BARE_NAME.test(argument)) names.add(argument);
    }
  }
  return names;
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
