// jscpd:ignore-start
import { expect } from "@std/expect";
import { KIND } from "#shared/accounting/kinds.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import {
  createServicingHold,
  editServiceCost,
  listingCostOf,
  recordServiceCost,
} from "#test-utils/servicing.ts";
// jscpd:ignore-end

export const SERVICE_DATE = "2026-07-01T00:00:00.000Z";

export const transfersOfKind = async (kind: string) =>
  (await allTransfers()).filter((transfer) => transfer.kind === kind);

export const listingProfitOf = async (listingId: number): Promise<number> => {
  const { getListingWithCount, invalidateListingsCache } = await import(
    "#shared/db/listings.ts"
  );
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

/** Post a £200 customer sale against the listing. */
export const postCustomerSale = async (listingId: number): Promise<void> => {
  const { attendee } = await createTestAttendeeDirect(
    listingId,
    "Customer",
    "c@example.com",
  );
  const { postListingSale } = await import("#test-utils/ledger.ts");
  await postListingSale({ attendeeId: attendee.id, gross: 20000, listingId });
};

/** Assert a cost POST was rejected as a recoverable form error and wrote no
 * new service cost leg. */
export const expectCostFormError = async (
  response: Response,
  servicingId: number,
  before: number,
): Promise<void> => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(
    `/admin/servicing/${servicingId}`,
  );
  expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
};

export { listingCostOf };
