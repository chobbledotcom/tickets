import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  getGroupIdsByListingId,
  setGroupPackageMembers,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import { updateListingAggregateValues } from "#shared/db/listings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  adminGet,
  assertAdminHtml,
  awaitTestRequest,
  createTestAttendee,
  createTestGroup,
  createTestListing,
  createTestManagerSession,
  deleteTestGroup,
  describeWithEnv,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
  updateTestGroup,
} from "#test-utils";

describeWithEnv("server (admin groups)", { db: true }, () => {
  beforeEach(() => {
    setDemoModeForTest(false);
  });

  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("GET /admin/groups", () => {
    testRequiresAuth("/admin/groups");

    test("accessible to managers", async () => {
      const response = await awaitTestRequest("/admin/groups", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(200)(response);
    });

    test("shows empty list when no groups exist", async () => {
      const response = await adminGet("/admin/groups");
      await expectHtmlResponse(response, 200, "Groups", "No groups configured");
    });

    test("shows groups in table when present", async () => {
      const group = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });

      const response = await adminGet("/admin/groups");
      // The name links to the group detail page; edit/delete live there now,
      // not inline in the list table.
      await expectHtmlResponse(
        response,
        200,
        "Group One",
        "group-one",
        `/admin/groups/${group.id}">`,
      );
    });
  });

  describe("GET /admin/groups/new", () => {
    testRequiresAuth("/admin/groups/new");

    test("accessible to managers", async () => {
      const response = await awaitTestRequest("/admin/groups/new", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(200)(response);
    });

    test("shows create group form without slug field", async () => {
      const response = await adminGet("/admin/groups/new");
      const html = await expectHtmlResponse(
        response,
        200,
        "Add Group",
        "Group Name",
        "Description (optional)",
        "Terms and Conditions",
      );
      expect(html).not.toContain('name="slug"');
    });
  });

  describe("POST /admin/groups", () => {
    testRequiresAuth("/admin/groups", {
      body: { name: "X" },
      method: "POST",
    });

    test("accessible to managers", async () => {
      const cookie = await createTestManagerSession("mgr-create-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/groups",
          {
            csrf_token: csrfToken,
            name: "Manager Group",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(
        /\/admin\/groups\/\d+(\?|$)/,
      );
      expectFlash(response, "Group created");
    });

    test("creates group with auto-generated slug", async () => {
      const group = await createTestGroup({
        name: "New Group",
        termsAndConditions: "Group terms",
      });
      expect(group.name).toBe("New Group");
      expect(group.slug).toBeTruthy();
      expect(group.slug.length).toBe(5);
      expect(group.terms_and_conditions).toBe("Group terms");
    });

    test("creates group with description", async () => {
      const group = await createTestGroup({
        description: "A fun group of listings",
        name: "Described Group",
      });
      expect(group.name).toBe("Described Group");
      expect(group.description).toBe("A fun group of listings");
    });

    test("creates group without description defaults to empty string", async () => {
      const group = await createTestGroup({ name: "No Desc Group" });
      expect(group.description).toBe("");
    });

    test("creates group with hidden flag", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Group",
      });
      expect(group.name).toBe("Hidden Group");
      expect(group.hidden).toBe(true);
    });

    test("creates group without hidden flag by default", async () => {
      const group = await createTestGroup({
        name: "Visible Group",
      });
      expect(group.hidden).toBe(false);
    });

    test("creates group and allows slug to be set via edit", async () => {
      const group = await createTestGroup({
        name: "New Group",
        slug: "custom-slug",
        termsAndConditions: "Group terms",
      });
      expect(group.name).toBe("New Group");
      expect(group.slug).toBe("custom-slug");
      expect(group.terms_and_conditions).toBe("Group terms");
    });
  });

  describe("GET /admin/groups/:id/edit", () => {
    test("shows edit form with pre-filled values", async () => {
      const group = await createTestGroup({
        description: "Editable description",
        name: "Editable",
        slug: "editable",
        termsAndConditions: "Original terms",
      });
      const response = await adminGet(`/admin/groups/${group.id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Edit Group",
        "Editable",
        "editable",
        "Editable description",
        "Original terms",
      );
    });

    test("shows hidden checkbox checked for hidden group", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Editable",
        slug: "hidden-editable",
      });
      const response = await adminGet(`/admin/groups/${group.id}/edit`);
      const html = await expectHtmlResponse(response, 200, "Edit Group");
      expect(html).toContain("checked");
    });

    test("returns 404 for non-existent group", async () => {
      const response = await adminGet("/admin/groups/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/groups/:id/edit", () => {
    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Edit Allow",
        slug: "edit-allow",
      });
      const cookie = await createTestManagerSession("mgr-edit-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/edit`,
          {
            csrf_token: csrfToken,
            name: "Changed",
            slug: "changed",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      // Follow as the manager who made the POST, so the render check verifies
      // the landing page that role actually sees (not the default owner's).
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Group updated",
        true,
        cookie,
      )(response);
    });

    test("updates group", async () => {
      const group = await createTestGroup({ name: "Before", slug: "before" });
      const updated = await updateTestGroup(group.id, {
        name: "After",
        slug: "after",
        termsAndConditions: "Updated terms",
      });
      expect(updated.name).toBe("After");
      expect(updated.slug).toBe("after");
      expect(updated.terms_and_conditions).toBe("Updated terms");
    });

    test("updates group description", async () => {
      const group = await createTestGroup({
        description: "Original description",
        name: "Desc Edit",
        slug: "desc-edit",
      });
      expect(group.description).toBe("Original description");
      const updated = await updateTestGroup(group.id, {
        description: "Updated description",
      });
      expect(updated.description).toBe("Updated description");
      expect(updated.name).toBe("Desc Edit");
    });

    test("updates group hidden flag", async () => {
      const group = await createTestGroup({
        name: "Toggle Hidden",
        slug: "toggle-hidden",
      });
      expect(group.hidden).toBe(false);
      const updated = await updateTestGroup(group.id, { hidden: true });
      expect(updated.hidden).toBe(true);
      const unhidden = await updateTestGroup(group.id, { hidden: false });
      expect(unhidden.hidden).toBe(false);
    });

    test("rejects slug collision with another group", async () => {
      const g1 = await createTestGroup({ name: "One", slug: "one" });
      const g2 = await createTestGroup({ name: "Two", slug: "two" });

      const { response } = await adminFormPost(`/admin/groups/${g2.id}/edit`, {
        name: "Two",
        slug: g1.slug,
        terms_and_conditions: "",
      });
      await expectFlashRedirect(
        `/admin/groups/${g2.id}/edit`,
        expect.stringContaining("Slug is already in use"),
        false,
      )(response);
    });

    test("returns 404 when editing a non-existent group", async () => {
      const { response } = await adminFormPost("/admin/groups/999/edit", {
        name: "Missing",
        slug: "missing",
        terms_and_conditions: "",
      });
      expectStatus(404)(response);
    });
  });

  describe("GET /admin/groups/:id/delete", () => {
    test("shows delete confirmation with listing note", async () => {
      const group = await createTestGroup({
        name: "Delete Me",
        slug: "delete-me",
      });
      const response = await adminGet(`/admin/groups/${group.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Group",
        "Listings in this group will not be deleted",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent group", async () => {
      const response = await adminGet("/admin/groups/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/groups/:id/delete", () => {
    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Delete Allow",
        slug: "delete-allow",
      });
      const cookie = await createTestManagerSession("mgr-delete-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/delete`,
          {
            confirm_identifier: "Delete Allow",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(/\/admin\/groups(\?|$)/);
      expectFlash(response, "Group deleted");
    });

    test("rejects deletion when name confirmation is wrong", async () => {
      const group = await createTestGroup({
        name: "Right Name",
        slug: "right-name",
      });
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/delete`,
        {
          confirm_identifier: "Wrong Name",
        },
      );
      await expectFlashRedirect(
        `/admin/groups/${group.id}/delete`,
        expect.stringContaining("Group name does not match"),
        false,
      )(response);
    });

    test("deletes group, resets listings to group_id=0, and does not delete listings", async () => {
      const group = await createTestGroup({
        name: "To Delete",
        slug: "to-delete",
      });
      const listing = await createTestListing({
        groupId: group.id,
        name: "Grouped Listing",
      });
      expect(await getGroupIdsByListingId(listing.id)).toContain(group.id);

      await deleteTestGroup(group.id);

      const { groupsTable } = await import("#shared/db/groups.ts");
      const { getListing } = await import("#shared/db/listings.ts");

      expect(await groupsTable.findById(group.id)).toBeNull();
      const existingListing = await getListing(listing.id);
      expect(existingListing).not.toBeNull();
      // Group delete prunes membership rows, leaving the listing ungrouped.
      expect(await getGroupIdsByListingId(listing.id)).toEqual([]);
    });

    test("returns 404 when deleting a non-existent group", async () => {
      const { response } = await adminFormPost("/admin/groups/999/delete", {
        confirm_identifier: "Anything",
      });
      expectStatus(404)(response);
    });

    test("succeeds when group is deleted between load and delete", async () => {
      const group = await createTestGroup({
        name: "Race Group",
        slug: "race-group",
      });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const { groupsTable } = await import("#shared/db/groups.ts");
      const original = groupsTable.findById.bind(groupsTable);
      let calls = 0;
      const findByIdStub = stub(
        groupsTable,
        "findById",
        (...args: Parameters<typeof original>) => {
          calls++;
          return calls === 1 ? original(...args) : Promise.resolve(null);
        },
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            `/admin/groups/${group.id}/delete`,
            { confirm_identifier: group.name, csrf_token: csrfToken },
            cookie,
          ),
        );
        await expectFlashRedirect("/admin/groups", "Group deleted")(response);
      } finally {
        findByIdStub.restore();
      }
    });
  });

  describe("GET /admin/groups/:id", () => {
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
      await expectHtmlResponse(
        response,
        200,
        "Detail Group",
        "detail-group",
        "Grouped Listing",
        `/admin/listing/${listing.id}`,
        "Edit Group",
        "Delete Group",
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

      const html = await (await adminGet(`/admin/groups/${target.id}`)).text();
      // The listing already in Group A is offered as an add candidate…
      expect(html).toContain(`value="${inOtherGroup.id}"`);
      // …while the target's own member is not (no add-form checkbox for it).
      expect(html).not.toContain(`value="${ownMember.id}"`);
    });

    test("group revenue comes from the ledger and survives attendee deletion", async () => {
      const { bookAttendee } = await import("#test-utils");
      const { deleteAttendee } = await import("#shared/db/attendees.ts");
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
      await expectHtmlResponse(response, 200, "No listings in this group");
    });

    test("shows ungrouped listings for adding to group", async () => {
      const group = await createTestGroup({
        name: "Target Group",
        slug: "target-group",
      });
      const ungrouped = await createTestListing({ name: "Ungrouped Listing" });

      const response = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Add Listings to Group",
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
      expect(html).not.toContain("Add Listings to Group");
    });

    test("shows attendee count and checked-in stats", async () => {
      const group = await createTestGroup({
        name: "Stats Group",
        slug: "stats-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        name: "Stats Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@test.com",
      );
      await createTestAttendee(listing.id, listing.slug, "Bob", "bob@test.com");

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees");
      expect(html).toContain("Checked In");
      expect(html).toContain("0 / 2");
      expect(html).toContain("2 remain");
    });

    test("shows stored-total mismatches on the group detail page", async () => {
      const group = await createTestGroup({
        name: "Mismatch Group",
        slug: "mismatch-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        name: "Mismatch Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Actual",
        "actual-group@test.com",
        2,
      );
      await updateListingAggregateValues(listing.id, {
        booked_quantity: 9,
        tickets_count: 1,
      });

      const response = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Running total check",
        "expected <strong>1</strong>, got",
        "Review group listings",
      );
    });

    test("shows dual checked-in rows when attendees have multi-quantity", async () => {
      const group = await createTestGroup({
        name: "Multi Qty Group",
        slug: "multi-qty-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 20,
        maxQuantity: 5,
        name: "Multi Qty Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Alice",
        "alice@multi.com",
        3,
      );
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Bob",
        "bob@multi.com",
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees Checked In");
      expect(html).toContain("Tickets Checked In");
      // 0 / 2 tickets checked in, 0 / 4 attendees checked in
      expect(html).toContain("0 / 2");
      expect(html).toContain("0 / 4");
    });

    test("shows attendees table with listing name column", async () => {
      const group = await createTestGroup({
        name: "Table Group",
        slug: "table-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Table Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Charlie",
        "charlie@test.com",
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Charlie");
      expect(html).toContain("Table Listing");
      expect(html).toContain(`/admin/listing/${listing.id}`);
    });

    test("shows question answer summary in group details", async () => {
      const group = await createTestGroup({
        name: "Q Group",
        slug: "q-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Q Listing",
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Dave",
        "dave@test.com",
      );
      const { questionsTable, answersTable, setListingQuestions } =
        await import("#shared/db/questions.ts");
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Color",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      await setListingQuestions(listing.id, [q.id]);

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("<th>Color</th>");
      expect(html).toContain("Red (0)");
    });

    test("shows total revenue for paid listings", async () => {
      const group = await createTestGroup({
        name: "Revenue Group",
        slug: "revenue-group",
      });
      const listing = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        name: "Paid Listing",
        unitPrice: 1000,
      });
      await createTestAttendee(
        listing.id,
        listing.slug,
        "Donor",
        "donor@test.com",
      );

      const response = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Total Revenue");
    });

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
      await setGroupPackageMembers(group.id, [
        { listingId: member.id, price: 2500 },
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
      await setGroupPackageMembers(group.id, [
        { dayPrices: { 2: 2500 }, listingId: member.id, price: null },
      ]);
      // A daily member needs a dated booking; the form helper posts date-less,
      // so book atomically like the checkout would.
      const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
      const { addDays } = await import("#shared/dates.ts");
      const { todayInTz } = await import("#shared/timezone.ts");
      const booked = await createAttendeeAtomic({
        bookings: [
          {
            date: addDays(todayInTz("UTC"), 2),
            listingId: member.id,
            quantity: 1,
          },
        ],
        email: "daybuyer@test.com",
        name: "Buyer",
        packageGroupId: group.id,
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
      const group = await createTestGroup({ name: groupName, slug: groupSlug });
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

      const html = await getGroupPageHtml(group.id);
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
      const html = await getGroupPageHtml(group.id);
      expect(html).toContain("No attendees yet");
    });
  });

  describe("POST /admin/groups/:id/add-listings", () => {
    testRequiresAuth("/admin/groups/1/add-listings", {
      body: { listing_ids: "1" },
      method: "POST",
    });

    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Add Allow",
        slug: "add-allow",
      });
      const cookie = await createTestManagerSession("mgr-add-listings");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-listings`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminFormPost(
        "/admin/groups/999/add-listings",
        {
          listing_ids: "1",
        },
      );
      expectStatus(404)(response);
    });

    test("assigns ungrouped listings to group", async () => {
      const group = await createTestGroup({
        name: "Assign Group",
        slug: "assign-group",
      });
      const listing1 = await createTestListing({ name: "Listing A" });
      const listing2 = await createTestListing({ name: "Listing B" });

      expect(await getGroupIdsByListingId(listing1.id)).toEqual([]);
      expect(await getGroupIdsByListingId(listing2.id)).toEqual([]);

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-listings`,
          {
            csrf_token: csrfToken,
            listing_ids: String(listing1.id),
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Listings added to group",
      )(response);

      expect(await getGroupIdsByListingId(listing1.id)).toContain(group.id);
      expect(await getGroupIdsByListingId(listing2.id)).toEqual([]);
    });

    test("handles empty selection gracefully", async () => {
      const group = await createTestGroup({
        name: "Empty Select",
        slug: "empty-select",
      });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-listings`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Listings added to group",
      )(response);
    });

    test("rejects adding listing with mismatched type", async () => {
      const group = await createTestGroup({
        name: "Type Check",
        slug: "type-check",
      });
      await createTestListing({
        groupId: group.id,
        listingType: "standard",
        name: "Standard In Group",
      });
      const dailyListing = await createTestListing({
        listingType: "daily",
        name: "Daily Ungrouped",
      });

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-listings`,
          {
            csrf_token: csrfToken,
            listing_ids: String(dailyListing.id),
          },
          cookie,
        ),
      );
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "This group already contains standard listings — all listings in a group must be the same type",
        false,
      )(response);

      // Verify listing was NOT assigned
      expect(await getGroupIdsByListingId(dailyListing.id)).toEqual([]);
    });
  });

  describe("redirect after create/edit", () => {
    test("create redirects to group detail page", async () => {
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/groups",
          {
            csrf_token: csrfToken,
            name: "Redirect Test",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toMatch(/\/admin\/groups\/\d+(\?|$)/);
      expectFlash(response, "Group created");
    });

    test("edit redirects to group detail page", async () => {
      const group = await createTestGroup({
        name: "Edit Redir",
        slug: "edit-redir",
      });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/edit`,
          {
            csrf_token: csrfToken,
            name: "Edited Redir",
            slug: "edited-redir",
            terms_and_conditions: "",
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      await expectFlashRedirect(
        `/admin/groups/${group.id}`,
        "Group updated",
      )(response);
    });
  });

  describe("group max_attendees", () => {
    test("creates group with max_attendees", async () => {
      const group = await createTestGroup({
        maxAttendees: 50,
        name: "Capped",
        slug: "capped",
      });
      expect(group.max_attendees).toBe(50);
    });

    test("creates group without max_attendees defaults to 0", async () => {
      const group = await createTestGroup({
        name: "Uncapped",
        slug: "uncapped",
      });
      expect(group.max_attendees).toBe(0);
    });

    test("edit form shows max_attendees field", async () => {
      const group = await createTestGroup({
        maxAttendees: 25,
        name: "Edit Max",
        slug: "edit-max",
      });

      await assertAdminHtml(
        `/admin/groups/${group.id}/edit`,
        "max_attendees",
        "25",
      );
    });

    test("updates max_attendees via edit", async () => {
      const group = await createTestGroup({
        maxAttendees: 10,
        name: "Update Max",
        slug: "update-max",
      });

      const updated = await updateTestGroup(group.id, { maxAttendees: 30 });
      expect(updated.max_attendees).toBe(30);
    });

    test("detail page shows Group Attendees with cap when set", async () => {
      const group = await createTestGroup({
        maxAttendees: 100,
        name: "Detail Max",
        slug: "detail-max",
      });

      await assertAdminHtml(
        `/admin/groups/${group.id}`,
        "Group Attendees",
        "0 / 100",
      );
    });

    test("detail page shows Group Attendees with no-cap note when uncapped", async () => {
      const group = await createTestGroup({
        name: "Detail No Max",
        slug: "detail-no-max",
      });

      await assertAdminHtml(
        `/admin/groups/${group.id}`,
        "Group Attendees",
        "(no group cap)",
      );
    });
  });

  describe("validateGroupListingType - customisable days", () => {
    test("rejects a non-customisable listing joining a customisable group", async () => {
      const group = await createTestGroup({ name: "Cust Group" });
      await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        groupId: group.id,
        name: "Customisable Member",
      });
      const error = await validateGroupListingType(group.id, "standard", false);
      expect(error).toBe(
        "This group already contains listings with customisable days — all listings in a group must match",
      );
    });

    test("rejects a customisable listing joining a non-customisable group", async () => {
      const group = await createTestGroup({ name: "Plain Group" });
      await createTestListing({
        groupId: group.id,
        name: "Plain Member",
      });
      const error = await validateGroupListingType(group.id, "standard", true);
      expect(error).toBe(
        "This group already contains listings without customisable days — all listings in a group must match",
      );
    });

    test("accepts a listing whose customisable setting matches the group", async () => {
      const group = await createTestGroup({ name: "Match Group" });
      await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        groupId: group.id,
        name: "Match Member",
      });
      const error = await validateGroupListingType(group.id, "standard", true);
      expect(error).toBeNull();
    });
  });

  describe("nav link", () => {
    test("groups link visible to owners", async () => {
      await assertAdminHtml("/admin/groups", "/admin/groups", "Groups");
    });

    test("groups link visible to managers", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: await createTestManagerSession("mgr-groups-nav"),
      });
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("/admin/groups");
    });
  });
});
