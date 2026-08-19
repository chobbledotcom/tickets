/**
 * The group record page: which tabs each role sees, and which actions the
 * Actions tab offers them. Every tab and action repeats the gate its target
 * route enforces, so a role never meets a link it cannot follow.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
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
    expect(html).toContain("<h1>Summer Fete</h1>");
  });

  test("marks the groups list as the section it belongs to", async () => {
    const group = await createTestGroup({ name: "Section Test" });

    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    expect(html).toContain(`<a class="active" href="/admin/groups">`);
  });

  test("offers staff the export, bulk actions, and delete", async () => {
    const group = await createTestGroup({ name: "Full Actions" });

    const html = await (
      await adminGet(`/admin/groups/${group.id}/actions`)
    ).text();

    expect(html).toContain(`href="/admin/groups/${group.id}/export.json"`);
    expect(html).toContain(`href="/admin/groups/${group.id}/bulk-actions"`);
    expect(html).toContain(`href="/admin/groups/${group.id}/delete"`);
  });

  test("offers an editor the export alone", async () => {
    // Bulk actions and delete are staff-only routes, so an editor is shown
    // neither link rather than one that answers 403.
    const group = await createTestGroup({ name: "Editor Actions" });

    const cookie = await editorCookie();
    const html = await (
      await awaitTestRequest(`/admin/groups/${group.id}/actions`, { cookie })
    ).text();

    expect(html).toContain(`href="/admin/groups/${group.id}/export.json"`);
    expect(html).not.toContain(`href="/admin/groups/${group.id}/bulk-actions"`);
    expect(html).not.toContain(`href="/admin/groups/${group.id}/delete"`);
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
    expect(await page.text()).toContain(
      `<a aria-current="page" class="active" href="/admin/groups/${group.id}/edit">Edit</a>`,
    );
    expect(attendees.status).toBe(404);
  });

  test("names each tab by the path it opens", async () => {
    const group = await createTestGroup({ name: "Tab Paths" });

    const html = await (await adminGet(`/admin/groups/${group.id}`)).text();

    expect(html).toContain(`href="/admin/groups/${group.id}">Overview</a>`);
    expect(html).toContain(
      `href="/admin/groups/${group.id}/attendees">Attendees</a>`,
    );
    expect(html).toContain(`href="/admin/groups/${group.id}/edit">Edit</a>`);
    expect(html).toContain(
      `href="/admin/groups/${group.id}/actions">Actions</a>`,
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

    expect(withoutStorage).not.toContain(
      `href="/admin/groups/${group.id}/images"`,
    );
    expect(withStorage).toContain(
      `href="/admin/groups/${group.id}/images">Images</a>`,
    );
  });

  test("keeps the delete apart, in the danger zone", async () => {
    const group = await createTestGroup({ name: "Danger Zone" });

    const html = await (
      await adminGet(`/admin/groups/${group.id}/actions`)
    ).text();
    const [beforeZone, insideZone] = html.split('class="entity-danger-zone"');

    expect(beforeZone).toContain(
      `href="/admin/groups/${group.id}/export.json"`,
    );
    expect(beforeZone).not.toContain(`href="/admin/groups/${group.id}/delete"`);
    expect(insideZone).toContain(`href="/admin/groups/${group.id}/delete"`);
  });

  test("answers 404 for a group that is not there", async () => {
    expect((await adminGet("/admin/groups/99999")).status).toBe(404);
  });
});
