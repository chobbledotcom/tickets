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
import { takePooledSiteForBuyer } from "#db/built-sites/claims.ts";
import { getAssignableBuiltSites, insertBuiltSite } from "#db/built-sites.ts";
import { t } from "#i18n";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import {
  emptyBookingLine,
  setupListingAndAttendee,
} from "#test-utils/attendees/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttendee,
  submitAttendeeEdit,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createFreeTextQuestion } from "#test-utils/db-helpers/questions.ts";
import {
  createTierListing,
  planListing,
} from "#test-utils/db-helpers/site-plans.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";
import { postListingSale, refundBookedOrder } from "#test-utils/ledger.ts";
import { adminFormPost } from "#test-utils/session.ts";

const resend = (attendeeId: number, name: string) =>
  adminFormPost(`/admin/attendees/${attendeeId}/resend-notification`, {
    confirm_identifier: name,
  });

/** Resend, then assert only one line was notified and the named pooled site
 * stayed unclaimed. Returns every site for further assertions. */
const resendLeavesSiteUnclaimed = async (
  attendeeId: number,
  name: string,
  siteName: string,
) => {
  await resend(attendeeId, name);
  expect(await registeredEntries()).toBe(1);
  const { builtSites } = await import("#db/built-sites.ts");
  const sites = await builtSites.getAll();
  expect(
    sites.find((site) => site.name === siteName)!.assignedAttendeeId,
  ).toBeNull();
  return sites;
};

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

describeWithEnv(
  "re-sending beside site-plan rows",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("skips a refunded plan row, so it assigns no site", async () => {
      await createTierListing();
      const ordinary = await createTestListing({
        maxAttendees: 100,
        name: "Ordinary First",
      });
      const plan = await planListing("Refunded Plan");
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const made = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: ordinary.id, quantity: 1 },
          { listingId: plan.id, pricePaid: 300, quantity: 1 },
        ],
        email: "refunded-plan@example.com",
        name: "Refunded Plan Buyer",
      });
      if (!made.success) throw new Error("Expected the booking to work");
      const attendee = made.attendees[0]!;
      await postListingSale({
        attendeeId: attendee.id,
        gross: 300,
        listingId: plan.id,
      });
      await refundBookedOrder(attendee.id, plan.id);
      await insertBuiltSite("Unwanted", "unwanted.test", "", "", true);

      await resendLeavesSiteUnclaimed(
        attendee.id,
        "Refunded Plan Buyer",
        "Unwanted",
      );
    });

    test("a claim recorded on a later-refunded plan serves the resend", async () => {
      await createTierListing();
      const claimed = await planListing("Claimed Plan");
      const kept = await planListing("Kept Plan");
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const made = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: claimed.id, pricePaid: 300, quantity: 1 },
          { listingId: kept.id, pricePaid: 300, quantity: 1 },
        ],
        email: "refund-after-claim@example.com",
        name: "Refund After Claim",
      });
      if (!made.success) throw new Error("Expected the booking to work");
      const attendee = made.attendees[0]!;
      await postListingSale({
        attendeeId: attendee.id,
        gross: 300,
        listingId: claimed.id,
      });
      // The purchase's first run claims a site on the first plan.
      await insertBuiltSite("First Site", "first.test", "", "", true);
      const pool = await getAssignableBuiltSites();
      await takePooledSiteForBuyer(
        pool,
        attendee.id,
        [claimed.id, kept.id],
        claimed.id,
      );
      await refundBookedOrder(attendee.id, claimed.id);
      await insertBuiltSite("Second Site", "second.test", "", "", true);

      const sites = await resendLeavesSiteUnclaimed(
        attendee.id,
        "Refund After Claim",
        "Second Site",
      );
      expect(
        sites.find((site) => site.name === "First Site")!.assignedAttendeeId,
      ).toBe(attendee.id);
    });

    test("does not double-notify a package row that is already covered", async () => {
      const group = await createTestGroup({ isPackage: true, name: "Mix" });
      const ordinary = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        name: "Bundled Ordinary",
      });
      await createTierListing();
      const plan = await planListing("Bundled Plan");
      const { setListingGroups } = await import("#db/groups.ts");
      await setListingGroups(plan.id, [group.id]);
      const { attendeesApi } = await import("#shared/db/attendees/api.ts");
      const made = await attendeesApi.createAttendeeAtomic({
        bookings: [
          { listingId: ordinary.id, packageGroupId: group.id, quantity: 1 },
          { listingId: plan.id, packageGroupId: group.id, quantity: 1 },
        ],
        email: "bundled-plan@example.com",
        name: "Bundled Plan Buyer",
      });
      if (!made.success) throw new Error("Expected the booking to work");
      const attendee = made.attendees[0]!;

      await resend(attendee.id, "Bundled Plan Buyer");

      // Both package rows once each — the plan row is covered, not repeated.
      expect(await registeredEntries()).toBe(2);
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

describeWithEnv("re-sending a purchase that was refunded", { db: true }, () => {
  test("is refused, and says why", async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Refunded Solo",
    });
    const { attendeesApi } = await import("#shared/db/attendees/api.ts");
    const made = await attendeesApi.createAttendeeAtomic({
      bookings: [{ listingId: listing.id, pricePaid: 300, quantity: 1 }],
      email: "refunded-solo@example.com",
      name: "Refunded Solo Buyer",
    });
    if (!made.success) throw new Error("Expected the booking to work");
    const attendee = made.attendees[0]!;
    await postListingSale({
      attendeeId: attendee.id,
      gross: 300,
      listingId: listing.id,
    });
    await refundBookedOrder(attendee.id, listing.id);
    const before = await registeredEntries();

    const { response } = await resend(attendee.id, "Refunded Solo Buyer");

    expectRedirectWithFlash(
      `/admin/attendees/${attendee.id}/actions`,
      "Cannot re-send a notification for a refunded purchase",
      false,
    )(response);
    expect(await registeredEntries()).toBe(before);
  });
});

describeWithEnv(
  "re-sending with a buyer's free-text answer",
  { db: true },
  () => {
    const fetch = stubFetchEachTest(() => new Response("{}"));

    /** The confirmation texts sent to this buyer, in send order. */
    const buyerEmailTexts = (buyer: string): string[] =>
      fetch.calls.flatMap(({ args }) => {
        const [, options] = args as [string, RequestInit];
        const body = JSON.parse(options.body as string) as {
          to?: string[];
          text?: string;
        };
        return body.to?.[0] === buyer && body.text !== undefined
          ? [body.text]
          : [];
      });

    test("renders the free-text answer as it stands now", async () => {
      await configureTestEmail();
      const listing = await createTestListing({ maxAttendees: 100 });
      const questionId = await createFreeTextQuestion([listing.id]);
      const attendee = await createTestAttendee(
        listing.id,
        listing.slug,
        "Current Wording",
        "wording@example.com",
        1,
        "",
        { [`question_${questionId}`]: "Coming by bus" },
      );
      const edited = await submitAttendeeEdit(attendee.id, {
        email: "wording@example.com",
        extra: { [`question_${questionId}`]: "Coming by train" },
        name: "Current Wording",
      });
      expect(edited.status).toBe(302);

      const { response } = await resend(attendee.id, "Current Wording");

      expectRedirectWithFlash(
        `/admin/attendees/${attendee.id}/actions`,
        t("success.notification_resent"),
      )(response);
      const resent = buyerEmailTexts("wording@example.com").at(-1);
      expect(resent).toContain("Anything else?: Coming by train");
      expect(resent).not.toContain("Coming by bus");
    });
  },
);
