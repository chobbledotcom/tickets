/**
 * Pure rules for check:e2e-labels — see scripts/check-e2e-labels.ts.
 *
 * The payment e2e drives the app by its visible words (clickButton,
 * clickLink, requirePageText), so every literal it passes is catalog copy
 * that a rename can move underneath it. That run is schedule-only, so the
 * break lands a day late on main. These rules compare each literal with the
 * words the message catalog renders, so the rename fails its own PR.
 *
 * A non-literal argument is left alone: it names the scenario's own data
 * (the listing or attendee it just created), which no catalog edit moves.
 * A deliberate literal parked in a variable dodges this check. Accidental
 * drift — the failure class — never does.
 *
 * The match is by substring, case-sensitive: a label passes when some catalog
 * message contains it verbatim. That cannot pin the exact button a phrase
 * came from, but it catches every rename of the words a spec clicks.
 */

import { mapNotNullish } from "#fp";
import { byLine, type LineIssue } from "#scripts/check-report.ts";
import { blankSpans } from "#scripts/typescript-lex.ts";
import { topLevelCommas } from "#shared/top-level-commas.ts";

/** The catalog, flattened to what a label or key is checked against. */
export interface CatalogCopy {
  /** Every message key, for example "settings.provider.update_credentials". */
  readonly keys: ReadonlySet<string>;
  /** Every message value. A label passes when one contains it verbatim. */
  readonly values: readonly string[];
}

export interface LabelIssue extends LineIssue {
  readonly message: string;
}

/** Reports the source line a match index sits on. */
type LineOf = (index: number) => number;

/** The calls the driver makes against an app page by visible words, and
 * which argument carries those words. */
const LABEL_CALLS: Record<string, number> = {
  clickButton: 1,
  clickLink: 1,
  requirePageText: 2,
};

/** A message-key call: the word `t` called with a literal key, not a
 * property or a longer identifier that merely ends in "t". */
const KEY_CALL = /(?<![.\w$])t\s*\(\s*"([a-z0-9_.-]+)"/g;

/**
 * The top-level argument texts of the call whose "(" sits at `open`, in
 * order. Structure is read from `blank`, the copy with comments and strings
 * blanked, and each argument is sliced from `code`, where the strings still
 * hold their text. The shared top-level comma scan does the structure work.
 */
const topLevelArgs = (code: string, blank: string, open: number): string[] => {
  const { commas, end } = topLevelCommas(blank, {
    closers: ")]}",
    depth: 1,
    openers: "([{",
    start: open + 1,
    stopWhenClosed: true,
  });
  let start = open + 1;
  const args = commas.map((comma) => {
    const piece = code.slice(start, comma).trim();
    start = comma + 1;
    return piece;
  });
  const last = code.slice(start, end).trim();
  if (last !== "") args.push(last);
  return args;
};

/** The text of a quoted literal argument, or null for any other argument. */
const stringLiteral = (arg: string): string | null => {
  const double = arg.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (double) return JSON.parse(`"${double[1]}"`) as string;
  const single = arg.match(/^'([^'\\]*)'$/);
  return single ? single[1]! : null;
};

/** Judge one argument that carries visible words. */
const argumentIssue = (arg: string, catalog: CatalogCopy): string | null => {
  const literal = stringLiteral(arg);
  // A non-literal names the scenario's own data. See the header.
  if (literal === null) return null;
  if (!catalog.values.some((value) => value.includes(literal))) {
    return (
      `uses "${literal}", which no message in src/locales/en renders. ` +
      `Match the new copy, or derive it with t("…") as saveCredentials does.`
    );
  }
  return null;
};

/** Issues from one scanned call's visible-word argument. */
const callSiteIssues = (
  code: string,
  blank: string,
  method: string,
  position: number,
  match: RegExpExecArray,
  catalog: CatalogCopy,
  lineOf: LineOf,
): LabelIssue[] => {
  const open = match.index + match[0].length - 1;
  const arg = topLevelArgs(code, blank, open)[position - 1];
  if (arg === undefined) {
    return [
      {
        line: lineOf(match.index),
        message: `calls ${method} with no argument ${position} to read.`,
      },
    ];
  }
  const message = argumentIssue(arg, catalog);
  return message === null ? [] : [{ line: lineOf(match.index), message }];
};

/** Issues from every `t("key", …)` call whose key the catalog dropped. */
const keyIssues = (
  code: string,
  catalog: CatalogCopy,
  lineOf: LineOf,
): LabelIssue[] =>
  mapNotNullish((match: RegExpExecArray) =>
    catalog.keys.has(match[1]!)
      ? null
      : {
          line: lineOf(match.index),
          message:
            `asks for message key "${match[1]}", which src/locales/en holds ` +
            "nowhere. Copy renames leave this driver with nothing to click.",
        },
  )([...code.matchAll(KEY_CALL)]);

/** Every way the driver's words and the catalog's words disagree. */
export const findLabelIssues = (
  source: string,
  catalog: CatalogCopy,
): LabelIssue[] => {
  // Comments become spaces, so a call site named in prose cannot be read.
  const code = blankSpans(source, false);
  // Strings become spaces too, so brackets and commas inside them cannot
  // masquerade as call structure.
  const blank = blankSpans(source, true);
  const lineOf: LineOf = (index) => source.slice(0, index).split("\n").length;

  const issues: LabelIssue[] = [];
  for (const [method, position] of Object.entries(LABEL_CALLS)) {
    const call = new RegExp(
      method === "requirePageText"
        ? `(?<![.\\w$])${method}\\s*\\(`
        : `\\.${method}\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(call)) {
      issues.push(
        ...callSiteIssues(
          code,
          blank,
          method,
          position,
          match,
          catalog,
          lineOf,
        ),
      );
    }
  }
  issues.push(...keyIssues(code, catalog, lineOf));

  return issues.sort(byLine);
};
