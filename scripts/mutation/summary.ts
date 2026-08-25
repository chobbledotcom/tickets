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

import { appendStepSummary } from "#scripts/github-actions.ts";
import { bold, dim, green, red, yellow } from "#scripts/precommit/colors.ts";
import { rel } from "#scripts/project-root.ts";
import type { Mutant } from "./generate.ts";
import { mutantKey } from "./ignore.ts";
import type { MutationPhase, PhaseTiming } from "./phases.ts";

export type Status = "killed" | "survived" | "ignored";

/** What one mutant concluded, plus the run being cancelled part-way through.
 *  Cancelling is not a verdict on the mutant, so it never becomes a scored
 *  {@link MutantResult} — the runner stops instead of recording one. */
export type EvaluationStatus = Status | "cancelled";

export interface MutantResult {
  detectedBy: MutationPhase | null;
  file: string;
  mutant: Mutant;
  status: Status;
  timings: PhaseTiming[];
}

export interface PhaseTimingSummary extends PhaseTiming {
  runs: number;
}

export interface Summary {
  detected: number;
  /** Mutants that count toward the score (total minus suppressed-equivalent). */
  effective: number;
  /** Known-equivalent survivors suppressed via the ignore-list. */
  ignored: number;
  killed: number;
  phaseTimings: PhaseTimingSummary[];
  score: number;
  survived: number;
  survivors: MutantResult[];
  total: number;
}

export interface ProgressSnapshot {
  completed: number;
  ignored: number;
  killed: number;
  last: MutantResult;
  survived: number;
  total: number;
}

/** Fold raw results into the score and survivor list. Pure. */
export const summarize = (results: MutantResult[]): Summary => {
  const byStatus = Object.groupBy(results, (result) => result.status);
  const count = (status: Status): number => byStatus[status]?.length ?? 0;
  const total = results.length;
  const ignored = count("ignored");
  const effective = total - ignored;
  const detected = count("killed");
  const timings = results.flatMap((result) => result.timings);
  const timingsByPhase = Object.groupBy(timings, (timing) => timing.phase);
  const phaseTimings = Object.entries(timingsByPhase).map(
    ([phase, entries]): PhaseTimingSummary => ({
      durationMs: entries!.reduce(
        (total, entry) => total + entry.durationMs,
        0,
      ),
      phase: phase as MutationPhase,
      runs: entries!.length,
    }),
  );
  return {
    detected,
    effective,
    ignored,
    killed: count("killed"),
    phaseTimings,
    // Suppressed-equivalent mutants are excluded from the denominator — they
    // can never be killed, so counting them would understate the real score.
    score: effective === 0 ? 100 : (detected / effective) * 100,
    survived: count("survived"),
    survivors: byStatus.survived ?? [],
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
    `ignored ${p.ignored}`,
    `last ${p.last.status} ${survivorLocation(p.last)} ${mutationLabel(p.last)}`,
  ].join("; ");
};

/**
 * What to say when the whole-run deadline stopped a run part-way. A partial run
 * has no score to give, so this reports the shortfall and says where to look
 * instead of publishing a number built from the mutants that did finish.
 */
export const deadlineReport = (
  deadline: number,
  tested: number,
  total: number,
): string[] => [
  red(
    total === 0
      ? `\nMutation run passed its ${deadline}ms deadline before it had a mutant to test.`
      : `\nMutation run passed its ${deadline}ms deadline with ` +
          `${tested} of ${total} mutants tested.`,
  ),
  "Nothing is scored from a run that stopped early. The usual cause is a",
  "mutant that makes a test loop forever — the mutants after the last one",
  "reported are where to look. Raise --deadline if the run is merely long.",
];

/**
 * How a run ended when it did not finish, or null when it ran to the end and a
 * score can be published. The deadline is checked first: a run the guard
 * stopped is a failure to report, not the operator changing their mind, and the
 * two must not be confused wherever a run can end early.
 */
export const unfinishedRun = (
  state: { aborted: boolean; hitDeadline: boolean },
  run: { deadline: number; tested: number; total: number },
): { code: number; lines: string[] } | null => {
  if (state.hitDeadline) {
    return {
      code: 1,
      lines: deadlineReport(run.deadline, run.tested, run.total),
    };
  }
  if (state.aborted) {
    return {
      code: 130,
      lines: [yellow("Interrupted — restored sources and built assets.")],
    };
  }
  return null;
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

type TimingOutput = "markdown" | "terminal";

const TIMING_FORMATS: Record<
  TimingOutput,
  { heading: string[]; row: (timing: PhaseTimingSummary) => string }
> = {
  markdown: {
    heading: [
      "",
      "### Phase timings",
      "",
      "These are cumulative phase times across mutant attempts. Parallel test batches count once per stage.",
      "",
      "| phase | runs | time |",
      "| --- | ---: | ---: |",
    ],
    row: (timing) =>
      `| ${timing.phase} | ${timing.runs} | ${Math.round(timing.durationMs)}ms |`,
  },
  terminal: {
    heading: ["", dim("  phase timings (cumulative elapsed):")],
    row: (timing) =>
      dim(
        `    ${timing.phase}: ${Math.round(timing.durationMs)}ms in ${timing.runs} run(s)`,
      ),
  },
};

const timingLines = (s: Summary, output: TimingOutput): string[] => {
  if (s.phaseTimings.length === 0) return [];
  const format = TIMING_FORMATS[output];
  return [...format.heading, ...s.phaseTimings.map(format.row)];
};

/** Build a "one survivor on a line" formatter from how it should wrap the two
 *  pieces. The terminal and Markdown reports show the same pair — where to
 *  look, and the registry line that would suppress it — so they share this one
 *  body. The registry line is printed whole so a proven-equivalent survivor can
 *  be pasted straight into `scripts/mutation/equivalent-mutants/`. */
const survivorFormatter =
  (render: (location: string, entry: string) => string) =>
  (result: MutantResult): string =>
    render(survivorLocation(result), mutantKey(result.file, result.mutant));

const survivorLine = survivorFormatter(
  (location, entry) => `  ${location}\n    ${bold(entry)}`,
);

/** Shown under the survivor list so nobody has to guess how to record one. */
const RECORDING_HINT =
  "Proven unkillable by any test? Paste its line above into a file under" +
  " scripts/mutation/equivalent-mutants/, followed by  # and the reason.";

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
      ...timingLines(s, "terminal"),
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
    ...timingLines(s, "terminal"),
    ...(s.survivors.length === 0
      ? [allDetected]
      : [
          red("\nSurvivors — these mutations did not fail any test:"),
          ...s.survivors.map(survivorLine),
          dim(`\n  ${RECORDING_HINT}`),
        ]),
  ];
};

// --- GitHub step summary (Markdown) --------------------------------------

/** A Markdown table cell: a raw `|` would split the row into another column
 * even inside a code span, and a backtick would close the span early. */
const cell = (text: string): string =>
  `<code>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("|", "&#124;")}</code>`;

const survivorRow = survivorFormatter(
  (location, entry) => `| ${cell(location)} | ${cell(entry)} |`,
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
      ...timingLines(s, "markdown"),
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
          "| location | registry entry |",
          "| --- | --- |",
          ...s.survivors.map(survivorRow),
          "",
          RECORDING_HINT,
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
    `| survived | ${s.survived} |`,
    ...(s.ignored > 0 ? [`| ignored (suppressed) | ${s.ignored} |`] : []),
    ...timingLines(s, "markdown"),
    ...survivorTable,
    "",
  ].join("\n");
};

/**
 * Append the Markdown summary to GitHub's per-step summary panel, when running
 * inside Actions (`GITHUB_STEP_SUMMARY` set). A no-op everywhere else.
 */
export const writeStepSummary = (s: Summary): void => {
  if (appendStepSummary(markdownSummary(s))) {
    console.log(dim("Wrote Markdown summary to $GITHUB_STEP_SUMMARY."));
  }
};
