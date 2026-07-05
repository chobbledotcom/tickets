// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  assertPublicHtml,
  createTestGroup,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  extractInputValue,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

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

      test("does not show date or location when they are empty", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const html = await assertPublicHtml(`/ticket/${listing.slug}`);
        expect(html).not.toContain("<strong>Date:</strong>");
        expect(html).not.toContain("<strong>Location:</strong>");
      });

      test("does not show description div when description is empty", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const html = await assertPublicHtml(`/ticket/${listing.slug}`);
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
      });

      test("does not set CSRF cookies (uses signed tokens instead)", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const cookie = response.headers.get("set-cookie") || "";
        expect(cookie).not.toContain("csrf_token=");
      });

      test("form action includes ?iframe=true in iframe mode", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}?iframe=true`),
        );
        const html = await response.text();
        expect(html).toContain(
          `action="/ticket/${listing.slug}?iframe=true"`,
        );
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
        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}?iframe=true`),
        );
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBe(null);

        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing.id}`]: "1",
            csrf_token: csrfToken!,
          }),
        );
        expect(response.status).toBe(302);
      });

      test("CSRF error response does not set cookies in iframe mode", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
            csrf_token: "wrong-token",
            name: "Test",
          }),
        );
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
        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}?iframe=true`),
        );
        const html = await response.text();
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
        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
            csrf_token: "wrong-token",
            name: "Test",
          }),
        );
        // Now redirects with flash error instead of rendering a 403 page
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid or expired form"),
          false,
        );
      });

      test("renders ticket page for group slug", async () => {
        const group = await createTestGroup({
          name: "Public Group",
          slug: "public-group",
        });
        const listing1 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Group Listing 1",
        });
        const listing2 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Group Listing 2",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Public Group",
          "Continue",
          "Select Tickets",
          "Group Listing 1",
          "Group Listing 2",
          `action="/ticket/${group.slug}"`,
          `quantity_${listing1.id}`,
          `quantity_${listing2.id}`,
        );
      });

      test("shows group name and description on multi-listing group page", async () => {
        const group = await createTestGroup({
          description: "A wonderful festival with multiple listings",
          name: "Festival Group",
          slug: "festival-group",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Festival Listing A",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Festival Listing B",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Festival Group",
          "A wonderful festival with multiple listings",
        );
      });

      test("returns 404 when group has no active listings", async () => {
        const group = await createTestGroup({
          name: "Empty Group",
          slug: "empty-group",
        });
        const listing = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Inactive In Group",
        });
        await deactivateTestListing(listing.id);

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        expect(response.status).toBe(404);
      });

      test("group terms override global terms", async () => {
        await settings.update.terms("GLOBAL TERMS UNIQUE");
        const group = await createTestGroup({
          name: "Terms Group",
          slug: "terms-group",
          termsAndConditions: "GROUP TERMS UNIQUE",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Terms Listing",
        });

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const html = await response.text();
        expect(html).toContain("GROUP TERMS UNIQUE");
        expect(html).not.toContain("GLOBAL TERMS UNIQUE");
      });

      test("group terms fall back to global when group terms are empty", async () => {
        await settings.update.terms("GLOBAL FALLBACK UNIQUE");
        const group = await createTestGroup({
          name: "Fallback Group",
          slug: "fallback-group",
          termsAndConditions: "",
        });
        await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          name: "Fallback Listing",
        });

        const response = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const html = await response.text();
        expect(html).toContain("GLOBAL FALLBACK UNIQUE");
      });

      test("group page shows shared date selector for daily listings", async () => {
        const group = await createTestGroup({
          name: "Daily Group",
          slug: "daily-group",
        });
        await createTestListing({
          bookableDays: ["Monday"],
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 10,
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
          name: "Daily A",
        });
        await createTestListing({
          bookableDays: ["Monday", "Tuesday"],
          groupId: group.id,
          listingType: "daily",
          maxAttendees: 10,
          maximumDaysAfter: 14,
          minimumDaysBefore: 0,
          name: "Daily B",
        });

        await assertPublicHtml(
          `/ticket/${group.slug}`,
          "Select Date",
          'name="date"',
        );
      });
    });
  },
);
