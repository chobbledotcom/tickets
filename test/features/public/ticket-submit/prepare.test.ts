/**
 * `prepareOrder` is the step the booking submit and the `/calculate` quote
 * share: it validates the form, folds children, builds the order's lines and
 * prices them. These are its direct tests.
 *
 * The answer scope is the one worth watching. It comes from the order's own
 * lines, so an answer can only be filed under a listing the order has a line
 * for, and `answerModifierQuantities` can price every key it is handed.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildTicketListing } from "#booking/model.ts";
import { quantityFieldName } from "#booking/tree.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { questionListings } from "#db/questions/queries.ts";
import { answersTable, questionsTable } from "#db/questions/tables.ts";
import { getTicketContext } from "#routes/public/ticket-payment.ts";
import {
  prepareOrder,
  singleListingThankYouUrl,
} from "#routes/public/ticket-submit/prepare.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import type { Group } from "#types";

const ticketContext = async (
  listingIds: number[],
  group?: Group,
): Promise<TicketCtx> => {
  const listings = await Promise.all(
    listingIds.map(async (id) =>
      buildTicketListing((await getListingWithCount(id))!, false, undefined),
    ),
  );
  return {
    ...(await getTicketContext(listings, group)),
    listings,
    slugs: listings.map((info) => info.listing.slug),
  };
};

const quantityForm = (counts: Record<number, number>): FormParams => {
  const form = new FormParams();
  for (const [listingId, quantity] of Object.entries(counts)) {
    form.set(quantityFieldName(Number(listingId)), String(quantity));
  }
  return form;
};

/** The order's lines and the answer scope prepareOrder settled on. */
const preparedOrder = async (
  listingIds: number[],
  counts: Record<number, number>,
) => {
  const ctx = await ticketContext(listingIds);
  const result = await prepareOrder(ctx, quantityForm(counts));
  if (!result.ok) throw new Error(`prepareOrder refused: ${result.error}`);
  return result.pricingParams;
};

const sorted = (ids: Iterable<number>): number[] =>
  [...ids].sort((a, b) => a - b);

describeWithEnv("prepareOrder", { db: true }, () => {
  describe("refusing a form it cannot price", () => {
    test("refuses an order that selected no tickets", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const result = await prepareOrder(ctx, quantityForm({ [listing.id]: 0 }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("Please select at least one ticket");
    });
  });

  describe("the order's lines", () => {
    test("carries one line per chosen listing", async () => {
      const first = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
      });
      const second = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
      });
      const { items } = await preparedOrder([first.id, second.id], {
        [first.id]: 2,
        [second.id]: 1,
      });

      expect(sorted(items.map((item) => item.listingId))).toEqual(
        sorted([first.id, second.id]),
      );
      const firstLine = items.find((item) => item.listingId === first.id);
      expect(firstLine?.quantity).toBe(2);
    });

    test("leaves out a listing the buyer chose none of", async () => {
      const chosen = await createTestListing({ maxAttendees: 5 });
      const ignored = await createTestListing({ maxAttendees: 5 });
      const { items } = await preparedOrder([chosen.id, ignored.id], {
        [chosen.id]: 1,
        [ignored.id]: 0,
      });

      expect(items.map((item) => item.listingId)).toEqual([chosen.id]);
    });
  });

  describe("the answer scope", () => {
    test("names exactly the listings the order has a line for", async () => {
      const first = await createTestListing({ maxAttendees: 5 });
      const second = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
      });
      const { items, info } = await preparedOrder([first.id, second.id], {
        [first.id]: 1,
        [second.id]: 3,
      });

      expect(sorted(info.selectedListingIds)).toEqual(
        sorted(new Set(items.map((item) => item.listingId))),
      );
    });

    test("leaves out a listing the buyer chose none of", async () => {
      const chosen = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
      });
      const ignored = await createTestListing({ maxAttendees: 5 });
      const { info } = await preparedOrder([chosen.id, ignored.id], {
        [chosen.id]: 2,
        [ignored.id]: 0,
      });

      expect(info.selectedListingIds.has(chosen.id)).toBe(true);
      expect(info.selectedListingIds.has(ignored.id)).toBe(false);
    });

    test("names a listing that every one of its lines can be priced by", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 5,
      });
      const { info, quantities } = await preparedOrder([listing.id], {
        [listing.id]: 4,
      });

      // answerModifierQuantities reads a chosen quantity for every answer key,
      // so each scoped listing must have one.
      for (const listingId of info.selectedListingIds) {
        expect(quantities.get(listingId)).toBeGreaterThan(0);
      }
      expect(quantities.get(listing.id)).toBe(4);
    });
  });
  describe("the booking date", () => {
    test("carries a date the page offers", async () => {
      const listing = await createDailyTestListing({ maxQuantity: 5 });
      const offered = (await bookableStartDates(listing.id))[0]!;
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set("date", offered);

      const result = await prepareOrder(ctx, form);
      if (!result.ok) throw new Error(`prepareOrder refused: ${result.error}`);
      expect(result.pricingParams.date).toBe(offered);
    });

    test("refuses a date the page does not offer", async () => {
      const listing = await createDailyTestListing({ maxQuantity: 5 });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set("date", "2020-01-01");

      const result = await prepareOrder(ctx, form);
      expect(result.ok).toBe(false);
    });
  });

  describe("questions the buyer must answer", () => {
    test("refuses an order that left an active question unanswered", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Choose one",
      });
      await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Chosen",
      });
      await questionListings.setIds(question.id, [listing.id]);
      const ctx = await ticketContext([listing.id]);

      const result = await prepareOrder(ctx, quantityForm({ [listing.id]: 1 }));
      expect(result.ok).toBe(false);
    });
  });

  describe("the promo code", () => {
    test("carries the code the buyer typed", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set("promo_code", "SAVE10");

      const result = await prepareOrder(ctx, form);
      if (!result.ok) throw new Error(`prepareOrder refused: ${result.error}`);
      expect(result.pricingParams.promoCode).toBe("SAVE10");
    });
  });

  describe("the thank-you page a booking lands on", () => {
    test("uses a single listing's own thank-you page", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

      expect(singleListingThankYouUrl(ctx)).toBe(
        (await getListingWithCount(listing.id))!.thank_you_url,
      );
    });

    test("uses none when the cart holds more than one listing", async () => {
      const first = await createTestListing({ maxAttendees: 5 });
      const second = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([first.id, second.id]);

      expect(singleListingThankYouUrl(ctx)).toBeNull();
    });

    test("uses none for a hidden package's only member", async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        name: "Secret Contents",
      });
      const ctx = await ticketContext([member.id], group);

      // Redirecting here would name the member the package conceals.
      expect(ctx.packages.some((pkg) => pkg.hideListings)).toBe(true);
      expect(singleListingThankYouUrl(ctx)).toBeNull();
    });
  });
});
