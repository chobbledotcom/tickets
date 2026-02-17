import { afterEach, beforeEach, describe, expect, spyOn, test } from "#test-compat";

import { encrypt, hmacHash } from "#lib/crypto.ts";
import { signCsrfToken } from "#lib/csrf.ts";
import { getSessionCookieName } from "#lib/cookies.ts";
import { getDb } from "#lib/db/client.ts";
import { createSession } from "#lib/db/sessions.ts";

import { handleRequest } from "#routes";
import {
  adminGet,
  adminFormPost,
  awaitTestRequest,
  createTestDbWithSetup,
  createTestEvent,
  createTestGroup,
  deleteTestGroup,
  expectAdminRedirect,
  expectStatus,
  loginAsAdmin,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  updateTestGroup,
} from "#test-utils";

const createManagerCookie = async (token = "mgr-groups-session"): Promise<string> => {
  const managerIdx = await hmacHash("groupsmanager");
  await getDb().execute({
    sql: `INSERT INTO users (username_hash, username_index, password_hash, wrapped_data_key, admin_level)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      await encrypt("groupsmanager"),
      managerIdx,
      "",
      null,
      await encrypt("manager"),
    ],
  });
  await createSession(token, "mgr-csrf", Date.now() + 60_000, null, 2);
  return `${getSessionCookieName()}=${token}`;
};

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
        cookie: await createManagerCookie(),
      });
      expectStatus(403)(response);
    });

    test("shows empty list when no groups exist", async () => {
      const { response } = await adminGet("/admin/groups");
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Groups");
      expect(html).toContain("No groups configured");
    });

    test("shows groups in table when present", async () => {
      const group = await createTestGroup({
        name: "Group One",
        slug: "group-one",
      });

      const { response } = await adminGet("/admin/groups");
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Group One");
      expect(html).toContain("group-one");
      expect(html).toContain(`/admin/group/${group.id}/edit`);
      expect(html).toContain(`/admin/group/${group.id}/delete`);
    });
  });

  describe("GET /admin/group/new", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/group/new"));
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const response = await awaitTestRequest("/admin/group/new", {
        cookie: await createManagerCookie(),
      });
      expectStatus(403)(response);
    });

    test("shows create group form", async () => {
      const { response } = await adminGet("/admin/group/new");
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Add Group");
      expect(html).toContain("Group Name");
      expect(html).toContain("Slug");
      expect(html).toContain("Terms and Conditions");
    });
  });

  describe("POST /admin/group", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/group", { name: "X", slug: "x" }),
      );
      expectAdminRedirect(response);
    });

    test("returns 403 for non-owner", async () => {
      const cookie = await createManagerCookie("mgr-create-post");
      const csrfToken = await signCsrfToken();
      const response = await handleRequest(
        mockFormRequest("/admin/group", { name: "X", slug: "x", csrf_token: csrfToken }, cookie),
      );
      expectStatus(403)(response);
    });

    test("creates group and redirects", async () => {
      const group = await createTestGroup({
        name: "New Group",
        slug: "new-group",
        termsAndConditions: "Group terms",
      });
      expect(group.name).toBe("New Group");
      expect(group.slug).toBe("new-group");
      expect(group.terms_and_conditions).toBe("Group terms");
    });

    test("rejects duplicate slug", async () => {
      await createTestGroup({ name: "First", slug: "dupe" });
      const { response } = await adminFormPost("/admin/group", {
        name: "Second",
        slug: "dupe",
      });
      expectStatus(400)(response);
      const html = await response.text();
      expect(html).toContain("Slug is already in use");
    });

    test("rejects slug that collides with an event", async () => {
      const event = await createTestEvent({ name: "Collision Event" });
      const { response } = await adminFormPost("/admin/group", {
        name: "Colliding Group",
        slug: event.slug,
      });
      expectStatus(400)(response);
      const html = await response.text();
      expect(html).toContain("Slug is already in use");
    });

    test("rejects invalid slug", async () => {
      const { response } = await adminFormPost("/admin/group", {
        name: "Bad",
        slug: "invalid_slug!",
      });
      expectStatus(400)(response);
      const html = await response.text();
      expect(html).toContain("Slug may only contain lowercase letters, numbers, and hyphens");
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
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Edit Group");
      expect(html).toContain("Editable");
      expect(html).toContain("editable");
      expect(html).toContain("Original terms");
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/group/999/edit");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/group/:id/edit", () => {
    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({ name: "Edit Deny", slug: "edit-deny" });
      const cookie = await createManagerCookie("mgr-edit-post");
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
      expectStatus(400)(response);
      const html = await response.text();
      expect(html).toContain("Slug is already in use");
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
      const group = await createTestGroup({ name: "Delete Me", slug: "delete-me" });
      const { response } = await adminGet(`/admin/group/${group.id}/delete`);
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).toContain("Delete Group");
      expect(html).toContain("Events in this group will not be deleted");
      expect(html).toContain("confirm_identifier");
    });

    test("returns 404 for non-existent group", async () => {
      const { response } = await adminGet("/admin/group/999/delete");
      expectStatus(404)(response);
    });
  });

  describe("POST /admin/group/:id/delete", () => {
    test("returns 403 for non-owner", async () => {
      const group = await createTestGroup({ name: "Delete Deny", slug: "delete-deny" });
      const cookie = await createManagerCookie("mgr-delete-post");
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
      const group = await createTestGroup({ name: "Right Name", slug: "right-name" });
      const { response } = await adminFormPost(`/admin/group/${group.id}/delete`, {
        confirm_identifier: "Wrong Name",
      });
      expectStatus(400)(response);
      const html = await response.text();
      expect(html).toContain("Group name does not match");
    });

    test("deletes group, resets events to group_id=0, and does not delete events", async () => {
      const group = await createTestGroup({ name: "To Delete", slug: "to-delete" });
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
      const group = await createTestGroup({ name: "Race Group", slug: "race-group" });
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

  describe("nav link", () => {
    test("groups link visible to owners", async () => {
      const { response } = await adminGet("/admin/groups");
      const html = await response.text();
      expect(html).toContain("/admin/groups");
      expect(html).toContain("Groups");
    });

    test("groups link not visible to managers", async () => {
      const response = await awaitTestRequest("/admin/", {
        cookie: await createManagerCookie("mgr-groups-nav"),
      });
      expectStatus(200)(response);
      const html = await response.text();
      expect(html).not.toContain("/admin/groups");
    });
  });
});
