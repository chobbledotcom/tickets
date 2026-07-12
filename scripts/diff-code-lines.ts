#!/usr/bin/env -S deno run --allow-run
/**
 * Count the changed lines of a branch's diff, split by area (src / test / other)
 * and by whether the line is real code or just an import / comment / blank.
 *
 * "Real code" is what's left after dropping import lines (including multi-line
 * `import { … } from …` blocks and `export … from` re-exports), comment lines
 * (`//`, and `/* … *\/` block comments including their `*` continuation lines),
 * and blank lines. The classifier is a line-based heuristic, not a parser, so
 * treat the numbers as a close estimate rather than an exact AST count.
 *
 * Usage:
 *   deno run --allow-run scripts/diff-code-lines.ts [baseRef]
 *
 * `baseRef` defaults to `origin/main`; the diff is `baseRef...HEAD` (the
 * branch's own changes since it forked, ignoring later commits on the base).
 */

type Area = "src" | "test" | "other";
type Kind = "code" | "import" | "comment" | "blank";

type Tally = Record<Kind, number>;
const emptyTally = (): Tally => ({ blank: 0, code: 0, comment: 0, import: 0 });

/** Running state for one side of the diff (added lines vs removed lines), so a
 * multi-line import block or block comment keeps its kind across its lines. */
type SideState = { inImport: boolean; inBlockComment: boolean };
const freshState = (): SideState => ({
  inBlockComment: false,
  inImport: false,
});

const areaOf = (path: string): Area =>
  path.startsWith("src/") ? "src" : path.startsWith("test/") ? "test" : "other";

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

/** Classify one changed line, advancing `state` for multi-line constructs. */
const classify = (raw: string, state: SideState): Kind => {
  const line = raw.trim();

  const open = continueOpenRun(line, state);
  if (open !== null) return open;

  if (line.startsWith("/*")) {
    state.inBlockComment = opensBlock(line, "/*", "*/");
    return "comment";
  }
  if (line === "") return "blank";
  if (line.startsWith("//") || line.startsWith("*")) return "comment";

  if (/^import\b/.test(line) || /^export\b.*\bfrom\b/.test(line)) {
    state.inImport = opensBlock(line, "{", "}");
    return "import";
  }
  return "code";
};

const runGitDiff = async (base: string): Promise<string> => {
  // --unified=0: only changed lines, no surrounding context to misclassify.
  const command = new Deno.Command("git", {
    args: ["diff", "--unified=0", `${base}...HEAD`],
    stderr: "piped",
    stdout: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  if (code !== 0) {
    throw new Error(`git diff failed: ${new TextDecoder().decode(stderr)}`);
  }
  return new TextDecoder().decode(stdout);
};

type Counts = { added: Record<Area, Tally>; removed: Record<Area, Tally> };

const tallyDiff = (diff: string): Counts => {
  const added: Record<Area, Tally> = {
    other: emptyTally(),
    src: emptyTally(),
    test: emptyTally(),
  };
  const removed: Record<Area, Tally> = {
    other: emptyTally(),
    src: emptyTally(),
    test: emptyTally(),
  };
  let area: Area = "other";
  let addState = freshState();
  let removeState = freshState();

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      area = areaOf(line.slice("+++ b/".length));
      continue;
    }
    if (line.startsWith("--- ")) continue;
    // A new hunk breaks any open import/comment run from the previous hunk.
    if (line.startsWith("@@")) {
      addState = freshState();
      removeState = freshState();
      continue;
    }
    if (line.startsWith("+")) {
      added[area][classify(line.slice(1), addState)] += 1;
    } else if (line.startsWith("-")) {
      removed[area][classify(line.slice(1), removeState)] += 1;
    }
  }
  return { added, removed };
};

const netCode = (t: Tally): number => t.code;

const report = (counts: Counts): void => {
  const areas: Area[] = ["src", "test", "other"];
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number) => String(n).padStart(6);

  console.log(
    `${pad("area", 7)}${pad("code +/-", 18)}${pad("import +/-", 16)}${pad("comment +/-", 16)}${pad("blank +/-", 14)}`,
  );
  for (const a of areas) {
    const add = counts.added[a];
    const rem = counts.removed[a];
    console.log(
      `${pad(a, 7)}` +
        `${num(add.code)}/${num(rem.code)}    ` +
        `${num(add.import)}/${num(rem.import)}  ` +
        `${num(add.comment)}/${num(rem.comment)}  ` +
        `${num(add.blank)}/${num(rem.blank)}`,
    );
  }

  const srcCode = netCode(counts.added.src) + netCode(counts.removed.src);
  const testCode = netCode(counts.added.test) + netCode(counts.removed.test);
  console.log(
    "\nCode lines changed (added + removed), imports/comments/blanks excluded:",
  );
  console.log(`  src : ${srcCode}`);
  console.log(`  test: ${testCode}`);
  if (srcCode > 0) {
    console.log(`  test/src ratio: ${(testCode / srcCode).toFixed(2)}`);
  }
};

const base = Deno.args[0] ?? "origin/main";
report(tallyDiff(await runGitDiff(base)));
