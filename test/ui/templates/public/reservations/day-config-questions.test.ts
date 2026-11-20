import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { splitChildQuestions } from "#templates/public/reservations/day-config.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testQuestion } from "#test-utils/factories.ts";
import { twoListingContext } from "#test-utils/ticket-ctx.ts";

/** A page with one parent and one child it folds, and two questions on the
 * child alone: one that asks once for the booking, and one that asks once for
 * each listing. */
const parentWithChild = async () => {
  const { ctx, first, second } = await twoListingContext();
  const [parent, child] = [
    ctx.listings.find((info) => info.listing.id === first.id)!,
    ctx.listings.find((info) => info.listing.id === second.id)!,
  ];
  const booking = testQuestion({ displayType: "free_text", id: 1 });
  const perListing = testQuestion({
    answerLevel: "listing",
    displayType: "free_text",
    id: 2,
  });
  const split = splitChildQuestions(
    [parent],
    [booking, perListing],
    new Map([
      [1, [second.id]],
      [2, [second.id]],
    ]),
    new Map([[first.id, [child]]]),
    new Map(),
    new Map(),
    new Map(),
    new Map(),
  );
  return { booking, perListing, split };
};

describeWithEnv("splitChildQuestions", { db: true }, () => {
  test("renders a question that asks once for each listing at page level, even when only a child is assigned", async () => {
    const { perListing, split } = await parentWithChild();
    expect(split.pageQuestions).toEqual([perListing]);
  });

  test("leaves a child-only booking-level question to the child's own block", async () => {
    const { booking, split } = await parentWithChild();
    expect(split.pageQuestions).not.toContainEqual(booking);
    expect([...(split.childCtx?.rendered ?? [])]).toEqual([2]);
  });
});
