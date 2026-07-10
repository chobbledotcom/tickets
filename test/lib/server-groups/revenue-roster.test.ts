import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  adminGet,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  expectStatus,
} from "#test-utils";

describeWithEnv(
  "server (admin groups) — revenue & roster decryption",
  { db: true },
  () => {
    beforeEach(() => {
      setDemoModeForTest(false);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    describe("GET /admin/groups/:id — revenue & roster", () => {
      test("decrypts the roster for a package whose member is paid only via its override", async () => {
        // A package member can be free on its own (unit_price 0) yet paid through
        // its package_price override; the roster must still decrypt payment data.
        const group = await createTestGroup({
          isPackage: true,
          name: "Override Paid",
          slug: "override-paid",
        });
        const member = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          name: "Free-Standalone Member",
          unitPrice: 0,
        });
        // A one-penny override is the tightest "paid" boundary: any positive
        // package price makes the package paid, so the paid check must use `> 0`,
        // not `> 1`.
        await setGroupPackageMembers(group.id, [
          { listingId: member.id, price: 1 },
        ]);
        await createTestAttendee(
          member.id,
          member.slug,
          "Buyer",
          "buyer@test.com",
        );

        const response = await adminGet(`/admin/groups/${group.id}`);
        expectStatus(200)(response);
        const html = await response.text();
        expect(html).toContain("Free-Standalone Member");
        // The override makes the package paid, so the page treats it as paid: the
        // revenue row shows (a non-package or no-override group would hide it).
        expect(html).toContain("Total Revenue");
      });

      test("decrypts the roster for a package paid only via a per-day override", async () => {
        // Same principle one layer deeper: a customisable member free on its own
        // (zero base and day prices) can still charge through a per-day package
        // override, so the paid check must consult the group_day rows too.
        const group = await createTestGroup({
          isPackage: true,
          name: "Day Override Paid",
          slug: "day-override-paid",
        });
        const member = await createTestListing({
          customisableDays: true,
          dayPrices: { 1: 0, 2: 0 },
          durationDays: 2,
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 10,
          name: "Free-Days Member",
          unitPrice: 0,
        });
        // A one-penny per-day override is the tightest "paid" boundary (`> 0`,
        // not `> 1`): any positive day price makes the package paid.
        await setGroupPackageMembers(group.id, [
          { dayPrices: { 2: 1 }, listingId: member.id, price: null },
        ]);
        // A daily member needs a dated booking; the form helper posts date-less,
        // so book atomically like the checkout would.
        const { createAttendeeAtomic } = await import(
          "#shared/db/attendees/api.ts"
        );
        const { addDays } = await import("#shared/dates.ts");
        const { todayInTz } = await import("#shared/timezone.ts");
        const booked = await createAttendeeAtomic({
          bookings: [
            {
              date: addDays(todayInTz("UTC"), 2),
              listingId: member.id,
              packageGroupId: group.id,
              quantity: 1,
            },
          ],
          email: "daybuyer@test.com",
          name: "Buyer",
        });
        if (!booked.success) throw new Error("day-override booking failed");

        const response = await adminGet(`/admin/groups/${group.id}`);
        expectStatus(200)(response);
        expect(await response.text()).toContain("Total Revenue");
      });

      test("hides revenue for a package whose free member has no override", async () => {
        // A package group still reaches the override check (unlike a non-package
        // group, which returns early): a free member with a null override (no
        // positive price anywhere) is not paid, so no revenue row is shown.
        const group = await createTestGroup({
          isPackage: true,
          name: "Override Free",
          slug: "override-free",
        });
        const member = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          name: "Truly-Free Member",
          unitPrice: 0,
        });
        await createTestAttendee(
          member.id,
          member.slug,
          "Guest",
          "guest@test.com",
        );

        const response = await adminGet(`/admin/groups/${group.id}`);
        expectStatus(200)(response);
        const html = await response.text();
        expect(html).toContain("Truly-Free Member");
        expect(html).not.toContain("Total Revenue");
      });

      const createGroupWithListing = async (
        groupName: string,
        groupSlug: string,
        listingName: string,
      ) => {
        const group = await createTestGroup({
          name: groupName,
          slug: groupSlug,
        });
        const listing = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          name: listingName,
        });
        return { group, listing };
      };

      const getGroupPageHtml = async (groupId: number): Promise<string> => {
        const response = await adminGet(`/admin/groups/${groupId}`);
        expectStatus(200)(response);
        return response.text();
      };

      // The roster moved to the Attendees tab; attendee-row assertions read it.
      const getGroupAttendeesHtml = async (
        groupId: number,
      ): Promise<string> => {
        const response = await adminGet(`/admin/groups/${groupId}/attendees`);
        expectStatus(200)(response);
        return response.text();
      };

      test("hides total revenue for free listings", async () => {
        const { group } = await createGroupWithListing(
          "Free Group",
          "free-group",
          "Free Listing",
        );
        const html = await getGroupPageHtml(group.id);
        expect(html).not.toContain("Total Revenue");
      });

      test("shows attendees from multiple listings in group", async () => {
        const { group, listing: listing1 } = await createGroupWithListing(
          "Multi Group",
          "multi-group",
          "Listing Alpha",
        );
        const listing2 = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          name: "Listing Beta",
        });
        await createTestAttendee(
          listing1.id,
          listing1.slug,
          "Alice Alpha",
          "alice@test.com",
        );
        await createTestAttendee(
          listing2.id,
          listing2.slug,
          "Bob Beta",
          "bob@test.com",
        );

        const html = await getGroupAttendeesHtml(group.id);
        expect(html).toContain("Alice Alpha");
        expect(html).toContain("Bob Beta");
        expect(html).toContain("Listing Alpha");
        expect(html).toContain("Listing Beta");
      });

      test("shows no attendees message for group with listings but no registrations", async () => {
        const { group } = await createGroupWithListing(
          "No Reg Group",
          "no-reg-group",
          "Empty Listing",
        );
        const html = await getGroupAttendeesHtml(group.id);
        expect(html).toContain("No attendees yet");
      });
    });
  },
);
