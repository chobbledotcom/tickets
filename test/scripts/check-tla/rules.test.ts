import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  findModuleIssues,
  findRegistryIssues,
} from "#scripts/check-tla/rules.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";

const helper: VerificationModule = {
  context: [],
  kind: "helper",
  module: "Shared",
};
const model: VerificationModule = {
  context: ["scripts/verify-models/vat.ts"],
  controls: [
    { data: async () => "control", name: "lost money", phase: "initial" },
  ],
  data: async () => "clean",
  kind: "model",
  module: "Example",
};
const source = (body: string, name = "Shared"): string =>
  `---- MODULE ${name} ----\n${body}\n====\n`;

describe("maintained model inventory", () => {
  test("refuses unregistered sources and missing declared sources", () => {
    const issues = findRegistryIssues(
      [helper],
      ["verification/Unexpected.tla"],
    );
    expect(issues.map((issue) => issue.rule)).toEqual([
      "missing-module",
      "unregistered-module",
    ]);
  });

  test("refuses duplicate declarations and missing negative controls", () => {
    const noControls = Object.assign({}, model, { controls: [] });
    expect(
      findRegistryIssues([helper, helper], ["verification/Shared.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["duplicate-module"]);
    expect(
      findRegistryIssues([noControls], ["verification/Example.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["missing-control"]);
  });

  test("refuses ambiguous controls without running their producers", () => {
    const fail = (): Promise<string> => {
      throw new Error("A metadata check ran a producer.");
    };
    const ambiguous = Object.assign({}, model, {
      controls: [
        { data: fail, name: "same", phase: "initial" },
        { data: fail, name: "same", phase: "step" },
      ],
      data: fail,
    });
    expect(
      findRegistryIssues([ambiguous], ["verification/Example.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["control-name"]);
  });

  test("refuses context escapes and checks the same policy for grading", () => {
    for (const path of [
      "../.env",
      "scripts/../secret.ts",
      "/run/secrets/key",
      "src/.private/key.ts",
      "src/customer.db",
    ]) {
      const forbidden = { ...helper, context: [path] };
      expect(
        findRegistryIssues([forbidden], ["verification/Shared.tla"]).map(
          (issue) => issue.rule,
        ),
      ).toEqual(["review-context"]);
      expect(
        findModuleIssues(
          "verification/Shared.tla",
          source("Double(n) == n * 2"),
          forbidden,
        ).map((issue) => issue.rule),
      ).toEqual(["review-context"]);
    }
  });
});

describe("TLA module policy", () => {
  test("allows pure helpers without fake state-machine obligations", () => {
    expect(
      findModuleIssues(
        "verification/Shared.tla",
        source(
          'Label == "VARIABLES"\n\\* VARIABLES in this comment declare no state.\nDouble(n) == n * 2',
        ),
        helper,
      ),
    ).toEqual([]);
  });

  test("refuses a stateful module registered as a helper", () => {
    const issues = findModuleIssues(
      "verification/Shared.tla",
      source("VARIABLES held\nInit == held = FALSE"),
      helper,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([{ line: 2, rule: "stateful-helper" }]);
  });

  test("reports a mismatched module identity at its original source line", () => {
    const issues = findModuleIssues(
      "verification/Example.tla",
      source("Value == 1"),
      model,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([{ line: 1, rule: "module-identity" }]);
  });

  test("refuses clone exclusions in comments but not inside string values", () => {
    const issues = findModuleIssues(
      "verification/Shared.tla",
      source('Label == "jscpd:ignore-start"\n(* jscpd:ignore-start *)'),
      helper,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([{ line: 3, rule: "clone-ignore" }]);
  });
});
