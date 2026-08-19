/**
 * The site-page record page: the shared Site-content tabs with the contents
 * manager slotted in. The POST sub-actions live in site-pages.ts, so these ask
 * what the GET surface shows.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSitePage } from "#test-utils/db-helpers/misc.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("the site page's page", { db: true }, () => {
  test("opens on the edit form for the page named in the path", async () => {
    const page = await createTestSitePage("about", { name: "About us" });

    const response = await adminGet(`/admin/site/pages/${page.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`action="/admin/site/pages/${page.id}/edit"`);
    expect(html).toContain("About us");
    expect(html).toContain('href="/admin/guide#public-site"');
  });

  test("titles the page with the page's own name", async () => {
    const page = await createTestSitePage("contact", { name: "Find us" });

    const html = await (await adminGet(`/admin/site/pages/${page.id}`)).text();

    expect(html).toContain("<h1>Find us</h1>");
  });

  test("carries the contents manager as its own tab", async () => {
    // A site page is built from items, so the manager sits beside Edit rather
    // than inside it.
    const page = await createTestSitePage("home", { name: "Home" });

    const strip = await (await adminGet(`/admin/site/pages/${page.id}`)).text();
    const response = await adminGet(`/admin/site/pages/${page.id}/items`);

    expect(strip).toContain(`href="/admin/site/pages/${page.id}/items"`);
    expect(response.status).toBe(200);
  });

  test("offers deleting the page on its actions tab", async () => {
    const page = await createTestSitePage("spare", { name: "Spare" });

    const response = await adminGet(`/admin/site/pages/${page.id}/actions`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`href="/admin/site/pages/${page.id}/delete"`);
  });

  test("answers 404 for a page that is not there", async () => {
    expect((await adminGet("/admin/site/pages/99999")).status).toBe(404);
  });
});
