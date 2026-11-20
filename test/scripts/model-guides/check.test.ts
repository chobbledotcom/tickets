import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { GuideAccess } from "#scripts/model-guides/access.ts";
import {
  checkModelGuides,
  findModelGuideIssues,
  generateModelGuidePages,
} from "#scripts/model-guides/check.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import {
  declaration,
  findWithGuide,
  guide,
  issues,
  issuesAfterFile,
  joinFindings,
  replaceGuide,
  SAMPLE_TLA,
  state,
  withFirstStep,
} from "./fixtures.ts";

describe("findModelGuideIssues", () => {
  test("accepts a current guide set", async () => {
    expect(await issues()).toEqual([]);
  });

  test("reports a guide with no cast", async () => {
    const found = await findWithGuide((first) => ({ ...first, cast: [] }));
    expectIncludesAll(found.join("\n"), ["no cast"]);
  });

  test("does not require a safety rule that the model does not define", async () => {
    const found = await issues((current) => {
      current.access.files.set(
        "verification/Sample.tla",
        SAMPLE_TLA.replace("Safety ==\n  TypeOK\n", ""),
      );
      const first = current.context.guides[0]!;
      replaceGuide(current, (currentGuide) => ({
        ...currentGuide,
        steps: [
          first.steps[0]!,
          first.steps[1]!,
          { ...first.steps[2]!, rules: ["TypeOK"] },
        ],
      }));
    });
    expect(found.some((line) => line.includes("does not name Safety"))).toBe(
      false,
    );
  });

  test("reports a missing, extra, and duplicate guide", async () => {
    const found = [
      await issues((current) => {
        current.context.modules.push({
          ...declaration,
          module: "Uncovered",
        });
      }),
      await issues((current) => {
        current.context.guides.push({ ...guide, module: "Extra" });
      }),
      await issues((current) => {
        current.context.guides.push(guide);
      }),
    ];
    expectIncludesAll(joinFindings(...found), [
      "[guide-missing]",
      "[guide-extra]",
      "[guide-duplicate]",
    ]);
  });

  test("reports empty fields, a repeated cast word, and no limits", async () => {
    const found = await findWithGuide((first) => ({
      ...first,
      cast: [
        { meaning: "", term: "listing" },
        { meaning: "Again.", term: "listing" },
      ],
      claim: " ",
      limits: [],
      title: "",
    }));
    expect(found.filter((line) => line.includes("[guide-field]"))).toHaveLength(
      5,
    );
  });

  test("reports too few steps and an empty step", async () => {
    const empty = await issues((current) => {
      replaceGuide(current, (first) => ({ ...first, steps: [] }));
    });
    const oneStep = await issues((current) => {
      replaceGuide(current, (first) => ({
        ...first,
        steps: [
          {
            code: [],
            rules: [],
            title: "",
            values: [{ name: "", value: "" }],
            what: "",
          },
          ...first.steps.slice(1),
        ],
      }));
    });
    expectIncludesAll(joinFindings(empty, oneStep), ["[guide-steps]"]);
    expect(oneStep.filter((line) => line.includes("step 1")).length).toBe(5);
  });

  test("reports a rule with no step and a step with no rule", async () => {
    const found = await findWithGuide((first) => ({
      ...first,
      steps: [
        ...[["TypeOK"], ["Step"], ["Safety"]].map((rules, index) => ({
          ...first.steps[index]!,
          rules,
        })),
        { ...first.steps[2]!, rules: ["Ghost"], title: "Ghost" },
      ],
    }));
    expectIncludesAll(found.join("\n"), [
      "Init has no step",
      "Next has no step",
      "[guide-anchor]",
    ]);
  });

  test("reports a source outside the model context", async () => {
    const found = await issues((current) => {
      current.access.files.set("src/other.ts", "export const other = 1;\n");
      replaceGuide(current, (first) =>
        withFirstStep(first, (step) => ({
          ...step,
          code: [{ path: "src/other.ts", symbol: "other" }],
        })),
      );
    });
    expectIncludesAll(found.join("\n"), ["[guide-source-context]"]);
  });

  test("reports no production file, a missing symbol, and a missing file", async () => {
    const noProduction = await issues((current) => {
      replaceGuide(current, (first) => ({
        ...first,
        steps: first.steps.map((step) => ({
          ...step,
          code: [{ path: "scripts/producer.ts", symbol: "producer" }],
        })),
      }));
    });
    const missingSymbol = await findWithGuide((first) =>
      withFirstStep(first, (step) => ({
        ...step,
        code: [{ path: "src/fake.ts", symbol: "missing" }],
      })),
    );
    const missingFile = await issues((current) => {
      current.access.files.delete("src/fake.ts");
    });
    expectIncludesAll(joinFindings(noProduction, missingSymbol, missingFile), [
      "no production source file",
      "cannot be read",
    ]);
  });

  test("reports a page when a model rule or a source declaration changes", async () => {
    const modelChange = await issuesAfterFile(
      "verification/Sample.tla",
      (content) => content.replace("  x = 0", "  x = 1"),
    );
    const sourceChange = await issuesAfterFile("src/fake.ts", (content) =>
      content.replace("start = 1", "start = 2"),
    );
    expect(modelChange).toHaveLength(1);
    expect(sourceChange).toHaveLength(1);
    expectIncludesAll(joinFindings(modelChange, sourceChange), [
      "docs/model-guides/Sample.md",
      "generated page is out of date",
      "[guide-doc]",
    ]);
  });

  test("reports a missing, stale, and extra page", async () => {
    const missing = await issues((current) => {
      current.access.files.delete("docs/model-guides/Sample.md");
    });
    const stale = await issues((current) => {
      current.access.files.set(
        "docs/model-guides/Sample.md",
        `${current.access.files.get("docs/model-guides/Sample.md")}\n`,
      );
    });
    const extra = await issues((current) => {
      current.access.files.set("docs/model-guides/Extra.md", "extra\n");
      current.access.files.set("docs/model-guides/note.txt", "note\n");
    });
    expectIncludesAll(joinFindings(missing, stale, extra), [
      "generated page is missing",
      "generated page is out of date",
      "[guide-doc-extra]",
    ]);
  });

  test("skips an absent helper module and a helper that extends itself", async () => {
    const found = await issues((current) => {
      current.access.files.set(
        "verification/Sample.tla",
        SAMPLE_TLA.replace("EXTENDS ModelRules", "EXTENDS ModelRules, Missing"),
      );
    });
    expect(found).toEqual([]);
  });

  test("raises an error that is not a missing file", async () => {
    const current = await state();
    current.access.files.set(
      "verification/Sample.tla",
      SAMPLE_TLA.replace("EXTENDS ModelRules", "EXTENDS ModelRules, Missing"),
    );
    const access: GuideAccess = {
      list: (directory) => current.access.list(directory),
      read: (path) =>
        path === "verification/Missing.tla"
          ? Promise.reject(new Error("boom"))
          : current.access.read(path),
    };
    await expect(findModelGuideIssues(access, current.context)).rejects.toThrow(
      /boom/,
    );
  });

  test("reports a source read that throws a plain value", async () => {
    const current = await state();
    const access: GuideAccess = {
      list: (directory) => current.access.list(directory),
      read: (path) =>
        path === "src/fake.ts"
          ? Promise.reject("plain failure")
          : current.access.read(path),
    };
    expect(
      (await findModelGuideIssues(access, current.context)).join("\n"),
    ).toContain("plain failure");
  });
});

describe("generateModelGuidePages", () => {
  test("rejects a guide with no model and a model with no guide", async () => {
    const current = await state();
    await expect(
      generateModelGuidePages(current.access, {
        ...current.context,
        guides: [...current.context.guides, { ...guide, module: "Extra" }],
      }),
    ).rejects.toThrow(/guide-extra/);
    await expect(
      generateModelGuidePages(current.access, {
        ...current.context,
        guides: [],
      }),
    ).rejects.toThrow(/guide-missing/);
  });

  test("rejects a missing source declaration", async () => {
    const current = await state();
    await expect(
      generateModelGuidePages(current.access, {
        ...current.context,
        guides: [
          {
            ...guide,
            steps: [
              {
                ...guide.steps[0]!,
                code: [{ path: "src/fake.ts", symbol: "missing" }],
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/cannot be read/);
  });
});

describe("checkModelGuides", () => {
  test("reports success and failure through the standard output", async () => {
    const current = await state();
    const logged: string[] = [];
    const errors: string[] = [];
    expect(
      await checkModelGuides(
        { log: logged.push.bind(logged), logError: errors.push.bind(errors) },
        current.access,
        current.context,
      ),
    ).toBe(0);
    expect(logged).toEqual([
      "Model walkthroughs: every model has a current, mapped walkthrough.",
    ]);
    expect(
      await checkModelGuides(
        { log: logged.push.bind(logged), logError: errors.push.bind(errors) },
        current.access,
        { ...current.context, guides: [] },
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain("model walkthrough issue(s) found");
  });
});
