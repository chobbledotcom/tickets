/**
 * The link to a listing's admin page, and the data-page opener that the
 * backup and update dashboards share.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  adminListingLink,
  flashDataPage,
} from "#templates/admin/admin-page.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

describe("the link to a listing's admin page", () => {
  beforeAll(setupAdminPageTest);

  test("names the listing and points at its own page", () => {
    const html = String(adminListingLink({ id: 12, name: "Gala Night" }));

    expect(html).toBe('<a href="/admin/listing/12">Gala Night</a>');
  });
});

describe("the data-page opener the backup and update dashboards share", () => {
  beforeAll(setupAdminPageTest);

  const opener = (active: string | undefined) =>
    flashDataPage<{ note: string }>("backup.page_title", active, ({ note }) => (
      <p>{note}</p>
    ));

  test("marks the nav section the caller names, and renders the body and notices", () => {
    const html = opener("/admin/backup")(
      OWNER_SESSION,
      { note: "Snapshot" },
      "Restore failed",
      "Backup saved",
    );

    expectIncludesAll(html, [
      "<title>Database backup</title>",
      'class="active" href="/admin/backup"',
      "<p>Snapshot</p>",
      "Restore failed",
      "Backup saved",
    ]);
    expect(html.indexOf("Restore failed")).toBeLessThan(
      html.indexOf("<p>Snapshot</p>"),
    );
  });

  test("falls back to the settings section when the caller names none", () => {
    const html = opener(undefined)(OWNER_SESSION, { note: "Snapshot" });

    assertStringIncludes(html, 'class="active" href="/admin/settings"');
    assert(!html.includes('class="active" href="/admin/backup"'));
    assertStringIncludes(html, "<p>Snapshot</p>");
  });
});
