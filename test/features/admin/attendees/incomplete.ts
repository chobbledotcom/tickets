/**
 * Setup and checks for the action that clears an incomplete payment. The
 * attendee action suites share them.
 */

import { expect } from "@std/expect";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { submitDeleteIncomplete } from "#test-utils/attendees/helpers.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { getAttendeesRaw } from "#test-utils/db-helpers/attendees.ts";
import { getTestSession, setupListingAndLogin } from "#test-utils/session.ts";

type Row = { id: number };

type ClearOutcome = {
  flash: string;
  left: number;
  succeeded: boolean;
};

/** A signed-in admin, a paid listing, and an attendee who never paid. */
export const stuckPaidAttendee = async () => {
  const { listing } = await setupListingAndLogin({
    maxAttendees: 100,
    name: "Paid Listing",
    unitPrice: 1000,
  });
  const attendee = await createPaidTestAttendee(
    listing.id,
    "Never Paid",
    "stuck@example.com",
    "",
    1000,
  );
  return { attendee, listing };
};

/** Clears the attendee's incomplete payment. Then checks the redirect to the
 * Attendees tab, the flash, and how many attendees stay on the listing. */
export const expectClearOutcome = async (
  listing: Row,
  attendee: Row,
  { flash, left, succeeded }: ClearOutcome,
) => {
  const { cookie, csrfToken } = await getTestSession();
  const response = await submitDeleteIncomplete(
    listing.id,
    attendee.id,
    cookie,
    csrfToken,
  );

  expectRedirectWithFlash(
    `/admin/listing/${listing.id}/attendees`,
    flash,
    succeeded,
  )(response);
  expect(await getAttendeesRaw(listing.id)).toHaveLength(left);
};
