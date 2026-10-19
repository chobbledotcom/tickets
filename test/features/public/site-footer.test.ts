// jscpd:ignore-start
import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { type Stub, stub } from "@std/testing/mock";
import { getDb } from "#db/client.ts";
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

  test("a failed footer image lookup renders the footer without its images", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterFallback");
    await settings.update.siteFooter(
      `Thanks.![FooterFallback](img#${image.id})`,
    );
    using _failedImages = failImageReads();
    await assertPublicHtml("/", "Thanks.", '<img src="" alt="FooterFallback">');
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
