/**
 * Classify the changed lines of a `git diff` by area (src / test / other) and
 * by kind (real code vs import / comment / blank), then format the tallies.
 *
 * "Real code" is what's left after dropping import lines (including multi-line
 * `import { … } from …` blocks and multi-line `export { … } from …`
 * re-exports), comment lines (`//`, and `/* … *\/` block comments including
 * their `*` continuation lines), and blank lines. Added and removed files are
 * both counted against their real area: a deletion names its path only on the
 * `--- a/…` header, so both file headers are read.
 *
 * This module is pure — it takes the diff text and returns strings — so the CLI
 * shell (diff-code-lines.ts) only has to run `git diff` and print.
 *
 * The classifier is a line-based heuristic, not a parser, so treat the numbers
 * as a close estimate rather than an exact AST count. Its known blind spots:
 *  - `git diff --unified=0` shows only the changed lines, so adding or removing
 *    a single member inside an existing multi-line import (the `import {` opener
 *    stays unchanged and off-diff) reads as a plain identifier and counts as
 *    code;
 *  - a multi-line *local* `export { … }` block with no `from` counts as import,
 *    not code: its opener is identical to a barrel re-export's, and telling them
 *    apart would need line lookahead this single-pass classifier does not do.
 *    Both are rare, and this stays a rough estimate rather than a parser.
 */

import { reduce } from "#fp";

export type Area = "src" | "test" | "other";
export type Kind = "code" | "import" | "comment" | "blank";

export type Tally = Record<Kind, number>;
const emptyTally = (): Tally => ({ blank: 0, code: 0, comment: 0, import: 0 });

/** A fresh per-area tally set (one empty tally for each area). */
export const emptyAreaTally = (): Record<Area, Tally> => ({
  other: emptyTally(),
  src: emptyTally(),
  test: emptyTally(),
});

/** Running state for one side of the diff (added lines vs removed lines), so a
 * multi-line import block or block comment keeps its kind across its lines. */
export type SideState = { inImport: boolean; inBlockComment: boolean };
export const freshState = (): SideState => ({
  inBlockComment: false,
  inImport: false,
});

const areaOf = (path: string): Area =>
  path.startsWith("src/") ? "src" : path.startsWith("test/") ? "test" : "other";

/** The area a `git diff` file header names, or `null` for its `/dev/null`
 * side. A created or deleted file names its real path on only one of its two
 * headers (`--- a/…` for a deletion, `+++ b/…` for a creation), so both header
 * lines are read and the `/dev/null` side is skipped. Returns `undefined` when
 * the line is not a file header. */
const fileHeaderArea = (line: string): Area | null | undefined => {
  if (line === "--- /dev/null" || line === "+++ /dev/null") return null;
  if (line.startsWith("--- a/")) return areaOf(line.slice("--- a/".length));
  if (line.startsWith("+++ b/")) return areaOf(line.slice("+++ b/".length));
  return;
};

/** A line opens a multi-line block if it starts one it doesn't also close. */
const opensBlock = (line: string, open: string, close: string): boolean =>
  line.includes(open) && !line.includes(close);

/** While a block comment or import block is open, classify its continuation
 * lines and close the run when its terminator arrives. Returns null when no run
 * is open, so the caller falls through to single-line classification. */
const continueOpenRun = (line: string, state: SideState): Kind | null => {
  if (state.inBlockComment) {
    if (line.includes("*/")) state.inBlockComment = false;
    return "comment";
  }
  if (state.inImport) {
    if (line.includes("}")) state.inImport = false;
    return "import";
  }
  return null;
};

/** A line begins a re-export: `export {` / `export * ` / `export type {` /
 * `export type *`. Requiring `*` or `{` right after `export` (optionally
 * `type`) is what keeps ordinary exported code out — `export const note =
 * 'from "x"'` starts with `const`, so it never counts as a re-export even
 * though it contains the word `from`. */
const startsReExport = (line: string): boolean =>
  /^export\s+(type\s+)?[*{]/.test(line);

/** True when a changed line is (or opens) an import / re-export statement:
 *  - a static `import` declaration — `import x from …`, `import { … } from …`,
 *    `import * as …`, a side-effect `import "…"`, or `import type …`. The
 *    `import.meta` property and a dynamic `import(…)` / `import (…)` call are
 *    executable code, so a `.` or `(` after `import` (any spacing) keeps them as
 *    code;
 *  - a single-line `export … from "…"` re-export (the quoted module name is the
 *    real module specifier);
 *  - an `export {` / `export type {` that opens a multi-line block, which barrel
 *    files close with `} from "…"` on a later line (that closing line is counted
 *    by the open-run handler, so the opener only needs to start the run). A
 *    multi-line *local* `export { … }` with no `from` is indistinguishable from
 *    a barrel opener without lookahead, so it also counts as import — see the
 *    module docstring's known blind spots. */
const isImportLine = (line: string): boolean =>
  (/^import\b/.test(line) && !/^import\s*[.(]/.test(line)) ||
  (startsReExport(line) &&
    (/\bfrom\s+["']/.test(line) || opensBlock(line, "{", "}")));

/** Classify one changed line, advancing `state` for multi-line constructs. */
export const classify = (raw: string, state: SideState): Kind => {
  const line = raw.trim();

  const open = continueOpenRun(line, state);
  if (open !== null) return open;

  if (line.startsWith("/*")) {
    state.inBlockComment = opensBlock(line, "/*", "*/");
    return "comment";
  }
  if (line === "") return "blank";
  if (line.startsWith("//") || line.startsWith("*")) return "comment";

  if (isImportLine(line)) {
    state.inImport = opensBlock(line, "{", "}");
    return "import";
  }
  return "code";
};

export type Counts = {
  added: Record<Area, Tally>;
  removed: Record<Area, Tally>;
};

/** Everything the diff walk carries from one line to the next: the tallies, the
 * current file's area, the add/remove classification runs, and whether we are
 * still in a file's header section. */
type WalkState = {
  counts: Counts;
  area: Area;
  addState: SideState;
  removeState: SideState;
  inHeader: boolean;
};

/** Handle a file-header or hunk-boundary line, updating the walk state. Returns
 * true when the line was header/boundary metadata the caller should skip.
 *
 * `--- a/…` / `+++ b/…` only name the file inside the header section between a
 * `diff --git` marker and the first `@@` hunk. Scoping header handling to that
 * section keeps a dash-prefixed content line (e.g. a removed SQL `-- comment`,
 * which diffs to `--- comment`) from being mistaken for a header and dropped. */
const applyBoundaryLine = (line: string, state: WalkState): boolean => {
  if (line.startsWith("diff --git ")) {
    state.inHeader = true;
    return true;
  }
  if (state.inHeader) {
    const headerArea = fileHeaderArea(line);
    if (headerArea !== undefined) {
      // A real path updates the area; a `/dev/null` side keeps the area set by
      // the file's other header, so a deletion still counts as its real area
      // rather than inheriting the previous file's.
      if (headerArea !== null) state.area = headerArea;
      return true;
    }
  }
  if (line.startsWith("@@")) {
    // The first hunk ends the header; a new hunk also breaks any open
    // import/comment run carried over from the previous hunk.
    state.inHeader = false;
    state.addState = freshState();
    state.removeState = freshState();
    return true;
  }
  return false;
};

/** Tally one changed content line under the current area, by its kind. */
const tallyContentLine = (line: string, state: WalkState): void => {
  if (line.startsWith("+")) {
    const kind = classify(line.slice(1), state.addState);
    state.counts.added[state.area][kind] += 1;
  } else if (line.startsWith("-")) {
    const kind = classify(line.slice(1), state.removeState);
    state.counts.removed[state.area][kind] += 1;
  }
};

/** Fold one diff line into the running walk state: boundary lines update the
 * state and are skipped, content lines are tallied. */
const foldLine = (state: WalkState, line: string): WalkState => {
  if (!applyBoundaryLine(line, state)) tallyContentLine(line, state);
  return state;
};

const freshWalkState = (): WalkState => ({
  addState: freshState(),
  area: "other",
  counts: { added: emptyAreaTally(), removed: emptyAreaTally() },
  inHeader: false,
  removeState: freshState(),
});

export const tallyDiff = (diff: string): Counts =>
  reduce(foldLine, freshWalkState())(diff.split("\n")).counts;

const codeCount = (t: Tally): number => t.code;

const pad = (s: string, n: number): string => s.padEnd(n);
const num = (n: number): string => String(n).padStart(6);

const areaRow = (a: Area, counts: Counts): string => {
  const add = counts.added[a];
  const rem = counts.removed[a];
  return (
    `${pad(a, 7)}` +
    `${num(add.code)}/${num(rem.code)}    ` +
    `${num(add.import)}/${num(rem.import)}  ` +
    `${num(add.comment)}/${num(rem.comment)}  ` +
    `${num(add.blank)}/${num(rem.blank)}`
  );
};

/** Format the whole report — per-area table plus the code-only src/test totals
 * and their ratio — as one string ready to print. */
export const formatReport = (counts: Counts): string => {
  const areas: Area[] = ["src", "test", "other"];
  const srcCode = codeCount(counts.added.src) + codeCount(counts.removed.src);
  const testCode =
    codeCount(counts.added.test) + codeCount(counts.removed.test);

  const lines = [
    `${pad("area", 7)}${pad("code +/-", 18)}${pad("import +/-", 16)}${pad(
      "comment +/-",
      16,
    )}${pad("blank +/-", 14)}`,
    ...areas.map((a) => areaRow(a, counts)),
    "",
    "Code lines changed (added + removed), imports/comments/blanks excluded:",
    `  src : ${srcCode}`,
    `  test: ${testCode}`,
  ];
  if (srcCode > 0) {
    lines.push(`  test/src ratio: ${(testCode / srcCode).toFixed(2)}`);
  }
  return lines.join("\n");
};
