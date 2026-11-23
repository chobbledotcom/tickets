/**
 * Clearing a registration whose payment never completed.
 *
 * The form lives on the listing's Attendees tab, so both outcomes return
 * there. A registration that is not stuck is left alone and the operator is
 * told why.
 */

import { assertArrayIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { setupListingAndLogin } from "#test-utils/session.ts";
import { expectClearOutcome, stuckPaidAttendee } from "./incomplete.ts";

describeWithEnv("clearing a stuck registration", { db: true }, () => {
  test("removes it and says so", async () => {
    const { attendee, listing } = await stuckPaidAttendee();

    await expectClearOutcome(listing, attendee, {
      flash: t("success.incomplete_removed"),
      left: 0,
      succeeded: true,
    });

    assertArrayIncludes(await activityMessages(), [
      "Incomplete attendee deleted from 'Paid Listing'",
    ]);
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

    await expectClearOutcome(listing, attendee, {
      flash: t("error.attendee_no_incomplete_payment"),
      left: 1,
      succeeded: false,
    });
  });
});
