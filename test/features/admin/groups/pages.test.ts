/** The admin group pages, and the routes that create and delete a group. The
 * image routes are in item-images.test.ts. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import { groups } from "#db/groups.ts";
import { createOwnerNote, getNoteRows } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { deleteGroup } from "#shared/records/groups.ts";
import { parseFlashCookie } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createGroupWithListings,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

describeWithEnv("admin group pages", { db: true }, () => {
  test("lists every group", async () => {
    const group = await createTestGroup({ name: "Listed group" });

    const response = await adminGet("/admin/groups");
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), group.name);
  });

  test("offers a form for a new group", async () => {
    const response = await adminGet("/admin/groups/new");

    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), 'name="name"');
  });

  test("opens a group's own page", async () => {
    const group = await createTestGroup({ name: "Opened group" });

    const response = await adminGet(`/admin/groups/${group.id}`);
    expect(response.status).toBe(200);
    assertStringIncludes(await response.text(), group.name);
  });

  test("sends the operator to the new group's page after creating it", async () => {
    const { response } = await adminFormPost("/admin/groups", {
      description: "",
      max_attendees: "0",
      name: "Created group",
      terms_and_conditions: "",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups\/\d+/);
    assertStringIncludes(parseFlashCookie(response).success ?? "", "Group");
  });

  test("sends the operator back to the group list after deleting one", async () => {
    const group = await createTestGroup({ name: "Deleted group" });

    const { response } = await adminFormPost(
      `/admin/groups/${group.id}/delete`,
      {
        confirm_identifier: group.name,
      },
    );
    expect(response.headers.get("location")).toMatch(/^\/admin\/groups(\?|$)/);
    assertStringIncludes(parseFlashCookie(response).success ?? "", "Group");
  });

  test("deletes a group and frees its listings", async () => {
    const {
      group,
      listings: [listing],
    } = await createGroupWithListings("Doomed group", ["Freed listing"]);
    // The group carries a note; deleting the group must clear it with it.
    await createOwnerNote(
      noteTargets.of("group")(group.id),
      "a note on this group",
    );

    await deleteGroup(group.id);
    groups.cache.invalidate();
    expect(
      await queryAll(
        "SELECT groupRecord.id FROM groups AS groupRecord WHERE groupRecord.id = ?",
        [group.id],
      ),
    ).toEqual([]);
    expect(await listingGroups.getIds(listing!.id)).toEqual([]);
    expect(await getNoteRows("group", [group.id])).toEqual([]);
  });
});
