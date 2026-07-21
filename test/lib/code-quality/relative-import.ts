import { blankSpans, skipComment, skipString } from "./detectors.ts";

/**
 * No relative "../" imports — use a `#` alias instead.
 *
 * Walk `contents` token-by-token, skipping comments and string literals, and
 * find every `import` declaration whose module specifier walks up a directory
 * (`../…` or `./../…`). Returns one violation per offending import.
 *
 * Why a token-aware walk instead of a regex? Two of the import forms a `../`
 * rule has to catch are inherently cross-line: a multi-line dynamic
 * `import(\n  "../x")` and a static `import { x }\n from\n "../x"` whose
 * specifier sits on the next line. A line-level regex sees each line in
 * isolation and would miss the specifier. They were once covered by a separate
 * file-level regex — but a regex can't tell the difference between an
 * `import "../x"` *statement* and the text `import "../x"` *as data* inside a
 * string literal or comment, so it both missed valid forms (a
 * `import(/* note *\/ "../x")` with a comment in the gap) and risked false
 * positives on test fixtures quoting that exact text. The walk below resolves
 * both: it ignores comments and string literals, so the only specifiers it
 * inspects are the ones a real `import` carries.
 *
 * Forms handled (any can sit on one line or many):
 *
 * - `import "…"`, `import '…'` — side-effect.
 * - `import("…")`, `await import("…")` — dynamic.
 * - `import { … } from "…"`, `import x from "…"`,
 *   `import * as ns from "…"`, `import type { … } from "…"` — static.
 *
 * A specifier starting with `./` (sibling) or `#`/`@` (alias or package) is
 * left alone — only the parent-walking kind ties a file to where it sits in
 * the tree, which is what `#` aliases exist to hide.
 */

const IMPORT_LENGTH = "import".length;

const isIdentChar = (c: string): boolean => /[\w$]/.test(c);
const isWhitespace = (c: string): boolean => /\s/.test(c);

/** Whether the `import` keyword begins at `i` (word-boundary both sides). */
const isImportKeyword = (contents: string, i: number): boolean =>
  contents.startsWith("import", i) &&
  (i === 0 || !isIdentChar(contents[i - 1]!)) &&
  (i + IMPORT_LENGTH >= contents.length ||
    !isIdentChar(contents[i + IMPORT_LENGTH]!));

/** Whether the `from` keyword begins at `i` (word-boundary both sides). */
const isFromKeyword = (contents: string, i: number): boolean =>
  contents.startsWith("from", i) &&
  (i === 0 || !isIdentChar(contents[i - 1]!)) &&
  (i + 4 >= contents.length || !isIdentChar(contents[i + 4]!));

/** 1-based line number of `offset` in `contents`. */
const lineOf = (contents: string, offset: number): number =>
  contents.slice(0, offset).split("\n").length;

/**
 * Read a quoted string literal starting at `quotePos` (the opening quote).
 * Returns the full literal (including the quotes) as `specifier` and the
 * index just past the closing quote as `end`, or `null` when `quotePos` isn't
 * a string literal or when the literal is a template with a `${…}`
 * substitution — those can't be a static path, so the caller treats them as
 * "no specifier found".
 */
const readStringLiteral = (
  contents: string,
  quotePos: number,
): { specifier: string; end: number } | null => {
  const quote = contents[quotePos];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let i = quotePos + 1;
  while (i < contents.length) {
    const c = contents[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) {
      return { end: i + 1, specifier: contents.slice(quotePos, i + 1) };
    }
    if (quote === "`" && c === "$" && contents[i + 1] === "{") return null;
    i++;
  }
  return null;
};

/**
 * Walk past whitespace and comments (the legal "trivia" between tokens) and
 * return the index of the next significant character. Both comments and
 * whitespace can span newlines, which is what lets the parent-import walk
 * follow a multi-line `import(\n  "…")` end-to-end.
 */
const skipTrivia = (contents: string, i: number): number => {
  let j = i;
  while (j < contents.length) {
    const pastComment = skipComment(contents, j);
    if (pastComment !== j) {
      j = pastComment;
      continue;
    }
    if (isWhitespace(contents[j]!)) {
      j++;
      continue;
    }
    break;
  }
  return j;
};

/** Whether `specifier` (a full quoted literal) starts with `../` or `./../`
 *  once the quotes are stripped. A sibling `./x` and a package `valibot` are
 *  left alone — neither makes a file's location matter. */
const isParentRelativeSpecifier = (specifier: string): boolean => {
  if (specifier.length < 5) return false;
  const inner = specifier.slice(1, -1);
  return inner.startsWith("../") || inner.startsWith("./../");
};

const isQuote = (c: string): boolean => c === '"' || c === "'" || c === "`";

type ScanStep =
  | { kind: "found"; specifier: string; end: number }
  | { kind: "continue"; next: number }
  | { kind: "stop" };

/** Walk a dynamic-import paren body one step from `i`. Tracks `depth`. */
const stepDynamicScan = (
  contents: string,
  i: number,
  depth: { value: number },
): ScanStep => {
  const pastComment = skipComment(contents, i);
  if (pastComment !== i) return { kind: "continue", next: pastComment };
  const c = contents[i]!;
  if (isQuote(c)) {
    const found = readStringLiteral(contents, i);
    if (found) return { kind: "found", ...found };
    return { kind: "continue", next: skipString(contents, i) };
  }
  if (c === "(") depth.value++;
  else if (c === ")") {
    depth.value--;
    if (depth.value === 0) return { kind: "stop" };
  }
  return { kind: "continue", next: i + 1 };
};

/**
 * Find the first string literal inside `(...)` starting at `openParenPos`
 * (the `(`). Returns the literal and its closing-quote offset, or `null`.
 * Used for dynamic imports — the specifier is the first argument.
 */
const findDynamicSpecifier = (
  contents: string,
  openParenPos: number,
): { specifier: string; end: number } | null => {
  const depth = { value: 1 };
  let i = openParenPos + 1;
  while (i < contents.length && depth.value > 0) {
    const step = stepDynamicScan(contents, i, depth);
    if (step.kind === "found") return step;
    if (step.kind === "stop") return null;
    i = step.next;
  }
  return null;
};

/**
 * Walk from `afterImportPos` (just past the `import` keyword) looking for the
 * `from` keyword at the top level of the bindings — i.e. outside any
 * `{ … }` clause — and then the string literal that follows it. Returns the
 * specifier and its end offset, or `null` if no `from` is found before a
 * statement-terminating `;` or end of input. Strings and comments inside the
 * bindings (e.g. `import { "weird-name" as x } from "…"`) are skipped so
 * their text never parses as `from`.
 */
const findStaticSpecifier = (
  contents: string,
  afterImportPos: number,
): { specifier: string; end: number } | null => {
  let i = afterImportPos;
  let braceDepth = 0;
  while (i < contents.length) {
    const pastComment = skipComment(contents, i);
    if (pastComment !== i) {
      i = pastComment;
      continue;
    }
    const c = contents[i]!;
    if (isQuote(c)) {
      i = skipString(contents, i);
      continue;
    }
    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth--;
    else if (braceDepth === 0 && isFromKeyword(contents, i)) {
      const afterFrom = skipTrivia(contents, i + 4);
      const spec = readStringLiteral(contents, afterFrom);
      return spec ?? null;
    } else if (c === ";") return null;
    i++;
  }
  return null;
};

/**
 * Find the module specifier and its end offset for an `import` declaration
 * whose `import` keyword begins at `importPos`. Returns `null` when no
 * specifier is reachable — e.g. `import type { Foo }` with no `from`, or a
 * malformed `import(…)` whose first argument isn't a string literal.
 *
 * The three import forms are distinguished by the first significant token
 * after `import`: a `(` is a dynamic `import(...)`; a quote begins a
 * side-effect `import "…"`; anything else is a static `import … from "…"`
 * (with `{ … }`, an identifier, or `* as ns` between `import` and `from`).
 */
const findImportSpecifier = (
  contents: string,
  importPos: number,
): { specifier: string; end: number } | null => {
  const afterImport = skipTrivia(contents, importPos + IMPORT_LENGTH);
  const next = contents[afterImport];

  // Dynamic: `import(…)`. The specifier is the first string literal inside the
  // parens, possibly on a different line with comments along the way.
  if (next === "(") {
    return findDynamicSpecifier(contents, afterImport);
  }
  // Side-effect: `import "…"`. The specifier is the string directly after.
  if (next === '"' || next === "'" || next === "`") {
    const spec = readStringLiteral(contents, afterImport);
    return spec ?? null;
  }
  // Static: walk forward, skipping bindings and comments, until `from`
  // (followed by the specifier) or `;` (no specifier — not a `from` import).
  return findStaticSpecifier(contents, afterImport);
};

export const detectRelativeImport = (
  relativePath: string,
  contents: string,
): string[] => {
  const violations: string[] = [];
  let i = 0;
  while (i < contents.length) {
    // Skip comments — they may quote `from "../x"` as documentation or data,
    // and the rule must not treat that as an import.
    const pastComment = skipComment(contents, i);
    if (pastComment !== i) {
      i = pastComment;
      continue;
    }
    // Skip string literals — they may quote an import statement as fixture
    // text, and the rule must not treat the inner text as an import either.
    const c = contents[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(contents, i);
      continue;
    }
    if (isImportKeyword(contents, i)) {
      const found = findImportSpecifier(contents, i);
      if (found && isParentRelativeSpecifier(found.specifier)) {
        const lineNum = lineOf(contents, i);
        // Blank comments so a multi-line `import(\n  // note\n  "../x")` is
        // reported with the import and its specifier, not the comment text —
        // matching the no-comment form's snippet so the message stays short.
        const snippet = blankSpans(contents.slice(i, found.end), false)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 50);
        violations.push(
          `${relativePath}:${lineNum}: ${snippet}... (use a # alias instead of a ../ relative import)`,
        );
      }
      // Resume scanning past the specifier so a file with multiple offending
      // imports reports each one — not just the first.
      i = found ? found.end : i + IMPORT_LENGTH;
      continue;
    }
    i++;
  }
  return violations;
};
