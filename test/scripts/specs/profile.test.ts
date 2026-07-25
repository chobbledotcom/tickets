import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import {
  expectInvalid,
  outlineFeature,
  registry,
  replace,
  source,
  validFeature,
} from "./profile-fixture.ts";

describe("Cucumber specification profile", () => {
  test("builds a stable story catalog from valid Gherkin", () => {
    const first = validateSpecSources([source()], registry);
    const second = validateSpecSources([source()], registry);

    expect(first).toEqual(second);
    expect(first.stories).toEqual([
      {
        actors: ["customer", "organiser"],
        description:
          "Customers get a clear result when the last place is taken during payment.",
        editions: ["managed", "self-hosted"],
        id: "payments.capacity-after-payment",
        line: 6,
        name: "Paid booking capacity",
        owner: "payments",
        risk: "high",
        rules: [
          {
            cases: [
              {
                id: "payment.place-available",
                line: 14,
                name: "Payment is confirmed before the last place is taken",
                surfaces: [],
              },
            ],
            description: "The confirmed payment creates the promised booking.",
            id: "payments.available-place-is-booked",
            line: 10,
            name: "A paid customer receives a place while one remains",
            surfaces: [],
          },
        ],
        surfaces: [],
        uri: "specs/payments/capacity.feature",
      },
    ]);
  });

  test("sorts sources before building the catalog", () => {
    const second = source(
      validFeature
        .replaceAll("payments.capacity-after-payment", "payments.other")
        .replaceAll("payments.available-place-is-booked", "payments.other-rule")
        .replaceAll("payment.place-available", "payment.other-case"),
      "specs/z.feature",
    );
    const result = validateSpecSources(
      [second, source(validFeature, "specs/a.feature")],
      registry,
    );
    expect(result.stories.map(({ uri }) => uri)).toEqual([
      "specs/a.feature",
      "specs/z.feature",
    ]);
  });

  test("reports malformed Gherkin at its source", () => {
    expect(() =>
      validateSpecSources([source("Feature Broken")], registry),
    ).toThrow("specs/payments/capacity.feature:1");
  });

  test("requires one known story owner risk actor and edition", () => {
    const cases = [
      ["@story:payments.capacity-after-payment\n", "", "@story:"],
      ["@owner:payments", "@owner:unknown", "@owner:unknown"],
      ["@risk:high", "@risk:urgent", "@risk:urgent"],
      ["@actor:customer @actor:organiser\n", "", "@actor:"],
      ["@edition:managed @edition:self-hosted\n", "", "@edition:"],
    ] as const;
    for (const [from, to, message] of cases) {
      expect(() =>
        validateSpecSources([source(replace(from, to))], registry),
      ).toThrow(message);
    }
  });

  test("rejects duplicate singular Feature tags and unknown tags", () => {
    expect(() =>
      validateSpecSources(
        [source(replace("@owner:payments", "@owner:payments @owner:payments"))],
        registry,
      ),
    ).toThrow("Duplicate @owner:payments");
    expect(() =>
      validateSpecSources(
        [source(replace("@risk:high", "@risk:high @mystery:value"))],
        registry,
      ),
    ).toThrow("Unknown tag @mystery:value");
    expectInvalid(
      replace(
        "@actor:customer @actor:organiser",
        "@actor:customer @actor:customer @actor:organiser",
      ),
      "Duplicate @actor:customer",
    );
  });

  test("requires every Scenario to belong to a described Rule", () => {
    expect(() =>
      validateSpecSources(
        [
          source(
            validFeature.replace(/ {2}@rule:[\s\S]*? {4}@case:/, "  @case:"),
          ),
        ],
        registry,
      ),
    ).toThrow("must belong to a Rule");
    expect(() =>
      validateSpecSources(
        [
          source(
            replace(
              "    The confirmed payment creates the promised booking.\n",
              "",
            ),
          ),
        ],
        registry,
      ),
    ).toThrow("Rule description is required");
  });

  test("requires stable Rule and Scenario ids", () => {
    expect(() =>
      validateSpecSources(
        [source(replace("  @rule:payments.available-place-is-booked\n", ""))],
        registry,
      ),
    ).toThrow("@rule:");
    expect(() =>
      validateSpecSources(
        [source(replace("    @case:payment.place-available\n", ""))],
        registry,
      ),
    ).toThrow("@case:");
  });

  test("rejects duplicate ids across files", () => {
    expect(() =>
      validateSpecSources(
        [source(), source(validFeature, "specs/payments/duplicate.feature")],
        registry,
      ),
    ).toThrow("Duplicate @story:payments.capacity-after-payment");
  });

  test("rejects the same id across metadata kinds", () => {
    expectInvalid(
      replace("payment.place-available", "payments.capacity-after-payment"),
      "Duplicate @case:payments.capacity-after-payment",
    );
  });

  test("validates Scenario Outline case ids and placeholders", () => {
    expect(
      validateSpecSources(
        [source(outlineFeature)],
        registry,
      ).stories[0]?.rules[0]?.cases.map(({ id }) => id),
    ).toEqual(["payment.one-left", "payment.two-left"]);
    expect(() =>
      validateSpecSources(
        [
          source(
            outlineFeature.replace(
              "case_id          | ",
              "example          | ",
            ),
          ),
        ],
        registry,
      ),
    ).toThrow("case_id");
    expect(() =>
      validateSpecSources(
        [
          source(
            outlineFeature.replace("payment.two-left", "payment.one-left"),
          ),
        ],
        registry,
      ),
    ).toThrow("Duplicate @case:payment.one-left");
    expect(() =>
      validateSpecSources(
        [source(outlineFeature.replace("<places>", "<missing>"))],
        registry,
      ),
    ).toThrow("placeholder <missing>");
    expect(() =>
      validateSpecSources(
        [source(outlineFeature.replace("| 1      |", "| <literal> |"))],
        registry,
      ),
    ).not.toThrow();
  });

  test("rejects a Scenario Outline without Examples", () => {
    expectInvalid(
      outlineFeature.replace(/\n {6}Examples:[\s\S]*$/, "\n"),
      "Scenario Outline needs Examples",
    );
  });

  test("rejects a Scenario without steps", () => {
    expectInvalid(
      validFeature.replace(/\n {6}Given[\s\S]*$/, "\n"),
      "Scenario needs a step",
    );
  });

  test("rejects misplaced tags on Examples", () => {
    expectInvalid(
      outlineFeature.replace(
        "      Examples:",
        "      @owner:payments\n      Examples:",
      ),
      "Unknown tag @owner:payments",
    );
  });

  test("rejects malformed and misplaced metadata tags", () => {
    expectInvalid(
      replace("@risk:high", "@risk:high @surface"),
      "Unknown tag @surface",
    );
    expectInvalid(
      replace("@risk:high", "@risk:high @surface:"),
      "Unknown tag @surface:",
    );
    expectInvalid(
      replace("@risk:high", "@risk:high @case:wrong-level"),
      "Unknown tag @case:wrong-level",
    );
  });

  test("rejects incomplete and inconsistent Examples tables", () => {
    expectInvalid(
      outlineFeature.replace(/ {8}\| payment\.one-left[\s\S]*$/, ""),
      "Scenario Outline needs Examples",
    );
    expectInvalid(
      outlineFeature.replace(/ {8}\| case_id[\s\S]*$/, ""),
      "Examples need a header",
    );
    expectInvalid(
      outlineFeature
        .replace(
          "| case_id          | places |",
          "| case_id          | places | places |",
        )
        .replace(
          "| payment.one-left | 1      |",
          "| payment.one-left | 1 | 1 |",
        )
        .replace(
          "| payment.two-left | 2      |",
          "| payment.two-left | 2 | 2 |",
        ),
      "Examples headers must be unique",
    );
    expectInvalid(
      outlineFeature
        .replace(
          "| case_id          | places |",
          "| case_id          | places | extra |",
        )
        .replace(
          "| payment.one-left | 1      |",
          "| payment.one-left | 1 | x |",
        )
        .replace(
          "| payment.two-left | 2      |",
          "| payment.two-left | 2 | y |",
        ),
      "Unused Examples column extra",
    );
    expectInvalid(
      outlineFeature.replace(
        "| payment.one-left | 1      |",
        "| payment.one-left |",
      ),
      "inconsistent cell count",
    );
    expectInvalid(
      outlineFeature.replace(
        "| payment.one-left | 1      |",
        "|                  | 1      |",
      ),
      "Examples case_id is required",
    );
  });

  test("keeps Outline ids only in Examples", () => {
    expectInvalid(
      outlineFeature.replace(
        "    Scenario Outline:",
        "    @case:payment.wrong-place\n    Scenario Outline:",
      ),
      "Scenario Outline case ids belong in Examples",
    );
  });

  test("requires executable Rules and a described Feature", () => {
    expectInvalid(
      validFeature.replace(
        / {4}@case:[\s\S]*$/,
        "    Background: A configured site\n      Given the site is ready\n",
      ),
      "Rule needs an executable Scenario",
    );
    expectInvalid(
      validFeature.replace(
        / {2}@rule:[\s\S]*$/,
        "  Background: A configured site\n    Given the site is ready\n",
      ),
      "Feature needs a Rule",
    );
    expectInvalid(
      replace(
        "  Customers get a clear result when the last place is taken during payment.\n",
        "",
      ),
      "Feature description is required",
    );
  });

  test("allows a Feature and Rule Background", () => {
    const withBackgrounds = validFeature
      .replace(
        "  @rule:",
        "  Background: A configured site\n    Given the site is ready\n\n  @rule:",
      )
      .replace(
        "    @case:",
        "    Background: Available payments\n      Given payments are active\n\n    @case:",
      );
    expect(
      validateSpecSources([source(withBackgrounds)], registry).stories,
    ).toHaveLength(1);
  });

  test("requires a Feature in each source", () => {
    expectInvalid("# This file has no Feature\n", "Feature is required");
  });

  test("keeps registered surfaces at their authored scope", () => {
    const scoped = outlineFeature
      .replace("@risk:high", "@risk:high @surface:webhook")
      .replace("  @rule:", "  @surface:return\n  @rule:")
      .replace(
        "    Scenario Outline:",
        "    @surface:webhook\n    Scenario Outline:",
      )
      .replace("      Examples:", "      @surface:return\n      Examples:");
    const story = validateSpecSources([source(scoped)], registry).stories[0];
    expect(story?.surfaces).toEqual(["webhook"]);
    expect(story?.rules[0]?.surfaces).toEqual(["return"]);
    expect(story?.rules[0]?.cases.map(({ surfaces }) => surfaces)).toEqual([
      ["webhook", "return"],
      ["webhook", "return"],
    ]);
  });

  test("rejects malformed ids", () => {
    expect(() =>
      validateSpecSources(
        [source(replace("payment.place-available", "Payment.place"))],
        registry,
      ),
    ).toThrow("Invalid case id");
  });
});
