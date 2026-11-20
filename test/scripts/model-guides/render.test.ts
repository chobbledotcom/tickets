import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  codeFence,
  renderIndex,
  renderPage,
} from "#scripts/model-guides/render.ts";
import type { SourceDefinition } from "#scripts/model-guides/source.ts";
import type { TlaDefinition, TlaModule } from "#scripts/model-guides/tla.ts";
import type { ModelGuide } from "#scripts/model-guides/types.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { checkRender } from "./fixtures.ts";

const model: TlaModule = {
  content: "",
  definitions: new Map(),
  extends: [],
  module: "Sample",
};

const safety: TlaDefinition = {
  end: 0,
  line: 10,
  name: "Safety",
  references: [],
  start: 0,
  text: "Safety ==\n  TRUE",
};

const source: SourceDefinition = {
  line: 5,
  path: "src/fake.ts",
  signature: "export const rule = 1;",
  symbol: "rule",
  text: "export const rule = 1;",
};

/* jscpd:ignore-start -- static data, not code */
const guide: ModelGuide = {
  badOutcome: "A listing takes more places than it holds.",
  cast: [{ meaning: "A bookable item.", term: "listing" }],
  claim: "The edit writes all lines or none.",
  limits: ["The model uses two listings."],
  module: "Sample",
  safety: "Every accepted edit stays within the limit.",
  steps: [
    {
      code: [{ path: "src/fake.ts", symbol: "rule" }],
      rules: ["Safety"],
      title: "Start",
      values: [{ name: "slot", value: "3" }],
      what: "The model starts empty.",
    },
  ],
  title: "A sample walkthrough",
};
/* jscpd:ignore-end */

const sources = {
  definition: (name: string) => (name === "Safety" ? safety : undefined),
  model,
  source: () => source,
};

/* jscpd:ignore-start -- static data, not code */
const PAGE_FRAGMENTS = [
  "# A sample walkthrough",
  "[Read the model](../../verification/Sample.tla).",
  "The edit writes all lines or none.",
  "## The bad outcome it rules out",
  "| **listing** | A bookable item. |",
  "### Step 1: Start",
  "| `slot` | 3 |",
  "**Model rule: [`Safety`](../../verification/Sample.tla#L10)**",
  "```tla\nSafety ==\n  TRUE\n```",
  "**Production code: [`src/fake.ts#rule`](../../src/fake.ts#L5)**",
  "Source fingerprint: `sha256:",
  "## The safety claim",
  "## What this model does not prove",
  "- The model uses two listings.",
  "## How to read the model text",
] as const;

const INDEX_FRAGMENTS = [
  "# Model walkthroughs",
  "[A sample walkthrough](Sample.md)",
  "a guide names a rule or a declaration that no longer exists",
  "## The notation key",
] as const;
/* jscpd:ignore-end */

const missingRuleGuide = (): ModelGuide => ({
  ...guide,
  steps: [{ ...guide.steps[0]!, rules: ["Missing"] }],
});

describe("renderPage", () => {
  test("renders every section and both links", () => {
    const page = renderPage(guide, sources);
    expectIncludesAll(page, [...PAGE_FRAGMENTS]);
    expect(page).toMatch(/sha256:[0-9a-f]{16}/);
  });

  test("omits the value table when a step has no values", () => {
    const page = renderPage(
      {
        ...guide,
        steps: [{ ...guide.steps[0]!, values: [] }],
      },
      sources,
    );
    expect(page).not.toContain("| Value | This step |");
  });

  test("renders several rules and code anchors", () => {
    const page = renderPage(
      {
        ...guide,
        steps: [
          {
            ...guide.steps[0]!,
            code: [
              { path: "src/fake.ts", symbol: "rule" },
              {
                detail: "declaration" as const,
                path: "src/fake.ts",
                symbol: "rule",
              },
            ],
            rules: ["Safety", "Safety"],
          },
        ],
      },
      sources,
    );
    expect(page.match(/\*\*Model rule: /g)).toHaveLength(2);
    expect(page.match(/\*\*Production code: /g)).toHaveLength(2);
    checkRender(page, () => renderPage(missingRuleGuide(), sources));
  });
});

describe("renderIndex", () => {
  test("links every guide and explains the check", () => {
    const index = renderIndex([guide]);
    expectIncludesAll(index, [...INDEX_FRAGMENTS]);
    expect(codeFence("plain")).toBe("```");
    expect(codeFence("```tla\nvalue\n```")).toBe("````");
  });
});
