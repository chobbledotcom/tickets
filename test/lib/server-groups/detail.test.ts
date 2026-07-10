import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { setGroupPackageMembers } from "#shared/db/groups.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  describeWithEnv,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv(
  "server (admin groups) — detail & sharing",
  { db: true },
  () => {
    beforeEach(() => {
      setDemoModeForTest(false);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    describe("GET /admin/groups/:id — detail & sharing", () => {
      testRequiresAuth("/admin/groups/1");

      test("accessible to managers", async () => {
        const group = await createTestGroup({
          name: "Detail Allow",
          slug: "detail-allow",
        });
        const response = await awaitTestRequest(`/admin/groups/${group.id}`, {
          cookie: await createTestManagerSession("mgr-detail"),
        });
        expectStatus(200)(response);
      });

      test("returns 404 for non-existent group", async () => {
        const response = await adminGet("/admin/groups/999");
        expectStatus(404)(response);
      });

      test("shows group detail with listings and embed options", async () => {
        const group = await createTestGroup({
          name: "Detail Group",
          slug: "detail-group",
        });
        const listing = await createTestListing({
          groupId: group.id,
          name: "Grouped Listing",
        });

        const response = await adminGet(`/admin/groups/${group.id}`);
        // Edit/delete moved to the Edit and Actions tabs; the Overview tab keeps
        // the info table, member listings, and share/embed affordances.
        await expectHtmlResponse(
          response,
          200,
          "Detail Group",
          "detail-group",
          "Grouped Listing",
          `/admin/listing/${listing.id}`,
          "Public URL",
          "/ticket/detail-group",
          "QR Code",
          "/ticket/detail-group/qr",
          "Embed Script",
          "data-listings=",
          "Embed Iframe",
          "iframe",
        );
      });

      test("a regular group with a sold-out but visible member stays shareable", async () => {
        // A non-package group is shareable whenever it has a visible member, even
        // if that member is sold out — bookability only gates PACKAGE groups.
        const group = await createTestGroup({
          name: "Sold Out Group",
          slug: "sold-out-group",
        });
        const listing = await createTestListing({
          groupId: group.id,
          maxAttendees: 1,
          name: "Sold Out Member",
        });
        await createTestAttendee(
          listing.id,
          listing.slug,
          "Buyer",
          "buyer@test.com",
        );

        const response = await adminGet(`/admin/groups/${group.id}`);
        const html = await response.text();
        // The embed/share affordances render despite the member being sold out.
        expect(html).toContain("Embed Script");
        expect(html).toContain("/ticket/sold-out-group");
      });

      test("a bookable package is shareable — public URL, QR, and embed render", async () => {
        // A package (unlike a regular group) gates its share affordances on the
        // whole bundle being bookable. A priced, uncapped member makes it so.
        const group = await createTestGroup({
          isPackage: true,
          name: "Bookable Pkg",
          slug: "bookable-pkg",
        });
        const member = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          name: "Bookable Member",
          unitPrice: 1000,
        });
        await setGroupPackageMembers(group.id, [
          { listingId: member.id, price: 1000 },
        ]);

        const html = await (await adminGet(`/admin/groups/${group.id}`)).text();
        expect(html).toContain("/ticket/bookable-pkg");
        expect(html).toContain(`embed-script-${group.id}`);
      });

      test("a sold-out package hides its share affordances", async () => {
        // The bundle can't be booked once its only member is full, so the package
        // (unlike a regular group) drops the public URL / QR / embed.
        const group = await createTestGroup({
          isPackage: true,
          name: "Sold Out Pkg",
          slug: "sold-out-pkg",
        });
        const member = await createTestListing({
          groupId: group.id,
          maxAttendees: 1,
          name: "Sold Package Member",
          unitPrice: 1000,
        });
        await setGroupPackageMembers(group.id, [
          { listingId: member.id, price: 1000 },
        ]);
        await createTestAttendee(
          member.id,
          member.slug,
          "Buyer",
          "pkgbuyer@test.com",
        );

        const html = await (await adminGet(`/admin/groups/${group.id}`)).text();
        expect(html).toContain("isn't currently bookable");
        expect(html).not.toContain("/ticket/sold-out-pkg");
      });

      test("add-listings form offers listings from other groups, not this group's own members", async () => {
        // Membership is many-to-many, so a listing already in another group is a
        // valid candidate to also join this one; only this group's current members
        // are excluded from the add form.
        const groupA = await createTestGroup({
          name: "Group A",
          slug: "group-a",
        });
        const inOtherGroup = await createTestListing({
          groupId: groupA.id,
          name: "Other Group Member",
        });
        const target = await createTestGroup({
          name: "Target",
          slug: "target-g",
        });
        const ownMember = await createTestListing({
          groupId: target.id,
          name: "Target Member",
        });

        const html = await (
          await adminGet(`/admin/groups/${target.id}`)
        ).text();
        // The listing already in Group A is offered as an add candidate…
        expect(html).toContain(`value="${inOtherGroup.id}"`);
        // …while the target's own member is not (no add-form checkbox for it).
        expect(html).not.toContain(`value="${ownMember.id}"`);
      });

      test("group revenue comes from the ledger and survives attendee deletion", async () => {
        const { bookAttendee } = await import("#test-utils");
        const { deleteAttendee } = await import(
          "#shared/db/attendees/delete.ts"
        );
        const group = await createTestGroup({ name: "Rev", slug: "rev-group" });
        const listing = await createTestListing({
          groupId: group.id,
          name: "Paid Listing",
          unitPrice: 2500,
        });
        const result = await bookAttendee(listing, { pricePaid: 2500 });
        if (!result.success) throw new Error("booking failed");
        const attendeeId = result.attendees[0]!.id;

        const before = await adminGet(`/admin/groups/${group.id}`);
        await expectHtmlResponse(before, 200, "Total Revenue", "£25");

        // Deleting the attendee purges its rows but not the ledger sale leg, so the
        // ledger-projected revenue still counts it — an attendee-sum would not.
        await deleteAttendee(attendeeId);
        const after = await adminGet(`/admin/groups/${group.id}`);
        await expectHtmlResponse(after, 200, "Total Revenue", "£25");
      });

      test("shows hidden status on detail page when group is hidden", async () => {
        const group = await createTestGroup({
          hidden: true,
          name: "Hidden Detail",
          slug: "hidden-detail",
        });
        const response = await adminGet(`/admin/groups/${group.id}`);
        await expectHtmlResponse(
          response,
          200,
          "Hidden",
          "not shown in public listings list",
        );
      });

      test("does not show hidden status when group is visible", async () => {
        const group = await createTestGroup({
          name: "Visible Detail",
          slug: "visible-detail",
        });
        const response = await adminGet(`/admin/groups/${group.id}`);
        const html = await response.text();
        expect(html).not.toContain("not shown in public listings list");
      });

      test("shows empty listings message when group has no listings", async () => {
        const group = await createTestGroup({
          name: "Empty Group",
          slug: "empty-group",
        });
        const response = await adminGet(`/admin/groups/${group.id}`);
        // A group with no visible members has no live /ticket page, so the Overview
        // shows the share-unavailable note instead of a public URL / embed / QR.
        const html = await expectHtmlResponse(
          response,
          200,
          "No listings in this group",
          "isn't currently bookable",
        );
        expect(html).not.toContain(`/ticket/${group.slug}`);
        expect(html).not.toContain(`embed-script-${group.id}`);
      });

      test("shows ungrouped listings for adding to group", async () => {
        const group = await createTestGroup({
          name: "Target Group",
          slug: "target-group",
        });
        const ungrouped = await createTestListing({
          name: "Ungrouped Listing",
        });

        const response = await adminGet(`/admin/groups/${group.id}`);
        await expectHtmlResponse(
          response,
          200,
          "Add listings:",
          "Ungrouped Listing",
          `value="${ungrouped.id}"`,
        );
      });

      test("hides add-listings form when no ungrouped listings exist", async () => {
        const group = await createTestGroup({
          name: "Solo Group",
          slug: "solo-group",
        });
        await createTestListing({ groupId: group.id, name: "Already Grouped" });

        const response = await adminGet(`/admin/groups/${group.id}`);
        expectStatus(200)(response);
        const html = await response.text();
        expect(html).not.toContain("Add listings:");
      });
    });
  },
);
