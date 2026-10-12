/**
 * The option-demand suite: the declared case table in ./cases.ts, driven
 * through the judge, the booking form's own fold, and the checkout
 * availability check. A surface that answers differently fails here without
 * a new test.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  judgeOptionDemand,
  type OptionDemandQuestion,
  type OptionVerdict,
} from "#booking/option-demand.ts";
import { checkAvailability } from "#routes/public/ticket-payment.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type BuiltCase,
  CASES,
  type DemandCase,
  foldFor,
  formFold,
  nameOf,
  questionFor,
  renderPhaseCases,
  sortedEntries,
} from "./cases.ts";

/** The child units the judge charges: the option's demand minus its parents'
 * own units. */
const chargedChildUnits = (
  question: OptionDemandQuestion,
  outcome: OptionVerdict["outcome"],
): [number, number][] => {
  if (outcome.state !== "bookable") return [];
  const parentIds = new Set(question.parents.map((p) => p.listing.id));
  return [...outcome.unitsByListingId]
    .filter(([listingId]) => !parentIds.has(listingId))
    .map(([listingId, qty]): [number, number] => [listingId, qty]);
};

/** The form's fold at one judged span accepts, and — when the fold is the
 * gallery's own empty form — produces exactly the demand the judge charges.
 * An explicit buyer choice decides its own child units, so the judge
 * deliberately charges none of those. */
const expectFoldMatchesJudge = async (
  testCase: DemandCase,
  built: BuiltCase,
  dayCount: number,
  outcome: Extract<OptionVerdict["outcome"], { state: "bookable" }>,
): Promise<void> => {
  const folded = await foldFor(testCase, built, dayCount);
  expect(folded.ok, testCase.name).toBe(true);
  if (!folded.ok || testCase.fold === "explicit-choice") return;
  expect(sortedEntries(folded.quantities), testCase.name).toEqual(
    sortedEntries(outcome.unitsByListingId),
  );
};

describeWithEnv(
  "booking > option demand — the one judge every surface asks",
  { db: true, triggers: true },
  () => {
    for (const testCase of CASES) {
      const expected = testCase.expected;
      test(`forwards — ${testCase.name}`, async () => {
        const built = await testCase.build();
        const outcome = judgeOptionDemand(questionFor(built)).outcome;
        if (outcome.state === "refused") {
          expect(expected.bookable, testCase.name).toBe(false);
          if (!expected.bookable) {
            expect(outcome).toEqual({
              reason: expected.reason,
              state: "refused",
            });
          }
          return;
        }
        if (!expected.bookable) {
          throw new Error("the judge must accept a bookable case");
        }
        expect(outcome.bookableDayCounts, testCase.name).toEqual(
          expected.dayCounts,
        );
        expect(
          chargedChildUnits(questionFor(built), outcome).map(
            ([listingId, qty]) => [nameOf(built, listingId), qty],
          ),
        ).toEqual(expected.childUnits);
      });

      test(`backwards — the form folds what the judge offers: ${testCase.name}`, async () => {
        const built = await testCase.build();
        const outcome = judgeOptionDemand(questionFor(built)).outcome;
        if (outcome.state === "refused") {
          // A refusal the fold shares. A capacity refusal is the one the
          // checkout's per-date check answers instead.
          expect((await formFold(built, 1)).ok).toBe(false);
          return;
        }
        for (const dayCount of outcome.bookableDayCounts) {
          await expectFoldMatchesJudge(testCase, built, dayCount, outcome);
        }
      });

      if (expected.bookable) {
        test(`backwards — checkout agrees with the pools: ${testCase.name}`, async () => {
          const built = await testCase.build();
          const outcome = judgeOptionDemand(questionFor(built)).outcome;
          if (outcome.state !== "bookable") {
            throw new Error("the judge must accept a bookable case");
          }
          const folded = await foldFor(
            testCase,
            built,
            outcome.bookableDayCounts[0]!,
          );
          if (!folded.ok) {
            throw new Error("the fold must accept a bookable case");
          }
          expect(
            await checkAvailability(
              folded.listings,
              folded.quantities,
              built.date,
              folded.dayCount,
            ),
          ).toBe(!testCase.capacityRefuses);
        });
      }
    }

    test("the render phase judges date-less, as the form does before a date", async () => {
      for (const index of renderPhaseCases) {
        const testCase = CASES[index]!;
        const built = { ...(await testCase.build()), date: null };
        const outcome = judgeOptionDemand(questionFor(built)).outcome;
        expect(outcome.state, testCase.name).toBe("bookable");
      }
    });
  },
);
