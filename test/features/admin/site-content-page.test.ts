/**
 * The Site content page shell: Edit, any extra tabs, Images, then Actions.
 * News and Site pages are both built from it, so this drives the shell itself
 * with a stand-in record rather than one of them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { panelTab } from "#routes/admin/entity-write-tab.ts";
import { defineSiteContentPage } from "#routes/admin/site-content-page.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupTestEncryptionKey } from "#test-utils/env.ts";
import { getTestAuthSession } from "#test-utils/session.ts";

type Leaflet = { id: number; name: string };

const LEAFLET: Leaflet = { id: 3, name: "Opening times" };

const page = defineSiteContentPage<Leaflet>({
  deleteLabelKey: "site.pages.delete_submit",
  destination: "sitePage",
  editPanel: (leaflet) => Raw({ html: `<p>Edit ${leaflet.name}</p>` }),
  extraTabs: [
    panelTab<Leaflet>("items", "entity.tab.items", () =>
      Promise.resolve(Raw({ html: "<p>Items</p>" })),
    ),
  ],
  guideAnchor: "public-site",
  itemType: "page",
  load: (id) => Promise.resolve(id === 404 ? null : LEAFLET),
  navActive: "/admin/site/pages",
  titleOf: (leaflet) => leaflet.name,
});

describeWithEnv("a site content page", { db: true }, () => {
  test("opens on the edit tab and titles itself with the record", async () => {
    setupTestEncryptionKey();
    const session = await getTestAuthSession();

    const response = await page.renderPage(session, 3, "");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Opening times</h1>");
    expect(html).toContain("<p>Edit Opening times</p>");
  });

  test("puts the extra tabs between edit and actions", async () => {
    const session = await getTestAuthSession();

    const html = await (await page.renderPage(session, 3, "")).text();
    const order = ["/edit", "/items", "/actions"].map((slug) =>
      html.indexOf(`href="/admin/site/pages/3${slug}"`),
    );

    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("leaves out the images tab when no storage is configured", async () => {
    // The tab would open a picture manager with nowhere to put pictures.
    const session = await getTestAuthSession();

    const html = await (await page.renderPage(session, 3, "")).text();

    expect(html).not.toContain('href="/admin/site/pages/3/images"');
  });

  test("links the guide section the page belongs to", async () => {
    const session = await getTestAuthSession();

    const html = await (await page.renderPage(session, 3, "")).text();

    expect(html).toContain('href="/admin/guide#public-site"');
  });

  test("offers deleting the record on the actions tab", async () => {
    const session = await getTestAuthSession();

    const html = await (await page.renderPage(session, 3, "actions")).text();

    expect(html).toContain('href="/admin/site/pages/3/delete"');
  });

  test("answers 404 for a record that is not there", async () => {
    const session = await getTestAuthSession();

    expect((await page.renderPage(session, 404, "")).status).toBe(404);
  });
});
