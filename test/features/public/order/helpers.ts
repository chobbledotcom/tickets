import { afterEach, beforeEach } from "@std/testing/bdd";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { DateString } from "#shared/validation/date-string.ts";
import { expectStatus } from "#test-utils/assertions.ts";
import { testDate } from "#test-utils/dates.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** Shared helpers for the public order test files. Not itself a test file. */

/** Turn the public site + order page on for each test in the block. */
export const enablePublicOrder = (): void => {
  beforeEach(async () => {
    await enablePublicSite();
    await settings.update.orderEnabled(true);
  });
  afterEach(async () => {
    await setAdminFeatureEnabled("site", false);
    await settings.update.orderEnabled(false);
  });
};

/** GET /order with the given checkbox selection (listing ids). */
export const selectOrder = (ids: number[]): Promise<Response> => {
  const query = ids.map((id) => `select_${id}=1`).join("&");
  return handleRequest(mockRequest(`/order?${query}`));
};

/** GET /order/availability with a raw query, parsed as the endpoint's JSON. */
export const fetchAvailability = async (
  query: string,
): Promise<{
  dateNeeded: boolean;
  states: Record<string, { state: string; label: string }>;
}> => {
  const response = await handleRequest(
    mockRequest(`/order/availability?${query}`),
  );
  expectStatus(200)(response);
  return response.json();
};

/** A start date comfortably inside every daily listing's booking window. */
export const orderDate = (): DateString =>
  addDays(testDate(todayInTz("UTC")), 2);
