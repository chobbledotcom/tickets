/**
 * Fixtures for the ticket-submit suites: a real page context built from real
 * listings, and a form that carries quantity selections.
 */

import { buildTicketListing } from "#booking/model.ts";
import { packageQuantityFieldName, quantityFieldName } from "#booking/tree.ts";
import { requireListingWithCount } from "#db/listings/records.ts";
import { getTicketContext } from "#routes/public/ticket-payment.ts";
import {
  type PrepareResult,
  prepareOrder,
} from "#routes/public/ticket-submit/prepare.ts";
import type { TicketCtx } from "#routes/public/types.ts";
import { FormParams } from "#shared/form-data.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Group, ListingWithCount } from "#types";

/** The page context for the given listings, as the public routes build it. */
export const ticketContext = async (
  listingIds: number[],
  group?: Group,
): Promise<TicketCtx> => {
  const listings = await Promise.all(
    listingIds.map(async (id) =>
      buildTicketListing(await requireListingWithCount(id), false, undefined),
    ),
  );
  return {
    ...(await getTicketContext(listings, group)),
    listings,
    slugs: listings.map((info) => info.listing.slug),
  };
};

/** The page context for two fresh listings, for a cart that holds both. */
export const twoListingContext = async (): Promise<{
  ctx: TicketCtx;
  first: ListingWithCount;
  second: ListingWithCount;
}> => {
  const first = await createTestListing({ maxAttendees: 5 });
  const second = await createTestListing({ maxAttendees: 5 });
  return { ctx: await ticketContext([first.id, second.id]), first, second };
};

/** A form that selects the given count for each listing. */
export const quantityForm = (
  counts: Record<number, number>,
  packageCounts: Record<number, number> = {},
): FormParams => {
  const form = new FormParams();
  for (const [fieldName, quantities] of [
    [quantityFieldName, counts],
    [packageQuantityFieldName, packageCounts],
  ] as const) {
    for (const [id, quantity] of Object.entries(quantities)) {
      form.set(fieldName(Number(id)), String(quantity));
    }
  }
  return form;
};

export const prepareTestOrder = async (
  ctx: TicketCtx,
  form: FormParams,
): Promise<Extract<PrepareResult, { ok: true }>> => {
  const result = await prepareOrder(ctx, form);
  if (!result.ok) throw new Error(`prepareOrder refused: ${result.error}`);
  return result;
};
