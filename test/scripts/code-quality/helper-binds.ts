/**
 * What a SQL helper call carries: the statement text its first argument
 * names, and the bind list its second argument holds — a bare name or an
 * inline array, past the type arguments a generic call carries.
 * `findRepeatedBinds` reads the bind lists beside the `args` object forms,
 * and the numbered-token rule resolves the statement names to constants.
 */

import { skipComment } from "#scripts/typescript-lex.ts";
import {
  firstArgumentComma,
  matchingBracket,
  pastSpaces,
  pastTypeArguments,
} from "#test/scripts/code-quality/brackets.ts";
import {
  type Block,
  visibleDeclaration,
} from "#test/scripts/code-quality/scopes.ts";

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

/** The bare names the file's SQL helper calls receive as their first
 *  argument, each with the position of its call: the statement text travels
 *  through them. A call whose argument list never closes names nothing, and
 *  the same name in another scope is a different constant. */
export type SqlUse = { at: number; name: string };

export const sqlConstantUses = (blanked: string): SqlUse[] => {
  const uses: SqlUse[] = [];
  for (const name of SQL_HELPERS) {
    for (const { at, open } of callOpens(blanked, name)) {
      const comma = firstArgumentComma(blanked, open);
      const close = matchingBracket(blanked, open);
      if (close < 0) continue;
      const end = comma >= 0 ? comma : close;
      const argument = blanked.slice(open + 1, end).trim();
      if (BARE_NAME.test(argument)) uses.push({ at, name: argument });
    }
  }
  return uses;
};

/** Every `const`/`let` declaration position of one file, by name. The
 *  annotation a declaration may carry ends at its `=`, so one match covers
 *  one declaration and a match never spans two statements. */
const NAME_DECLARATION =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;{}]*?)?=/g;

export const nameDeclarations = (
  blanked: string,
): Map<string, { start: number }[]> => {
  const declarations = new Map<string, { start: number }[]>();
  for (const match of [...blanked.matchAll(NAME_DECLARATION)]) {
    const name = match[1] as string;
    const starts = declarations.get(name) ?? [];
    starts.push({ start: match.index });
    declarations.set(name, starts);
  }
  return declarations;
};

/** The declaration positions the file's SQL helper calls receive: the
 *  binding visible at a call is the constant whose string spans count as
 *  SQL text. A bare name without a visible declaration names nothing. */
export const sqlCarryingStarts = (
  blanked: string,
  blocks: Block[],
  declarations: Map<string, { start: number }[]>,
): Set<number> => {
  const carrying = new Set<number>();
  for (const { at, name } of sqlConstantUses(blanked)) {
    const visible = visibleDeclaration(blocks, declarations.get(name), at);
    if (visible !== undefined) carrying.add(visible.start);
  }
  return carrying;
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
