/**
 * The option-demand suite: the declared case table in ./cases.ts, driven
 * through the judge, the booking form's own fold, and the checkout
 * availability check. A surface that answers differently fails here without
 * a new test.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  type Alternative,
  judgeOptionDemand,
  type OptionDemandQuestion,
  type OptionVerdict,
} from "#booking/option-demand.ts";
import {
  judgedByDay,
  loadCapacitySnapshot,
  perDayRemainingFromSnapshot,
  remainingFromSnapshot,
} from "#db/attendees/capacity/snapshot.ts";
import { listingGroups } from "#db/groups/table.ts";
import { uniqueBy } from "#fp";
import { FormParams } from "#shared/form-data.ts";
import { judgedOption } from "#routes/public/order-catalog.ts";
import {
  checkAvailability,
  resolveDayCount,
} from "#routes/public/ticket-payment.ts";
import { evaluateOrder } from "#shared/order/evaluate.ts";
import {
  listingOption,
  type OrderOption,
  type OrderPools,
} from "#shared/order/options.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { ListingWithCount } from "#types";
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

/** The widest alternative the judge answered: the biggest span the buyer
 * can pick, and the committed preview. */
const widestAlternative = (
  outcome: Extract<OptionVerdict["outcome"], { state: "bookable" }>,
): Alternative => {
  const [widest] = [...outcome.alternatives].sort(
    (left, right) => right.dayCount - left.dayCount,
  );
  if (widest === undefined) throw new Error("a bookable verdict has spans");
  return widest;
};

/** The child units one alternative charges: its demand minus the parents'
 * own units. */
const chargedChildUnits = (
  question: OptionDemandQuestion,
  alternative: Alternative,
): [number, number][] => {
  const parentIds = new Set(question.parents.map((p) => p.listing.id));
  return [...alternative.unitsByListingId]
    .filter(([listingId]) => !parentIds.has(listingId))
    .map(([listingId, qty]): [number, number] => [listingId, qty]);
};

/** The alternative judged for one span, or undefined when the span is not
 * bookable. */
const alternativeAt = (
  outcome: Extract<OptionVerdict["outcome"], { state: "bookable" }>,
  dayCount: number,
): Alternative | undefined =>
  outcome.alternatives.find((alternative) => alternative.dayCount === dayCount);

/** The gallery's capacity pools for one case's fixtures, built the way the
 * order page builds them: one snapshot over the option's widest span, per
 * day for day-judged listings, a running total otherwise. */
const galleryPools = async (
  built: BuiltCase,
  judged: OrderOption,
): Promise<OrderPools> => {
  const involved = uniqueBy((listing: ListingWithCount) => listing.id)([
    ...built.parents.map((info) => info.listing),
    ...[...built.childrenByParentId.values()]
      .flat()
      .map((info) => info.listing),
  ]);
  const widestSpanDays = Math.max(1, ...judged.spanDaysByListingId.values());
  const groupIdsByListingId = await listingGroups.getIdsByKeys(
    involved.map((listing) => listing.id),
  );
  const snapshot = await loadCapacitySnapshot(
    involved,
    built.date,
    widestSpanDays,
    groupIdsByListingId,
  );
  const dateless = involved.filter((info) => !judgedByDay(info, snapshot));
  return {
    days: snapshot.days,
    groupIdsByListingId,
    remainingByGroupDay: snapshot.groupByDay,
    remainingByGroupId: snapshot.datelessGroupRemaining,
    remainingByListingDay: perDayRemainingFromSnapshot(snapshot, involved),
    remainingByListingId: remainingFromSnapshot(snapshot, dateless, () => 1),
  };
};

/** The form's fold at one judged span accepts, and — when the fold is the
 * gallery's own empty form — produces exactly the demand the judge charges
 * for that span. An explicit buyer choice decides its own child units, so
 * the judge deliberately charges none of those. */
const expectFoldMatchesJudge = async (
  testCase: DemandCase,
  built: BuiltCase,
  dayCount: number,
  outcome: Extract<OptionVerdict["outcome"], { state: "bookable" }>,
): Promise<void> => {
  const folded = await foldFor(testCase, built, dayCount);
  expect(folded.ok, testCase.name).toBe(true);
  const alternative = alternativeAt(outcome, dayCount);
  expect(alternative, testCase.name).toBeDefined();
  if (!folded.ok || testCase.fold === "explicit-choice" || !alternative) return;
  expect(sortedEntries(folded.quantities), testCase.name).toEqual(
    sortedEntries(alternative.unitsByListingId),
  );
};

/** The checkout must answer each realisable booking the judge offers,
 * refusing exactly the spans the per-date capacity refuses. */
const expectCheckoutAgreesWithPools = async (
  testCase: DemandCase,
  built: BuiltCase,
): Promise<void> => {
  const outcome = judgeOptionDemand(questionFor(built)).outcome;
  if (outcome.state !== "bookable") {
    throw new Error("the judge must accept a bookable case");
  }
  for (const dayCount of outcome.bookableDayCounts) {
    const folded = await foldFor(testCase, built, dayCount);
    if (!folded.ok) {
      throw new Error("the fold must accept a bookable case");
    }
    const fits =
      testCase.capacityFitsAt?.includes(dayCount) ?? !testCase.capacityRefuses;
    expect(
      await checkAvailability(
        folded.listings,
        folded.quantities,
        built.date,
        folded.dayCount,
      ),
      `${testCase.name} at ${dayCount} day(s)`,
    ).toBe(fits);
  }
};

/** The gallery's greying must agree with the checkout's per-date answer:
 * available when the buyer's booking fits the pools, unavailable when the
 * per-date capacity refuses it. */
const expectGalleryAgreesWithCheckout = async (
  testCase: DemandCase,
  built: BuiltCase,
): Promise<void> => {
  const verdict = judgeOptionDemand(questionFor(built));
  if (verdict.outcome.state !== "bookable") {
    throw new Error("the judge must accept a bookable case");
  }
  // The gallery's own merge: the card option carrying the judge's
  // realisable alternatives.
  const judged = judgedOption(
    listingOption(built.parents[0]!.listing, true),
    verdict,
  );
  const states = evaluateOrder(
    [judged],
    await galleryPools(built, judged),
    [],
    true,
  );
  const state = states.get(judged.key);
  expect(state, testCase.name).toBeDefined();
  expect(state?.kind, testCase.name).toBe(
    testCase.capacityRefuses ? "unavailable" : "available",
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
        const charged = chargedChildUnits(
          questionFor(built),
          widestAlternative(outcome),
        );
        expect(
          charged.map(([listingId, qty]) => [nameOf(built, listingId), qty]),
        ).toEqual(expected.childUnits);
      });

      test(`backwards — the form folds what the judge offers: ${testCase.name}`, async () => {
        const built = await testCase.build();
        const outcome = judgeOptionDemand(questionFor(built)).outcome;
        if (outcome.state === "refused") {
          // A refusal the fold shares, unless the page's day-count
          // resolution answers it first: the fold walk folds each member
          // at its own duration, and the day-count gate refuses the
          // submission.
          expect((await formFold(built, 1)).ok).toBe(
            testCase.foldAccepts ?? false,
          );
          if (testCase.foldAccepts) {
            const chosen = built.parents.map((info) => ({
              listing: info.listing,
              qty: built.quantities.get(info.listing.id) ?? 0,
            }));
            const resolved = await resolveDayCount(
              chosen,
              new FormParams([["day_count", "1"]]),
              built.date,
            );
            expect("error" in resolved, testCase.name).toBe(true);
          }
          return;
        }
        for (const dayCount of outcome.bookableDayCounts) {
          await expectFoldMatchesJudge(testCase, built, dayCount, outcome);
        }
      });

      if (expected.bookable) {
        test(`backwards — checkout agrees with the pools: ${testCase.name}`, async () => {
          await expectCheckoutAgreesWithPools(testCase, await testCase.build());
        });

        test(`backwards — the gallery judges as the checkout answers: ${testCase.name}`, async () => {
          await expectGalleryAgreesWithCheckout(
            testCase,
            await testCase.build(),
          );
        });
      }
    }

    test("the render phase judges date-less, as the form does before a date", async () => {
      for (const index of renderPhaseCases) {
        const testCase = CASES[index]!;
        const built = { ...(await testCase.build()), date: null };
        const outcome = judgeOptionDemand(questionFor(built)).outcome;
        expect(outcome.state, testCase.name).toBe("bookable");
        // The form's date-less fold holds exactly where no daily child
        // demands a date: a standard-priced child folds, a daily child
        // waits for the date gate.
        const folded = await formFold(built, 1);
        expect(folded.ok, testCase.name).toBe(testCase.foldsDateless ?? false);
      }
    });

    test("nameOf refuses a listing id no fixture holds", async () => {
      const built = await CASES[0]!.build();
      expect(() => nameOf(built, -1)).toThrow("Unknown listing -1");
    });

    test("a zero-quantity parent books nothing and demands nothing", async () => {
      // The judge answers the option the catalog hands it. The catalog only
      // judges parents the buyer books, and a zero quantity contributes no
      // fold and no demand, on every surface.
      const built = await CASES[0]!.build();
      const question = questionFor(built);
      const parentId = built.parents[0]!.listing.id;
      const outcome = judgeOptionDemand({
        ...question,
        quantities: new Map([[parentId, 0]]),
      }).outcome;
      expect(outcome.state, "a zero-quantity parent is bookable").toBe(
        "bookable",
      );
      if (outcome.state !== "bookable") return;
      expect(outcome.bookableDayCounts).toEqual([1]);
      expect(
        sortedEntries(widestAlternative(outcome).unitsByListingId),
      ).toEqual([]);
    });
  },
);
