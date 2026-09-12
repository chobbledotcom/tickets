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
export interface SteIssue extends PerFileFinding {
  /** The prose of the whole line the problem was found on, junk stripped —
   * the stable identity the baseline records, because line numbers shift
   * every time somebody edits a paragraph above. */
  context: string;
}

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
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/** A fence line, split into its marker and what follows it. */
interface FenceLine {
  /** What follows the marker: an info string when the line opens, and only
   * spaces when the line can close. */
  after: string;
  /** The backtick or tilde run that opens or closes a block. */
  marker: string;
}

/** What fence marker, if any, one line holds. */
const fenceOn = (line: string): FenceLine | null => {
  const match = FENCE.exec(line);
  // Both groups always participate: the marker run and the line remainder.
  return match === null ? null : { after: match[3]!, marker: match[2]! };
};

/** Whether `fence` closes a block that `open` opened: same marker, at least
 * as long, and only spaces after the marker — Markdown lets an opening fence
 * carry an info string (` ```ts `), but a closing fence carry none, so a
 * typed fence inside an open block is code, not a terminator. */
const sameFence = (fence: FenceLine, open: string): boolean =>
  fence.marker[0] === open[0] &&
  fence.marker.length >= open.length &&
  fence.after.trim() === "";

/** The open fence after one line. A fence line either closes `open` or
 * becomes the new open fence. */
const fenceState = (
  fence: FenceLine | null,
  open: string | null,
): string | null => {
  if (fence === null) return open;
  if (open === null) return fence.marker;
  return sameFence(fence, open) ? null : open;
};

/**
 * The prose lines of one Markdown file: fenced code blocks, indented code
 * blocks, and table rows are dropped line-by-line, and every remaining line
 * has its machine-owned spans removed. A line is a table row when the first
 * character of its content is `|`, the way every table in this repository is
 * written.
 *
 * A fence closes only on the marker it opened with: Markdown pairs the
 * closing fence with the opening one, so a `~~~` line inside a ` ``` `
 * block is code, not a terminator.
 *
 * An indented block starts at four or more leading spaces, the standard
 * Markdown code form, and runs until a line that is neither indented nor
 * blank — the way CommonMark ends one. Blank lines inside it belong to it.
 */
/** The standard Markdown code-block indent: four or more spaces, or a tab. */
const INDENT = /^(?: {4}|\t)/;

/** Whether one line sits inside an indented code block, given whether the
 * line before it did: the indent opens the block, and a non-blank line
 * without the indent closes it. Blank lines belong to the block either way. */
const insideIndentAfter = (raw: string, wasInside: boolean): boolean => {
  const indented = INDENT.test(raw);
  if (wasInside) return indented || raw.trim() === "";
  return indented;
};

export const proseLines = (content: string): ProseLine[] => {
  const lines: ProseLine[] = [];
  let openFence: string | null = null;
  let inIndentedBlock = false;
  for (const [index, raw] of blankQuotedSpans(content).split("\n").entries()) {
    const fence = fenceOn(raw);
    openFence = fenceState(fence, openFence);
    if (fence !== null || openFence !== null) continue;
    inIndentedBlock = insideIndentAfter(raw, inIndentedBlock);
    if (inIndentedBlock) continue;
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
    context: line,
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
    context: line,
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
