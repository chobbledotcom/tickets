// jscpd:ignore-start
import type { InStatement } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { executeWithoutCacheInvalidation, getDb } from "#db/client.ts";
import { bumpSettingsVersion, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { MAX_TOKEN_404S } from "#shared/limits.ts";
import {
  createReserved,
  getPayPage,
  settle,
} from "#test/integration/balance-helpers.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  assertPublicHtml,
  expectHtmlResponse,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
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

  test("the footer's img#N reference resolves on the pages a link opens", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterLink");
    await settings.update.siteFooter(`Thanks.![FooterLink](img#${image.id})`);
    // Each of these pages renders the site footer, so each resolves the
    // footer's images: the reservation confirmation, the read-only notice, a
    // balance link that is not valid, the choices page, an invite that does
    // not exist, and a QR link with no code. Their statuses differ; the
    // footer's picture resolves on each.
    for (const [path, status] of [
      ["/ticket/reserved", 200],
      ["/read-only", 200],
      ["/pay/bal1.bogus.bogus", 200],
      ["/unsubscribe?email=abc", 200],
      ["/join/not-a-real-invite", 404],
      ["/ticket/no-such-listing/qr-book", 400],
    ] as const) {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest(path)),
        status,
        `<img src="/image/${image.filename}" alt="FooterLink">`,
      );
      expect(html).not.toContain("img#");
    }
  });

  test("the footer's img#N reference resolves on the balance pages", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterBalance");
    await settings.update.siteFooter(
      `Pay here.![FooterBalance](img#${image.id})`,
    );
    const picture = `<img src="/image/${image.filename}" alt="FooterBalance">`;
    const attendeeId = await createReserved(1500);
    for (const html of [await getPayPage(attendeeId)]) {
      expect(html).toContain(picture);
      expect(html).not.toContain("img#");
    }
    await settleAttendeeBalance(attendeeId, 1500, settle());
    expect(await getPayPage(attendeeId)).toContain(picture);
    // A link whose every line is no-quantity shows the honest no-tickets
    // page, and its footer resolves the same way. The two bookings name their
    // listings differently, because one test may not create two listings of
    // one name.
    const noTicketsId = (
      await createReservedAttendee(1500, { listingName: "No Line Ticket" })
    ).attendeeId;
    await getDb().execute({
      args: [noTicketsId],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ?",
    });
    expect(await getPayPage(noTicketsId)).toContain(picture);
  });

  test("the footer's img#N reference resolves on the paid success page", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterPaid");
    await settings.update.siteFooter(`Thanks.![FooterPaid](img#${image.id})`);
    const { token } = await createTestAttendeeWithToken("Ada", "ada@test.com");
    const html = await expectHtmlResponse(
      await handleRequest(mockRequest(`/payment/success?tokens=${token}`)),
      200,
      `<img src="/image/${image.filename}" alt="FooterPaid">`,
    );
    expect(html).not.toContain("img#");
  });

  test("the footer's img#N reference resolves when a form post is refused", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterForm");
    await settings.update.siteFooter(`Note.![FooterForm](img#${image.id})`);
    // A post without a valid one-way code re-renders the page, and its
    // footer resolves the same way the page's own render does.
    const html = await expectHtmlResponse(
      await handleRequest(mockFormRequest("/unsubscribe", { email: "abc" })),
      403,
      `<img src="/image/${image.filename}" alt="FooterForm">`,
    );
    expect(html).not.toContain("img#");
  });

  test("the footer's img#N reference resolves on the rate-limited page", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterLimited");
    await settings.update.siteFooter(`Sorry.![FooterLimited](img#${image.id})`);
    // Earlier tests in this file have asked for unknown tokens, so the
    // failure window starts empty here.
    await getDb().execute({ args: [], sql: "DELETE FROM token_attempts" });
    for (let attempt = 0; attempt < MAX_TOKEN_404S; attempt++) {
      expectStatus(404)(
        await handleRequest(mockRequest(`/t/not-a-real-token-${attempt}`)),
      );
    }
    const html = await expectHtmlResponse(
      await handleRequest(mockRequest("/t/one-more-made-up-token")),
      429,
      `<img src="/image/${image.filename}" alt="FooterLimited">`,
    );
    expect(html).not.toContain("img#");
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

    // Another isolate commits the removal: the row leaves the images table
    // and the shared version moves there. This isolate's invalidation
    // callbacks never run, so the version is the only signal the cache reads.
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

  test("requests that never render the footer run no images lookup", async () => {
    await enablePublicSite();
    await settings.update.orderEnabled(true);
    const image = await makeImage("FooterQuiet");
    await settings.update.siteFooter(`Note.![FooterQuiet](img#${image.id})`);
    const listing = await createTestListing({ name: "Quiet Item" });
    const sqls = await withRecordedSql(async () => {
      // A stylesheet, a JSON evaluation, and the gallery's redirect never
      // render a page, so none of them may pay the page's images read.
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
    });
    // The requests ran real reads, so an empty recording would prove nothing.
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.some((sql) => sql.includes("FROM images"))).toBe(false);
  });
});
