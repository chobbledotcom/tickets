/** Direct tests for the live payment harness's target selection contract. */

import type { Envelope } from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  caseExpression,
  catalogCaseIds,
  executedCaseCount,
  LIVE_TARGETS,
  TARGET_CASES,
  verifyCatalogTargets,
  verifyExecutedCases,
} from "#e2e/targets.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";

describe("live target selection", () => {
  it("covers every case in the feature exactly once across all targets", async () => {
    const catalog = await readSpecCatalog([
      "e2e-payments/specs/live-payment-providers.feature",
    ]);
    expect(() => verifyCatalogTargets(catalog)).not.toThrow();

    const allTargetCases = LIVE_TARGETS.flatMap((t) => TARGET_CASES[t]);
    expect(allTargetCases.length).toBe(new Set(allTargetCases).size);
    expect(catalogCaseIds(catalog).sort()).toEqual(
      [...new Set(allTargetCases)].sort(),
    );
  });

  it("builds an or-expression from the target's case tags", () => {
    expect(caseExpression(["live-payments.free-booking-once"])).toBe(
      "@case:live-payments.free-booking-once",
    );
    expect(
      caseExpression([
        "live-payments.free-booking-once",
        "live-payments.complex-free",
      ]),
    ).toBe(
      "@case:live-payments.free-booking-once or @case:live-payments.complex-free",
    );
  });

  it("fails when a target names a case the feature does not carry", () => {
    expect(() => verifyCatalogTargets({ stories: [] })).toThrow(
      /must carry each of these case ids exactly once/,
    );
  });

  it("fails when the feature carries a case no target runs", async () => {
    const catalog = await readSpecCatalog([
      "e2e-payments/specs/live-payment-providers.feature",
    ]);
    // Simulate a target set that forgot one case by checking against a
    // catalog with an extra case grafted on.
    const [story] = catalog.stories;
    if (!story) throw new Error("catalog has no stories");
    const grafted = {
      stories: [
        {
          ...story,
          rules: [
            ...story.rules.slice(0, -1),
            {
              ...story.rules[story.rules.length - 1]!,
              cases: [
                ...story.rules[story.rules.length - 1]!.cases,
                {
                  id: "live-payments.unclaimed",
                  line: 999,
                  name: "x",
                  surfaces: [],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => verifyCatalogTargets(grafted)).toThrow(
      /no nightly target runs these live payment cases: live-payments.unclaimed/,
    );
  });
});

describe("executed-case counting", () => {
  /** A minimal finished-case envelope; Envelope's oneof shape has dozens of
   * members, so only the fields the counter reads are populated. */
  const finished = (id: string): Envelope =>
    ({
      testCaseFinished: {
        testCaseId: id,
        testCaseStartedId: `${id}-started`,
        timestamp: { nanos: 0, seconds: 0 },
        willBeRetried: false,
      },
    }) as unknown as Envelope;

  it("counts only finished cases", () => {
    const messages = [
      finished("1"),
      { testCaseStarted: { testCaseId: "2" } } as Envelope,
      finished("2"),
      finished("2"),
    ];
    expect(executedCaseCount(messages)).toBe(3);
  });

  it("requires exactly the selected number of executions", () => {
    const messages = [finished("1"), finished("2")];
    expect(() =>
      verifyExecutedCases(messages, [
        "live-payments.free-booking-once",
        "live-payments.complex-free",
      ]),
    ).not.toThrow();
  });

  it("fails a zero-case run even though runSpecs would call it success", () => {
    expect(() =>
      verifyExecutedCases([], ["live-payments.free-booking-once"]),
    ).toThrow(/expected 1 executed case/);
  });

  it("fails when fewer cases ran than were selected", () => {
    expect(() =>
      verifyExecutedCases(
        [finished("1")],
        ["live-payments.free-booking-once", "live-payments.complex-free"],
      ),
    ).toThrow(/finished 1/);
  });
});
