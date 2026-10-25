import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { blankSpans } from "#scripts/typescript-lex.ts";
import { matchingBracket } from "#test/scripts/code-quality/brackets.ts";
import {
  SQL_HELPERS,
  sqlConstantUses,
} from "#test/scripts/code-quality/helper-binds.ts";
import { REPO_ROOT } from "#test/scripts/code-quality/scan-context.ts";

/**
 * The checker's SQL helper set and the client module's exported bind helpers
 * stay one set. A new helper the set misses would let its calls escape the
 * bind checks silently. The earlier miss of `executeReturningRow` and
 * `queryIdColumn` showed how, and a name the client no longer exports would
 * leave a dead entry in the set.
 */

/** Whether a declaration's head or a type's members carry a statement's two
 * bind positions: the `sql` and the `args` the client module's bind helpers
 * spell. */
const carriesSqlAndArgs = (text: string): boolean =>
  /\bsql\b/.test(text) && /\bargs\b/.test(text);

/** The index of the first character at depth zero after `at` that `stops`
 * names, where every bracket group is skipped whole, or -1 when none comes
 * before the text ends. */
const topLevelChar = (blanked: string, at: number, stops: string): number => {
  for (let cursor = at; cursor < blanked.length; cursor++) {
    const character = blanked[cursor] as string;
    if (stops.includes(character)) return cursor;
    if ("([{".includes(character)) {
      const close = matchingBracket(blanked, cursor);
      if (close < 0) return -1;
      cursor = close;
    }
  }
  return -1;
};

/** The index of the `=` that starts one type definition, past the alias's
 * generic parameters, or -1 when no definition starts there. */
const typeDefinitionEquals = (blanked: string, nameEnd: number): number => {
  let depth = 0;
  for (let at = nameEnd; at < blanked.length; at++) {
    const character = blanked[at] as string;
    if (character === "<") depth += 1;
    if (character === ">") depth -= 1;
    if (depth === 0 && character === "=") return at;
  }
  return -1;
};

/** One bracket group's full text, or an empty text when the group never
 * closes. */
const bracketGroup = (blanked: string, open: number): string => {
  const close = matchingBracket(blanked, open);
  return close < 0 ? "" : blanked.slice(open, close + 1);
};

/** One exported declaration's head: its type annotation and the parameter
 * list its body follows, where a statement's bind positions would show. */
const declarationHead = (blanked: string, nameEnd: number): string => {
  const annotationEnd = topLevelChar(blanked, nameEnd, "=(");
  if (annotationEnd < 0) return "";
  const annotation = blanked.slice(nameEnd, annotationEnd);
  if (blanked[annotationEnd] === "(") {
    return annotation + bracketGroup(blanked, annotationEnd);
  }
  const paramsOpen = topLevelChar(blanked, annotationEnd + 1, "(;");
  return blanked[paramsOpen] === "("
    ? annotation + bracketGroup(blanked, paramsOpen)
    : annotation;
};

/** The module's types that carry a statement's two bind positions in their
 * own members: a tuple or function type spelled `sql` and `args`. An export
 * annotated with one is a bind helper even when its own parameter list stays
 * unwritten. */
const bindAliases = (blanked: string): string[] => {
  const aliases: string[] = [];
  for (const match of blanked.matchAll(/\btype\s+([A-Za-z_$][\w$]*)/g)) {
    const nameEnd = (match.index ?? 0) + match[0].length;
    const equals = typeDefinitionEquals(blanked, nameEnd);
    if (equals < 0) continue;
    const open = topLevelChar(blanked, equals + 1, "([");
    if (open < 0) continue;
    if (carriesSqlAndArgs(bracketGroup(blanked, open))) {
      aliases.push(match[1] as string);
    }
  }
  return aliases;
};

/** The exported second-argument bind helpers of one module's blanked source:
 * every export whose head carries the statement's `sql` and `args` positions,
 * or names a type that carries them. */
const exportedBindHelpers = (blanked: string): string[] => {
  const aliases = bindAliases(blanked);
  const helpers: string[] = [];
  for (const match of blanked.matchAll(
    /\bexport\s+(?:async\s+)?(?:const|function)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    const name = match[1] as string;
    const head = declarationHead(blanked, (match.index ?? 0) + match[0].length);
    const annotated = aliases.some((alias) =>
      new RegExp(`\\b${alias}\\b`).test(head),
    );
    if (carriesSqlAndArgs(head) || annotated) helpers.push(name);
  }
  return helpers;
};

describe("SQL helper set", () => {
  test("names exactly the client module's exported bind helpers", async () => {
    const source = await readFile(
      join(REPO_ROOT, "src/shared/db/client.ts"),
      "utf8",
    );
    expect(exportedBindHelpers(blankSpans(source, true)).sort()).toEqual(
      [...SQL_HELPERS].sort(),
    );
  });
});

describe("SQL constant uses", () => {
  test("skips a helper call whose argument list never closes", () => {
    const blanked = blankSpans(
      "await execute(statement, [id]);\nawait execute(statement);\nawait execute(broken",
      true,
    );
    expect(sqlConstantUses(blanked).map((use) => use.name)).toEqual([
      "statement",
      "statement",
    ]);
  });
});
