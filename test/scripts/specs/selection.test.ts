import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { validateSpecSources } from "#scripts/specs/profile.ts";
import { selectSpecCases } from "#scripts/specs/selection.ts";
import {
  outlineFeature,
  registry,
  source,
} from "#test/scripts/specs/profile-fixture.ts";

describe("Cucumber case selection", () => {
  const taggedOutline = outlineFeature
    .replace("@risk:high", "@risk:high @surface:return")
    .replace(
      "@rule:payments.available-place-is-booked",
      "@rule:payments.available-place-is-booked @surface:webhook",
    );
  const catalog = validateSpecSources([source(taggedOutline)], registry);

  test("selects an Outline row by its stable case id", () => {
    expect(selectSpecCases(catalog, "@case:payment.two-left")).toEqual([
      "specs/payments/capacity.feature:21",
    ]);
  });

  test("evaluates inherited metadata and boolean tag expressions", () => {
    expect(
      selectSpecCases(catalog, "@risk:high and not @case:payment.two-left"),
    ).toEqual(["specs/payments/capacity.feature:20"]);
    expect(selectSpecCases(catalog, "@risk:low")).toEqual([]);
  });
});
