import type { PerFileFinding } from "#scripts/check-runner.ts";
import { proseBlocks } from "./prose.ts";

export interface SteIssue extends PerFileFinding {
  column: number;
  /** Normalized prose block, independent of source wraps and exempt span lengths. */
  context: string;
}

interface Rule {
  fix: string;
  pattern: RegExp;
  rule: string;
}

const WORDY: Record<string, string> = {
  comprehensive: "delete it. It adds no fact",
  "e.g.": 'write "for example"',
  "in order to": 'write "to"',
  "in the event that": 'write "if"',
  "it is worth noting": "delete it. It adds no fact",
  leverage: 'write "use"',
  powerful: "delete it. It adds no fact",
  "prior to": 'write "before"',
  robust: "delete it. It adds no fact",
  seamlessly: "delete it. It adds no fact",
  simply: "delete it. It adds no fact",
  utilize: 'write "use"',
};

const RULES: Rule[] = [
  {
    fix: 'write the words in full, for example "do not"',
    pattern:
      /\b\w+n't\b|\b(?:it|that|there|here|where|how|what|who|he|she|let|you|we|they|i)'s\b|\b(?:i|you|we|they|he|she|it|this|that|there|here|where|how|who|what)'(?:re|ve|ll|m|d)\b/gi,
    rule: "contraction",
  },
  {
    fix: 'write the simple past or present, for example "completed"',
    pattern: /\b(?:has|have|had) been\b/gi,
    rule: "present-perfect",
  },
  {
    fix: "use can, will, or must",
    pattern: /\b(?:should|would|might|could)\b/gi,
    rule: "banned-modal",
  },
  // Capital May remains exempt because it also names a month.
  { fix: "use can, will, or must", pattern: /\bmay\b/g, rule: "banned-modal" },
  { fix: "write two sentences", pattern: /;/g, rule: "semicolon" },
  {
    fix: "write a new sentence",
    pattern:
      /, (?:making|allowing|giving|showing|letting|causing|keeping|using|forcing|hiding|leaving)\b/gi,
    rule: "participle",
  },
  ...Object.entries(WORDY).map(([word, fix]) => ({
    fix,
    pattern: new RegExp(`\\b${word.replace(/\./g, "\\.")}(?!\\w)`, "gi"),
    rule: "wordy",
  })),
];

export const findIssues = (content: string): SteIssue[] =>
  proseBlocks(content).flatMap(({ text, lines, columns }) =>
    RULES.flatMap(({ pattern, fix, rule }) =>
      [...text.matchAll(pattern)].map((match) => ({
        column: columns[match.index]!,
        context: text,
        fix,
        index: match.index,
        line: lines[match.index]!,
        problem: `"${match[0]}"`,
        rule,
      })),
    )
      .sort((a, b) => a.index - b.index)
      .map(({ index: _index, ...issue }) => issue),
  );
