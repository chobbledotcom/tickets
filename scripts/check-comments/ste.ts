/**
 * The comment-language rules: the mechanical Simplified Technical English
 * patterns over a comment's prose, and the 25-word sentence limit (see
 * "Simplified Technical English — How We Write Documentation" in AGENTS.md).
 * The prose reader is the Markdown one the policy check uses: the file's
 * comments become one virtual Markdown text, and one reader judges both
 * surfaces.
 */

import type { PerFileFinding } from "#scripts/check-runner.ts";
import { type ProseBlock, proseBlocks } from "#scripts/check-ste/prose.ts";
import { issuesInBlocks } from "#scripts/check-ste/rules.ts";
import { blankDirective, readComments } from "./rules.ts";

/** The longest sentence a comment may carry. The procedural 20-word bound
 * needs the reader to tell descriptive from procedural text, which is a
 * human call, so the mechanical check holds every sentence to the
 * descriptive limit. */
export const MAX_SENTENCE_WORDS = 25;

/** The gutter a line comment carries: the slashes and one space, so an
 * indented code block keeps its four spaces. */
const LINE_GUTTER = /^\s*\/\/ ?/;

/** The gutter a block comment carries: its indent, its opener or one star,
 * and one space after them. A list marker after the gutter's star stays. */
const BLOCK_GUTTER = /^(?:\s*\*|\/\*\*?) ?/;

/** A fenced code block's marker, in backticks or tildes, indented the up to
 * three spaces Markdown allows. Text after the marker never closes the
 * fence. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A block comment's closer, stripped before the gutter reads the star it
 * shares its line with. */
const CLOSER = /\*\/\s*$/;

/** The JSDoc tag whose body is code, and the JSDoc block tags that end that
 * body. A decorator such as `@sealed` is not a JSDoc tag, so it stays inside
 * the sample. */
const EXAMPLE_TAG = /^@example\b/;
const KNOWN_TAG =
  /^@(?:abstract|access|alias|arg|argument|async|augments|author|borrows|callback|class|classdesc|constant|constructs|copyright|default(?:value)?|deprecated|description|enum|event|example|exports|external|file|fires|function|generator|global|hideconstructor|ignore|implements|inheritdoc|inner|instance|interface|internal|kind|lends|license|listens|member(?:of)?|mixes|mixin|module|name|namespace|override|package|param|private|property|protected|public|readonly|requires|remarks|returns?|satisfies|see|since|static|summary|template|this|throws|todo|tutorial|type|typedef|variation|version|yields?)\b/;

/** One row of the virtual Markdown document: its prose, and the source line
 * its findings name. */
interface Row {
  line: number;
  text: string;
}

/** The example and fence state a run of comments carries. Code between
 * comments resets it, and a block comment is self-contained. */
interface ProseState {
  /** The open fence's exact marker, or "" when no fence is open. */
  fenceMarker: string;
  inExample: boolean;
}

/** The example state one prose line leaves: an example tag starts the
 * example, and the next tag ends it. A line inside a fence changes
 * nothing. */
const exampleOf = (prose: string, state: ProseState): boolean =>
  state.fenceMarker !== ""
    ? state.inExample
    : EXAMPLE_TAG.test(prose) || (state.inExample && !KNOWN_TAG.test(prose));

/** The fence state one prose line leaves: a marker opens the fence, and a
 * closer must repeat the opener's character at least its length. Text after
 * the marker never closes the fence. */
const fenceOf = (prose: string, state: ProseState): string => {
  const match = FENCE.exec(prose);
  if (match === null) return state.fenceMarker;
  const run = match[1]!;
  if (state.fenceMarker === "") return run;
  const closes =
    run.charAt(0) === state.fenceMarker.charAt(0) &&
    run.length >= state.fenceMarker.length &&
    prose.slice(match[0].length).trim() === "";
  return closes ? "" : state.fenceMarker;
};

/** JSDoc tags whose argument is machine-owned: the name after the tag is
 * code's, not prose. */
const TAG_WITH_ARGUMENT = /^@(?:param|arg|argument|property|template)\b/;

/** An inline JSDoc tag: its target is code's, not prose. A human-readable
 * label after the target stays. A tag without one leaves "%", so the period
 * before it still ends its sentence and its identifier adds no word. */
const INLINE_TAG = /\{\s*@link(?:code|plain)?\s+([^{}]*)}/g;

const blankInlineTags = (prose: string): string =>
  prose.replace(
    INLINE_TAG,
    (_, body: string) => body.replace(/^\S+\s*/, "") || "%",
  );

/** The prose one comment line contributes: none inside an example or a
 * fence, and none for a fence marker, with the JSDoc tag, its type, and its
 * machine argument dropped. */
const rowTextOf = (prose: string, state: ProseState): string => {
  if (state.fenceMarker !== "" || FENCE.test(prose) || state.inExample) {
    return "";
  }
  const head = prose.replace(/^@[A-Za-z]+(?:\s+\{(?:[^{}]|\{[^{}]*})*})?/, "");
  return TAG_WITH_ARGUMENT.test(prose) ? head.replace(/^\s+\S+\s?/, "") : head;
};

/** One file's comments as one virtual Markdown document: one row per comment
 * line, so every finding the reader makes names the file's line directly. A
 * row holds its prose with the gutter and closer stripped. An example body,
 * a fenced block, and the machine part of a directive are blank. Code
 * between comments breaks the prose block and ends the example or fence the
 * comments carried, and a block comment starts and ends its own. */
const markdownOf = (
  content: string,
): { lineOfRow: number[]; markdown: string } => {
  const rows: Row[] = [];
  let lastLine = 0;
  let lastEnd = 0;
  let inExample = false;
  let fenceMarker = "";
  let afterBlock = false;
  for (const comment of readComments(content, { keepDirectives: true })) {
    const isLine = comment.text.startsWith("//");
    const gutter = isLine ? LINE_GUTTER : BLOCK_GUTTER;
    const codeBetween = /\S/.test(content.slice(lastEnd, comment.start));
    if (comment.line > lastLine + 1 || codeBetween || !isLine || afterBlock) {
      // Code between comments ends the state the comments carried, and a
      // block comment starts and ends its own prose block.
      inExample = false;
      fenceMarker = "";
      rows.push({ line: comment.line, text: "" });
    }
    let rowLine = comment.line;
    for (const raw of comment.text.split("\n")) {
      const prose = blankInlineTags(
        blankDirective(raw.replace(CLOSER, "").replace(gutter, "")),
      ).trimEnd();
      const state = { fenceMarker, inExample };
      inExample = exampleOf(prose, state);
      fenceMarker = fenceOf(prose, state);
      rows.push({
        line: rowLine,
        text: rowTextOf(prose, { fenceMarker, inExample }),
      });
      lastLine = rowLine;
      rowLine += 1;
    }
    lastEnd = comment.end;
    afterBlock = !isLine;
    if (!isLine) {
      // A block comment's example and fence end with its closer.
      inExample = false;
      fenceMarker = "";
    }
  }
  return {
    lineOfRow: rows.map((row) => row.line),
    markdown: rows.map((row) => row.text).join("\n"),
  };
};

/** The sentences one prose block carries: the block's normalised text split
 * on sentence punctuation, each sentence named by the source line it starts
 * on. A period followed by a lower-case word reads as mid-sentence, so an
 * abbreviation such as "etc." does not end a sentence. A closing bracket or
 * quote between the period and the space still ends it. */
const sentencesOf = (block: ProseBlock): { line: number; text: string }[] => {
  let searchFrom = 0;
  return block.text.split(/(?<=[.!?]["')\]]?)\s+(?![a-z])/).map((sentence) => {
    const offset = block.text.indexOf(sentence, searchFrom);
    searchFrom = offset + sentence.length;
    return { line: block.lines[offset]!, text: sentence };
  });
};

const wordCount = (sentence: string): number =>
  sentence
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;

/** Every long-sentence finding one file's prose blocks carry: the sentences
 * past the word limit, each written as the finding the report shows. */
const longSentenceFindings = (
  blocks: readonly ProseBlock[],
): PerFileFinding[] =>
  blocks
    .flatMap(sentencesOf)
    .map((sentence) => ({ sentence, words: wordCount(sentence.text) }))
    .filter(({ words }) => words > MAX_SENTENCE_WORDS)
    .map(({ sentence, words }) => ({
      fix: `split it or cut it to ${MAX_SENTENCE_WORDS} words`,
      line: sentence.line,
      problem: `${words}-word sentence`,
      rule: "long-sentence",
    }));

/** Every comment-language finding one file's comments carry, in source
 * order: the shared STE patterns over the Markdown reader's prose blocks,
 * and the sentences past the word limit. */
export const findCommentSteIssues = (content: string): PerFileFinding[] => {
  const { lineOfRow, markdown } = markdownOf(content);
  const blocks = proseBlocks(markdown).map((block) => ({
    ...block,
    // The document's rows carry the source lines the findings name.
    lines: block.lines.map((row) => lineOfRow[row - 1]!),
  }));
  return [...issuesInBlocks(blocks), ...longSentenceFindings(blocks)].sort(
    (a, b) => a.line - b.line,
  );
};
