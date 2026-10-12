/**
 * Direct tests for the QR token override at form parse: a token signed for
 * the page reprices its listing, and every other case leaves the prices
 * alone.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { applyQrTokenOverride } from "#routes/public/ticket-submit/parse.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { buildQrBookPayload, signQrBookToken } from "#shared/qr-token.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { ticketContext } from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

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

describeWithEnv("ticket-submit parse", { db: true }, () => {
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
});
