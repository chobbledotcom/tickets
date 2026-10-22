// jscpd:ignore-start
import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { executeWithoutCacheInvalidation, getDb } from "#db/client.ts";
import { bumpSettingsVersion } from "#db/settings/cache.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

const footerTag = `<footer class="site-footer">`;

const footerCount = (html: string): number => html.split(footerTag).length - 1;

/** Record every statement the client runs, passing each through to the real
 * client. Restore the client before reading the list back. */
const withRecordedSql = async (
  run: () => Promise<unknown>,
): Promise<string[]> => {
  const db = getDb();
  const realExecute = db.execute.bind(db);
  const sqls: string[] = [];
  const executeStub = stub(db, "execute", (stmt: InStatement) => {
    sqls.push(typeof stmt === "string" ? stmt : stmt.sql);
    return realExecute(stmt);
  });
  try {
    await run();
  } finally {
    executeStub.restore();
  }
  return sqls;
};

/** Reject the images-table reads, so a footer lookup fails for real. */
const failImageReads = (): Stub => {
  const db = getDb();
  const realExecute = db.execute.bind(db);
  return stub(db, "execute", (stmt: InStatement) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    return sql.includes("FROM images")
      ? Promise.reject(new Error("images table unavailable"))
      : realExecute(stmt);
  });
};

describeWithEnv("site footer", { db: true, triggers: true }, () => {
  test("renders nothing when the footer is empty", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("");

    const home = await assertPublicHtml("/");
    expect(home).not.toContain(footerTag);
    const listings = await assertPublicHtml("/listings");
    expect(listings).not.toContain(footerTag);
  });

  test("renders the footer once, at the bottom of the home page and the listings page", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("**Thanks for visiting!**");

    for (const path of ["/", "/listings"]) {
      const html = await assertPublicHtml(
        path,
        "<strong>Thanks for visiting!</strong>",
      );
      expect(footerCount(html)).toBe(1);
      // The footer sits at the bottom of the layout, after the page content.
      expect(html.indexOf(footerTag)).toBeGreaterThan(
        html.lastIndexOf("</main>"),
      );
    }
  });

  test("strips script and HTML from the footer", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("<script>alert(1)</script>\n\n**Bold**");

    const html = await assertPublicHtml(
      "/listings",
      "&lt;script&gt;alert(1)&lt;/script&gt;",
      "<strong>Bold</strong>",
    );
    expect(html).not.toContain("<script>alert(1)");
  });

  test("keeps the footer off an embedded page", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("A visitor-facing note.");

    const embedded = await assertPublicHtml("/listings?iframe=true");
    expect(embedded).not.toContain(footerTag);
    const page = await assertPublicHtml("/listings");
    expect(page).toContain(footerTag);
  });

  test("keeps the footer off admin pages", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("**Admin pages must not show this**");

    const admin = await adminGet("/admin/settings");
    const html = await expectHtmlResponse(admin, 200);
    expect(html).not.toContain(footerTag);
    // The settings form shows the raw text for editing; the page must not
    // render it as markdown.
    expect(html).not.toContain(
      "<strong>Admin pages must not show this</strong>",
    );
  });

  test("the footer's img#N reference resolves on the pages that render it", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterPoster");
    await settings.update.siteFooter(
      `Thanks for coming.![FooterPoster](img#${image.id})`,
    );
    for (const path of ["/", "/listings"]) {
      const html = await assertPublicHtml(
        path,
        `<img src="/image/${image.filename}" alt="FooterPoster">`,
      );
      expect(html).not.toContain("img#");
    }
  });

  test("the footer's img#N reference resolves on the not-found pages too", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterNotFound");
    await settings.update.siteFooter(
      `See you there.![FooterNotFound](img#${image.id})`,
    );
    // Every 404 renders the site footer, so each not-found surface resolves
    // the footer's images exactly like the rendered pages do: a missing
    // ticket, a missing site page, an empty news list, empty terms, and the
    // contact page with neither text nor a form.
    await settings.update.terms("");
    await settings.update.contactPageText("");
    await settings.update.contactFormEnabled(false);
    for (const path of [
      "/t/not-a-real-token",
      "/page/no-such-page",
      "/news",
      "/terms",
      "/contact",
    ]) {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest(path)),
        404,
        `<img src="/image/${image.filename}" alt="FooterNotFound">`,
      );
      expect(html).not.toContain("img#");
    }
  });

  test("a page render runs the footer's images lookup through the recorder", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterQuery");
    await settings.update.siteFooter(
      `Visit us.![FooterQuery](img#${image.id})`,
    );
    const sqls = await withRecordedSql(() => assertPublicHtml("/"));
    // The resolution test above proves the page consumed the lookup; this one
    // proves the recorder sees the images read that the tests below exclude.
    expect(sqls.some((sql) => sql.includes("FROM images"))).toBe(true);
  });

  test("a warm render re-serves the cold lookup until a settings write", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterMemo");
    const footerText = `Thanks for coming.![FooterMemo](img#${image.id})`;
    await settings.update.siteFooter(footerText);
    const footerRegionOf = (html: string): string =>
      html.slice(html.indexOf(footerTag), html.indexOf("</footer>"));

    let coldHtml = "";
    const coldSqls = await withRecordedSql(async () => {
      coldHtml = await assertPublicHtml("/");
    });
    expect(coldSqls.filter((sql) => sql.includes("FROM images")).length).toBe(
      1,
    );

    let warmHtml = "";
    const warmSqls = await withRecordedSql(async () => {
      warmHtml = await assertPublicHtml("/");
    });
    expect(warmSqls.some((sql) => sql.includes("FROM images"))).toBe(false);
    // The warm render serves the cold lookup's own table, so the footer is
    // byte-identical and the picture keeps its own address.
    expect(footerRegionOf(warmHtml)).toBe(footerRegionOf(coldHtml));
    expect(warmHtml).toContain(`<img src="/image/${image.filename}"`);

    // A settings write moves the version, so the next render re-queries.
    await settings.update.siteFooter(footerText);
    let rewrittenHtml = "";
    const rewrittenSqls = await withRecordedSql(async () => {
      rewrittenHtml = await assertPublicHtml("/");
    });
    expect(
      rewrittenSqls.filter((sql) => sql.includes("FROM images")).length,
    ).toBe(1);
    expect(rewrittenHtml).toContain(
      `<img src="/image/${image.filename}" alt="FooterMemo">`,
    );
  });

  test("a picture another isolate removes leaves the warm footer", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterOtherIsolate");
    await settings.update.siteFooter(
      `Thanks for coming.![FooterOtherIsolate](img#${image.id})`,
    );

    const coldSqls = await withRecordedSql(async () => {
      await assertPublicHtml("/", `<img src="/image/${image.filename}"`);
    });
    expect(coldSqls.filter((sql) => sql.includes("FROM images")).length).toBe(
      1,
    );

    // The warm render re-serves the cold lookup, so it runs no images query.
    const warmSqls = await withRecordedSql(async () => {
      await assertPublicHtml("/");
    });
    expect(warmSqls.some((sql) => sql.includes("FROM images"))).toBe(false);

    // Another warm isolate commits the removal: the row leaves the images
    // table and the shared version moves there. This isolate's invalidation
    // callbacks never run, so the version is the only signal the memo reads.
    await executeWithoutCacheInvalidation(
      "DELETE FROM image_uses WHERE image_id = ?",
      [image.id],
    );
    await executeWithoutCacheInvalidation("DELETE FROM images WHERE id = ?", [
      image.id,
    ]);
    await bumpSettingsVersion();

    const afterSqls = await withRecordedSql(async () => {
      const html = await assertPublicHtml("/");
      expect(html).not.toContain(`<img src="/image/${image.filename}"`);
      expect(html).toContain('<img src="" alt="FooterOtherIsolate">');
    });
    expect(afterSqls.filter((sql) => sql.includes("FROM images")).length).toBe(
      1,
    );
  });

  test("a failed footer image lookup renders the footer without its images", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterFallback");
    await settings.update.siteFooter(
      `Thanks.![FooterFallback](img#${image.id})`,
    );
    using _failedImages = failImageReads();
    await assertPublicHtml("/", "Thanks.", '<img src="" alt="FooterFallback">');
    // The not-found page runs the same guarded lookup, so a failed read
    // leaves its footer intact too.
    await expectHtmlResponse(
      await handleRequest(mockRequest("/page/no-such-page")),
      404,
      '<img src="" alt="FooterFallback">',
    );
  });

  test("requests that never render the footer run no images lookup", async () => {
    await enablePublicSite();
    await settings.update.orderEnabled(true);
    const image = await makeImage("FooterQuiet");
    await settings.update.siteFooter(`Note.![FooterQuiet](img#${image.id})`);
    const listing = await createTestListing({ name: "Quiet Item" });
    const sqls = await withRecordedSql(async () => {
      // A stylesheet, a JSON evaluation, the gallery's redirect, and an
      // embedded page all skip the footer render, so none of them may pay
      // the footer's read.
      expectStatus(200)(await handleRequest(mockRequest("/custom.css")));
      expectStatus(200)(
        await handleRequest(
          mockRequest(`/order/availability?select_${listing.id}=1`),
        ),
      );
      expectRedirect(
        await handleRequest(mockRequest(`/order?select_${listing.id}=1`)),
        /^\/ticket\//,
      );
      const embedded = await assertPublicHtml("/listings?iframe=true");
      expect(embedded).not.toContain(footerTag);
    });
    // The requests ran real reads, so an empty recording would prove nothing.
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((sql) => sql.includes("FROM images"))).toBe(false);
  });
});
