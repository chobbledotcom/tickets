/**
 * Simplified Technical English checks for repository Markdown.
 *
 * This module is pure: it takes Markdown prose in and returns issues out, so
 * every rule is trivially unit-testable. The IO shell that reads the files
 * lives in `run.ts`.
 *
 * The rules here are the *mechanical* half of the "Simplified Technical
 * English" guide in AGENTS.md — the patterns a machine can flag without
 * reading for meaning. The machine never reads machine-owned spans: code,
 * link targets, tables, and quoted words (the guide quotes its own
 * counterexamples, and those keep the fault they show). Prose quality — the
 * right verb form, the plain word — still needs a human eye.
 */

/** One line of prose from one Markdown file, machine-owned spans removed. */
export interface ProseLine {
  /** 1-based line number in the original file. */
  line: number;
  text: string;
}

import type { PerFileFinding } from "#scripts/check-runner.ts";

/** Where a rule found a Simplified Technical English problem. */
export type SteIssue = PerFileFinding;

/**
 * Replace every machine-owned span in one line with a `%`, which breaks word
 * boundaries on both sides: no rule can match across a code span, and a
 * double space never joins into a false word. Machine-owned spans: inline
 * code, HTML comments, autolinks, and link targets. The link text stays
 * prose; the destination does not.
 */
export const stripMachineSpans = (line: string): string =>
  line
    .replace(/`[^`]*`/g, "%")
    .replace(/<!--.*?-->/g, "%")
    .replace(/<[^>]+>/g, "%")
    .replace(/\]\([^)]*\)/g, "%");

/** Blank every quoted span — every character but a line break becomes `%` —
 * so a span that wraps across lines keeps every line number in place. */
export const blankQuotedSpans = (content: string): string =>
  content.replace(/"[^"]*"/g, (span) => span.replace(/[^\n]/g, "%"));

/** The opening fence of a code block: three or more backticks or tildes. */
const FENCE = /^(\s*)(`{3,}|~{3,})/;

/** Whether `fence` closes a block that `open` opened: same marker, at
 * least as long. */
const sameFence = (fence: string, open: string): boolean =>
  fence[0] === open[0] && fence.length >= open.length;

/** The open fence after one line. `fence` marks a fence line, which either
 * closes `open` or becomes the new open fence. */
const fenceState = (
  fence: string | null,
  open: string | null,
): string | null => {
  if (fence === null) return open;
  if (open === null) return fence;
  return sameFence(fence, open) ? null : open;
};

/**
 * The prose lines of one Markdown file: fenced code blocks and table rows are
 * dropped line-by-line, and every remaining line has its machine-owned spans
 * removed. A line is a table row when the first character of its content is
 * `|`, the way every table in this repository is written.
 *
 * A fence closes only on the marker it opened with: Markdown pairs the
 * closing fence with the opening one, so a `~~~` line inside a ` ``` `
 * block is code, not a terminator.
 */
export const proseLines = (content: string): ProseLine[] => {
  const lines: ProseLine[] = [];
  let openFence: string | null = null;
  for (const [index, raw] of blankQuotedSpans(content).split("\n").entries()) {
    const fence = FENCE.exec(raw)?.[2] ?? null;
    openFence = fenceState(fence, openFence);
    if (fence !== null || openFence !== null) continue;
    if (raw.trimStart().startsWith("|")) continue;
    lines.push({ line: index + 1, text: stripMachineSpans(raw) });
  }
  return lines;
};

/** Contractions the guide names: pronoun contractions, `'d`, and every
 * `n't`. */
const CONTRACTION =
  /\b\w+n't\b|\b(?:it|that|there|what|who|he|she|let|you|we|they|i)'s\b|\b(?:i|you|we|they|he|she|it|that|there|who|what)'(?:re|ve|ll|m|d)\b/gi;

/** The present perfect the guide names, spotted by its passive marker. */
const HAS_BEEN = /\b(?:has|have|had) been\b/gi;

/** The modals the guide bans, at any capitalization — a sentence-initial
 * `Should` or `Would` cannot slip through. Capital-`M` `May` is left alone:
 * the machine cannot tell the month from a modal question, and in technical
 * prose capital-`M` May is the month almost always. */
const BANNED_MODAL = /\b(?:should|would|might|could)\b/gi;

/** The modal `may` on its own, lowercase: capital-`M` `May` is the month. */
const BANNED_MAY = /\bmay\b/g;

/** One word from the guide's delete-or-replace list, not run into a longer
 * word. The lookahead, not a trailing `\b`, ends the match: a word like
 * `e.g.` ends in a dot, and no boundary exists between a dot and a space. */
const wordyPattern = (word: string): RegExp =>
  new RegExp(`\\b${word.replace(/\./g, "\\.")}(?!\\w)`, "gi");

/** A word from the guide's delete-or-replace list. */
const WORDY: Record<string, string> = {
  comprehensive: "delete it; it adds no fact",
  "e.g.": 'write "for example"',
  "in order to": 'write "to"',
  "in the event that": 'write "if"',
  leverage: 'write "use"',
  powerful: "delete it; it adds no fact",
  "prior to": 'write "before"',
  robust: "delete it; it adds no fact",
  seamlessly: "delete it; it adds no fact",
  simply: "delete it; it adds no fact",
  utilize: 'write "use"',
};

/** Every occurrence of `pattern` in `line`, as one issue apiece. */
const matchIssues = (
  pattern: RegExp,
  fix: string,
  rule: string,
  line: string,
  lineNo: number,
): SteIssue[] =>
  [...line.matchAll(pattern)].map((match) => ({
    fix,
    line: lineNo,
    problem: `"${match[0]}"`,
    rule,
  }));

/** A rule for one plain pattern: every occurrence in a line is one issue. */
const findingsFor =
  (pattern: RegExp, fix: string, rule: string) =>
  (line: string, lineNo: number): SteIssue[] =>
    matchIssues(pattern, fix, rule, line, lineNo);

const contractionIssues = findingsFor(
  CONTRACTION,
  'write the words in full, e.g. "do not"',
  "contraction",
);

const hasBeenIssues = findingsFor(
  HAS_BEEN,
  'write the simple past or present, e.g. "completed"',
  "present-perfect",
);

const modalIssues = [
  findingsFor(BANNED_MODAL, "use can, will, or must", "banned-modal"),
  findingsFor(BANNED_MAY, "use can, will, or must", "banned-modal"),
];

const semicolonIssues = findingsFor(/;/g, "write two sentences", "semicolon");

/** The `, making it easy` family: an -ing clause tacked onto a comma. */
const PARTICIPLE =
  /,\s+(making|allowing|giving|showing|letting|causing|keeping|using|forcing|hiding|leaving)\b/gi;

const participleIssues = (line: string, lineNo: number): SteIssue[] =>
  [...line.matchAll(PARTICIPLE)].map((match) => ({
    fix: "write a new sentence",
    line: lineNo,
    problem: `", ${match[1]}"`,
    rule: "participle",
  }));

const wordyIssues = (line: string, lineNo: number): SteIssue[] =>
  Object.entries(WORDY).flatMap(([word, fix]) =>
    matchIssues(wordyPattern(word), fix, "wordy", line, lineNo),
  );

/** Every rule the checker runs, applied to every prose line. */
const RULES = [
  contractionIssues,
  hasBeenIssues,
  ...modalIssues,
  semicolonIssues,
  participleIssues,
  wordyIssues,
];

/**
 * Run every rule over the prose of a file's content and collect what they
 * flag, in line order.
 */
export const findIssues = (content: string): SteIssue[] =>
  proseLines(content).flatMap(({ line, text }) =>
    RULES.flatMap((rule) => rule(text, line)),
  );
