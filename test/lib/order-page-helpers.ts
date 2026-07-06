import { afterEach, beforeEach } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { addDays } from "#shared/dates.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { expectStatus, mockRequest } from "#test-utils";

/** Shared helpers for the server (public order) test files. Not itself a
 * test file. */

/** Turn the public site + order page on for each test in the block. */
export const enablePublicOrder = (): void => {
  beforeEach(async () => {
    await settings.update.showPublicSite(true);
    await settings.update.orderEnabled(true);
  });
  afterEach(async () => {
    await settings.update.showPublicSite(false);
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
export const orderDate = (): string => addDays(todayInTz("UTC"), 2);
