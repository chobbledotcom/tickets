import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import {
  outlineFeature,
  registry,
  source,
} from "#test/scripts/specs/profile-fixture.ts";

describe("Cucumber Outline step arguments", () => {
  test("finds placeholders in DocStrings and DataTables", () => {
    const withStepArguments = outlineFeature
      .replace(
        "      When a customer payment is confirmed",
        '      When a customer payment is confirmed\n        """\n        <detail>\n        """',
      )
      .replace(
        "      Then the customer receives a ticket",
        "      Then the customer receives a ticket\n        | result | <table_value> |",
      )
      .replace("| places |", "| places | detail | table_value |")
      .replaceAll("| 1      |", "| 1      | first  | booked      |")
      .replaceAll("| 2      |", "| 2      | second | refunded    |");

    expect(() =>
      validateSpecSources([source(withStepArguments)], registry),
    ).not.toThrow();
  });
});
