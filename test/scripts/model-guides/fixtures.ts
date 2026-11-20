import type { GuideAccess } from "#scripts/model-guides/access.ts";
import {
  findModelGuideIssues,
  generateModelGuidePages,
} from "#scripts/model-guides/check.ts";
import type { ModelGuide } from "#scripts/model-guides/types.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { thrownError } from "#test-utils/errors.ts";

const HEADER = "---------------- MODULE Sample ----------------";
const FOOTER =
  "=============================================================================";

const tla = (definitions: string, extendsLine = "EXTENDS ModelRules") =>
  [
    HEADER,
    extendsLine,
    "",
    "VARIABLES",
    "  x",
    "",
    definitions,
    FOOTER,
    "",
  ].join("\n");

export const SAMPLE_TLA = tla(
  [
    "TypeOK ==",
    "  x \\in {0, 1}",
    "Init ==",
    "  x = 0",
    "Step ==",
    "  x' = 1",
    "Safety ==",
    "  TypeOK",
    "Next == Step \\/ UNCHANGED <<x>>",
  ].join("\n"),
);

const HELPER_TLA = tla("Shared == TRUE", "EXTENDS ModelRules");

const SOURCE = [
  "export const start = 1;",
  "export const producer = 2;",
  "export const step = 3;",
  "export const safety = 4;",
  "",
].join("\n");

export const declaration: VerificationModule = {
  context: ["src/fake.ts", "scripts/producer.ts"],
  controls: [
    {
      data: () => Promise.resolve(""),
      name: "a bad fact",
      phase: "initial",
    },
  ],
  data: () => Promise.resolve(""),
  kind: "model",
  module: "Sample",
};

const helperDeclaration: VerificationModule = {
  context: [],
  kind: "helper",
  module: "SampleHelper",
};

/* jscpd:ignore-start -- static data, not code */
export const guide: ModelGuide = {
  badOutcome: "A listing takes more places than it holds.",
  cast: [{ meaning: "A bookable item.", term: "listing" }],
  claim: "The edit writes all lines or none.",
  limits: ["The model uses two listings."],
  module: "Sample",
  safety: "Every accepted edit stays within the limit.",
  steps: [
    {
      code: [
        { path: "src/fake.ts", symbol: "start" },
        {
          detail: "declaration",
          path: "scripts/producer.ts",
          symbol: "producer",
        },
      ],
      rules: ["Init", "TypeOK"],
      title: "Start",
      values: [{ name: "x", value: "0" }],
      what: "The model starts at zero.",
    },
    {
      code: [
        { path: "src/fake.ts", symbol: "step" },
        { path: "src/fake.ts", symbol: "step" },
      ],
      rules: ["Step", "Next"],
      title: "Take a step",
      what: "One step moves the value.",
    },
    {
      code: [{ path: "src/fake.ts", symbol: "safety" }],
      rules: ["Safety"],
      title: "Check safety",
      what: "The safety rule joins the promises.",
    },
  ],
  title: "A sample walkthrough",
};

const helperGuide: ModelGuide = {
  badOutcome: "A status is read as the wrong kind.",
  cast: [{ meaning: "A stored word.", term: "status" }],
  claim: "The helper names the stored status words.",
  limits: ["The helper has no lifecycle."],
  module: "SampleHelper",
  safety: "The helper makes no safety claim of its own.",
  steps: [
    { code: [], rules: ["Shared"], title: "One", what: "One rule." },
    { code: [], rules: ["Shared"], title: "Two", what: "Two rules." },
  ],
  title: "A helper walkthrough",
};
/* jscpd:ignore-end */

export class MemoryAccess implements GuideAccess {
  readonly files = new Map<string, string>();

  read = (path: string): Promise<string> => {
    const content = this.files.get(path);
    if (content === undefined) {
      return Promise.reject(new Deno.errors.NotFound(path));
    }
    return Promise.resolve(content);
  };

  list = (directory: string): Promise<readonly string[]> => {
    const prefix = `${directory}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.includes("/")),
    );
  };
}

export type State = {
  readonly access: MemoryAccess;
  readonly context: {
    readonly guides: ModelGuide[];
    readonly modules: VerificationModule[];
  };
};

export const state = async (): Promise<State> => {
  const access = new MemoryAccess();
  access.files.set("verification/Sample.tla", SAMPLE_TLA);
  access.files.set("verification/SampleHelper.tla", HELPER_TLA);
  access.files.set("verification/ModelRules.tla", HELPER_TLA);
  access.files.set("src/fake.ts", SOURCE);
  access.files.set("scripts/producer.ts", "export const producer = 2;\n");
  const context: State["context"] = {
    guides: [guide, helperGuide],
    modules: [declaration, helperDeclaration],
  };
  await declaration.data();
  for (const control of declaration.controls) await control.data();
  const pages = await generateModelGuidePages(access, context);
  for (const [name, content] of pages) {
    access.files.set(`docs/model-guides/${name}`, content);
  }
  return { access, context };
};

export const issues = async (
  change: (current: State) => void = () => {},
): Promise<string[]> => {
  const current = await state();
  change(current);
  return await findModelGuideIssues(current.access, current.context);
};

/** Replace the model guide under test, keeping the same state. */
export const replaceGuide = (
  current: State,
  change: (guide: ModelGuide) => ModelGuide,
): void => {
  current.context.guides[0] = change(current.context.guides[0]!);
};

/** Report the issues after one change to the model guide. */
export const findWithGuide = (
  change: (guide: ModelGuide) => ModelGuide,
): Promise<string[]> => issues((current) => replaceGuide(current, change));

/** Report the issues after one edit to a stored example file. */
export const issuesAfterFile = (
  path: string,
  edit: (content: string) => string,
): Promise<string[]> =>
  issues((current) => {
    const content = current.access.files.get(path)!;
    current.access.files.set(path, edit(content));
  });

/** Join finding groups into one report. */
export const joinFindings = (...groups: (readonly string[])[]): string =>
  groups.map((lines) => lines.join("\n")).join("\n");

/** Change the first step and keep every other step. */
export const withFirstStep = (
  guide: ModelGuide,
  change: (step: ModelGuide["steps"][number]) => ModelGuide["steps"][number],
): ModelGuide => ({
  ...guide,
  steps: [
    { ...guide.steps[0]!, ...change(guide.steps[0]!) },
    ...guide.steps.slice(1),
  ],
});

/** The rendered anchor counts and the message from a failing render. */
export const renderSummary = (page: string, run: () => unknown): string =>
  [
    `code=${page.match(/Production code:/g)?.length}`,
    `rules=${page.match(/Model rule:/g)?.length}`,
    thrownError(run).message,
  ].join("\n");

/** Check the anchor counts and the failing-render message in one call. */
export const checkRender = (page: string, run: () => unknown): void => {
  expectIncludesAll(renderSummary(page, run), [
    "code=2",
    "rules=2",
    "has no rule named Missing",
  ]);
};
