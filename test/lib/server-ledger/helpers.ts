import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { KIND } from "#shared/accounting/kinds.ts";
import { MANUAL_ATTENDEE_PAYMENT } from "#shared/accounting/manual-entries.ts";
import { account } from "#shared/ledger/account.ts";
import type { TransferInput } from "#shared/ledger/types.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postListingSale, tx } from "#test-utils/ledger.ts";
import { adminFormPost } from "#test-utils/session.ts";

/** Seed a listing and registered attendee, then post a fully paid sale. */
export const seededSale = async (
  name = "Summer Concert",
  gross = 2500,
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name,
    thankYouUrl: "https://example.com",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  await postListingSale({
    attendeeId: attendee.id,
    gross,
    listingId: listing.id,
  });
  return { attendeeId: attendee.id, listingId: listing.id };
};

export const listingMoneyLegs = ({
  listingId,
  prefix,
  occurredAt,
  income,
  cost,
}: {
  listingId: number;
  prefix: string;
  occurredAt: string;
  income: number;
  cost: number;
}): TransferInput[] => [
  tx({
    amount: income,
    destination: account("revenue", listingId),
    eventGroup: `${prefix}-income`,
    kind: KIND.sale,
    occurredAt,
    reference: `${prefix}-income`,
    source: account("attendee", listingId),
  }),
  tx({
    amount: cost,
    destination: account("external", "world"),
    eventGroup: `${prefix}-cost`,
    kind: KIND.serviceCost,
    occurredAt,
    reference: `${prefix}-cost`,
    source: account("cost", listingId),
  }),
];

export const seededAttendee = async (): Promise<{
  attendeeId: number;
  listingId: number;
}> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    name: "Manual listing",
    thankYouUrl: "https://example.com",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Ada Lovelace",
    "ada@example.com",
  );
  return { attendeeId: attendee.id, listingId: listing.id };
};

export const redirectTargetWithoutFlash = (response: Response): string => {
  const location = response.headers.get("location");
  assertExists(location);
  const url = new URL(location, "http://localhost");
  url.searchParams.delete("flash");
  return `${url.pathname}${url.search}${url.hash}`;
};

export const postAttendeePayment = async (
  attendeeId: number,
  amount = "12.34",
): Promise<void> => {
  const returnUrl = `/admin/attendees/${attendeeId}`;
  const { response } = await adminFormPost(
    `/admin/ledger/attendee/${attendeeId}/add`,
    {
      amount,
      entry_type: MANUAL_ATTENDEE_PAYMENT,
      occurred_at: "2026-06-22T09:30",
      return_url: returnUrl,
    },
  );
  await expectFlashRedirect(returnUrl, "Money change added.")(response);
  const [entry] = await getAllActivityLog(1);
  expect(entry?.message).toBe("Manual ledger entry added");
};
