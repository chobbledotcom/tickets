/**
 * Clearing a registration whose payment never completed.
 *
 * The form lives on the listing's Attendees tab, so both outcomes return
 * there. A registration that is not stuck is left alone and the operator is
 * told why.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { submitDeleteIncomplete } from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import {
  createTestAttendee,
  getAttendeesRaw,
} from "#test-utils/db-helpers/attendees.ts";
import { getTestSession, setupListingAndLogin } from "#test-utils/session.ts";

describeWithEnv("clearing a stuck registration", { db: true }, () => {
  test("removes it and says so", async () => {
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
    const { cookie, csrfToken } = await getTestSession();

    const response = await submitDeleteIncomplete(
      listing.id,
      attendee.id,
      cookie,
      csrfToken,
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      t("success.incomplete_removed"),
    )(response);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);
    expect(await activityMessages()).toContain(
      "Incomplete attendee deleted from 'Paid Listing'",
    );
  });

  test("leaves a registration that is not stuck, and says why", async () => {
    const { listing } = await setupListingAndLogin({
      maxAttendees: 100,
      name: "Free Listing",
    });
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Paid Up",
      "fine@example.com",
    );
    const { cookie, csrfToken } = await getTestSession();

    const response = await submitDeleteIncomplete(
      listing.id,
      attendee.id,
      cookie,
      csrfToken,
    );

    expectRedirectWithFlash(
      `/admin/listing/${listing.id}/attendees`,
      t("error.attendee_no_incomplete_payment"),
      false,
    )(response);
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
  });
});
