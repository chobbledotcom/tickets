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

/**
 * The readable prose of each non-code segment, with HTML tags stripped. Working
 * segment-by-segment (rather than on one joined string) means a link check
 * never matches a phrase that spans a code/pre example: a code block sitting
 * between "click" and "here" separates them into different segments instead of
 * fabricating a match.
 */
const readableSegments = (value: string): string[] =>
  proseSegments(value).map((segment) => segment.replace(/<[^>]+>/g, " "));

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
  find: (value) => {
    const hits = readableSegments(value).flatMap((segment) =>
      [...segment.matchAll(VAGUE_LINK)].map((m) => m[0]),
    );
    return [...new Set(hits)].map((hit) => ({
      fix: 'name the destination, e.g. "View your ticket"',
      problem: `vague link text "${hit}"`,
    }));
  },
  name: "descriptive-links",
};

/** Every rule the checker runs, applied to every copy string. */
export const RULES: Rule[] = [doubleSpace, descriptiveLinks];

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
