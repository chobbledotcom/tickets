/**
 * The Public URL rows on the overview tabs of the listing and group pages.
 * The tabs that carry the rows are staff-only, so the roles that see a row
 * are exactly the staff roles — and the editor, who lands on no such tab,
 * never sees one of the section's controls.
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

/** Staff see the rows; the editor is the content role that sees no tab. */
const STAFF_ROLES: [AdminLevel, string][] = [
  ["owner", "urlrowowner"],
  ["manager", "urlrowmanager"],
];

const get = (path: string, session: { cookie: string; csrfToken: string }) =>
  handleRequest(requestAsSession(path, session));

describeWithEnv("the Public URL rows", { db: true }, () => {
  for (const [role, name] of STAFF_ROLES) {
    test(`${role} sees the row with its Embed toggle on the group and listing pages`, async () => {
      const { group } = await createGroupWithListings(`url row ${role}`, [
        `url row ${role} listing`,
      ]);
      const listing = await createTestListing({
        name: `url row ${role} page`,
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
        // Embed opens the page's own embed code rows, so it is a label for
        // the hidden toggle, not a link into the guide.
        expect(html).toContain(
          '<label class="small-action" for="embed-toggle-',
        );
        expect(html).not.toContain('href="/admin/guide#embed_booking_form"');
      }
    });
  }

  test("the editor never sees a Public URL row", async () => {
    // The overview tabs that carry the rows are staff-only, so an editor
    // lands on a tab without them.
    const editor = await sessionAs("editor", "urlroweditor");
    const { group } = await createGroupWithListings("url row editor", [
      "url row editor listing",
    ]);
    const listing = await createTestListing({ name: "url row editor b" });
    for (const path of [
      `/admin/groups/${group.id}`,
      `/admin/listing/${listing.id}`,
    ]) {
      const response = await get(path, editor);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).not.toContain("data-share-url");
      expect(html).not.toContain("embed-toggle-");
    }
  });
});
