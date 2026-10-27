// jscpd:ignore-start
import type { InStatement } from "@libsql/client";
import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settleAttendeeBalance } from "#db/attendees/balance.ts";
import { insertBuiltSite } from "#db/built-sites.ts";
import { getDb } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  databaseBusyResponse,
  migrationInProgressResponse,
  siteNotActivatedResponse,
  temporaryErrorResponse,
} from "#routes/response.ts";
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
  expectStatus,
} from "#test-utils/assertions.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { provisionTestBuiltSite } from "#test-utils/db-helpers/built-sites.ts";
import { withMigrationLock } from "#test-utils/db-helpers/migration-lock.ts";
import { createTestInvite } from "#test-utils/db-helpers/misc.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

// jscpd:ignore-end

const footerTag = `<footer class="site-footer">`;

const footerCount = (html: string): number => html.split(footerTag).length - 1;

describeWithEnv("site footer", { db: true, triggers: true }, () => {
  test("renders nothing when the footer is empty", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("");

    const home = await assertPublicHtml("/");
    assert(!home.includes(footerTag));
    const listings = await assertPublicHtml("/listings");
    assert(!listings.includes(footerTag));
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
    assert(!html.includes("<script>alert(1)"));
  });

  test("keeps the footer off an embedded page", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("A visitor-facing note.");

    const embedded = await assertPublicHtml("/listings?iframe=true");
    assert(!embedded.includes(footerTag));
    const page = await assertPublicHtml("/listings");
    assertStringIncludes(page, footerTag);
  });

  test("keeps the footer off admin pages", async () => {
    await enablePublicSite();
    await settings.update.siteFooter("**Admin pages must not show this**");

    const admin = await adminGet("/admin/settings");
    const html = await expectHtmlResponse(admin, 200);
    assert(!html.includes(footerTag));
    // The settings form shows the raw text for editing; the page must not
    // render it as markdown.
    assert(!html.includes("<strong>Admin pages must not show this</strong>"));
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
      assert(!html.includes("img#"));
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
      assert(!html.includes("img#"));
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
      assert(!html.includes("img#"));
    }
  });

  test("the footer's img#N reference resolves on the check-in and join-complete pages", async () => {
    const image = await makeImage("FooterVisit");
    await settings.update.siteFooter(`Soon.![FooterVisit](img#${image.id})`);
    const { token } = await createTestAttendeeWithToken("Ada", "a@t.test");
    for (const path of [`/checkin/${token}`, "/join/complete"]) {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest(path)),
        200,
        `<img src="/image/${image.filename}" alt="FooterVisit">`,
      );
      assert(!html.includes("img#"));
    }
  });

  test("the footer's img#N reference resolves on the invite page", async () => {
    const image = await makeImage("FooterJoinForm");
    await settings.update.siteFooter(`Soon.![FooterJoinForm](img#${image.id})`);
    const { inviteCode } = await createTestInvite("footer-joiner");
    const html = await expectHtmlResponse(
      await handleRequest(mockRequest(`/join/${inviteCode}`)),
      200,
      `<img src="/image/${image.filename}" alt="FooterJoinForm">`,
    );
    assert(!html.includes("img#"));
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
      assertStringIncludes(html, picture);
      assert(!html.includes("img#"));
    }
    await settleAttendeeBalance(attendeeId, 1500, settle());
    assertStringIncludes(await getPayPage(attendeeId), picture);
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
    assertStringIncludes(await getPayPage(noTicketsId), picture);
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
    assert(!html.includes("img#"));
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
    assert(!html.includes("img#"));
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
    assert(!html.includes("img#"));
  });

  test("the footer's img#N reference resolves on the 503 pages", async () => {
    const image = await makeImage("FooterOffline");
    await settings.update.siteFooter(
      `Back soon.![FooterOffline](img#${image.id})`,
    );
    // Every shared 503 page renders the site footer, so each resolves the
    // footer's images exactly like the rendered pages do: the temporary
    // error page, the busy database page, the not-activated page, and the
    // migration page.
    for (const response of [
      await withRequestContext(() => temporaryErrorResponse("GET")),
      await withRequestContext(() => databaseBusyResponse("POST")),
      await withRequestContext(() => siteNotActivatedResponse()),
      await withRequestContext(() => migrationInProgressResponse()),
    ]) {
      const html = await expectHtmlResponse(
        response,
        503,
        `<img src="/image/${image.filename}" alt="FooterOffline">`,
      );
      assert(!html.includes("img#"));
    }
  });

  test("a failed footer read still renders the 503 page", async () => {
    const image = await makeImage("FooterBrokenRead");
    await settings.update.siteFooter(
      `Note.![FooterBrokenRead](img#${image.id})`,
    );
    const db = getDb();
    const realExecute = db.execute.bind(db);
    // `using` restores the stub when the test's scope closes.
    using _executeStub = stub(db, "execute", (statement: InStatement) => {
      const sql = typeof statement === "string" ? statement : statement.sql;
      if (sql.includes("FROM images")) {
        throw new Error("the images read failed");
      }
      return realExecute(statement);
    });
    // The database refused the footer's lookup, so the page still answers
    // and the footer shows the reference's alt text with no picture to load.
    const html = await expectHtmlResponse(
      await withRequestContext(() => temporaryErrorResponse("GET")),
      503,
      "<p>Note.FooterBrokenRead</p>",
    );
    assert(!html.includes(`<img src="/image/${image.filename}"`));
    assert(!html.includes("<img"));
  });

  test("the footer's img#N reference resolves on the migration page", async () => {
    const image = await makeImage("FooterMigration");
    await settings.update.siteFooter(
      `Almost there.![FooterMigration](img#${image.id})`,
    );
    await withMigrationLock(async () => {
      const html = await expectHtmlResponse(
        await handleRequest(mockRequest("/")),
        503,
        "Update In Progress",
        `<img src="/image/${image.filename}" alt="FooterMigration">`,
      );
      assert(!html.includes("img#"));
    });
  });

  test("the footer's img#N reference resolves on the renewal error page", async () => {
    const image = await makeImage("FooterRenewal");
    await settings.update.siteFooter(
      `Renew here.![FooterRenewal](img#${image.id})`,
    );
    const site = await insertBuiltSite(
      "Footer Renewal Site",
      "renewal-footer.b-cdn.net",
      "",
      "",
      false,
      "7201",
    );
    const { token } = await provisionTestBuiltSite(site.id);
    // No listing qualifies as a renewal tier, so the link shows the error
    // page, and its footer resolves like every other public page's.
    const html = await expectHtmlResponse(
      await handleRequest(
        mockRequest(`/renew/?t=${encodeURIComponent(token)}`),
      ),
      200,
      "Renewal Unavailable",
      `<img src="/image/${image.filename}" alt="FooterRenewal">`,
    );
    assert(!html.includes("img#"));
  });
});
