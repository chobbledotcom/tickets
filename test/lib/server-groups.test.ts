import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import { signCsrfToken } from "#lib/csrf.ts";
import { setDemoModeForTest } from "#lib/demo.ts";

import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  assertAdminHtml,
  awaitTestRequest,
  createTestAttendee,
  createTestEvent,
  createTestGroup,
  createTestManagerSession,
  deleteTestGroup,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirectWithFlash,
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
      const { response } = await adminGet("/admin/groups");
      await expectHtmlResponse(response, 200, "Groups", "No groups configured");
    });

    test("shows groups in table when present", async () => {
      const group = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });

      const { response } = await adminGet("/admin/groups");
      await expectHtmlResponse(
        response,
        200,
        "Group One",
        "group-one",
        `/admin/groups/${group.id}">`,
        `/admin/groups/${group.id}/edit`,
        `/admin/groups/${group.id}/delete`,
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
      const { response } = await adminGet("/admin/groups/new");
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
        description: "A fun group of events",
        name: "Described Group",
      });
      expect(group.name).toBe("Described Group");
      expect(group.description).toBe("A fun group of events");
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
      const { response } = await adminGet(`/admin/groups/${group.id}/edit`);
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
      const { response } = await adminGet(`/admin/groups/${group.id}/edit`);
      const html = await expectHtmlResponse(response, 200, "Edit Group");
      expect(html).toContain("checked");
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/groups/999/edit");
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
      expectRedirectWithFlash(
        `/admin/groups/${group.id}`,
        "Group updated",
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
      expectRedirectWithFlash(
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
    test("shows delete confirmation with event note", async () => {
      const group = await createTestGroup({
        name: "Delete Me",
        slug: "delete-me",
      });
      const { response } = await adminGet(`/admin/groups/${group.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Group",
        "Events in this group will not be deleted",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/groups/999/delete");
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
      expectRedirectWithFlash(
        `/admin/groups/${group.id}/delete`,
        expect.stringContaining("Group name does not match"),
        false,
      )(response);
    });

    test("deletes group, resets events to group_id=0, and does not delete events", async () => {
      const group = await createTestGroup({
        name: "To Delete",
        slug: "to-delete",
      });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Grouped Event",
      });
      expect(event.group_id).toBe(group.id);

      await deleteTestGroup(group.id);

      const { groupsTable } = await import("#lib/db/groups.ts");
      const { getEvent } = await import("#lib/db/events.ts");

      expect(await groupsTable.findById(group.id)).toBeNull();
      const existingEvent = await getEvent(event.id);
      expect(existingEvent).not.toBeNull();
      expect(existingEvent?.group_id).toBe(0);
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

      const { groupsTable } = await import("#lib/db/groups.ts");
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
        expectRedirectWithFlash("/admin/groups", "Group deleted")(response);
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
      const { response } = await adminGet("/admin/groups/999");
      expectStatus(404)(response);
    });

    test("shows group detail with events and embed options", async () => {
      const group = await createTestGroup({
        name: "Detail Group",
        slug: "detail-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        name: "Grouped Event",
      });

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Detail Group",
        "detail-group",
        "Grouped Event",
        `/admin/event/${event.id}`,
        "Edit Group",
        "Delete Group",
        "Public URL",
        "/ticket/detail-group",
        "QR Code",
        "/ticket/detail-group/qr",
        "Embed Script",
        "data-events=",
        "Embed Iframe",
        "iframe",
      );
    });

    test("shows hidden status on detail page when group is hidden", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Detail",
        slug: "hidden-detail",
      });
      const { response } = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Hidden",
        "not shown in public events list",
      );
    });

    test("does not show hidden status when group is visible", async () => {
      const group = await createTestGroup({
        name: "Visible Detail",
        slug: "visible-detail",
      });
      const { response } = await adminGet(`/admin/groups/${group.id}`);
      const html = await response.text();
      expect(html).not.toContain("not shown in public events list");
    });

    test("shows empty events message when group has no events", async () => {
      const group = await createTestGroup({
        name: "Empty Group",
        slug: "empty-group",
      });
      const { response } = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(response, 200, "No events in this group");
    });

    test("shows ungrouped events for adding to group", async () => {
      const group = await createTestGroup({
        name: "Target Group",
        slug: "target-group",
      });
      const ungrouped = await createTestEvent({ name: "Ungrouped Event" });

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Add Events to Group",
        "Ungrouped Event",
        `value="${ungrouped.id}"`,
      );
    });

    test("hides add-events form when no ungrouped events exist", async () => {
      const group = await createTestGroup({
        name: "Solo Group",
        slug: "solo-group",
      });
      await createTestEvent({ groupId: group.id, name: "Already Grouped" });

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).not.toContain("Add Events to Group");
    });

    test("shows attendee count and checked-in stats", async () => {
      const group = await createTestGroup({
        name: "Stats Group",
        slug: "stats-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 20,
        name: "Stats Event",
      });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com");

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees");
      expect(html).toContain("Checked In");
      expect(html).toContain("0 / 2");
      expect(html).toContain("2 remain");
    });

    test("shows dual checked-in rows when attendees have multi-quantity", async () => {
      const group = await createTestGroup({
        name: "Multi Qty Group",
        slug: "multi-qty-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 20,
        maxQuantity: 5,
        name: "Multi Qty Event",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Alice",
        "alice@multi.com",
        3,
      );
      await createTestAttendee(event.id, event.slug, "Bob", "bob@multi.com");

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees Checked In");
      expect(html).toContain("Tickets Checked In");
      // 0 / 2 tickets checked in, 0 / 4 attendees checked in
      expect(html).toContain("0 / 2");
      expect(html).toContain("0 / 4");
    });

    test("shows attendees table with event name column", async () => {
      const group = await createTestGroup({
        name: "Table Group",
        slug: "table-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Table Event",
      });
      await createTestAttendee(
        event.id,
        event.slug,
        "Charlie",
        "charlie@test.com",
      );

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Charlie");
      expect(html).toContain("Table Event");
      expect(html).toContain(`/admin/event/${event.id}`);
    });

    test("shows question answer summary in group details", async () => {
      const group = await createTestGroup({
        name: "Q Group",
        slug: "q-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Q Event",
      });
      await createTestAttendee(event.id, event.slug, "Dave", "dave@test.com");
      const { questionsTable, answersTable, setEventQuestions } = await import(
        "#lib/db/questions.ts"
      );
      const q = await questionsTable.insert({ text: "Color" });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Red",
      });
      await setEventQuestions(event.id, [q.id]);

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("<th>Color</th>");
      expect(html).toContain("Red (0)");
    });

    test("shows total revenue for paid events", async () => {
      const group = await createTestGroup({
        name: "Revenue Group",
        slug: "revenue-group",
      });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Paid Event",
        unitPrice: 1000,
      });
      await createTestAttendee(event.id, event.slug, "Donor", "donor@test.com");

      const { response } = await adminGet(`/admin/groups/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Total Revenue");
    });

    const createGroupWithEvent = async (
      groupName: string,
      groupSlug: string,
      eventName: string,
    ) => {
      const group = await createTestGroup({ name: groupName, slug: groupSlug });
      const event = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: eventName,
      });
      return { event, group };
    };

    const getGroupPageHtml = async (groupId: number): Promise<string> => {
      const { response } = await adminGet(`/admin/groups/${groupId}`);
      expectStatus(200)(response);
      return response.text();
    };

    test("hides total revenue for free events", async () => {
      const { group } = await createGroupWithEvent(
        "Free Group",
        "free-group",
        "Free Event",
      );
      const html = await getGroupPageHtml(group.id);
      expect(html).not.toContain("Total Revenue");
    });

    test("shows attendees from multiple events in group", async () => {
      const { group, event: event1 } = await createGroupWithEvent(
        "Multi Group",
        "multi-group",
        "Event Alpha",
      );
      const event2 = await createTestEvent({
        groupId: group.id,
        maxAttendees: 10,
        name: "Event Beta",
      });
      await createTestAttendee(
        event1.id,
        event1.slug,
        "Alice Alpha",
        "alice@test.com",
      );
      await createTestAttendee(
        event2.id,
        event2.slug,
        "Bob Beta",
        "bob@test.com",
      );

      const html = await getGroupPageHtml(group.id);
      expect(html).toContain("Alice Alpha");
      expect(html).toContain("Bob Beta");
      expect(html).toContain("Event Alpha");
      expect(html).toContain("Event Beta");
    });

    test("shows no attendees message for group with events but no registrations", async () => {
      const { group } = await createGroupWithEvent(
        "No Reg Group",
        "no-reg-group",
        "Empty Event",
      );
      const html = await getGroupPageHtml(group.id);
      expect(html).toContain("No attendees yet");
    });
  });

  describe("POST /admin/groups/:id/add-events", () => {
    testRequiresAuth("/admin/groups/1/add-events", {
      body: { event_ids: "1" },
      method: "POST",
    });

    test("accessible to managers", async () => {
      const group = await createTestGroup({
        name: "Add Allow",
        slug: "add-allow",
      });
      const cookie = await createTestManagerSession("mgr-add-events");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-events`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminFormPost("/admin/groups/999/add-events", {
        event_ids: "1",
      });
      expectStatus(404)(response);
    });

    test("assigns ungrouped events to group", async () => {
      const group = await createTestGroup({
        name: "Assign Group",
        slug: "assign-group",
      });
      const event1 = await createTestEvent({ name: "Event A" });
      const event2 = await createTestEvent({ name: "Event B" });

      expect(event1.group_id).toBe(0);
      expect(event2.group_id).toBe(0);

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-events`,
          {
            csrf_token: csrfToken,
            event_ids: String(event1.id),
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/groups/${group.id}`,
        "Events added to group",
      )(response);

      const { getEvent } = await import("#lib/db/events.ts");
      const updated1 = await getEvent(event1.id);
      const updated2 = await getEvent(event2.id);
      expect(updated1?.group_id).toBe(group.id);
      expect(updated2?.group_id).toBe(0);
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
          `/admin/groups/${group.id}/add-events`,
          {
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expectRedirectWithFlash(
        `/admin/groups/${group.id}`,
        "Events added to group",
      )(response);
    });

    test("rejects adding event with mismatched type", async () => {
      const group = await createTestGroup({
        name: "Type Check",
        slug: "type-check",
      });
      await createTestEvent({
        eventType: "standard",
        groupId: group.id,
        name: "Standard In Group",
      });
      const dailyEvent = await createTestEvent({
        eventType: "daily",
        name: "Daily Ungrouped",
      });

      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          `/admin/groups/${group.id}/add-events`,
          {
            csrf_token: csrfToken,
            event_ids: String(dailyEvent.id),
          },
          cookie,
        ),
      );
      expectRedirectWithFlash(
        `/admin/groups/${group.id}`,
        "This group already contains standard events — all events in a group must be the same type",
        false,
      )(response);

      // Verify event was NOT assigned
      const { getEvent } = await import("#lib/db/events.ts");
      const unchanged = await getEvent(dailyEvent.id);
      expect(unchanged?.group_id).toBe(0);
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
      expectRedirectWithFlash(
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
