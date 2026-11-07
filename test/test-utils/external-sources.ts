/**
 * Shared requests for the external sources admin API tests: one source and one
 * link, each created through the API the way a caller does.
 */

import { assertJson } from "#test-utils/assertions.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";
import type { ListingWithCount } from "#types";

export const SOURCE_BODY = {
  name: "Stripe invoices",
  url_pattern: "https://dashboard.stripe.com/invoices/{external_id}",
};

export type SourceBody = { source: Record<string, unknown> };

export const sourcePath = (id: number): string =>
  `/api/admin/external-sources/${id}`;

export const linksPath = (sourceId: number): string =>
  `${sourcePath(sourceId)}/links`;

export const linkPath = (sourceId: number, linkId: number): string =>
  `${linksPath(sourceId)}/${linkId}`;

export const createSource = (
  body: Record<string, unknown> = SOURCE_BODY,
): Promise<SourceBody> =>
  assertJson(
    apiRequest("/api/admin/external-sources", { body, method: "POST" }),
    201,
  );

/** One listing, used as the record a link points at. */
export const addListing = (
  name = "Watercolour day",
): Promise<ListingWithCount> => createTestListing({ name });

export const createLink = (
  sourceId: number,
  body: Record<string, unknown>,
): Promise<{ link: Record<string, unknown> }> =>
  assertJson(apiRequest(linksPath(sourceId), { body, method: "POST" }), 201);
