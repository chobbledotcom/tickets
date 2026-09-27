/**
 * Re-sending an attendee's booking notification.
 *
 * A standalone booking notifies once. A booking made through a package
 * notifies for every line of that package, so a re-send is the same message
 * the attendee got the first time, not one member row standing in for the
 * whole bundle.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { insertBuiltSite } from "#db/built-sites.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  emptyBookingLine,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost } from "#test-utils/session.ts";

const resend = (attendeeId: number, name: string) =>
  adminFormPost(`/admin/attendees/${attendeeId}/resend-notification`, {
    confirm_identifier: name,
  });

/** How many "registered" entries the re-send wrote — one per line it notified. */
const registeredEntries = async (): Promise<number> =>
  (await activityMessages()).filter((one) =>
    one.startsWith("Attendee registered for"),
  ).length;

describeWithEnv("re-sending a standalone booking", { db: true }, () => {
  test("notifies that one booking and says it went", async () => {
    const { attendee } = await setupListingAndAttendee({
      listing: { name: "Solo Listing" },
      name: "On Their Own",
    });
    const before = await registeredEntries();

    const { response } = await resend(attendee.id, "On Their Own");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      t("success.notification_resent"),
    )(response);
    expect((await registeredEntries()) - before).toBe(1);
  });
});

describeWithEnv("re-sending a booking made in a package", { db: true }, () => {
  test("notifies every line of that package, not just the one", async () => {
    const group = await createTestGroup({ isPackage: true, name: "Bundle" });
    const first = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      name: "Bundled One",
    });
    const second = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      name: "Bundled Two",
    });
    const { attendeesApi } = await import("#shared/db/attendees/api.ts");
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [
        { listingId: first.id, packageGroupId: group.id, quantity: 1 },
        { listingId: second.id, packageGroupId: group.id, quantity: 1 },
      ],
      email: "bundle@example.com",
      name: "Bundle Buyer",
    });
    if (!made.success) throw new Error("Expected the package booking to work");
    const attendee = made.attendees[0]!;
    const before = await registeredEntries();

    await resend(attendee.id, "Bundle Buyer");

    expect((await registeredEntries()) - before).toBe(2);
  });
});

describeWithEnv(
  "re-sending a booking beside an unassigned site plan",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("notifies the plan row too, so the assignment can serve it", async () => {
      // The hidden monthly tier the plan's booking validation requires.
      await createTestListing({
        hidden: true,
        monthsPerUnit: 1,
        purchaseOnly: true,
        unitPrice: 300,
      });
      const ordinary = await createTestListing({
        maxAttendees: 100,
        name: "Ordinary First",
      });
      const plan = await createTestListing({
        assignBuiltSite: true,
        initialSiteMonths: 3,
        maxAttendees: 100,
        name: "Site Plan",
        unitPrice: 300,
      });
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const made = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: ordinary.id, quantity: 1 },
          { listingId: plan.id, quantity: 1 },
        ],
        email: "plan-beside@example.com",
        name: "Plan Beside",
      });
      if (!made.success) throw new Error("Expected the booking to work");
      const attendee = made.attendees[0]!;
      await insertBuiltSite("For The Plan", "plan.test", "", "", true);
      const before = await registeredEntries();

      await resend(attendee.id, "Plan Beside");

      // Both rows notified, and the plan row's site is now assigned.
      expect((await registeredEntries()) - before).toBe(2);
      const { builtSites } = await import("#db/built-sites.ts");
      const sites = await builtSites.getAll();
      expect(
        sites.find((s) => s.name === "For The Plan")!.assignedAttendeeId,
      ).toBe(attendee.id);
    });
  },
);

describeWithEnv("re-sending for a line with no places", { db: true }, () => {
  test("is refused, and says why", async () => {
    const { attendee, listing } = await setupListingAndAttendee({
      name: "Gave It Up",
    });
    await emptyBookingLine(listing.id, attendee.id);
    const before = await registeredEntries();

    const { response } = await resend(attendee.id, "Gave It Up");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      "Cannot re-send a notification for a no-quantity line",
      false,
    )(response);
    expect(await registeredEntries()).toBe(before);
  });
});
