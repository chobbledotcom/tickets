import { createHash } from "node:crypto";
import type { SourceDefinition } from "#scripts/model-guides/source.ts";
import type { TlaDefinition, TlaModule } from "#scripts/model-guides/tla.ts";
import type { CodeAnchor, ModelGuide } from "#scripts/model-guides/types.ts";

/** Everything that a renderer needs, already read from the repository. */
export type GuideSources = {
  readonly model: TlaModule;
  readonly definition: (name: string) => TlaDefinition | undefined;
  readonly source: (anchor: CodeAnchor) => SourceDefinition;
};

const fingerprint = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A fence that the code inside cannot close. */
export const codeFence = (text: string): string => {
  const runs = [...text.matchAll(/(?:^|\n)(`{3,})/g)].map(
    (match) => match[1]!.length,
  );
  return "`".repeat(Math.max(3, ...runs.map((run) => run + 1)));
};

const cell = (text: string): string =>
  text.replace(/[\n|]/g, (character) => (character === "\n" ? " " : "\\|"));

const sourceLink = (path: string, line: number): string =>
  `../../${path}#L${String(line)}`;

const ruleSection = (
  name: string,
  definition: TlaDefinition,
  module: string,
): string => {
  const fence = codeFence(definition.text);
  return [
    `**Model rule: [\`${name}\`](${sourceLink(`verification/${module}.tla`, definition.line)})**`,
    "",
    `${fence}tla`,
    definition.text,
    fence,
  ].join("\n");
};

const codeSection = (definition: SourceDefinition): string => {
  const fence = codeFence(definition.signature);
  return [
    `**Production code: [\`${definition.path}#${definition.symbol}\`](${sourceLink(definition.path, definition.line)})**`,
    "",
    `${fence}ts`,
    definition.signature,
    fence,
    "",
    `Source fingerprint: \`sha256:${fingerprint(definition.text)}\``,
  ].join("\n");
};

const stepSection = (
  step: ModelGuide["steps"][number],
  number: number,
): string => {
  const lines = [`### Step ${number}: ${step.title}`, "", step.what];
  if (step.values !== undefined && step.values.length > 0) {
    lines.push(
      "",
      "| Value | This step |",
      "| --- | --- |",
      ...step.values.map(
        (value) => `| \`${cell(value.name)}\` | ${cell(value.value)} |`,
      ),
    );
  }
  return lines.join("\n");
};

const NOTATION_ROWS = [
  "| Symbol | Meaning |",
  "| --- | --- |",
  "| `==` | This line defines a rule. It does not assign a value. |",
  "| `x'` | The value of `x` after the step. |",
  "| `/\\` | Both conditions must hold. |",
  "| `\\/` | One of the conditions must hold. |",
  "| `\\A` | Every supplied value must satisfy the rule. |",
  "| `\\E` | At least one supplied value must satisfy the rule. |",
  "| `\\in` | The value belongs to the set. |",
  "| `=>` | If the left condition holds, the right condition must hold. |",
] as const;

const MODEL_GUIDE_NOTE = [
  "Read [the model verification guide](../model-verification.md) for the",
  "method and its limits.",
] as const;

const page = (guide: ModelGuide, sources: GuideSources): string => {
  const lines = [
    `# ${guide.title}`,
    "",
    `[Read the model](../../verification/${guide.module}.tla).`,
    "",
    guide.claim,
    "",
    "## The bad outcome it rules out",
    "",
    guide.badOutcome,
    "",
    "## The cast",
    "",
    "| Word | Meaning |",
    "| --- | --- |",
    ...guide.cast.map(
      (entry) => `| **${cell(entry.term)}** | ${cell(entry.meaning)} |`,
    ),
    "",
    "## The walkthrough",
    "",
  ];
  guide.steps.forEach((step, index) => {
    lines.push(stepSection(step, index + 1), "");
    for (const name of step.rules) {
      const definition = sources.definition(name);
      if (definition === undefined) {
        throw new Error(`${guide.module} has no rule named ${name}.`);
      }
      lines.push(ruleSection(name, definition, sources.model.module), "");
    }
    for (const anchor of step.code) {
      lines.push(codeSection(sources.source(anchor)), "");
    }
  });
  lines.push(
    "## The safety claim",
    "",
    guide.safety,
    "",
    "The model checks two things:",
    "",
    "- The first state satisfies the claim.",
    "- Every allowed step from a state that satisfies the claim keeps it.",
    "",
    "Together, these checks cover every finite run of the model.",
    "",
    "## What this model does not prove",
    "",
    ...guide.limits.map((limit) => `- ${limit}`),
    "",
    "## How to read the model text",
    "",
    ...NOTATION_ROWS,
    "",
    ...MODEL_GUIDE_NOTE,
    "",
  );
  return lines.join("\n");
};

/* jscpd:ignore-start -- static data, not code */
const INDEX_HEAD = [
  "# Model walkthroughs",
  "",
  "These pages explain each maintained TLA model in everyday words.",
  "Each page maps the model rules to the TypeScript code that supplies or",
  "writes the facts.",
  "",
  "The pages are generated from `scripts/model-guides/guides/`.",
  "Do not edit them by hand.",
  "",
  "## What keeps the pages honest",
  "",
  "The generator reads every rule and every production declaration that a guide",
  "names. It uses the current model and source text. The check fails when:",
  "",
  "- a guide names a rule or a declaration that no longer exists.",
  "- a rule in the model has no step.",
  "- a guide names a production file outside the model's review context.",
  "",
  "After a change, run `deno task model-guides` to review the page.",
  "",
  "## The pages",
  "",
  "| Model | What it protects | Bad outcome it rules out |",
  "| --- | --- | --- |",
] as const;

const INDEX_TAIL = [
  "",
  "## The notation key",
  "",
  ...NOTATION_ROWS,
  "",
  ...MODEL_GUIDE_NOTE,
  "",
] as const;
/* jscpd:ignore-end */

const indexPage = (guides: readonly ModelGuide[]): string =>
  [
    ...INDEX_HEAD,
    ...guides.map(
      (guide) =>
        `| [${cell(guide.title)}](${guide.module}.md) | ${cell(guide.claim)} | ${cell(guide.badOutcome)} |`,
    ),
    ...INDEX_TAIL,
  ].join("\n");

export const renderPage = (guide: ModelGuide, sources: GuideSources): string =>
  page(guide, sources);

export const renderIndex = (guides: readonly ModelGuide[]): string =>
  indexPage(guides);
