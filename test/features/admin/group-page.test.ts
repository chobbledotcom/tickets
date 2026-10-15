/**
 * The group record page: which tabs each role sees, and which actions the
 * Actions tab offers them. Every tab and action repeats the gate its target
 * route enforces, so a role never meets a link it cannot follow.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { awaitTestRequest, withStorageEnabled } from "#test-utils/mocks.ts";
import { adminGet, createTestEditorSession } from "#test-utils/session.ts";

/** One editor session, reused across the requests of a single test. */
const editorCookie = async (): Promise<string> =>
  (await createTestEditorSession()).cookie;

describeWithEnv("the group page", { db: true }, () => {
  test("opens on the overview and titles it with the group's name", async () => {
    const group = await createTestGroup({ name: "Summer Fete" });

    const response = await adminGet(`/admin/groups/${group.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    assertStringIncludes(html, "<h1>Summer Fete</h1>");
  });

  test("marks the groups list as the section it belongs to", async () => {
    const group = await createTestGroup({ name: "Section Test" });

    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    assertStringIncludes(html, `<a class="active" href="/admin/groups">`);
  });

  test("offers staff the export, bulk actions, and delete", async () => {
    const group = await createTestGroup({ name: "Full Actions" });

    const html = await (
      await adminGet(`/admin/groups/${group.id}/actions`)
    ).text();

    assertStringIncludes(html, `href="/admin/groups/${group.id}/export.json"`);
    assertStringIncludes(html, `href="/admin/groups/${group.id}/bulk-actions"`);
    assertStringIncludes(html, `href="/admin/groups/${group.id}/delete"`);
  });

  test("offers an editor the export alone", async () => {
    // Bulk actions and delete are staff-only routes, so an editor is shown
    // neither link rather than one that answers 403.
    const group = await createTestGroup({ name: "Editor Actions" });

    const cookie = await editorCookie();
    const html = await (
      await awaitTestRequest(`/admin/groups/${group.id}/actions`, { cookie })
    ).text();

    assertStringIncludes(html, `href="/admin/groups/${group.id}/export.json"`);
    assert(
      !html.includes(`href="/admin/groups/${group.id}/bulk-actions"`),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes(`href="/admin/groups/${group.id}/delete"`),
      "the value should not contain the searched item",
    );
  });

  test("opens an editor on edit and keeps the attendee tabs shut", async () => {
    // The overview and attendees tabs decrypt attendee details, so an editor
    // sees neither. Asking for one by name is a 404; asking for the page
    // itself lands them on the first tab they can see, which is Edit.
    const group = await createTestGroup({ name: "Hidden Tabs" });

    const cookie = await editorCookie();
    const page = await awaitTestRequest(`/admin/groups/${group.id}`, {
      cookie,
    });
    const attendees = await awaitTestRequest(
      `/admin/groups/${group.id}/attendees`,
      { cookie },
    );

    expect(page.status).toBe(200);
    assertStringIncludes(
      await page.text(),
      `<a aria-current="page" class="active" href="/admin/groups/${group.id}/edit">Edit</a>`,
    );
    expect(attendees.status).toBe(404);
  });

  test("names each tab by the path it opens", async () => {
    const group = await createTestGroup({ name: "Tab Paths" });

    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    assertStringIncludes(html, `href="/admin/groups/${group.id}">Overview</a>`);
    assertStringIncludes(
      html,
      `href="/admin/groups/${group.id}/attendees">Attendees</a>`,
    );
    assertStringIncludes(
      html,
      `href="/admin/groups/${group.id}/scanner">Scanner</a>`,
    );
    assertStringIncludes(
      html,
      `href="/admin/groups/${group.id}/edit">Edit</a>`,
    );
    assertStringIncludes(
      html,
      `href="/admin/groups/${group.id}/actions">Actions</a>`,
    );
  });

  test("keeps an editor off the scanner tab", async () => {
    // The scanner route is staff-only, so an editor is shown no tab for it
    // rather than one that answers 403.
    const group = await createTestGroup({ name: "Editor Scans" });

    const html = await (
      await awaitTestRequest(`/admin/groups/${group.id}`, {
        cookie: await editorCookie(),
      })
    ).text();

    assert(
      !html.includes("/scanner"),
      "the value should not contain the searched item",
    );
  });

  test("adds the images tab once a storage zone is configured", async () => {
    // The tab is hidden without one, because the page behind it cannot store
    // an upload.
    const group = await createTestGroup({ name: "Has Images" });

    const withoutStorage = await (
      await adminGet(`/admin/groups/${group.id}`)
    ).text();
    const withStorage = await withStorageEnabled(async () =>
      (await adminGet(`/admin/groups/${group.id}`)).text(),
    );

    assert(
      !withoutStorage.includes(`href="/admin/groups/${group.id}/images"`),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      withStorage,
      `href="/admin/groups/${group.id}/images">Images</a>`,
    );
  });

  test("keeps the delete apart, in the danger zone", async () => {
    const group = await createTestGroup({ name: "Danger Zone" });

    const html = await (
      await adminGet(`/admin/groups/${group.id}/actions`)
    ).text();
    const [beforeZone, insideZone] = html.split('class="entity-danger-zone"');

    assertStringIncludes(
      beforeZone ?? "",
      `href="/admin/groups/${group.id}/export.json"`,
    );
    assert(
      beforeZone !== undefined &&
        !beforeZone.includes(`href="/admin/groups/${group.id}/delete"`),
      "the value should not contain the searched item",
    );
    assertStringIncludes(
      insideZone ?? "",
      `href="/admin/groups/${group.id}/delete"`,
    );
  });

  test("keeps a hidden member in the roster while its group withholds the public share links", async () => {
    // The group opted out of hidden listings and has no public tier, so its
    // public page 404s — the overview must not offer a dead share link, but
    // the roster still names the hidden member for the operator.
    const group = await createTestGroup({
      name: "Fan Club",
      showHiddenListings: false,
    });
    await createTestListing({
      groupId: group.id,
      hidden: true,
      name: "Fan Club Tier",
    });

    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    assertStringIncludes(html, "Fan Club Tier");
    assert(
      !html.includes(`href="/ticket/${group.slug}"`),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "404s");
  });

  test("answers 404 for a group that is not there", async () => {
    expect((await adminGet("/admin/groups/99999")).status).toBe(404);
  });
});
