import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { hmacHash } from "#crypto/hashing.ts";
import { getSitePageById, getSitePageBySlugIndex } from "#db/site-pages.ts";
import { wasActivityLogged as wasLogged } from "#test-utils/activity-log.ts";
import {
  expectErrorFlash,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("edit + update", () => {
    test("GET edit 404s for a missing page", async () => {
      expect((await adminGet(`${BASE}/9999/edit`)).status).toBe(404);
    });

    test("the edit tab renders the form, editable slug, public link, and tab strip", async () => {
      await create("editme");
      const page = await findPage("editme");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/edit`),
        200,
      );
      // The page's own name is the heading; the form carries the editable slug.
      expect(html).toContain(`<h1>${page.name}</h1>`);
      expect(html).toContain('name="slug"');
      expect(html).toContain(`value="${page.slug}"`);
      // The public link sits under the slug field, opening in a new tab.
      expect(html).toContain(
        `Public link: <a href="/page/${page.slug}" rel="noopener" target="_blank">/page/${page.slug}</a>`,
      );
      // A guide footer sits at the bottom of the body.
      expect(html).toContain('class="guide-footer"');
      expect(html).toContain('href="/admin/guide#public-site"');
      // The tabbed strip carries Edit, Items and Actions (Images hidden while
      // storage is off). The item manager lives on the Items tab, not here.
      expect(html).toContain('class="entity-tabs"');
      expect(html).toContain(`href="${BASE}/${page.id}/items"`);
      expect(html).toContain(`href="${BASE}/${page.id}/actions"`);
      expect(html).not.toContain("Add to this page");
    });

    test("the items tab renders the add-item manager when something can be added", async () => {
      await create("itemtab");
      const page = await findPage("itemtab");
      await createTestListing({ name: "Addable" });
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      expect(html).toContain("Add to this page");
      expect(html).toContain(">Addable<");
    });

    test("the items tab hides the add section (and any 'nothing available') when nothing can be added", async () => {
      await create("emptytab");
      const page = await findPage("emptytab");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/items`),
        200,
      );
      // No listings/groups/sub-pages to offer, so the whole add section — and
      // the old confusing "nothing available" line — is gone.
      expect(html).not.toContain("Add to this page");
      expect(html).not.toContain("nothing available");
      // The page still shows its empty-contents message.
      expect(html).toContain(
        "This page has no listings, groups, or sub-pages yet.",
      );
    });

    test("a bare /:id lands on the edit tab", async () => {
      await create("bare");
      const page = await findPage("bare");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}`),
        200,
      );
      expect(html).toContain(`<h1>${page.name}</h1>`);
      expect(html).toContain('name="slug"');
    });

    test("an image POST with storage disabled bounces to the edit tab, not the hidden images tab", async () => {
      await create("storage-off");
      const page = await findPage("storage-off");
      const { response } = await adminFormPost(`${BASE}/${page.id}/images`, {
        image_ids: "1",
      });
      expectRedirect(response, new RegExp(`^${BASE}/${page.id}/edit`));
      expectFlash(response, "File storage is not configured.", false);
    });

    test("an upload POST with storage disabled bounces to the edit tab too", async () => {
      await create("upload-off");
      const page = await findPage("upload-off");
      const { response } = await adminFormPost(
        `${BASE}/${page.id}/images/upload`,
        { image: "not-a-file" },
      );
      expectRedirect(response, new RegExp(`^${BASE}/${page.id}/edit`));
      expectFlash(response, "File storage is not configured.", false);
    });

    test("updates a page's fields", async () => {
      await create("orig");
      const page = await findPage("orig");
      const { response } = await adminFormPost(`${BASE}/${page.id}/edit`, {
        name: "Renamed",
        slug: "renamed",
      });
      expectRedirect(response);
      expectFlash(response, "Page updated", true);
      expect((await getSitePageById(page.id))?.name).toBe("Renamed");
      expect(await wasLogged("Page 'Renamed' updated")).toBe(true);
      // The blind index is recomputed, so the new slug is findable and the old
      // one is freed (both key off slug_index).
      const byNew = await getSitePageBySlugIndex(await hmacHash("renamed"));
      expect(byNew?.id).toBe(page.id);
      const byOld = await getSitePageBySlugIndex(await hmacHash("orig"));
      expect(byOld).toBeNull();
    });

    test("update rejects a slug taken by another page", async () => {
      await create("keep-a");
      await create("keep-b");
      const b = await findPage("keep-b");
      const { response } = await adminFormPost(`${BASE}/${b.id}/edit`, {
        name: "B",
        slug: "keep-a",
      });
      expectErrorFlash(response, "already in use by a listing, group, or page");
      expect((await getSitePageById(b.id))?.slug).toBe("keep-b");
    });

    test("update rejects a reserved slug", async () => {
      await create("keep-reserved");
      const page = await findPage("keep-reserved");
      const { response } = await adminFormPost(`${BASE}/${page.id}/edit`, {
        name: "Still here",
        slug: "contact",
      });
      expectErrorFlash(response, "reserved");
      expect((await getSitePageById(page.id))?.slug).toBe("keep-reserved");
    });

    test("update rejects a missing name and changes nothing", async () => {
      await create("unchanged");
      const page = await findPage("unchanged");
      const { response } = await adminFormPost(`${BASE}/${page.id}/edit`, {
        name: "",
        slug: "changed",
      });
      expectErrorFlash(response, "Page Name is required");
      const unchanged = await getSitePageById(page.id);
      expect(unchanged?.name).toBe("Name unchanged");
      expect(unchanged?.slug).toBe("unchanged");
    });

    test("update 404s for a missing page", async () => {
      const { response } = await adminFormPost(`${BASE}/9999/edit`, {
        name: "X",
        slug: "x",
      });
      expect(response.status).toBe(404);
    });
  });
});
