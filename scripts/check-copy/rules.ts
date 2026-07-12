/**
 * Simple-language checks for the user-facing copy catalog.
 *
 * This module is pure: it takes copy strings in and returns a list of issues
 * out, so every rule is trivially unit-testable. The IO shell that reads the
 * locale JSON files lives in `run.ts`.
 *
 * The rules here are the *mechanical* half of the "Simple Language" guide in
 * AGENTS.md — the parts a machine can judge without reading for tone. They stay
 * deliberately narrow (few false positives) and mostly guard against
 * regressions: the catalog already passes them, so the value is keeping it that
 * way. Prose quality (short sentences, plain words a reader can follow) still
 * needs a human eye.
 */

/** One translatable string from the locale catalog. */
export interface CopyEntry {
  file: string;
  key: string;
  value: string;
}

/** A place where one copy string breaks a simple-language rule. */
export interface CopyIssue {
  file: string;
  /** How to put it right. */
  fix: string;
  key: string;
  /** What was found in the copy. */
  problem: string;
  rule: string;
}

/** What one rule found in a single copy string. */
type Finding = { problem: string; fix: string };

/** A named rule: given one copy string, list what it flags (empty if clean). */
interface Rule {
  find: (value: string) => Finding[];
  name: string;
}

/**
 * A whole `<code>…</code>` or `<pre>…</pre>` block. These hold literal route,
 * CLI, or config examples whose exact spacing and wording are intentional and
 * must never be read as prose. Uses non-capturing groups so `String.split`
 * returns only the prose between blocks, not the tag names.
 */
const CODE_BLOCK = /<(?:code|pre)\b[^>]*>[\s\S]*?<\/(?:code|pre)>/gi;

/**
 * The prose pieces of a string with the code/pre examples lifted out — split at
 * each block rather than blanked to a space, so a space on either side of an
 * example never joins across the removed block into a false "double space".
 */
const proseSegments = (value: string): string[] => value.split(CODE_BLOCK);

/** The readable words of a string: code examples and HTML tags removed, so the
 * word checks read what the user reads rather than the markup around it. */
const prose = (value: string): string =>
  value.replace(CODE_BLOCK, " ").replace(/<[^>]+>/g, " ");

/**
 * Formal or old-fashioned words that have a plainer everyday twin. Modelled
 * after the GOV.UK "words to avoid" list. Each `avoid` is matched
 * case-insensitively on whole words; keep them to letters and spaces so the
 * alternation below needs no regular-expression escaping.
 */
export const PLAIN_WORDS: { avoid: string; use: string }[] = [
  { avoid: "utilise", use: "use" },
  { avoid: "utilize", use: "use" },
  { avoid: "commence", use: "start" },
  { avoid: "terminate", use: "end or stop" },
  { avoid: "aforementioned", use: "this" },
  { avoid: "furthermore", use: "also" },
  { avoid: "moreover", use: "also" },
  { avoid: "henceforth", use: "from now on" },
  { avoid: "kindly", use: "nothing — just drop it" },
  { avoid: "leverage", use: "use" },
  { avoid: "facilitate", use: "help" },
  { avoid: "endeavour", use: "try" },
  { avoid: "endeavor", use: "try" },
  { avoid: "ascertain", use: "find out" },
  { avoid: "requisite", use: "needed" },
  { avoid: "hereby", use: "nothing — just drop it" },
  { avoid: "whereby", use: "where" },
  { avoid: "thereof", use: "of it" },
  { avoid: "herein", use: "here" },
  { avoid: "whilst", use: "while" },
  { avoid: "amongst", use: "among" },
  { avoid: "pursuant to", use: "under" },
  { avoid: "in order to", use: "to" },
  { avoid: "prior to", use: "before" },
  { avoid: "subsequent to", use: "after" },
  { avoid: "in the event that", use: "if" },
];

const plainerWord = new Map(PLAIN_WORDS.map((w) => [w.avoid, w.use]));

/** One alternation over every avoided word, matched on whole words. */
const FORMAL_WORDS = new RegExp(
  `\\b(${PLAIN_WORDS.map((w) => w.avoid).join("|")})\\b`,
  "gi",
);

/** Non-descriptive link text: "click here", "tap below", and the like. */
const VAGUE_LINK = /\b(?:click|tap)\s+(?:here|below)\b/gi;

/** Two or more spaces in a row read as a typo and break even spacing. */
const doubleSpace: Rule = {
  find: (value) =>
    proseSegments(value).some((segment) => / {2,}/.test(segment))
      ? [{ fix: "use a single space", problem: "two or more spaces in a row" }]
      : [],
  name: "double-space",
};

/** Link text must name where it goes, for skimmers and screen-reader users. */
const descriptiveLinks: Rule = {
  find: (value) =>
    [...new Set([...prose(value).matchAll(VAGUE_LINK)].map((m) => m[0]))].map(
      (hit) => ({
        fix: 'name the destination, e.g. "View your ticket"',
        problem: `vague link text "${hit}"`,
      }),
    ),
  name: "descriptive-links",
};

/** Prefer the plain everyday word over the formal one. */
const plainWords: Rule = {
  find: (value) =>
    [...prose(value).matchAll(FORMAL_WORDS)].map((m) => {
      const found = m[1]!;
      return {
        fix: `use "${plainerWord.get(found.toLowerCase())!}"`,
        problem: `formal word "${found}"`,
      };
    }),
  name: "plain-words",
};

/** Every rule the checker runs, applied to every copy string. */
export const RULES: Rule[] = [doubleSpace, descriptiveLinks, plainWords];

/** Run every rule over every copy string and collect what they flag. */
export const findIssues = (entries: CopyEntry[]): CopyIssue[] =>
  entries.flatMap((entry) =>
    RULES.flatMap((rule) =>
      rule.find(entry.value).map(({ problem, fix }) => ({
        file: entry.file,
        fix,
        key: entry.key,
        problem,
        rule: rule.name,
      })),
    ),
  );

/** One human-readable line describing an issue. */
export const formatIssue = (issue: CopyIssue): string =>
  `${issue.file} ${issue.key} [${issue.rule}]: ${issue.problem} — ${issue.fix}`;
