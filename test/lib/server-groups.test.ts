import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "#test-compat";

import { signCsrfToken } from "#lib/csrf.ts";

import { handleRequest } from "#routes";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestDbWithSetup,
  createTestEvent,
  createTestGroup,
  createTestManagerSession,
  deleteTestGroup,
  expectAdminRedirect,
  expectHtmlResponse,
  expectStatus,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  updateTestGroup,
} from "#test-utils";

describe("server (admin groups)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/groups", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/groups"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const response = await awaitTestRequest("/admin/groups", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
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
        `/admin/group/${group.id}">`,
        `/admin/group/${group.id}/edit`,
        `/admin/group/${group.id}/delete`,
      );
    });
  });

  describe("GET /admin/group/new", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/group/new"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const response = await awaitTestRequest("/admin/group/new", {
        cookie: await createTestManagerSession(),
      });
      expectStatus(403)(response);
    });

    test("shows create group form without slug field", async () => {
      const { response } = await adminGet("/admin/group/new");
      const html = await expectHtmlResponse(
        response,
        200,
        "Add Group",
        "Group Name",
        "Terms and Conditions",
      );
      expect(html).not.toContain('name="slug"');
    });
  });

  describe("POST /admin/group", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/group", { name: "X" }),
      );
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const cookie = await createTestManagerSession("mgr-create-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/group",
          { name: "X", csrf_token: csrfToken },
          cookie,
        ),
      );
      expectStatus(403)(response);
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

  describe("GET /admin/group/:id/edit", () => {
    test("shows edit form with pre-filled values", async () => {
      const group = await createTestGroup({
        name: "Editable",
        slug: "editable",
        termsAndConditions: "Original terms",
      });
      const { response } = await adminGet(`/admin/group/${group.id}/edit`);
      await expectHtmlResponse(
        response,
        200,
        "Edit Group",
        "Editable",
        "editable",
        "Original terms",
      );
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/group/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/group/:id/edit", () => {
    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({
        name: "Edit Deny",
        slug: "edit-deny",
      });
      const cookie = await createTestManagerSession("mgr-edit-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/edit`, {
          name: "Changed",
          slug: "changed",
          terms_and_conditions: "",
          csrf_token: csrfToken,
        }, cookie),
      );
      expectStatus(403)(response);
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

    test("rejects slug collision with another group", async () => {
      const g1 = await createTestGroup({ name: "One", slug: "one" });
      const g2 = await createTestGroup({ name: "Two", slug: "two" });

      const { response } = await adminFormPost(`/admin/group/${g2.id}/edit`, {
        name: "Two",
        slug: g1.slug,
        terms_and_conditions: "",
      });
      await expectHtmlResponse(response, 400, "Slug is already in use");
    });

    test("returns 404 when editing a non-existent group", async () => {
      const { response } = await adminFormPost("/admin/group/999/edit", {
        name: "Missing",
        slug: "missing",
        terms_and_conditions: "",
      });
      expectStatus(404)(response);
    });
  });

  describe("GET /admin/group/:id/delete", () => {
    test("shows delete confirmation with event note", async () => {
      const group = await createTestGroup({
        name: "Delete Me",
        slug: "delete-me",
      });
      const { response } = await adminGet(`/admin/group/${group.id}/delete`);
      await expectHtmlResponse(
        response,
        200,
        "Delete Group",
        "Events in this group will not be deleted",
        "confirm_identifier",
      );
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/group/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/group/:id/delete", () => {
    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({
        name: "Delete Deny",
        slug: "delete-deny",
      });
      const cookie = await createTestManagerSession("mgr-delete-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/delete`, {
          confirm_identifier: "Delete Deny",
          csrf_token: csrfToken,
        }, cookie),
      );
      expectStatus(403)(response);
    });

    test("rejects deletion when name confirmation is wrong", async () => {
      const group = await createTestGroup({
        name: "Right Name",
        slug: "right-name",
      });
      const { response } = await adminFormPost(
        `/admin/group/${group.id}/delete`,
        {
          confirm_identifier: "Wrong Name",
        },
      );
      await expectHtmlResponse(response, 400, "Group name does not match");
    });

    test("deletes group, resets events to group_id=0, and does not delete events", async () => {
      const group = await createTestGroup({
        name: "To Delete",
        slug: "to-delete",
      });
      const event = await createTestEvent({
        name: "Grouped Event",
        groupId: group.id,
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
      const { response } = await adminFormPost("/admin/group/999/delete", {
        confirm_identifier: "Anything",
      });
      expectStatus(404)(response);
    });

    test("returns 404 when group is deleted before resource delete", async () => {
      const group = await createTestGroup({
        name: "Race Group",
        slug: "race-group",
      });
      const { cookie, csrfToken } = await loginAsAdmin();

      const { groupsTable } = await import("#lib/db/groups.ts");
      const original = groupsTable.findById.bind(groupsTable);
      let calls = 0;
      const spy = spyOn(groupsTable, "findById");
      spy.mockImplementation((...args: Parameters<typeof original>) => {
        calls++;
        return calls === 1 ? original(...args) : Promise.resolve(null);
      });

      try {
        const response = await handleRequest(
          mockFormRequest(
            `/admin/group/${group.id}/delete`,
            { csrf_token: csrfToken, confirm_identifier: group.name },
            cookie,
          ),
        );
        expectStatus(404)(response);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("GET /admin/group/:id", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/group/1"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({
        name: "Detail Deny",
        slug: "detail-deny",
      });
      const response = await awaitTestRequest(`/admin/group/${group.id}`, {
        cookie: await createTestManagerSession("mgr-detail"),
      });
      expectStatus(403)(response);
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/group/999");
      expectStatus(404)(response);
    });

    test("shows group detail with events and embed options", async () => {
      const group = await createTestGroup({
        name: "Detail Group",
        slug: "detail-group",
        termsAndConditions: "Some terms",
      });
      const event = await createTestEvent({
        name: "Grouped Event",
        groupId: group.id,
      });

      const { response } = await adminGet(`/admin/group/${group.id}`);
      await expectHtmlResponse(
        response,
        200,
        "Detail Group",
        "detail-group",
        "Some terms",
        "Grouped Event",
        `/admin/event/${event.id}`,
        "Edit Group",
        "Delete Group",
        "Public URL",
        "/ticket/detail-group",
        "Embed Script",
        "data-events=",
        "Embed Iframe",
        "iframe",
      );
    });

    test("shows empty events message when group has no events", async () => {
      const group = await createTestGroup({
        name: "Empty Group",
        slug: "empty-group",
      });
      const { response } = await adminGet(`/admin/group/${group.id}`);
      await expectHtmlResponse(response, 200, "No events in this group");
    });

    test("shows ungrouped events for adding to group", async () => {
      const group = await createTestGroup({
        name: "Target Group",
        slug: "target-group",
      });
      const ungrouped = await createTestEvent({ name: "Ungrouped Event" });

      const { response } = await adminGet(`/admin/group/${group.id}`);
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
      await createTestEvent({ name: "Already Grouped", groupId: group.id });

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).not.toContain("Add Events to Group");
    });

    test("shows attendee count and checked-in stats", async () => {
      const group = await createTestGroup({ name: "Stats Group", slug: "stats-group" });
      const event = await createTestEvent({ name: "Stats Event", groupId: group.id, maxAttendees: 20 });
      await createTestAttendee(event.id, event.slug, "Alice", "alice@test.com");
      await createTestAttendee(event.id, event.slug, "Bob", "bob@test.com");

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Attendees");
      expect(html).toContain("Checked In");
      expect(html).toContain("0 / 2");
      expect(html).toContain("2 remain");
    });

    test("shows attendees table with event name column", async () => {
      const group = await createTestGroup({ name: "Table Group", slug: "table-group" });
      const event = await createTestEvent({ name: "Table Event", groupId: group.id, maxAttendees: 10 });
      await createTestAttendee(event.id, event.slug, "Charlie", "charlie@test.com");

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Charlie");
      expect(html).toContain("Table Event");
      expect(html).toContain(`/admin/event/${event.id}`);
    });

    test("shows total revenue for paid events", async () => {
      const group = await createTestGroup({ name: "Revenue Group", slug: "revenue-group" });
      const event = await createTestEvent({ name: "Paid Event", groupId: group.id, maxAttendees: 10, unitPrice: 1000 });
      await createTestAttendee(event.id, event.slug, "Donor", "donor@test.com");

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Total Revenue");
    });

    test("hides total revenue for free events", async () => {
      const group = await createTestGroup({ name: "Free Group", slug: "free-group" });
      await createTestEvent({ name: "Free Event", groupId: group.id, maxAttendees: 10 });

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).not.toContain("Total Revenue");
    });

    test("shows attendees from multiple events in group", async () => {
      const group = await createTestGroup({ name: "Multi Group", slug: "multi-group" });
      const event1 = await createTestEvent({ name: "Event Alpha", groupId: group.id, maxAttendees: 10 });
      const event2 = await createTestEvent({ name: "Event Beta", groupId: group.id, maxAttendees: 10 });
      await createTestAttendee(event1.id, event1.slug, "Alice Alpha", "alice@test.com");
      await createTestAttendee(event2.id, event2.slug, "Bob Beta", "bob@test.com");

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Alice Alpha");
      expect(html).toContain("Bob Beta");
      expect(html).toContain("Event Alpha");
      expect(html).toContain("Event Beta");
    });

    test("shows no attendees message for group with events but no registrations", async () => {
      const group = await createTestGroup({ name: "No Reg Group", slug: "no-reg-group" });
      await createTestEvent({ name: "Empty Event", groupId: group.id, maxAttendees: 10 });

      const { response } = await adminGet(`/admin/group/${group.id}`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("No attendees yet");
    });
  });

  describe("POST /admin/group/:id/add-events", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/group/1/add-events", { event_ids: "1" }),
      );
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({
        name: "Add Deny",
        slug: "add-deny",
      });
      const cookie = await createTestManagerSession("mgr-add-events");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/add-events`, {
          event_ids: "1",
          csrf_token: csrfToken,
        }, cookie),
      );
      expectStatus(403)(response);
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminFormPost("/admin/group/999/add-events", {
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

      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/add-events`, {
          event_ids: String(event1.id),
          csrf_token: csrfToken,
        }, cookie),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/group/${group.id}`);

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
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/add-events`, {
          csrf_token: csrfToken,
        }, cookie),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/group/${group.id}`);
    });
  });

  describe("redirect after create/edit", () => {
    test("create redirects to group detail page", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest("/admin/group", {
          name: "Redirect Test",
          terms_and_conditions: "",
          csrf_token: csrfToken,
        }, cookie),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toMatch(/\/admin\/group\/\d+$/);
    });

    test("edit redirects to group detail page", async () => {
      const group = await createTestGroup({
        name: "Edit Redir",
        slug: "edit-redir",
      });
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(`/admin/group/${group.id}/edit`, {
          name: "Edited Redir",
          slug: "edited-redir",
          terms_and_conditions: "",
          csrf_token: csrfToken,
        }, cookie),
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(`/admin/group/${group.id}`);
    });
  });

  describe("nav link", () => {
    test("groups link visible to owners", async () => {
      const { response } = await adminGet("/admin/groups");
      const html = await response.text();
      expect(html).toContain("/admin/groups");
      expect(html).toContain("Groups");
    });

    test("groups link not visible to managers", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: await createTestManagerSession("mgr-groups-nav"),
      });
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).not.toContain("/admin/groups");
    });
  });
});
