import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { resolveEvidenceScenario } from "#scripts/specs/evidence/resolve.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  outlineFeature,
  validFeature,
} from "#test/scripts/specs/profile-fixture.ts";
import {
  compileEvidenceFeature,
  PLAIN_EVIDENCE_SCENARIO,
} from "./evidence-fixture.ts";

describe("Cucumber evidence stable scenario resolution", () => {
  test("resolves authored story rule case and steps for a plain Scenario", () => {
    const fixture = compileEvidenceFeature(validFeature);
    const pickle = requireValue(fixture.pickles[0], "Plain Pickle is missing");
    const resolved = resolveEvidenceScenario(
      fixture.catalog,
      fixture.document,
      pickle,
    );

    expect(resolved).toEqual(PLAIN_EVIDENCE_SCENARIO);
  });

  test("uses each Scenario Outline row case_id and interpolated name", () => {
    const fixture = compileEvidenceFeature(outlineFeature);

    expect(
      fixture.pickles
        .map((pickle) =>
          resolveEvidenceScenario(fixture.catalog, fixture.document, pickle),
        )
        .map(({ case: specCase, steps }) => ({ specCase, steps })),
    ).toEqual([
      {
        specCase: {
          id: "payment.one-left",
          name: "Payment result payment.one-left",
        },
        steps: [
          { keyword: "Given", text: "a paid listing has 1 places left" },
          { keyword: "When", text: "a customer payment is confirmed" },
          { keyword: "Then", text: "the customer receives a ticket" },
        ],
      },
      {
        specCase: {
          id: "payment.two-left",
          name: "Payment result payment.two-left",
        },
        steps: [
          { keyword: "Given", text: "a paid listing has 2 places left" },
          { keyword: "When", text: "a customer payment is confirmed" },
          { keyword: "Then", text: "the customer receives a ticket" },
        ],
      },
    ]);
  });

  test("fails when a Pickle does not belong to the validated catalog", () => {
    const fixture = compileEvidenceFeature(validFeature);
    const pickle = {
      ...requireValue(fixture.pickles[0], "Plain Pickle is missing"),
      uri: "specs/other.feature",
    };

    expect(() =>
      resolveEvidenceScenario(fixture.catalog, fixture.document, pickle),
    ).toThrow("Could not resolve one stable case");
  });

  test("includes authored Background steps", () => {
    const fixture = compileEvidenceFeature(`
@story:payments.capacity-after-payment
@owner:payments @risk:high
@actor:customer @edition:managed
Feature: Paid booking capacity
  Customers get a clear result when payment completes.

  @rule:payments.available-place-is-booked
  Rule: A paid customer receives an available place
    The confirmed payment creates the promised booking.

    Background:
      Given a paid listing has one place left

    @case:payment.place-available
    Scenario: Payment is confirmed before the last place is taken
      When a customer payment is confirmed
      Then the customer receives a ticket
`);
    const pickle = requireValue(
      fixture.pickles[0],
      "Background Pickle is missing",
    );

    expect(
      resolveEvidenceScenario(fixture.catalog, fixture.document, pickle).steps,
    ).toEqual([
      { keyword: "Given", text: "a paid listing has one place left" },
      { keyword: "When", text: "a customer payment is confirmed" },
      { keyword: "Then", text: "the customer receives a ticket" },
    ]);
  });

  test("fails when the Gherkin document has no Feature", () => {
    const fixture = compileEvidenceFeature(validFeature);
    const pickle = requireValue(fixture.pickles[0], "Plain Pickle is missing");
    const { feature: _feature, ...documentWithoutFeature } = fixture.document;

    expect(() =>
      resolveEvidenceScenario(fixture.catalog, documentWithoutFeature, pickle),
    ).toThrow("Evidence Gherkin document has no Feature");
  });

  test("fails when a Pickle step has no authored step", () => {
    const fixture = compileEvidenceFeature(validFeature);
    const pickle = requireValue(fixture.pickles[0], "Plain Pickle is missing");
    const firstStep = requireValue(pickle.steps[0], "Plain step is missing");
    const brokenPickle = {
      ...pickle,
      steps: [{ ...firstStep, astNodeIds: ["missing-authored-step"] }],
    };

    expect(() =>
      resolveEvidenceScenario(fixture.catalog, fixture.document, brokenPickle),
    ).toThrow(`Could not resolve authored step ${firstStep.text}`);
  });
});
