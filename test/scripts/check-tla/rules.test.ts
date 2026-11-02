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
  language: "tla",
  module: "Shared",
};
const model: VerificationModule = {
  context: ["scripts/verify-models/vat.ts"],
  controls: [
    { data: async () => "control", name: "lost money", phase: "initial" },
  ],
  data: async () => "clean",
  kind: "model",
  language: "tla",
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

  test("refuses duplicate context paths", () => {
    const duplicateContext = {
      ...helper,
      context: ["scripts/verify-models/vat.ts", "scripts/verify-models/vat.ts"],
    };
    expect(
      findRegistryIssues([duplicateContext], ["verification/Shared.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["duplicate-context"]);
  });

  test("refuses a control phase outside initial and step", () => {
    const invalidPhase = Object.assign({}, model, {
      controls: [{ ...model.controls[0], phase: "reachable" }],
    });
    expect(
      findRegistryIssues([invalidPhase], ["verification/Example.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["control-phase"]);
  });

  test("refuses an invalid module identifier", () => {
    const invalidName = { ...helper, module: "9Invalid" };
    expect(
      findRegistryIssues([invalidName], ["verification/9Invalid.tla"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["module-name"]);
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

const quintSource = (body: string, name = "Shared"): string =>
  `module ${name} {\n${body}\n}\n`;

describe("Quint module policy", () => {
  const quintHelper: VerificationModule = { ...helper, language: "quint" };
  const quintModel: VerificationModule = { ...model, language: "quint" };

  test("allows a Quint helper without state", () => {
    expect(
      findModuleIssues(
        "verification/Shared.qnt",
        quintSource(
          "pure def double(n: int): int = n * 2\n/// var in a doc comment declares no state.",
        ),
        quintHelper,
      ),
    ).toEqual([]);
  });

  test("refuses a Quint module that declares state as a helper", () => {
    const issues = findModuleIssues(
      "verification/Shared.qnt",
      quintSource("var held: bool\n\npure def holds: bool = held"),
      quintHelper,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([{ line: 2, rule: "stateful-helper" }]);
  });

  test("reports a mismatched Quint module identity", () => {
    const issues = findModuleIssues(
      "verification/Example.qnt",
      quintSource("pure val value: int = 1", "Shared"),
      quintModel,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([{ line: 1, rule: "module-identity" }]);
  });

  test("refuses clone exclusions in Quint comments but not in strings", () => {
    const issues = findModuleIssues(
      "verification/Shared.qnt",
      quintSource(
        'pure val label: str = "jscpd:ignore-start"\n\n// jscpd:ignore-start\n/* jscpd:ignore-end */',
      ),
      quintHelper,
    );
    expect(
      issues.map((issue) => ({ line: issue.line, rule: issue.rule })),
    ).toEqual([
      { line: 4, rule: "clone-ignore" },
      { line: 5, rule: "clone-ignore" },
    ]);
  });

  test("refuses a Quint source with no module header", () => {
    expect(() =>
      findModuleIssues(
        "verification/Shared.qnt",
        "pure val value: int = 1",
        quintHelper,
      ),
    ).toThrow(/Quint module header/);
  });

  test("refuses a declared TLA source that arrives as Quint", () => {
    expect(
      findRegistryIssues([model], ["verification/Example.qnt"]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["missing-module"]);
  });
});
