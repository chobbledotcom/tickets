/** The code-only text pass behind the dead-export scanner's matchers: the
 * text they read after comments, strings, template chunks, and regex
 * literals are blanked. Split from detectors.ts so the scanner and its
 * preprocessing each hold one concern. */

import {
  type LexicalSpan,
  lexicalSpans,
  skipCommentOrString,
} from "#scripts/typescript-lex.ts";

/**
 * One lazyExport clause, anchored where the walk stands. The pass copies a
 * match through whole, so the quoted route name — which lives inside a string
 * literal the pass blanks — still reaches the clause matcher.
 */
const LAZY_EXPORT_CLAUSE =
  /lazyExport\(\s*\(\)\s*=>\s*import\([^)]+\),\s*"(\w+)"/y;

/** The matching `}` of the interpolation that opens at `start`, or `limit`
 * when the braces never close. Strings, comments, and nested templates are
 * skipped with the call-site scanner's helpers, so only brace depth at code
 * positions counts. */
const interpolationEnd = (
  content: string,
  start: number,
  limit: number,
): number => {
  let depth = 1;
  let k = start;
  while (k < limit) {
    const skipped = skipCommentOrString(content, k);
    if (skipped !== k) {
      k = skipped;
      continue;
    }
    const character = content[k];
    if (character === "{") depth++;
    if (character === "}") {
      depth--;
      if (depth === 0) return k;
    }
    k++;
  }
  return limit;
};

/** One span blanked to spaces, newlines kept so line offsets stay fixed. */
const blankRange = (
  content: string,
  out: string[],
  start: number,
  end: number,
): void => {
  for (let k = start; k < end; k++) {
    out[k] = content[k] === "\n" ? "\n" : " ";
  }
};

/** The text of one template span: its literal chunks blanked, the code inside
 * each top-level interpolation kept through a recursive code-only pass. An
 * interpolation is executable code, so a name read there is a real use; a
 * nested template inside an interpolation follows the whole-literal rule. */
const templateCodeOnly = (content: string, span: LexicalSpan): string => {
  const out: string[] = [];
  for (let k = span.start; k < span.end; k++) {
    out.push(content[k] === "\n" ? "\n" : " ");
  }
  let j = span.start + 1;
  const last = span.end - 1;
  while (j < last) {
    if (content[j] === "$" && content[j + 1] === "{") {
      const close = interpolationEnd(content, j + 2, last);
      const code = codeOnly(content.slice(j, close + 1));
      out.splice(j - span.start, code.length, ...code.split(""));
      j = close + 1;
      continue;
    }
    j++;
  }
  return out.join("");
};

/** Write one lexical span into `out`: a template keeps its interpolation
 * code, anything else blanks whole. Returns the index just past the span. */
const writeSpan = (
  content: string,
  out: string[],
  span: LexicalSpan,
): number => {
  if (span.kind === "string" && content[span.start] === "`") {
    const text = templateCodeOnly(content, span);
    out.splice(span.start, text.length, ...text.split(""));
  } else {
    blankRange(content, out, span.start, span.end);
  }
  return span.end;
};

/** The whole lazyExport clause at a code position, or null when none starts
 * there or the shape differs from the route table's. */
const lazyExportClauseAt = (content: string, i: number): string | null => {
  if (!content.startsWith("lazyExport(", i)) return null;
  LAZY_EXPORT_CLAUSE.lastIndex = i;
  const clause = LAZY_EXPORT_CLAUSE.exec(content);
  return clause === null ? null : clause[0];
};

/**
 * The code-only text of `content`: comments, strings, template literal
 * chunks, and regex literals blanked to spaces, with newlines kept so line
 * offsets stay fixed. Clause-shaped text in a comment or a literal therefore
 * registers no import and no usage. The walk reuses the call-site scanner's
 * lexer spans and `skipCommentOrString`, so it adds no second lexer. Two
 * stretches survive blanking: a lazyExport clause (see
 * {@link LAZY_EXPORT_CLAUSE}), and the executable code inside a template's
 * interpolations.
 */
export const codeOnly = (content: string): string => {
  const out: string[] = new Array(content.length);
  const spans = [...lexicalSpans(content)];
  let spanIndex = 0;
  let i = 0;
  while (i < content.length) {
    const span = spans[spanIndex];
    if (span && span.start === i) {
      spanIndex++;
      i = writeSpan(content, out, span);
      continue;
    }
    const clause = lazyExportClauseAt(content, i);
    if (clause) {
      out.splice(i, clause.length, ...clause.split(""));
      i += clause.length;
      // The clause swallowed the string spans inside it; drop them.
      while (spanIndex < spans.length && spans[spanIndex]!.end <= i) {
        spanIndex++;
      }
      continue;
    }
    out[i] = content[i]!;
    i++;
  }
  return out.join("");
};

/**
 * The code-only text of every file in the corpus, computed once per corpus.
 * Keyed by the contents Map instance, so the corpus is only walked the first
 * time it is queried.
 */
const codeOnlyCache = new WeakMap<Map<string, string>, Map<string, string>>();

export const codeOnlyCorpus = (
  contents: Map<string, string>,
): Map<string, string> => {
  const cached = codeOnlyCache.get(contents);
  if (cached) return cached;
  const text = new Map(
    [...contents].map(([file, content]) => [file, codeOnly(content)]),
  );
  codeOnlyCache.set(contents, text);
  return text;
};
