/**
 * Direct tests for the submitted-booking parsers: page-state refusals,
 * contact-field validation, custom prices, QR overrides, answer maps, and
 * the quantities each standalone selector or package count resolves to.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { buildBookingTree } from "#booking/build-tree.ts";
import { buildTicketListing } from "#booking/model.ts";
import {
  customPriceFieldName,
  packageQuantityFieldName,
} from "#booking/tree.ts";
import { questionListings } from "#db/questions/queries.ts";
import { questionsTable } from "#db/questions/tables.ts";
import type { AnswerInfo } from "#routes/public/ticket-form.ts";
import { ctxToBuildTreeInput } from "#routes/public/ticket-payment.ts";
import {
  applyQrTokenOverride,
  computeListingAnswerMap,
  computeListingTextAnswerIdMap,
  parseCustomPrices,
  resolvePageQuantities,
  validateFormState,
  validateTicketFields,
} from "#routes/public/ticket-submit/parse.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { priceFormValue } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import {
  quantityForm,
  ticketContext,
  twoListingContext,
} from "#test-utils/ticket-ctx.ts";

/** The page context with its listings replaced, for the state a real page
 * cannot reach in one shot (a closed listing beside an open one). */
const withListings = (
  ctx: TicketCtx,
  listings: ReturnType<typeof buildTicketListing>[],
): TicketCtx => ({ ...ctx, listings });

/** A pay-more listing's custom-price outcome: the listing is created with the
 * given overrides, its field carries `priceMinor`, and the parser answers. */
const customPriceOutcome = async (
  overrides: Record<string, unknown>,
  priceMinor: number,
) => {
  const listing = await createTestListing({
    canPayMore: true,
    unitPrice: 1000,
    ...overrides,
  });
  const ctx = await ticketContext([listing.id]);
  const form = quantityForm({ [listing.id]: 1 });
  form.set(customPriceFieldName(listing.id), priceFormValue(priceMinor));
  return {
    listing,
    result: parseCustomPrices(form, ctx, new Map([[listing.id, 1]])),
  };
};

/** A QR token signed for `slug`, carrying one fixed override price. */
const signedTokenFor = (slug: string): Promise<string> =>
  signQrBookToken(slug, buildQrBookPayload({ value: 2500 }));

/** The prices after the override ran on a form carrying `token` (or none). */
const pricesAfterOverride = async (
  ctx: TicketCtx,
  token: string | null,
): Promise<Map<number, number>> => {
  const form = new FormParams();
  if (token !== null) form.set("qr_token", token);
  const prices = new Map<number, number>();
  await applyQrTokenOverride(form, ctx, prices);
  return prices;
};

/** The submitted answers of a one-listing order: no answers at all unless
 * `chosen` or `typed` says otherwise. */
const answerInfo = (
  ctx: TicketCtx,
  listingId: number,
  chosen: { answerIds: number[]; textAnswers: AnswerInfo["textAnswers"] } = {
    answerIds: [],
    textAnswers: [],
  },
): AnswerInfo => ({
  activeQuestions: ctx.questions,
  selectedListingIds: new Set([listingId]),
  ...chosen,
});

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("validateFormState", () => {
    test("refuses a form that skipped the terms box", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = { ...(await ticketContext([listing.id])), terms: "/terms" };

      expect(validateFormState(quantityForm({ [listing.id]: 1 }), ctx)).toBe(
        "You must agree to the terms and conditions",
      );
    });

    test("accepts the same form with the terms box ticked", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = { ...(await ticketContext([listing.id])), terms: "/terms" };
      const form = quantityForm({ [listing.id]: 1 });
      form.set("agree_terms", "1");

      expect(validateFormState(form, ctx)).toBeNull();
    });

    test("says registration closed when every listing is closed", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const closed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
      ]);

      expect(validateFormState(quantityForm({}), closed)).toBe(
        "Sorry, registration closed while you were submitting.",
      );
    });

    test("says sold out when the page has no spots left", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);
      const soldOut = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, false, 0),
      ]);

      expect(validateFormState(quantityForm({}), soldOut)).toBe(
        "Sorry, not enough spots available",
      );
    });

    test("refuses a quantity chosen on a closed listing", async () => {
      const { ctx, first, second } = await twoListingContext();
      const halfClosed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
        ctx.listings[1]!,
      ]);

      expect(
        validateFormState(quantityForm({ [first.id]: 1 }), halfClosed),
      ).toBe("Sorry, registration closed while you were submitting.");
      expect(
        validateFormState(quantityForm({ [second.id]: 1 }), halfClosed),
      ).toBeNull();
    });

    test("reads a quantity box that carries no number as zero", async () => {
      // A crafted or half-cleared POST must not read as a chosen quantity.
      const { ctx, first } = await twoListingContext();
      const halfClosed = withListings(ctx, [
        buildTicketListing(ctx.listings[0]!.listing, true, undefined),
        ctx.listings[1]!,
      ]);
      const form = quantityForm({});
      form.set(`quantity_${first.id}`, "abc");

      expect(validateFormState(form, halfClosed)).toBeNull();
    });
  });

  describe("validateTicketFields", () => {
    test("answers a paid order missing its email with the error redirect", async () => {
      const listing = await createTestListing({ fields: "email" });
      const ctx = await ticketContext([listing.id]);

      const result = validateTicketFields(
        quantityForm({ [listing.id]: 1 }),
        ctx,
        true,
      );
      expect(result).toBeInstanceOf(Response);
    });

    test("keeps the contact values the form carries", async () => {
      const listing = await createTestListing({ fields: "email" });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set("email", "buyer@example.com");
      form.set("name", "Buyer");

      const result = validateTicketFields(form, ctx, true);
      expect(result).not.toBeInstanceOf(Response);
      if (result instanceof Response) return;
      expect(result.email).toBe("buyer@example.com");
      expect(result.name).toBe("Buyer");
    });
  });

  describe("parseCustomPrices", () => {
    test("reads a pay-more listing's custom price into the map", async () => {
      const { listing, result } = await customPriceOutcome(
        { maxPrice: 5000 },
        1500,
      );
      expect(result).toEqual(new Map([[listing.id, 1500]]));
    });

    test("refuses a price below the listing's own price, naming it", async () => {
      const { result } = await customPriceOutcome(
        { name: "Supporter ticket" },
        500,
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("Supporter ticket");
    });

    test("ignores a pay-more listing the buyer chose none of", async () => {
      const listing = await createTestListing({ canPayMore: true });
      const ctx = await ticketContext([listing.id]);

      const result = parseCustomPrices(
        quantityForm({ [listing.id]: 0 }),
        ctx,
        new Map(),
      );
      expect(result).toEqual(new Map());
    });

    test("ignores a fixed-price listing even when its field is posted", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);
      const form = quantityForm({ [listing.id]: 1 });
      form.set(customPriceFieldName(listing.id), "1");

      const result = parseCustomPrices(form, ctx, new Map([[listing.id, 1]]));
      expect(result).toEqual(new Map());
    });
  });

  describe("applyQrTokenOverride", () => {
    test("overrides a fixed-price listing's price from a signed token", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);

      const prices = await pricesAfterOverride(
        ctx,
        await signedTokenFor(listing.slug),
      );
      expect(prices.get(listing.id)).toBe(2500);
    });

    test("applies a free-price token as a zero-price override", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);

      const prices = await pricesAfterOverride(
        ctx,
        await signQrBookToken(listing.slug, buildQrBookPayload({ value: 0 })),
      );
      expect(prices.get(listing.id)).toBe(0);
    });

    test("leaves prices alone when no token is posted", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);

      expect((await pricesAfterOverride(ctx, null)).size).toBe(0);
    });

    test("leaves prices alone when the page holds two listings' slugs", async () => {
      const first = await createTestListing({ unitPrice: 1000 });
      const second = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([first.id, second.id]);

      expect(
        (await pricesAfterOverride(ctx, await signedTokenFor(first.slug))).size,
      ).toBe(0);
    });

    test("leaves prices alone for a token signed for another slug", async () => {
      const listing = await createTestListing({ unitPrice: 1000 });
      const other = await createTestListing({ unitPrice: 1000 });
      const ctx = await ticketContext([listing.id]);

      expect(
        (await pricesAfterOverride(ctx, await signedTokenFor(other.slug))).size,
      ).toBe(0);
    });
  });

  describe("the answer maps", () => {
    test("files chosen answer ids under the listing the question is on", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const { answerId } = await createQuestionWithAnswer([listing.id]);
      const ctx = await ticketContext([listing.id]);

      expect(
        computeListingAnswerMap(
          ctx,
          answerInfo(ctx, listing.id, {
            answerIds: [answerId],
            textAnswers: [],
          }),
        ),
      ).toEqual({ [String(listing.id)]: [answerId] });
    });

    test("is undefined when no answer was chosen", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

      expect(
        computeListingAnswerMap(ctx, answerInfo(ctx, listing.id)),
      ).toBeUndefined();
    });

    test("gives text answers their stored string ids, keyed per listing", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const question = await questionsTable.insert({
        displayType: "free_text",
        text: "Say something",
      });
      await questionListings.setIds(question.id, [listing.id]);
      const ctx = await ticketContext([listing.id]);

      const map = await computeListingTextAnswerIdMap(
        ctx,
        answerInfo(ctx, listing.id, {
          answerIds: [],
          textAnswers: [{ questionId: question.id, text: "Hello" }],
        }),
      );
      const entry = map?.[String(listing.id)]?.[0];
      expect(entry?.q).toBe(question.id);
      expect(entry?.s).toBeGreaterThan(0);
    });

    test("has no text map when no text answer was given", async () => {
      const listing = await createTestListing({ maxAttendees: 5 });
      const ctx = await ticketContext([listing.id]);

      expect(
        await computeListingTextAnswerIdMap(ctx, answerInfo(ctx, listing.id)),
      ).toBeUndefined();
    });
  });

  describe("resolvePageQuantities", () => {
    const resolvedQuantities = async (
      listingIds: number[],
      form: FormParams,
      group?: Awaited<ReturnType<typeof createHiddenPackageGroup>>,
    ) => {
      const ctx = await ticketContext(listingIds, group);
      return resolvePageQuantities(
        form,
        ctx,
        buildBookingTree(ctxToBuildTreeInput(ctx)),
      );
    };

    test("reads each standalone listing's chosen quantity", async () => {
      const listing = await createTestListing({ maxQuantity: 5 });

      const { quantities } = await resolvedQuantities(
        [listing.id],
        quantityForm({ [listing.id]: 2 }),
      );
      expect(quantities.get(listing.id)).toBe(2);
    });

    test("clamps a standalone quantity to what the listing can sell", async () => {
      const listing = await createTestListing({
        maxAttendees: 5,
        maxQuantity: 3,
      });

      const { quantities } = await resolvedQuantities(
        [listing.id],
        quantityForm({ [listing.id]: 9 }),
      );
      expect(quantities.get(listing.id)).toBe(3);
    });

    /** A hidden package and one member it can book. */
    const mysteryBoxMember = async () => {
      const group = await createHiddenPackageGroup("Mystery Box");
      const member = await createTestListing({
        groupId: group.id,
        maxAttendees: 5,
        maxQuantity: 5,
        name: "Secret Contents",
      });
      return {
        form: (count: string) => {
          const form = new FormParams();
          form.set(packageQuantityFieldName(group.id), count);
          return form;
        },
        group,
        member,
      };
    };

    test("multiplies one package count across the package's member", async () => {
      const box = await mysteryBoxMember();

      const { quantities } = await resolvedQuantities(
        [box.member.id],
        box.form("2"),
        box.group,
      );
      expect(quantities.get(box.member.id)).toBe(2);
    });

    test("books nothing when the package count carries no number", async () => {
      const box = await mysteryBoxMember();

      const { quantities } = await resolvedQuantities(
        [box.member.id],
        box.form("abc"),
        box.group,
      );
      expect(quantities.get(box.member.id) ?? 0).toBe(0);
    });
  });
});
