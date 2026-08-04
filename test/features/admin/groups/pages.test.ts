/** The admin group pages, and the routes that create, delete and illustrate a
 * group. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { deleteGroup } from "#routes/admin/groups.ts";
import { queryAll } from "#shared/db/client.ts";
import { groups, listingGroups } from "#shared/db/groups.ts";
import {
  imageNamesForItem,
  makeImage,
  postImageUpload,
} from "#test-utils/admin-images.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withStorageMock } from "#test-utils/mocks.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";
import { adminPost } from "./helpers.ts";

describeWithEnv("admin group pages", { db: true }, () => {
  test("lists every group", async () => {
    const group = await createTestGroup({ name: "Listed group" });

    const response = await adminGet("/admin/groups");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(group.name);
  });

  test("offers a form for a new group", async () => {
    const response = await adminGet("/admin/groups/new");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="name"');
  });

  test("opens a group's own page", async () => {
    const group = await createTestGroup({ name: "Opened group" });

    const response = await adminGet(`/admin/groups/${group.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(group.name);
  });

  test("sends the operator to the new group's page after creating it", async () => {
    const response = await adminPost("/admin/groups", {
      description: "",
      max_attendees: "0",
      name: "Created group",
      terms_and_conditions: "",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups\/\d+/);
    expect(parseFlashCookie(response).success).toContain("Group");
  });

  test("sends the operator back to the group list after deleting one", async () => {
    const group = await createTestGroup({ name: "Deleted group" });

    const response = await adminPost(`/admin/groups/${group.id}/delete`, {
      confirm_identifier: group.name,
    });
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups(\?|$)/);
    expect(parseFlashCookie(response).success).toContain("Group");
  });

  test("adds an uploaded image to the group", async () => {
    const group = await createTestGroup({ name: "Illustrated group" });
    const session = await getTestSession();

    await withStorageMock(async () => {
      const response = await postImageUpload(
        `/admin/groups/${group.id}/images/upload`,
        session.cookie,
        session.csrfToken,
        "Group photo",
      );
      expect(response.status).toBe(302);
    });
    expect(await imageNamesForItem("group", group.id)).toEqual(["Group photo"]);
  });

  test("links a library image to the group", async () => {
    const group = await createTestGroup({ name: "Linked group" });
    const image = await makeImage("Library shot");

    await withStorageMock(async () => {
      const response = await adminPost(`/admin/groups/${group.id}/images`, {
        image_ids: [String(image.id)],
      });
      expect(response.status).toBe(302);
    });
    expect(await imageNamesForItem("group", group.id)).toEqual([
      "Library shot",
    ]);
  });

  test("deletes a group and frees its listings", async () => {
    const group = await createTestGroup({ name: "Doomed group" });
    const listing = await createTestListing({
      groupId: group.id,
      name: "Freed listing",
    });

    await deleteGroup(group.id);
    groups.cache.invalidate();
    expect(
      await queryAll(
        "SELECT groupRecord.id FROM groups AS groupRecord WHERE groupRecord.id = ?",
        [group.id],
      ),
    ).toEqual([]);
    expect(await listingGroups.getIds(listing.id)).toEqual([]);
  });
});
