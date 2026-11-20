import { formatFinding } from "#scripts/check-report.ts";
import type { TlaDefinition, TlaModule } from "#scripts/model-guides/tla.ts";
import type { CodeAnchor, ModelGuide } from "#scripts/model-guides/types.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";

/** One model and the rules that its guide may name. */
export type ModuleRun = {
  readonly declaration: VerificationModule;
  readonly index: ReadonlyMap<string, TlaDefinition>;
  readonly module: TlaModule;
};

export const issue = (
  where: string,
  rule: string,
  problem: string,
  fix: string,
): string => formatFinding(where, { fix, problem, rule });

export const sourceKey = (anchor: CodeAnchor): string =>
  `${anchor.path}#${anchor.symbol}#${anchor.detail ?? ""}`;

const empty = (value: string, field: string): string | undefined =>
  value.trim() === "" ? `The guide has an empty ${field}.` : undefined;

const pushRuleIssue = (
  findings: string[],
  where: string,
  rule: string,
  problem: string,
  fix: string,
): void => {
  findings.push(issue(where, rule, problem, fix));
};

const pushIssue = (
  findings: string[],
  where: string,
  problem: string,
  fix: string,
): void => {
  pushRuleIssue(findings, where, "guide-field", problem, fix);
};

const pushIf = (
  findings: string[],
  condition: boolean,
  where: string,
  problem: string,
  fix: string,
): void => {
  if (condition) pushIssue(findings, where, problem, fix);
};

const textProblem = (
  findings: string[],
  where: string,
  problem: string | undefined,
): void => {
  if (problem === undefined) return;
  pushIssue(findings, where, problem, "Write the text.");
};

const textFieldIssues = (
  where: string,
  fields: readonly (readonly [string, string])[],
): string[] =>
  fields.flatMap(([field, value]) => {
    const problem = empty(value, field);
    return problem === undefined
      ? []
      : [issue(where, "guide-field", problem, "Write the text.")];
  });

export const fieldIssues = (guide: ModelGuide): string[] => {
  const where = `guide ${guide.module}`;
  const findings = textFieldIssues(where, [
    ["title", guide.title],
    ["claim", guide.claim],
    ["bad outcome", guide.badOutcome],
    ["safety claim", guide.safety],
  ]);
  if (guide.cast.length === 0) {
    pushIssue(
      findings,
      where,
      "The guide has no cast.",
      "Explain the domain words before the steps.",
    );
  }
  const terms = new Set<string>();
  for (const entry of guide.cast) {
    textProblem(
      findings,
      where,
      empty(entry.term, "cast term") ?? empty(entry.meaning, "cast meaning"),
    );
    pushIf(
      findings,
      terms.has(entry.term),
      where,
      `The cast repeats ${entry.term}.`,
      "Keep one entry for each word.",
    );
    terms.add(entry.term);
  }
  pushIf(
    findings,
    guide.limits.length === 0,
    where,
    "The guide has no limits.",
    "State what the model does not prove.",
  );
  return findings;
};

type GuideStep = ModelGuide["steps"][number];

const stepFieldIssues = (
  label: string,
  step: GuideStep,
  isModel: boolean,
): string[] => {
  const findings = textFieldIssues(label, [
    ["title", step.title],
    ["what", step.what],
  ]);
  pushIf(
    findings,
    step.rules.length === 0,
    label,
    "The step names no model rule.",
    "Name the rule or rules that decide the step.",
  );
  pushIf(
    findings,
    isModel && step.code.length === 0,
    label,
    "The step names no production code.",
    "Name the declaration that supplies or writes this step's facts.",
  );
  for (const value of step.values ?? []) {
    textProblem(
      findings,
      label,
      empty(value.name, "value name") ?? empty(value.value, "value"),
    );
  }
  return findings;
};

export const stepIssues = (guide: ModelGuide, isModel: boolean): string[] => {
  const where = `guide ${guide.module}`;
  const countIssues =
    guide.steps.length < (isModel ? 3 : 2)
      ? [
          issue(
            where,
            "guide-steps",
            "The guide has too few steps.",
            "Walk the model from its start state to its safety claim.",
          ),
        ]
      : [];
  return [
    ...countIssues,
    ...guide.steps.flatMap((step, index) =>
      stepFieldIssues(`${where} step ${index + 1}`, step, isModel),
    ),
  ];
};

export const coverageIssues = (guide: ModelGuide, run: ModuleRun): string[] => {
  const where = `guide ${guide.module}`;
  const covered = new Set(guide.steps.flatMap((step) => step.rules));
  const missing = [...run.module.definitions.keys()]
    .filter((name) => !covered.has(name))
    .map((name) =>
      issue(
        where,
        "guide-coverage",
        `The model rule ${name} has no step.`,
        "Add the rule to a step, or remove the rule from the model.",
      ),
    );
  const required =
    run.declaration.kind !== "model"
      ? []
      : ["Init", "Next", "Safety"]
          .filter(
            (name) => !covered.has(name) && run.module.definitions.has(name),
          )
          .map((name) =>
            issue(
              where,
              "guide-coverage",
              `The guide does not name ${name}.`,
              "Walk the start state, the steps, and the safety claim.",
            ),
          );
  return [...missing, ...required];
};

export const ruleIssues = (guide: ModelGuide, run: ModuleRun): string[] =>
  guide.steps.flatMap((step) =>
    step.rules
      .filter((name) => !run.index.has(name))
      .map((name) =>
        issue(
          `guide ${guide.module}`,
          "guide-anchor",
          `The guide names a rule that the model does not define: ${name}.`,
          "Use a top-level rule name from the model or a local helper module.",
        ),
      ),
  );

export const sourceIssues = (guide: ModelGuide, run: ModuleRun): string[] => {
  if (run.declaration.kind !== "model") return [];
  const where = `guide ${guide.module}`;
  const anchors = guide.steps.flatMap((step) => step.code);
  const missing = anchors.some((anchor) => anchor.path.startsWith("src/"))
    ? []
    : [
        issue(
          where,
          "guide-source",
          "The guide names no production source file.",
          "Map at least one step to a declaration under src/.",
        ),
      ];
  const contexts = anchors
    .filter((anchor) => !run.declaration.context.includes(anchor.path))
    .map((anchor) =>
      issue(
        where,
        "guide-source-context",
        `${anchor.path} is not review context for ${guide.module}.`,
        "Name the file in the registry context for this model.",
      ),
    );
  return [...missing, ...contexts];
};
