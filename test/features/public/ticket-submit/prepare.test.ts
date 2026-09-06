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
import { packageQuantityFieldName } from "#booking/tree.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import {
  prepareOrder,
  singleListingThankYouUrl,
} from "#routes/public/ticket-submit/prepare.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import {
  bookableStartDates,
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import {
  quantityForm,
  ticketContext,
  twoListingContext,
} from "#test-utils/ticket-ctx.ts";

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

    test("names a mixed package member by its chosen path", async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 500 },
        groupId: group.id,
        maxQuantity: 5,
        name: "Standalone Unit",
      });
      const ctx = await ticketContext([member.id], group);
      ctx.slugs = [group.slug, member.slug];
      const date = (await bookableStartDates(member.id))[0]!;
      const invalidDaysForm = (
        standaloneQuantity: number,
        packageQuantity: number,
      ) => {
        const form = quantityForm({ [member.id]: standaloneQuantity });
        form.set(packageQuantityFieldName(group.id), String(packageQuantity));
        form.set("date", date);
        form.set("day_count", "2");
        return form;
      };

      expect(await prepareOrder(ctx, invalidDaysForm(1, 0))).toEqual({
        error: "Standalone Unit does not offer a 2-day booking",
        ok: false,
      });
      expect(await prepareOrder(ctx, invalidDaysForm(0, 1))).toEqual({
        error: "Mystery Box does not offer a 2-day booking",
        ok: false,
      });
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
      await createQuestionWithAnswer([listing.id]);
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
      const listing = await createTestListing({
        maxAttendees: 5,
        thankYouUrl: "https://example.com/listing-thanks",
      });
      const ctx = await ticketContext([listing.id]);

      const result = await prepareOrder(ctx, quantityForm({ [listing.id]: 1 }));
      if (!result.ok) throw new Error(result.error);
      expect(singleListingThankYouUrl(ctx, result.pricingParams.items)).toBe(
        (await getListingWithCount(listing.id))!.thank_you_url,
      );
    });

    test("uses none when the cart holds more than one listing", async () => {
      const { ctx } = await twoListingContext();

      expect(singleListingThankYouUrl(ctx, [])).toBeNull();
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
      expect(
        singleListingThankYouUrl(ctx, [
          {
            listingId: member.id,
            name: "Mystery Box",
            packageGroupId: group.id,
            quantity: 1,
            slug: member.slug,
            unitPrice: 0,
          },
        ]),
      ).toBeNull();
    });

    test("uses a package member's URL for its standalone path", async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        name: "Separate Unit",
        thankYouUrl: "https://example.com/separate",
      });
      const ctx = await ticketContext([member.id], group);
      ctx.slugs = [group.slug, member.slug];

      expect(
        singleListingThankYouUrl(ctx, [
          {
            listingId: member.id,
            name: member.name,
            quantity: 1,
            slug: member.slug,
            unitPrice: member.unit_price,
          },
        ]),
      ).toBe("https://example.com/separate");
    });

    test("keeps the standalone URL when both paths are selected", async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        thankYouUrl: "https://example.com/mixed-thanks",
      });
      const ctx = await ticketContext([member.id], group);
      ctx.slugs = [group.slug, member.slug];
      const form = quantityForm({ [member.id]: 1 });
      form.set(packageQuantityFieldName(group.id), "1");
      const result = await prepareOrder(ctx, form);
      if (!result.ok) throw new Error(result.error);

      expect(result.pricingParams.items).toHaveLength(2);
      expect(singleListingThankYouUrl(ctx, result.pricingParams.items)).toBe(
        "https://example.com/mixed-thanks",
      );
    });

    test("a folded child does not reveal a concealed parent's URL", async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        thankYouUrl: "https://example.com/concealed-parent",
      });
      const child = await createTestListing({ maxAttendees: 5 });
      await listingChildren.setIds(member.id, [child.id]);
      const ctx = await ticketContext([member.id], group);
      ctx.slugs = [group.slug];
      const form = quantityForm({ [member.id]: 0 });
      form.set(packageQuantityFieldName(group.id), "1");
      const result = await prepareOrder(ctx, form);
      if (!result.ok) throw new Error(result.error);

      expect(result.pricingParams.items).toHaveLength(2);
      expect(
        singleListingThankYouUrl(ctx, result.pricingParams.items),
      ).toBeNull();
    });
  });
});
