/**
 * The share row's Embed link and the guide page it names. The link must never
 * be dead or forbidden. The share rows render on the overview tabs of the
 * listing and group pages, and both tabs are staff-only, so the roles that
 * see a row are exactly the staff roles — and the guide's route opens for
 * staff. An editor, who the guide refuses, lands on a tab that carries no
 * share row, so no role ever sees a link it cannot follow.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createGroupWithListings } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createKeyedRoleSession } from "#test-utils/role-sessions.ts";
import { requestAsSession } from "#test-utils/session.ts";
import type { AdminLevel } from "#types";

/** A logged-in session for one admin role, as the login flow would hand it
 * out (the login lookup hashes usernames lower-cased). */
const sessionAs = async (
  role: AdminLevel,
  name: string,
): Promise<{ cookie: string; csrfToken: string }> => {
  const { cookie } = await createKeyedRoleSession(role, {
    csrfToken: `${name}-csrf`,
    token: `${name}-session`,
    username: name,
  });
  return { cookie, csrfToken: `${name}-csrf` };
};

/** Staff see the rows; the editor is the content role the guide refuses. */
const STAFF_ROLES: [AdminLevel, string][] = [
  ["owner", "shareowner"],
  ["manager", "sharemanager"],
];

const get = (path: string, session: { cookie: string; csrfToken: string }) =>
  handleRequest(requestAsSession(path, session));

describeWithEnv("the share row's Embed link", { db: true }, () => {
  for (const [role, name] of STAFF_ROLES) {
    test(`${role} sees the share row with its Embed link on the group and listing pages`, async () => {
      const { group } = await createGroupWithListings(`share row ${role}`, [
        `share row ${role} listing`,
      ]);
      const listing = await createTestListing({
        name: `share row ${role} page`,
      });
      const session = await sessionAs(role, name);
      for (const path of [
        `/admin/groups/${group.id}`,
        `/admin/listing/${listing.id}`,
      ]) {
        const response = await get(path, session);
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("data-share-url");
        expect(html).toContain('href="/admin/guide#embed_booking_form"');
      }
    });

    test(`${role} opens the guide at the embed answer`, async () => {
      const session = await sessionAs(role, name);
      const response = await get("/admin/guide", session);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('id="embed_booking_form"');
    });
  }

  test("the editor the guide refuses never sees a share row", async () => {
    // The overview tabs that carry the rows are staff-only, so an editor
    // lands on a tab without them: no share row, and no link into the
    // guide that would answer 403.
    const editor = await sessionAs("editor", "shareeditor");
    const { group } = await createGroupWithListings("share row editor", [
      "share row editor listing",
    ]);
    const listing = await createTestListing({ name: "share row editor b" });
    for (const path of [
      `/admin/groups/${group.id}`,
      `/admin/listing/${listing.id}`,
    ]) {
      const response = await get(path, editor);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("data-share-url");
      expect(html).not.toContain("/admin/guide");
    }
    const guide = await get("/admin/guide", editor);
    expect(guide.status).toBe(403);
  });
});
