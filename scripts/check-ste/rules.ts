import type { PerFileFinding } from "#scripts/check-runner.ts";
import { type ProseBlock, proseBlocks } from "./prose.ts";

export interface SteIssue extends PerFileFinding {
  column: number;
  /** Normalised prose block, independent of source wraps and exempt span lengths. */
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

/** The irregular past participles the present-perfect rule knows by heart.
 * A word whose noun reading forms a compound directly after had stays off
 * the list: "cost overruns", "ground beef". */
const PARTICIPLES = [
  "arisen",
  "been",
  "become",
  "begun",
  "bent",
  "bitten",
  "blown",
  "bought",
  "bound",
  "bred",
  "brought",
  "built",
  "burnt",
  "caught",
  "chosen",
  "come",
  "dealt",
  "done",
  "drawn",
  "driven",
  "drunk",
  "eaten",
  "fallen",
  "fed",
  "felt",
  "fled",
  "flown",
  "forgotten",
  "found",
  "frozen",
  "gotten",
  "given",
  "gone",
  "got",
  "grown",
  "had",
  "heard",
  "held",
  "hidden",
  "hit",
  "hurt",
  "kept",
  "known",
  "laid",
  "led",
  "left",
  "lent",
  "let",
  "lost",
  "made",
  "meant",
  "met",
  "mistaken",
  "paid",
  "put",
  "read",
  "ridden",
  "risen",
  "run",
  "said",
  "seen",
  "sold",
  "sent",
  "shaken",
  "shed",
  "shot",
  "shown",
  "shut",
  "slept",
  "spoken",
  "spent",
  "split",
  "spread",
  "stood",
  "stolen",
  "struck",
  "stuck",
  "sung",
  "sunk",
  "sworn",
  "taken",
  "taught",
  "thought",
  "thrown",
  "told",
  "torn",
  "understood",
  "woken",
  "withheld",
  "withdrawn",
  "won",
  "worn",
  "written",
];

/** -ed words that are nouns or the adverb "indeed", not participles: had
 * and have take them as objects, so they name no present perfect. */
const NOT_PARTICIPLES = [
  "bed",
  "breed",
  "creed",
  "deed",
  "feed",
  "greed",
  "heed",
  "indeed",
  "need",
  "red",
  "seed",
  "speed",
  "weed",
];

/** A participle that heads a hyphenated compound ("has required-child
 * edges", "has built-in support") carries an attributive noun phrase, not a
 * present perfect, so a hyphen after the participle stops the match. */
const PRESENT_PERFECT = new RegExp(
  `\\b(?:has|have|had)\\s+(?:${PARTICIPLES.join("|")}\\b|(?!(?:${NOT_PARTICIPLES.join("|")})\\b)\\w+ed\\b)(?!-)`,
  "gi",
);

/** The mechanical STE patterns one prose run is judged by, shared by the
 * Markdown check (`findIssues`) and the source-comment check
 * (`scripts/check-comments/ste.ts`). */
export const STE_RULES: Rule[] = [
  {
    fix: 'write the words in full, for example "do not"',
    pattern:
      /\b\w+n't\b|\b(?:it|that|there|here|where|how|what|who|he|she|let|you|we|they|i)'s\b|\b(?:i|you|we|they|he|she|it|this|that|there|here|where|how|who|what)'(?:re|ve|ll|m|d)\b/gi,
    rule: "contraction",
  },
  {
    fix: 'write the simple past or present, for example "completed"',
    pattern: PRESENT_PERFECT,
    rule: "present-perfect",
  },
  {
    fix: "use can, will, or must",
    pattern: /\b(?:should|would|might|could)\b/gi,
    rule: "banned-modal",
  },
  // Capital May remains exempt because it also names a month.
  { fix: "use can, will, or must", pattern: /\bmay\b/g, rule: "banned-modal" },
  {
    fix: "write two sentences",
    pattern: /(?<!&[a-zA-Z]{1,10});/g,
    rule: "semicolon",
  },
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

/** Every STE finding the prose blocks hold, one per pattern match, each
 * naming its line and column in the source the blocks were read from. */
export const issuesInBlocks = (blocks: readonly ProseBlock[]): SteIssue[] =>
  blocks.flatMap(({ text, lines, columns }) =>
    STE_RULES.flatMap(({ pattern, fix, rule }) =>
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

export const findIssues = (content: string): SteIssue[] =>
  issuesInBlocks(proseBlocks(content));
