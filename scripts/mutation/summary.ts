/**
 * Mutation result reporting — the pure core of the runner.
 *
 * `summarize` folds the raw per-mutant results into a score and the survivor
 * list; the formatters turn that one `Summary` into either coloured terminal
 * lines or a GitHub-flavoured Markdown block. Keeping the computation pure (no
 * I/O) makes the score logic obvious and lets the runner stay a thin shell of
 * effects around it. `writeStepSummary` is the only side effect, and only when
 * running inside GitHub Actions.
 */

import { bold, dim, green, red, yellow } from "../precommit/colors.ts";
import { projectRoot } from "../project-root.ts";
import type { Mutant } from "./generate.ts";

export type Status = "killed" | "survived" | "timed-out" | "ignored";

export interface MutantResult {
  file: string;
  mutant: Mutant;
  status: Status;
}

export interface Summary {
  detected: number;
  /** Mutants that count toward the score (total minus suppressed-equivalent). */
  effective: number;
  /** Known-equivalent survivors suppressed via the ignore-list. */
  ignored: number;
  killed: number;
  score: number;
  survived: number;
  survivors: MutantResult[];
  timedOut: number;
  total: number;
}

export interface ProgressSnapshot {
  completed: number;
  ignored: number;
  killed: number;
  last: MutantResult;
  survived: number;
  timedOut: number;
  total: number;
}

/** Project-relative path for display (absolute paths get noisy in reports). */
export const rel = (path: string): string =>
  path.startsWith(`${projectRoot}/`)
    ? path.slice(projectRoot.length + 1)
    : path;

/** Fold raw results into the score and survivor list. Pure. */
export const summarize = (results: MutantResult[]): Summary => {
  const byStatus = Object.groupBy(results, (result) => result.status);
  const count = (status: Status): number => byStatus[status]?.length ?? 0;
  const total = results.length;
  const ignored = count("ignored");
  const effective = total - ignored;
  const detected = count("killed") + count("timed-out");
  return {
    detected,
    effective,
    ignored,
    killed: count("killed"),
    // Suppressed-equivalent mutants are excluded from the denominator — they
    // can never be killed, so counting them would understate the real score.
    score: effective === 0 ? 100 : (detected / effective) * 100,
    survived: count("survived"),
    survivors: byStatus.survived ?? [],
    timedOut: count("timed-out"),
    total,
  };
};

const survivorLocation = (result: MutantResult): string =>
  `${rel(result.file)}:${result.mutant.line}:${result.mutant.column}`;

const mutationLabel = (result: MutantResult): string =>
  `${result.mutant.operator} -> ${result.mutant.newOperator}`;

/** Plain progress line suitable for terminals, CI logs, and log parsers. */
export const formatProgressLine = (p: ProgressSnapshot): string => {
  const percent = p.total === 0 ? 100 : (p.completed / p.total) * 100;
  return [
    `Mutation progress: ${p.completed}/${p.total} (${percent.toFixed(1)}%)`,
    `killed ${p.killed}`,
    `survived ${p.survived}`,
    `timed out ${p.timedOut}`,
    `ignored ${p.ignored}`,
    `last ${p.last.status} ${survivorLocation(p.last)} ${mutationLabel(p.last)}`,
  ].join("; ");
};

// --- Terminal formatting -------------------------------------------------

const identity = (s: string): string => s;
const LABEL_WIDTH = 11;

/** The summary's count rows as a schema, so one renderer aligns them all. */
const countRows = (
  s: Summary,
): Array<{ color: (s: string) => string; label: string; value: string }> => [
  { color: identity, label: "mutants:", value: String(s.total) },
  { color: green, label: "killed:", value: String(s.killed) },
  { color: yellow, label: "timed out:", value: String(s.timedOut) },
  { color: red, label: "survived:", value: String(s.survived) },
  ...(s.ignored > 0
    ? [{ color: dim, label: "ignored:", value: String(s.ignored) }]
    : []),
  {
    color: bold,
    label: "score:",
    value: `${s.score.toFixed(1)}%  (detected ${s.detected}/${s.effective}${
      s.ignored > 0 ? `, ${s.ignored} suppressed` : ""
    })`,
  },
];

const renderRow = (row: {
  color: (s: string) => string;
  label: string;
  value: string;
}): string =>
  `  ${row.color(row.label)}${" ".repeat(LABEL_WIDTH - row.label.length)}${row.value}`;

/** Build a "one survivor on a line" formatter from how it should wrap the
 *  location and the two operators. The terminal and Markdown reports show the
 *  same three pieces (location, old operator, new operator); only the
 *  surrounding text differs, so they share this one body. */
const survivorFormatter =
  (
    render: (location: string, operator: string, newOperator: string) => string,
  ) =>
  (result: MutantResult): string => {
    const { newOperator, operator } = result.mutant;
    return render(survivorLocation(result), operator, newOperator);
  };

const survivorLine = survivorFormatter(
  (location, operator, newOperator) =>
    `  ${location}  ${bold(operator)} → ${bold(newOperator)}`,
);

/** The full terminal report as lines, ready for the runner to print. Pure. */
export const formatSummaryLines = (s: Summary): string[] => {
  if (s.total === 0) {
    return [
      bold("\nMutation testing summary"),
      yellow("  No mutable operators were found — nothing to mutate."),
      yellow("  Result is INCONCLUSIVE (a mutation score needs ≥1 mutant)."),
    ];
  }
  if (s.effective === 0) {
    // Every mutant is a recorded known-equivalent — exactly what the ignore
    // list is for. There is nothing killable, but nothing unexpected: a pass.
    return [
      bold("\nMutation testing summary"),
      green(
        `  All ${s.total} mutant(s) suppressed as known-equivalent — nothing killable.`,
      ),
    ];
  }
  const allDetected = green(
    `\nAll mutants were detected.${
      s.ignored > 0 ? ` (${s.ignored} suppressed as known-equivalent)` : ""
    }`,
  );
  return [
    bold("\nMutation testing summary"),
    ...countRows(s).map(renderRow),
    ...(s.survivors.length === 0
      ? [allDetected]
      : [
          red("\nSurvivors — these mutations did not fail any test:"),
          ...s.survivors.map(survivorLine),
        ]),
  ];
};

// --- GitHub step summary (Markdown) --------------------------------------

const survivorRow = survivorFormatter(
  (location, operator, newOperator) =>
    `| \`${location}\` | \`${operator}\` → \`${newOperator}\` |`,
);

const markdownSummary = (s: Summary): string => {
  if (s.total === 0) {
    return [
      "## 🧬 Mutation testing",
      "",
      "⚠️ **Inconclusive** — no mutable operators were found, so nothing was" +
        " mutated. A mutation score needs at least one mutant.",
      "",
    ].join("\n");
  }
  if (s.effective === 0) {
    return [
      "## 🧬 Mutation testing",
      "",
      `✅ All ${s.total} mutant(s) suppressed as known-equivalent — nothing killable.`,
      "",
    ].join("\n");
  }
  const suffix = s.ignored > 0 ? `, ${s.ignored} suppressed` : "";
  const headline =
    s.survived === 0
      ? `✅ **All ${s.effective} mutants detected** — score ${s.score.toFixed(1)}%${suffix}`
      : `❌ **${s.survived} mutant(s) survived** — score ${s.score.toFixed(1)}%` +
        ` (detected ${s.detected}/${s.effective}${suffix})`;
  const survivorTable =
    s.survived === 0
      ? []
      : [
          "",
          "### Survivors",
          "",
          "These mutations did not fail any test:",
          "",
          "| location | mutation |",
          "| --- | --- |",
          ...s.survivors.map(survivorRow),
        ];
  return [
    "## 🧬 Mutation testing",
    "",
    headline,
    "",
    "| metric | count |",
    "| --- | --- |",
    `| mutants | ${s.total} |`,
    `| killed | ${s.killed} |`,
    `| timed out | ${s.timedOut} |`,
    `| survived | ${s.survived} |`,
    ...(s.ignored > 0 ? [`| ignored (suppressed) | ${s.ignored} |`] : []),
    ...survivorTable,
    "",
  ].join("\n");
};

/**
 * Append the Markdown summary to GitHub's per-step summary panel, when running
 * inside Actions (`GITHUB_STEP_SUMMARY` set). A no-op everywhere else, and
 * best-effort: a failure to write the cosmetic summary never fails the run.
 */
export const writeStepSummary = (s: Summary): void => {
  const path = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (!path) return;
  try {
    Deno.writeTextFileSync(path, markdownSummary(s), { append: true });
    console.log(dim("Wrote Markdown summary to $GITHUB_STEP_SUMMARY."));
  } catch {
    // The step summary is best-effort cosmetics; never fail a run over it.
  }
};
