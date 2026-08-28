/**
 * Pure rules for check:e2e-labels — see scripts/check-e2e-labels.ts.
 *
 * The payment e2e drives the app by its visible words (clickButton,
 * clickLink, page text), so every literal it passes is catalog copy that a
 * rename can move underneath it. That run is schedule-only, so the break
 * lands a day late on main. These rules compare each literal with the words
 * the message catalog renders, so the rename fails its own PR.
 *
 * A non-literal argument is left alone: it names the scenario's own data
 * (the listing or attendee it just created), which no catalog edit moves.
 * A deliberate literal parked in a variable dodges this check. Accidental
 * drift — the failure class — never does.
 *
 * A clicked control must equal a catalog message exactly, because its
 * accessible name is that whole message. Page-text assertions may quote a
 * fragment, so those match by case-sensitive substring.
 */

import { mapNotNullish } from "#fp";
import { byLine, type LineIssue } from "#scripts/check-report.ts";
import {
  blankSpans,
  type LexicalSpan,
  lexicalSpans,
} from "#scripts/typescript-lex.ts";
import { topLevelCommas } from "#shared/top-level-commas.ts";

/** The catalog, flattened to what a label or key is checked against. */
export interface CatalogCopy {
  /** Every message key, for example "settings.provider.update_credentials". */
  readonly keys: ReadonlySet<string>;
  /** Every message value. Controls must equal one. Page text may be part. */
  readonly values: readonly string[];
}

export interface LabelIssue extends LineIssue {
  readonly message: string;
}

/** Reports the source line a match index sits on. */
type LineOf = (index: number) => number;

/** How one scanned call names its words. */
interface LabelCall {
  /** Which argument carries the words, counted from one. */
  readonly argument: number;
  /** A free call reads `name(…)`. A member call reads `session.name(…)`. */
  readonly form: "free" | "member";
  /** A control's name is the whole message. Page text may be a fragment.
   * A key call passes the catalog key itself. */
  readonly match: "exact" | "contains" | "key";
}

/** The calls the driver makes against an app page by visible words. */
const LABEL_CALLS: Record<string, LabelCall> = {
  attendeeCatalogButtons: { argument: 2, form: "free", match: "key" },
  clickButton: { argument: 1, form: "member", match: "exact" },
  clickLink: { argument: 1, form: "member", match: "exact" },
  exactLinkCount: { argument: 2, form: "free", match: "exact" },
  pageTextCount: { argument: 3, form: "free", match: "key" },
  pageTextIncludes: { argument: 3, form: "free", match: "key" },
  requireNoExactLink: { argument: 2, form: "free", match: "exact" },
  requirePageText: { argument: 2, form: "free", match: "contains" },
};

/** A `t("key", …)` call in either quote style, not a property or longer
 * identifier ending in "t". Group 1 is the quote, group 2 the key. */
const T_KEY_CALL = /(?<![.\w$])t\s*\(\s*(["'])([a-z0-9_.-]+)\1/g;

/** A `catalogWords("group", "key", …)` call in either quote style. Group 2
 * is the key's quote, group 3 the key. */
const CATALOG_WORDS_CALL =
  /(?<![.\w$])catalogWords\s*\(\s*(["'])[a-z0-9_-]+\1\s*,\s*(["'])([a-z0-9_.-]+)\2/g;

/**
 * The top-level argument texts of the call whose "(" sits at `open`, in
 * order. Structure is read from `blank`, the copy with comments and strings
 * blanked, and each argument is sliced from `code`, where the strings still
 * hold their text. The shared top-level comma scan does the structure work.
 */
const topLevelArgs = (code: string, blank: string, open: number): string[] => {
  const { commas, end } = topLevelCommas(blank, {
    closers: ")]}",
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

/** Replacement text for each named escape. Identity escapes (`\'`, `\"`,
 * `\\`) need no row: the decoder returns the escaped character unchanged. */
const ESCAPES: Record<string, string> = {
  "0": "\0",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** One whole escape sequence: the text between the backslash and its end. A
 * backslash before a line terminator is a continuation and decodes to
 * nothing. */
const ESCAPE =
  /\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|\r\n|\r|\n|[\s\S])/g;

/** Decode one escape body: a named escape, \xHH, \uHHHH, or \u{H+}. */
const decodeEscape = (body: string): string => {
  if (body === "\r\n" || body === "\r" || body === "\n") return "";
  if (body.startsWith("x") || body.startsWith("u")) {
    const hex = body.startsWith("u{") ? body.slice(2, -1) : body.slice(1);
    return String.fromCodePoint(Number.parseInt(hex, 16));
  }
  const named = ESCAPES[body];
  return named === undefined ? body : named;
};

/** The text of a quoted literal argument, or null for any other argument.
 * Both quote styles decode the escape sequences TypeScript allows. */
const stringLiteral = (arg: string): string | null => {
  const double = arg.match(/^"((?:[^"\\]|\\[\s\S])*)"$/);
  const single = arg.match(/^'((?:[^'\\]|\\[\s\S])*)'$/);
  const quoted = double === null ? single : double;
  if (quoted === null) return null;
  return quoted[1]!.replace(ESCAPE, (_, body: string) => decodeEscape(body));
};

/** Judge one argument that carries visible words or a catalog key. */
const argumentIssue = (
  arg: string,
  catalog: CatalogCopy,
  how: LabelCall,
): string | null => {
  const literal = stringLiteral(arg);
  // A non-literal names the scenario's own data. See the header.
  if (literal === null) return null;
  if (how.match === "key") {
    return catalog.keys.has(literal)
      ? null
      : `uses key "${literal}", which src/locales/en holds nowhere. ` +
          `Give the group and key the page's template reads.`;
  }
  const renders = catalog.values.some((value) =>
    how.match === "exact" ? value === literal : value.includes(literal),
  );
  if (!renders) {
    return (
      `uses "${literal}", which no message in src/locales/en renders ` +
      `${how.match === "exact" ? "exactly" : "at all"}. ` +
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
  how: LabelCall,
  match: RegExpExecArray,
  catalog: CatalogCopy,
  lineOf: LineOf,
): LabelIssue[] => {
  const open = match.index + match[0].length - 1;
  const args = topLevelArgs(code, blank, open);
  // A spread argument hides the positions, so no static read is possible.
  if (args.some((one) => one.startsWith("..."))) return [];
  const arg = args[how.argument - 1];
  if (arg === undefined) {
    return [
      {
        line: lineOf(match.index),
        message: `calls ${method} with no argument ${how.argument} to read.`,
      },
    ];
  }
  const message = argumentIssue(arg, catalog, how);
  return message === null ? [] : [{ line: lineOf(match.index), message }];
};

/** True when a match's key quote opens a real string span, so the call is
 * executable and not words quoted inside another string. */
const opensAString = (
  spans: readonly LexicalSpan[],
  quoteAt: number,
): boolean =>
  spans.some((span) => span.kind === "string" && span.start === quoteAt);

/** Issues from every `t("key")` or `catalogWords("group", "key")` call whose
 * key the catalog dropped, in either quote style. A call named inside a
 * string literal is prose, not code, so its quoted words do not count. */
const keyIssues = (
  code: string,
  spans: readonly LexicalSpan[],
  catalog: CatalogCopy,
  lineOf: LineOf,
): LabelIssue[] => {
  const droppedKey = (
    match: RegExpExecArray,
    quote: number,
    key: number,
  ): LabelIssue | null => {
    const quoteAt = match.index + match[0].indexOf(match[quote]!);
    return opensAString(spans, quoteAt) && !catalog.keys.has(match[key]!)
      ? {
          line: lineOf(match.index),
          message:
            `asks for message key "${match[key]}", which src/locales/en holds ` +
            "nowhere. Copy renames leave this driver with nothing to click.",
        }
      : null;
  };
  const droppedTKey = (match: RegExpExecArray): LabelIssue | null =>
    droppedKey(match, 1, 2);
  const droppedCatalogKey = (match: RegExpExecArray): LabelIssue | null =>
    droppedKey(match, 2, 3);
  return [
    ...mapNotNullish(droppedTKey)([...code.matchAll(T_KEY_CALL)]),
    ...mapNotNullish(droppedCatalogKey)([...code.matchAll(CATALOG_WORDS_CALL)]),
  ];
};

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
  for (const [method, how] of Object.entries(LABEL_CALLS)) {
    const call = new RegExp(
      how.form === "free"
        ? `(?<![.\\w$])${method}\\s*\\(`
        : `\\.${method}\\s*\\(`,
      "g",
    );
    for (const match of code.matchAll(call)) {
      issues.push(
        ...callSiteIssues(code, blank, method, how, match, catalog, lineOf),
      );
    }
  }
  issues.push(...keyIssues(code, [...lexicalSpans(source)], catalog, lineOf));

  return issues.sort(byLine);
};
