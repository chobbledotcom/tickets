/**
 * Shared helpers for the servicing §22 ledger tests (service costs & listing
 * profit). These are split across several `ledger-*.test.ts` files under
 * `test/shared/db/attendees/servicing/`; the fixtures and assertions they all
 * lean on live here so no two files carry their own copy.
 */
import { expect } from "@std/expect";
import { KIND } from "#accounting/kinds.ts";
import { allTransfers } from "#accounting/queries.ts";
import {
  getListingWithCount,
  invalidateListingsCache,
} from "#db/listings/records.ts";
import type { Transfer } from "#shared/ledger/types.ts";
import { expectFlashError } from "#test-utils/assertions.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import {
  createServicingHold,
  editServiceCost,
  recordServiceCost,
} from "#test-utils/servicing.ts";

/** The default service date every cost-recording fixture stamps its leg with. */
export const SERVICE_DATE = "2026-07-01T00:00:00.000Z";

/** The ledger transfers of a single `kind` (e.g. `service_cost`). */
export const transfersOfKind = async (kind: string): Promise<Transfer[]> =>
  (await allTransfers()).filter((t) => t.kind === kind);

/** The listing row's profit, reading through a fresh listings cache so a
 *  just-recorded cost is reflected. */
export const listingProfitOf = async (listingId: number): Promise<number> => {
  invalidateListingsCache();
  return (await getListingWithCount(listingId))!.profit;
};

/** Record a £90 "Boiler part" cost against the servicing event. */
export const recordBoilerCost = (
  servicingId: number,
  listingId: number,
): Promise<number> =>
  recordServiceCost({
    amount: 9000,
    listingId,
    memo: "Boiler part",
    occurredAt: SERVICE_DATE,
    servicingId,
  });

export const editBoilerCostTo = async (...amounts: number[]) => {
  const fixture = await createServicingHold();
  const costId = await recordBoilerCost(fixture.id, fixture.listing.id);
  const beforeRows = (await transfersOfKind(KIND.serviceCost)).length;
  for (const amount of amounts) {
    await editServiceCost(costId, { amount });
  }
  const afterRows = (await transfersOfKind(KIND.serviceCost)).length;
  return { ...fixture, afterRows, beforeRows, costId };
};

/** Post a £200 customer sale against `listingId` (the income side of a profit
 *  assertion, so cost/profit can be checked against real revenue). */
export const postCustomerSale = async (listingId: number): Promise<void> => {
  const { attendee } = await createTestAttendeeDirect(
    listingId,
    "Customer",
    "c@example.com",
  );
  await postListingSale({ attendeeId: attendee.id, gross: 20000, listingId });
};

/** Assert a cost POST was rejected as a recoverable form error: a 302 back to
 *  the event page with an error flash, and NO new ledger leg of any kind (not
 *  just no `service_cost`). `before` is the total transfer count before the
 *  POST. */
export const expectCostFormError = async (
  response: Response,
  servicingId: number,
  before: number,
): Promise<void> => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(
    `/admin/servicing/${servicingId}`,
  );
  expectFlashError(response);
  expect((await allTransfers()).length).toBe(before);
};
