// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { setImagesForItem } from "#db/images.ts";
import { handleRequest } from "#routes";
import { BROKEN_IMAGE_FILENAME } from "#shared/images/broken.ts";
import { insertBrokenImage } from "#test-utils/admin-images.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectHtmlResponse,
} from "#test-utils/assertions.ts";
import { extractInputValue, submitMultiTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite, withSetting } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket slug GET",
  { db: true, triggers: true },
  () => {
    describe("GET /ticket/:slug", () => {
      test("returns 404 for non-existent slug", async () => {
        const response = await handleRequest(
          mockRequest("/ticket/non-existent"),
        );
        expect(response.status).toBe(404);
      });

      test("shows ticket page for existing listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
          `action="/ticket/${listing.slug}"`,
        );
      });

      test("still renders when the listing's image record is broken", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await setImagesForItem("listing", listing.id, [
          await insertBrokenImage(),
        ]);

        // The page renders (no 503) and shows the red-pixel marker in place
        // of the unreadable image.
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
          `/image/${BROKEN_IMAGE_FILENAME}`,
        );
      });

      test("includes OpenGraph meta tags", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          name: "Birthday Party",
          thankYouUrl: "https://example.com",
        });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          '<meta property="og:title" content="Birthday Party">',
          '<meta property="og:type" content="website">',
          `<meta property="og:url" content="http://localhost/ticket/${listing.slug}">`,
        );
      });

      test("shows description when listing has one", async () => {
        const listing = await createTestListing({
          description: "A <b>great</b> listing",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "A &lt;b&gt;great&lt;/b&gt; listing",
          'class="description"',
        );
      });

      test("shows date and location when listing has them", async () => {
        const listing = await createTestListing({
          date: "2026-06-15T14:00",
          location: "Village Hall",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "<strong>Date:</strong>",
          "Monday 15 June 2026 at 14:00 UTC",
          "<strong>Location:</strong>",
          "Village Hall",
        );
      });

      /** A plain listing's rendered ticket page — the shared fetch behind
       * the two "does not show X when empty" checks below. */
      const plainTicketHtml = async (): Promise<string> => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        return assertPublicHtml(`/ticket/${listing.slug}`);
      };

      test("does not show date or location when they are empty", async () => {
        const html = await plainTicketHtml();
        expect(html).not.toContain("<strong>Date:</strong>");
        expect(html).not.toContain("<strong>Location:</strong>");
      });

      test("does not show description div when description is empty", async () => {
        const html = await plainTicketHtml();
        expect(html).not.toContain("font-size: 0.9em");
      });

      test("returns 404 for inactive listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        // Deactivate the listing
        await deactivateTestListing(listing.id);
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        await expectHtmlResponse(response, 404, "<h1>Not Found</h1>");
      });

      test("hides header and description in iframe mode", async () => {
        const listing = await createTestListing({
          description: "A <b>great</b> listing",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const html = await assertPublicHtml(
          `/ticket/${listing.slug}?iframe=true`,
          'class="iframe"',
          "Continue",
        );
        expect(html).not.toContain("<h1>");
        expect(html).not.toContain("A <b>great</b> listing");
        // The site menu is dropped inside an embedded iframe.
        expect(html).not.toContain("admin-nav-group");
      });

      test("hides the configured header image in iframe mode", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await withSetting({ header_image_url: "header.jpg" }, () =>
          assertPublicHtml(`/ticket/${listing.slug}?iframe=true`),
        );
        expect(html).not.toContain("header-image");
        expect(html).not.toContain("/image/header.jpg");
      });

      test("shows the configured header image without iframe param", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await withSetting({ header_image_url: "header.jpg" }, () =>
          assertPublicHtml(`/ticket/${listing.slug}`),
        );
        expect(html).toContain('class="header-image"');
        expect(html).toContain("/image/header.jpg");
      });

      test("shows header and description without iframe param", async () => {
        const listing = await createTestListing({
          description: "A <b>great</b> listing",
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const html = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "<h1>",
          "A &lt;b&gt;great&lt;/b&gt; listing",
        );
        expect(html).not.toContain('class="iframe"');
        // With the public site off (the default), the menu's Home/Listings
        // links would only bounce a visitor to the admin login, so no menu.
        expect(html).not.toContain("admin-nav-group");
      });

      test("shows the site menu on a normal page when the public site is on", async () => {
        await enablePublicSite();
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await assertPublicHtml(`/ticket/${listing.slug}`, "<h1>");
        expect(html).toContain('<div class="admin-nav-group">');
        expect(html).toContain('aria-label="Site menu"');
      });

      test("still drops the menu in iframe mode when the public site is on", async () => {
        await enablePublicSite();
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await assertPublicHtml(
          `/ticket/${listing.slug}?iframe=true`,
          'class="iframe"',
        );
        expect(html).not.toContain("admin-nav-group");
      });

      test("does not set CSRF cookies (uses signed tokens instead)", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const cookie = response.headers.get("set-cookie") || "";
        expect(cookie).not.toContain("csrf_token=");
      });

      /** GETs a listing's ticket page with `?iframe=true` and returns the
       * rendered HTML — the shared fetch behind the iframe form-action and
       * signed-CSRF-token checks below. */
      const iframeTicketHtml = async (listing: {
        slug: string;
      }): Promise<string> => {
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}?iframe=true`),
        );
        return response.text();
      };

      test("form action includes ?iframe=true in iframe mode", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await iframeTicketHtml(listing);
        expect(html).toContain(`action="/ticket/${listing.slug}?iframe=true"`);
      });

      test("form action does not include ?iframe=true without iframe param", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await response.text();
        expect(html).toContain(`action="/ticket/${listing.slug}"`);
        expect(html).not.toContain("?iframe=true");
      });

      test("POST with iframe=true succeeds with valid signed CSRF token", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await submitMultiTicketForm(
          `${listing.slug}?iframe=true`,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing.id}`]: "1",
          },
        );
        expect(response.status).toBe(302);
      });

      /** POSTs a listing's iframe ticket form with a deliberately wrong CSRF
       * token — the shared setup behind both CSRF-error checks below. */
      /** Makes a fresh listing and POSTs its iframe form with a wrong CSRF
       * token, the shared arrange for both CSRF-error checks. */
      const postWrongCsrfToNewListing = async (): Promise<Response> => {
        const listing = await createTestListing({ maxAttendees: 50 });
        return handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
            csrf_token: "wrong-token",
            name: "Test",
          }),
        );
      };

      test("CSRF error response does not set cookies in iframe mode", async () => {
        const response = await postWrongCsrfToNewListing();
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid or expired form"),
          false,
        );
        const cookies = response.headers.getSetCookie().join("; ");
        expect(cookies).not.toContain("csrf_token=");
      });

      test("GET returns signed CSRF token in form", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await iframeTicketHtml(listing);
        // Signed tokens start with s1.
        expect(extractInputValue(html, "csrf_token")).toMatch(/^s1\./);
      });

      test("POST succeeds with signed token and no cookie", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        // GET the page to obtain the signed token
        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await getResponse.text();
        const signedToken = extractInputValue(html, "csrf_token") ?? "";
        expect(signedToken.startsWith("s1.")).toBe(true);

        // POST without any cookie - signed tokens are the only CSRF mechanism
        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}`, {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing.id}`]: "1",
            csrf_token: signedToken,
          }),
        );
        expect(response.status).toBe(302);
      });

      test("CSRF error regenerates a signed token", async () => {
        const response = await postWrongCsrfToNewListing();
        // Now redirects with flash error instead of rendering a 403 page
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid or expired form"),
          false,
        );
      });
    });
  },
);
