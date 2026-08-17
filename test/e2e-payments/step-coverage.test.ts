/**
 * Every step text the live Feature uses must match a registered step
 * definition. A missing definition only surfaces at runtime — Cucumber marks
 * the step undefined and the scenario fails or silently passes around it —
 * and the live dispatch is far too expensive a place to learn that. This is
 * the static handshake: the same support code the runner loads, matched
 * against every step the Feature carries.
 */

import { loadSupport } from "@cucumber/cucumber/api";
import type { Step } from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { relativeToProject } from "#scripts/path.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { parseGherkinSource } from "#scripts/specs/gherkin.ts";

const FEATURE = "e2e-payments/specs/live-payment-providers.feature";
const SUPPORT_GLOBS = [
  "e2e-payments/src/cucumber/support/**/*.ts",
  "e2e-payments/src/cucumber/steps/**/*.ts",
];

/** The step expressions Cucumber compiled from the harness's support code.
 * The public d.ts types the library without its step-definition list, but
 * the runtime library carries it — this is the one boundary cast, checked by
 * the assertions below. */
const registeredExpressions = async (): Promise<
  { match: (text: string) => unknown }[]
> => {
  const support = await loadSupport(
    {
      sources: {
        defaultDialect: "en",
        names: [],
        order: "defined",
        paths: [FEATURE],
        tagExpression: "",
      },
      support: { importPaths: SUPPORT_GLOBS },
    },
    { cwd: projectRoot },
  );
  const definitions = (
    support as unknown as {
      stepDefinitions: { expression: { match: (text: string) => unknown } }[];
    }
  ).stepDefinitions;
  expect(definitions?.length).toBeGreaterThan(0);
  return definitions.map((d) => d.expression);
};

/** Every concrete step text in the Feature, in document order. */
const featureStepTexts = async (): Promise<string[]> => {
  const data = await Deno.readTextFile(`${projectRoot}/${FEATURE}`);
  const document = parseGherkinSource(
    { data, uri: relativeToProject(FEATURE) },
    () => "id",
  );
  const feature = document.feature;
  if (!feature) throw new Error("the live feature is empty");
  const texts: string[] = [];
  const collect = (steps: readonly Step[]): void => {
    for (const step of steps) texts.push(step.text);
  };
  for (const child of feature.children) {
    if (child.rule) {
      for (const ruleChild of child.rule.children) {
        if (ruleChild.scenario) collect(ruleChild.scenario.steps);
      }
    }
    if (child.scenario) collect(child.scenario.steps);
  }
  return texts;
};

describe("live feature step coverage", () => {
  it("matches every step text against a registered definition", async () => {
    const expressions = await registeredExpressions();
    const texts = await featureStepTexts();
    expect(texts.length).toBeGreaterThan(0);

    const unmatched = texts.filter(
      (text) => !expressions.some((e) => e.match(text) !== null),
    );
    expect(unmatched).toEqual([]);
  });
});
