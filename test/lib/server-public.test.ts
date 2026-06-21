import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { capacityErrorFormatter } from "#routes/format.ts";
import { builderApi } from "#shared/builder.ts";
import { addDays } from "#shared/dates.ts";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { hashPhone, recordVisit } from "#shared/db/contact-preferences.ts";
import {
  getAllModifiers,
  modifiersTable,
  setModifierAnswers,
} from "#shared/db/modifiers.ts";
import {
  answersTable,
  getAttendeeAnswersBatch,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { todayInTz } from "#shared/timezone.ts";
import { ICS_DISCOVERY_TAG, RSS_DISCOVERY_TAG } from "#templates/public.tsx";
import {
  assertJson,
  assertPublicHtml,
  awaitTestRequest,
  bookAttendee,
  createTestAttendeeWithToken,
  createTestGroup,
  createTestHoliday,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectCheckoutRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  extractInputValue,
  getTicketCsrfToken,
  hasCheckedInput,
  mockFormRequest,
  mockRequest,
  setTestEnv,
  setupStripe,
  singleItem,
  submitMultiTicketForm,
  submitTicketForm,
  testCookie,
  updateTestListing,
} from "#test-utils";

const expectReservedRedirectWithTokens = (response: Response): void => {
  expect(response.status).toBe(302);
  const location = response.headers.get("location") || "";
  expect(location).toMatch(/^\/ticket\/reserved\?tokens=.+$/);
};

describeWithEnv("server (public routes)", { db: true, triggers: true }, () => {
  describe("GET /", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("shows public homepage when enabled", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml("/", "Home", "/admin/login");
    });

    test("shows website title on homepage", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Cool Site");
      await assertPublicHtml("/", "My Cool Site");
    });

    test("shows homepage text when configured", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.homepageText("Welcome to our listings!");
      await assertPublicHtml("/", "Welcome to our listings!");
    });

    test("shows no content message when homepage text not set", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml("/", "No content.");
    });

    test("shows public nav links", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.terms("Some terms");
      await settings.update.contactPageText("Contact us");
      await assertPublicHtml(
        "/",
        'href="/"',
        'href="/listings"',
        'href="/terms"',
        'href="/contact"',
      );
    });

    test("hides terms and contact nav links when pages are empty", async () => {
      await settings.update.showPublicSite(true);
      const html = await assertPublicHtml("/", 'href="/"', 'href="/listings"');
      expect(html).not.toContain('href="/terms"');
      expect(html).not.toContain('href="/contact"');
    });

    test("shows login link styled as footer", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml(
        "/",
        'class="homepage-footer"',
        'href="/admin/login"',
        "Login",
      );
    });

    test("returns 404 for non-GET requests to /", async () => {
      const response = await handleRequest(mockRequest("/", { method: "PUT" }));
      expect(response.status).toBe(404);
    });

    test("redirects legacy /events to listings when public site is enabled", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/events"));
      expectRedirect(response, /^\/listings$/);
    });

    test("does not redirect legacy /events when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/events"));
      expect(response.status).toBe(404);
    });

    test("renders markdown paragraphs in homepage text", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.homepageText("Line one\n\nLine two");
      await assertPublicHtml("/", "<p>Line one</p>", "<p>Line two</p>");
    });

    test("includes RSS and ICS feed discovery tags", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml("/", RSS_DISCOVERY_TAG, ICS_DISCOVERY_TAG);
    });
  });

  describe("GET /listings", () => {
    test("redirects legacy /events to /listings when public site is enabled", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/events"));
      expectRedirect(response, /^\/listings$/);
    });

    test("does not redirect legacy /events subpaths", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/events/archive"));
      expect(response.status).toBe(404);
    });

    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/listings"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("shows no listings message when enabled but no listings exist", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml(
        "/listings",
        "No listings listed.",
        "/admin/login",
      );
    });

    test("shows website title with no listings message", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Listings");
      await assertPublicHtml("/listings", "No listings listed.", "My Listings");
    });

    test("shows active listings with book now links", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      await assertPublicHtml(
        "/listings",
        listing.name,
        "Book now",
        `href="/ticket/${listing.slug}"`,
      );
    });

    test("shows Buy now link for purchase_only listings", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        maxAttendees: 100,
        name: "Raffle",
        purchaseOnly: true,
      });
      const html = await assertPublicHtml("/listings", "Raffle", "Buy now");
      expect(html).not.toContain("Book now");
    });

    test("does not show inactive listings", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Hidden Listing",
      });
      await deactivateTestListing(listing.id);
      const html = await assertPublicHtml("/listings", "No listings listed.");
      expect(html).not.toContain("Hidden Listing");
    });

    test("does not show hidden listings in public listings list", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({ hidden: true, name: "Secret Listing" });
      const html = await assertPublicHtml("/listings", "No listings listed.");
      expect(html).not.toContain("Secret Listing");
    });

    test("shows non-hidden listings alongside hidden ones", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({ name: "Visible Listing" });
      await createTestListing({ hidden: true, name: "Secret Listing" });
      const html = await assertPublicHtml("/listings", "Visible Listing");
      expect(html).not.toContain("Secret Listing");
    });

    test("hidden listing is still accessible via direct ticket URL", async () => {
      const listing = await createTestListing({
        hidden: true,
        name: "Secret Listing",
      });
      await assertPublicHtml(`/ticket/${listing.slug}`, "Secret Listing");
    });

    test("hidden listing ticket page has noindex x-robots-tag", async () => {
      const listing = await createTestListing({ hidden: true });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });

    test("non-hidden listing ticket page has index x-robots-tag", async () => {
      const listing = await createTestListing();
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.headers.get("x-robots-tag")).toBe("index, follow");
    });

    test("x-robots-noindex signal header is not leaked to client", async () => {
      const listing = await createTestListing({ hidden: true });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      expect(response.headers.has("x-robots-noindex")).toBe(false);
    });

    test("shows groups with active listings on listings page", async () => {
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({
        name: "Summer Festival",
        slug: "summer-festival",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Festival Listing",
      });
      await assertPublicHtml(
        "/listings",
        "Summer Festival",
        `href="/ticket/${group.slug}"`,
        "Book now",
      );
    });

    test("shows group description on listings page", async () => {
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({
        description: "A wonderful summer celebration",
        name: "Described Festival",
        slug: "described-festival",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Described Festival Listing",
      });
      await assertPublicHtml(
        "/listings",
        "Described Festival",
        "A wonderful summer celebration",
      );
    });

    test("does not show hidden groups on listings page", async () => {
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({
        hidden: true,
        name: "Secret Group",
        slug: "secret-group",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Visible Listing In Hidden Group",
      });
      const html = await assertPublicHtml(
        "/listings",
        "Visible Listing In Hidden Group",
      );
      expect(html).not.toContain("Secret Group");
    });

    test("hidden group is still accessible via direct ticket URL", async () => {
      const group = await createTestGroup({
        hidden: true,
        name: "Hidden Group",
        slug: "hidden-group",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Hidden Group Listing",
      });
      await assertPublicHtml(`/ticket/${group.slug}`, "Hidden Group Listing");
    });

    test("grouped listings also appear individually on listings page", async () => {
      await settings.update.showPublicSite(true);
      const group = await createTestGroup({
        name: "My Group",
        slug: "my-group",
      });
      await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        name: "Grouped Listing",
      });
      await createTestListing({
        maxAttendees: 50,
        name: "Ungrouped Listing",
      });
      await assertPublicHtml(
        "/listings",
        "My Group",
        "Ungrouped Listing",
        "Grouped Listing",
      );
    });

    test("shows sold out for listings at capacity", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 1,
        name: "Full Listing",
      });
      await bookAttendee(listing, {
        email: "a@test.com",
        name: "Attendee",
        quantity: 1,
      });
      const html = await assertPublicHtml("/listings", "Sold Out");
      expect(html).not.toContain(`href="/ticket/${listing.slug}"`);
    });

    test("shows registration closed for listings past closes_at", async () => {
      await settings.update.showPublicSite(true);
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      await createTestListing({
        closesAt: pastDate,
        maxAttendees: 100,
        name: "Closed Listing",
      });
      await assertPublicHtml("/listings", "Registration Closed");
    });

    test("shows listing location when set", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located Listing",
      });
      await assertPublicHtml("/listings", "Town Hall");
    });

    test("shows listing date when set", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated Listing",
      });
      await assertPublicHtml("/listings", "2026");
    });

    test("shows listing description when set", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        description: "A great listing",
        maxAttendees: 100,
        name: "Described Listing",
      });
      await assertPublicHtml("/listings", "A great listing");
    });

    test("shows website title on listings page", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Listings Site");
      await createTestListing({ maxAttendees: 100, name: "Concert" });
      await assertPublicHtml("/listings", "My Listings Site");
    });

    test("shows public nav on listings page", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.terms("Some terms");
      await settings.update.contactPageText("Contact us");
      await assertPublicHtml(
        "/listings",
        'href="/"',
        'href="/listings"',
        'href="/terms"',
        'href="/contact"',
      );
    });

    test("returns 404 for POST requests", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(
        mockFormRequest("/listings", { name: "Test" }),
      );
      expect(response.status).toBe(404);
    });

    test("includes RSS and ICS feed discovery tags", async () => {
      await settings.update.showPublicSite(true);
      await assertPublicHtml("/listings", RSS_DISCOVERY_TAG, ICS_DISCOVERY_TAG);
    });
  });

  describe("GET /terms", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/terms"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("shows terms page when enabled", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.terms("Our terms and conditions.");
      await assertPublicHtml("/terms", "Our terms and conditions.", "T&amp;Cs");
    });

    test("returns 404 when terms not configured", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/terms"));
      expect(response.status).toBe(404);
    });

    test("includes RSS and ICS feed discovery tags", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.terms("Some terms");
      await assertPublicHtml("/terms", RSS_DISCOVERY_TAG, ICS_DISCOVERY_TAG);
    });
  });

  describe("GET /contact", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/contact"));
      expectRedirect(response, /^\/admin\/login$/);
    });

    test("shows contact page when enabled", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.contactPageText("Get in touch with us");
      await assertPublicHtml("/contact", "Get in touch with us", "Contact");
    });

    test("returns 404 when contact text not configured", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/contact"));
      expect(response.status).toBe(404);
    });

    test("renders markdown paragraphs in contact text", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.contactPageText(
        "Phone: 123\n\nAddress: 1 High Street",
      );
      await assertPublicHtml(
        "/contact",
        "<p>Phone: 123</p>",
        "<p>Address: 1 High Street</p>",
      );
    });

    test("returns 404 for non-GET requests to /contact", async () => {
      const response = await handleRequest(
        mockFormRequest("/contact", { name: "Test" }),
      );
      expect(response.status).toBe(404);
    });

    test("includes RSS and ICS feed discovery tags", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.contactPageText("Contact us");
      await assertPublicHtml("/contact", RSS_DISCOVERY_TAG, ICS_DISCOVERY_TAG);
    });
  });

  describe("non-GET/POST requests to public pages", () => {
    test("returns 404 for POST to /terms", async () => {
      const response = await handleRequest(
        mockFormRequest("/terms", { name: "Test" }),
      );
      expect(response.status).toBe(404);
    });

    test("returns 404 for PUT to /listings", async () => {
      const response = await handleRequest(
        mockRequest("/listings", { method: "PUT" }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe("GET /health", () => {
    test("returns health status", async () => {
      await assertJson(handleRequest(mockRequest("/health")), 200, (json) => {
        expect(json).toEqual({ status: "ok" });
      });
    });

    test("returns 404 for non-GET requests to /health", async () => {
      const response = await awaitTestRequest("/health", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /robots.txt", () => {
    test("returns plain text robots.txt", async () => {
      const response = await handleRequest(mockRequest("/robots.txt"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/plain; charset=utf-8",
      );
    });

    test("allows crawlers on /listings/ but disallows everything else", async () => {
      const response = await handleRequest(mockRequest("/robots.txt"));
      const body = await response.text();
      expect(body).toContain("User-agent: *");
      expect(body).toContain("Allow: /listings/");
      expect(body).toContain("Disallow: /");
    });

    test("returns 404 for non-GET requests to /robots.txt", async () => {
      const response = await awaitTestRequest("/robots.txt", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/robots.txt"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /favicon.ico", () => {
    test("returns SVG favicon", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const svg = await response.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain("viewBox");
    });

    test("returns 404 for non-GET requests to /favicon.ico", async () => {
      const response = await awaitTestRequest("/favicon.ico", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/favicon.ico"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /icons.svg", () => {
    test("returns SVG icon sprite", async () => {
      const response = await handleRequest(mockRequest("/icons.svg"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/svg+xml");
      const svg = await response.text();
      expect(svg).toContain("<svg");
      expect(svg).toContain('id="plus"');
    });

    test("returns 404 for non-GET requests to /icons.svg", async () => {
      const response = await awaitTestRequest("/icons.svg", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/icons.svg"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /style.css", () => {
    test("returns CSS stylesheet", async () => {
      const response = await handleRequest(mockRequest("/style.css"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/css; charset=utf-8",
      );
      const css = await response.text();
      expect(css).toContain(":root");
      expect(css).toContain("--color-link");
    });

    test("returns 404 for non-GET requests to /style.css", async () => {
      const response = await awaitTestRequest("/style.css", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/style.css"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /admin.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/admin.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      const js = await response.text();
      expect(js).toContain("data-select-on-click");
      expect(js).toContain("data-nav-select");
    });

    test("returns 404 for non-GET requests to /admin.js", async () => {
      const response = await awaitTestRequest("/admin.js", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/admin.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /embed.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
      const js = await response.text();
      expect(js.length).toBeGreaterThan(0);
    });

    test("returns 404 for non-GET requests to /embed.js", async () => {
      const response = await awaitTestRequest("/embed.js", {
        data: {},
        method: "POST",
      });
      expect(response.status).toBe(404);
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /iframe-resizer-parent.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(
        mockRequest("/iframe-resizer-parent.js"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(
        mockRequest("/iframe-resizer-parent.js"),
      );
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /iframe-resizer-child.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(
        mockRequest("/iframe-resizer-child.js"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(
        mockRequest("/iframe-resizer-child.js"),
      );
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /embed.js", () => {
    test("returns JavaScript file", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/javascript; charset=utf-8",
      );
    });

    test("has long cache headers", async () => {
      const response = await handleRequest(mockRequest("/embed.js"));
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
    });
  });

  describe("GET /ticket/:slug", () => {
    test("returns 404 for non-existent slug", async () => {
      const response = await handleRequest(mockRequest("/ticket/non-existent"));
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

  describe("POST /ticket/:slug", () => {
    test("returns 404 for non-existent slug", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/non-existent", {
          email: "john@example.com",
          name: "John",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("processes registration for group slug", async () => {
      const group = await createTestGroup({
        name: "Post Group",
        slug: "post-group",
      });
      const listing1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Post Group Listing 1",
      });
      const listing2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Post Group Listing 2",
      });

      const getResponse = await handleRequest(
        mockRequest(`/ticket/${group.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${group.slug}`,
          {
            email: "group@example.com",
            name: "Group User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "2",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(1);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(2);
    });

    test("rejects group registration when group capacity exceeded", async () => {
      const group = await createTestGroup({
        maxAttendees: 3,
        name: "Cap Group",
        slug: "cap-group",
      });
      const listing1 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 5,
        name: "Cap Listing 1",
      });
      const listing2 = await createTestListing({
        groupId: group.id,
        maxAttendees: 10,
        maxQuantity: 5,
        name: "Cap Listing 2",
      });

      // First booking: 2 on listing1 — should succeed (group: 2/3)
      const getResponse1 = await handleRequest(
        mockRequest(`/ticket/${group.slug}`),
      );
      const csrfToken1 = getTicketCsrfToken(await getResponse1.text());
      if (!csrfToken1) throw new Error("Failed to get CSRF token");
      const r1 = await handleRequest(
        mockFormRequest(
          `/ticket/${group.slug}`,
          {
            email: "first@example.com",
            name: "First User",
            [`quantity_${listing1.id}`]: "2",
            [`quantity_${listing2.id}`]: "0",
            csrf_token: csrfToken1,
          },
          `csrf_token=${csrfToken1}`,
        ),
      );
      expectReservedRedirectWithTokens(r1);

      // Second booking: 1 on listing1 + 1 on listing2 — should fail (group: 2+2=4 > 3)
      const getResponse2 = await handleRequest(
        mockRequest(`/ticket/${group.slug}`),
      );
      const csrfToken2 = getTicketCsrfToken(await getResponse2.text());
      if (!csrfToken2) throw new Error("Failed to get CSRF token");
      const r2 = await handleRequest(
        mockFormRequest(
          `/ticket/${group.slug}`,
          {
            email: "second@example.com",
            name: "Second User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken2,
          },
          `csrf_token=${csrfToken2}`,
        ),
      );
      // The first atomic insert (listing1 qty=1) succeeds (group: 3/3),
      // but the second (listing2 qty=1) fails because group is now full
      expect(r2.status).toBe(302);
      expectFlash(
        r2,
        expect.stringContaining("no longer has enough spots available"),
        false,
      );
    });

    test("returns 404 for inactive listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // Deactivate the listing
      await deactivateTestListing(listing.id);
      const response = await handleRequest(
        mockFormRequest(`/ticket/${listing.slug}`, {
          email: "john@example.com",
          name: "John",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("rejects request without CSRF token", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest(`/ticket/${listing.slug}`, {
          email: "john@example.com",
          name: "John",
        }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("preserves form data on CSRF failure", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await handleRequest(
        mockFormRequest(`/ticket/${listing.slug}`, {
          email: "john@example.com",
          name: "John Doe",
        }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });

    test("does not leak saved form data into subsequent GET request", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // First: POST with invalid CSRF to save form data
      await handleRequest(
        mockFormRequest(`/ticket/${listing.slug}`, {
          email: "stale@example.com",
          name: "Stale Name",
        }),
      );
      // Second: GET the same page — stale values must not appear
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await getResponse.text();
      expect(html).not.toContain("Stale Name");
      expect(html).not.toContain("stale@example.com");
    });

    test("does not leak saved form data from validation error into next POST", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      // First: POST with missing name to trigger validation error
      await submitTicketForm(listing.slug, {
        email: "first@example.com",
        name: "",
      });
      // Second: POST with different data and its own validation error
      const response = await submitTicketForm(listing.slug, {
        email: "second@example.com",
        name: "",
      });
      // Now redirects with flash error
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Your Name is required"),
        false,
      );
    });

    test("validates required fields", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "",
        name: "",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Your Name is required"),
        false,
      );
    });

    test("validates name is required", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "   ",
      });
      expect(response.status).toBe(302);
    });

    test("validates email is required", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "   ",
        name: "John",
      });
      expect(response.status).toBe(302);
    });

    test("creates attendee and redirects to thank you page", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });
      expectRedirect(response, "https://example.com/thanks");
    });

    test("shows order success for purchase_only listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        purchaseOnly: true,
        thankYouUrl: "",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "jane@example.com",
        name: "Jane Doe",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).toContain("/ticket/reserved?tokens=");

      // Follow the redirect and check the success page
      const successResponse = await handleRequest(mockRequest(location));
      const html = await successResponse.text();
      expect(html).toContain("Thank you for your order");
    });

    test("rejects when listing is full", async () => {
      const listing = await createTestListing({
        maxAttendees: 1,
        thankYouUrl: "https://example.com",
      });
      await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John",
      });

      const response = await submitTicketForm(listing.slug, {
        email: "jane@example.com",
        name: "Jane",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not enough spots available"),
        false,
      );
    });

    test("returns 404 for unsupported method on ticket route", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com",
      });
      const response = await awaitTestRequest(`/ticket/${listing.slug}`, {
        method: "PUT",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("GET /ticket/:slug1+:slug2", () => {
    test("returns 404 when no valid listings", async () => {
      const response = await handleRequest(
        mockRequest("/ticket/nonexistent1+nonexistent2"),
      );
      expect(response.status).toBe(404);
    });

    test("shows ticket page for multiple existing listings", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Listing 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 100,
        name: "Multi Listing 2",
      });
      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Continue",
        "Multi Listing 1",
        "Multi Listing 2",
        "Select Tickets",
      );
    });

    test("shows description beneath each listing in ticket page", async () => {
      const listing1 = await createTestListing({
        description: "First listing info",
        maxAttendees: 50,
        name: "Multi Desc 1",
      });
      const listing2 = await createTestListing({
        description: "Second listing info",
        maxAttendees: 100,
        name: "Multi Desc 2",
      });
      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "First listing info",
        "Second listing info",
      );
    });

    test("omits description div in ticket when description is empty", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi No Desc",
      });
      const listing2 = await createTestListing({
        maxAttendees: 100,
        name: "Multi No Desc 2",
      });
      const html = await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Multi No Desc",
      );
      expect(html).not.toContain("margin: 0.25rem 0 0.5rem");
    });

    test("shows sold-out label for full listings", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Available",
      });
      const listing2 = await createTestListing({
        maxAttendees: 1,
        name: "Multi Full",
      });
      // Fill up listing2
      await bookAttendee(listing2, {
        email: "john@example.com",
        name: "John",
        quantity: 1,
      });

      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Sold Out",
      );
    });

    test("shows description for sold-out listing in ticket page", async () => {
      const listing1 = await createTestListing({
        description: "Available desc",
        maxAttendees: 50,
        name: "Multi Avail Desc",
      });
      const listing2 = await createTestListing({
        description: "Sold out desc",
        maxAttendees: 1,
        name: "Multi Full Desc",
      });
      await bookAttendee(listing2, {
        email: "jane@example.com",
        name: "Jane",
        quantity: 1,
      });

      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Available desc",
        "Sold out desc",
        "Sold Out",
      );
    });

    test("filters out inactive listings", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Active",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Inactive",
      });
      await deactivateTestListing(listing2.id);

      // The active listing should have a quantity selector
      const html = await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        `quantity_${listing1.id}`,
      );
      // The inactive listing should not have a quantity selector
      expect(html).not.toContain(`quantity_${listing2.id}`);
    });

    test("returns 404 when all listings are inactive", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "All Inactive 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "All Inactive 2",
      });
      await deactivateTestListing(listing1.id);
      await deactivateTestListing(listing2.id);

      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
      );
      expect(response.status).toBe(404);
    });

    test("preserves slug order instead of sorting listings", async () => {
      const listing1 = await createTestListing({
        date: "2026-12-01",
        maxAttendees: 50,
        name: "Zebra Listing",
      });
      const listing2 = await createTestListing({
        date: "2026-01-01",
        maxAttendees: 50,
        name: "Alpha Listing",
      });
      // Request with Zebra first, Alpha second — opposite of sort order
      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
      );
      const html = await response.text();
      const zebraPos = html.indexOf("Zebra Listing");
      const alphaPos = html.indexOf("Alpha Listing");
      expect(zebraPos).toBeGreaterThan(-1);
      expect(alphaPos).toBeGreaterThan(-1);
      expect(zebraPos).toBeLessThan(alphaPos);
    });

    test("does not set CSRF cookies for ticket (uses signed tokens)", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
      );
      const cookie = response.headers.get("set-cookie") || "";
      expect(cookie).not.toContain("csrf_token=");
    });

    test("form action includes ?iframe=true in iframe mode", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}?iframe=true`),
      );
      const html = await response.text();
      expect(html).toContain(
        `action="/ticket/${listing1.slug}+${listing2.slug}?iframe=true"`,
      );
    });

    test("ticket GET returns signed CSRF token in form", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}?iframe=true`),
      );
      const html = await response.text();
      expect(extractInputValue(html, "csrf_token")).toMatch(/^s1\./);
    });

    test("ticket POST succeeds with signed token and no cookie", async () => {
      const listing1 = await createTestListing({ maxAttendees: 50 });
      const listing2 = await createTestListing({ maxAttendees: 50 });
      const path = `/ticket/${listing1.slug}+${listing2.slug}`;

      const getResponse = await handleRequest(
        mockRequest(`${path}?iframe=true`),
      );
      const html = await getResponse.text();
      const signedToken = extractInputValue(html, "csrf_token") ?? "";

      const response = await handleRequest(
        mockFormRequest(`${path}?iframe=true`, {
          email: "test@example.com",
          name: "Test User",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "1",
          csrf_token: signedToken,
        }),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("POST /ticket/:slug1+:slug2", () => {
    /** Helper to submit ticket form with CSRF */
    const submitMultiTicketForm = async (
      slugs: string[],
      data: Record<string, string>,
    ): Promise<Response> => {
      const path = `/ticket/${slugs.join("+")}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      return handleRequest(
        mockFormRequest(path, { ...data, csrf_token: csrfToken }),
      );
    };

    test("returns 404 when no valid listings", async () => {
      const response = await handleRequest(
        mockFormRequest("/ticket/nonexistent1+nonexistent2", {
          email: "john@example.com",
          name: "John",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("validates name is required", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi 2",
      });
      const response = await submitMultiTicketForm(
        [listing1.slug, listing2.slug],
        {
          email: "john@example.com",
          name: "",
          [`quantity_${listing1.id}`]: "1",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("requires at least one ticket selected", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi Empty 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi Empty 2",
      });
      const response = await submitMultiTicketForm(
        [listing1.slug, listing2.slug],
        {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "0",
          [`quantity_${listing2.id}`]: "0",
        },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Please select at least one ticket"),
        false,
      );
    });

    test("renders flashed 'select at least one ticket' error after redirect", async () => {
      const { FLASH_TEST_ID, flashCookieHeader } = await import(
        "#test-utils/assertions.ts"
      );
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Flash Render 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Flash Render 2",
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await handleRequest(
        mockRequest(`/ticket/${slug}?flash=${FLASH_TEST_ID}`, {
          headers: {
            cookie: flashCookieHeader(
              "Please select at least one ticket",
              false,
            ),
          },
        }),
      );
      await expectHtmlResponse(
        response,
        200,
        "Please select at least one ticket",
      );
    });

    test("creates attendees for selected free listings", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Post Multi Free 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Post Multi Free 2",
      });
      const response = await submitMultiTicketForm(
        [listing1.slug, listing2.slug],
        {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "2",
          [`quantity_${listing2.id}`]: "1",
        },
      );
      expectReservedRedirectWithTokens(response);

      // Verify attendees were created
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });

    test("only registers for listings with quantity > 0", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi Partial 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Post Multi Partial 2",
      });
      const response = await submitMultiTicketForm(
        [listing1.slug, listing2.slug],
        {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
        },
      );
      expectReservedRedirectWithTokens(response);

      // Verify only listing1 has an attendee
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(0);
    });

    test("caps quantity at max purchasable", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 3,
        maxQuantity: 2,
        name: "Post Multi Cap 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Post Multi Cap 2",
      });
      const response = await submitMultiTicketForm(
        [listing1.slug, listing2.slug],
        {
          email: "john@example.com",
          name: "John Doe",
          [`quantity_${listing1.id}`]: "10", // Request more than max
          [`quantity_${listing2.id}`]: "0",
        },
      );
      expectReservedRedirectWithTokens(response);

      // Verify quantity was capped
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing1.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.quantity).toBe(2); // Capped at maxQuantity
    });
  });

  describe("404 handling", () => {
    test("returns 404 for unknown routes", async () => {
      const response = await handleRequest(mockRequest("/unknown/path"));
      expect(response.status).toBe(404);
    });
  });

  describe("GET /ticket/reserved", () => {
    test("shows reservation success page", async () => {
      const html = await assertPublicHtml(
        "/ticket/reserved",
        "Thank you for your order",
      );
      expect(html).not.toContain("view your ticket");
    });

    test("shows ticket link when tokens are provided", async () => {
      // The page now resolves tokens and only shows the CTA for a real
      // (quantity > 0) line, so use a genuine attendee token.
      const { token } = await createTestAttendeeWithToken(
        "Resv",
        "resv@example.com",
      );
      await assertPublicHtml(
        `/ticket/reserved?tokens=${token}`,
        `href="/t/${token}"`,
        "Click here to view your ticket",
      );
    });

    test("includes iframe-resizer child script when iframe=true", async () => {
      await assertPublicHtml(
        "/ticket/reserved?tokens=abc123&iframe=true",
        "iframe-resizer-child.js",
        'class="iframe"',
      );
    });

    test("excludes iframe-resizer child script without iframe param", async () => {
      const html = await assertPublicHtml("/ticket/reserved?tokens=abc123");
      expect(html).not.toContain("iframe-resizer-child.js");
    });

    test("shows email notice when email sending is configured", async () => {
      // The email notice only appears alongside a real ticket CTA, so use a
      // genuine attendee token.
      const { token } = await createTestAttendeeWithToken(
        "Resv",
        "resv@example.com",
      );
      const restore = setTestEnv({
        HOST_EMAIL_API_KEY: "re_test123",
        HOST_EMAIL_FROM_ADDRESS: "tickets@mysite.com",
        HOST_EMAIL_PROVIDER: "resend",
      });
      try {
        await assertPublicHtml(
          `/ticket/reserved?tokens=${token}`,
          "Junk/Spam",
          "tickets@mysite.com",
        );
      } finally {
        restore();
      }
    });

    test("does not show email notice when email is not configured", async () => {
      const html = await assertPublicHtml(
        "/ticket/reserved?tokens=abc123",
        "Thank you for your order",
      );
      expect(html).not.toContain("Junk/Spam");
    });
  });

  describe("POST /ticket/:slug (free listing without thank_you_url)", () => {
    test("shows inline success page when no thank_you_url", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "", // No thank_you_url
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });
      // Should redirect to success page
      expectReservedRedirectWithTokens(response);
    });

    test("propagates iframe=true in redirect to reserved page", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });

      const getResponse = await handleRequest(
        mockRequest(`/ticket/${listing.slug}?iframe=true`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      expect(csrfToken).not.toBe(null);

      const response = await handleRequest(
        mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
          email: "jane@example.com",
          name: "Jane Doe",
          [`quantity_${listing.id}`]: "1",
          csrf_token: csrfToken!,
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).toContain("/ticket/reserved");
      expect(location).toContain("iframe=true");
    });
  });

  describe("ticket paid flow", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("redirects to checkout for ticket paid listings", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Paid 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Paid 2",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "2",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("shows error when no tickets selected in ticket paid form", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Nosel 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Nosel 2",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with all quantities at 0
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "0",
            [`quantity_${listing2.id}`]: "0",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Please select at least one ticket"),
        false,
      );
    });
  });

  describe("ticket free flow (capacity exceeded)", () => {
    test("shows error when free ticket atomic create fails capacity", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Free Cap 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Free Cap 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock atomic create to fail (simulates race condition / capacity exceeded)
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockCreate = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "capacity_exceeded" as const,
          success: false as const,
        }),
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("no longer has enough spots"),
          false,
        );
      } finally {
        mockCreate.restore();
      }
    });

    test("ticket free registration succeeds for both listings", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Free Ok 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Free Ok 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "multifree@example.com",
            name: "Multi Free User",
            [`quantity_${listing1.id}`]: "2",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      expectReservedRedirectWithTokens(response);

      // Verify attendees created for both listings
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    });
  });

  describe("POST /ticket/:slug1+:slug2 (unsupported method)", () => {
    test("returns 404 for PUT on ticket route", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Put 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Put 2",
      });
      const response = await awaitTestRequest(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        { method: "PUT" },
      );
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (additional coverage)", () => {
    test("ticket form with phone-only fields (no email field) works", async () => {
      const listing = await createTestListing({
        fields: "phone",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });

      const response = await submitTicketForm(listing.slug, {
        name: "John Doe",
        phone: "555-1234",
      });
      // With fields="phone", email is not collected and extractContact returns "" for email
      expectRedirect(response, "https://example.com/thanks");
    });

    test("Square requires email when a free listing has a paid add-on", async () => {
      await settings.update.paymentProvider("square");
      const listing = await createTestListing({
        fields: "phone",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0,
      });
      const addOn = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Workshop kit",
        trigger: "optional",
      });

      const page = await handleRequest(mockRequest(`/ticket/${listing.slug}`));
      const html = await page.text();
      expect(html).toContain('name="email"');

      const response = await submitTicketForm(listing.slug, {
        [`addon_${addOn.id}`]: "1",
        name: "John Doe",
        phone: "555-1234",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Your Email is required"),
        false,
      );
    });

    test("Square requires email when a returning-customer charge makes a free listing paid", async () => {
      await settings.update.paymentProvider("square");
      await recordVisit(await hashPhone("555-1234"));
      const listing = await createTestListing({
        fields: "phone",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0,
      });
      await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        minVisits: 1,
        name: "Returning customer fee",
        trigger: "automatic",
      });

      const response = await submitTicketForm(listing.slug, {
        name: "John Doe",
        phone: "555-1234",
      });

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Your Email is required"),
        false,
      );
    });

    test("Square redirects when a returning-customer charge has the required email", async () => {
      await settings.update.paymentProvider("square");
      await settings.update.square.accessToken("EAAAl_test_123");
      await settings.update.square.locationId("L_test_123");
      await recordVisit(await hashPhone("555-1234"));
      const listing = await createTestListing({
        fields: "phone",
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
        unitPrice: 0,
      });
      await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        minVisits: 1,
        name: "Returning customer fee",
        trigger: "automatic",
      });
      const { squarePaymentProvider } = await import(
        "#shared/square-provider.ts"
      );
      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const checkout = stub(
        squarePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://square.example/checkout",
            sessionId: "square_order_123",
          });
        },
      );

      try {
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
          phone: "555-1234",
        });

        expectCheckoutRedirect(response);
        expect(capturedIntent?.email).toBe("john@example.com");
      } finally {
        checkout.restore();
      }
    });

    test("ticket form with invalid quantity rejects submission", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        thankYouUrl: "https://example.com/thanks",
      });

      // Submit with non-numeric quantity — parsed as 0, rejected
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing.id}`]: "abc",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("select at least one ticket"),
        false,
      );
    });

    test("skips sold-out listings in quantity parsing", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 1,
        name: "Multi Soldout Parse 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Soldout Parse 2",
      });

      // Fill up listing1 to make it sold out
      await bookAttendee(listing1, {
        email: "first@example.com",
        name: "First",
        quantity: 1,
      });

      // GET the ticket page (sold-out listing will show Sold Out label)
      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      expect(getResponse.status).toBe(200);
      const html = await getResponse.text();
      expect(html).toContain("Sold Out");

      // POST with quantity for both listings - sold out listing's quantity is ignored
      const csrfToken = getTicketCsrfToken(html);
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });

    test("ticket with invalid quantity form value falls back to 0", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Invalid Qty 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Invalid Qty 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with non-numeric quantity for listing1 and valid for listing2
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "abc",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      // Only listing2 should have an attendee
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });

    test("ticket paid checks availability and rejects sold out", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 1,
        maxQuantity: 5,
        name: "Multi Avail 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Avail 2",
        unitPrice: 1000,
      });

      // Fill listing1
      await bookAttendee(listing1, {
        email: "first@example.com",
        name: "First",
        paymentId: "pi_first",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Try to purchase - listing1 is sold out
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Should redirect to checkout since only listing2 has quantity (listing1 is sold out and skipped)
      expect(response.status).toBe(302);
      resetStripeClient();
    });

    test("returns null for non-ticket paths", async () => {
      const response = await handleRequest(mockRequest("/notticket/test"));
      expect(response.status).toBe(404);
    });

    test("returns null when slug is empty from path extraction", async () => {
      const response = await handleRequest(mockRequest("/ticket/"));
      // Path /ticket/ is normalized to /ticket, which doesn't match slug pattern
      expect(response.status).toBe(404);
    });
  });

  describe("routes/public.ts (ticket CSRF)", () => {
    test("ticket POST rejects invalid CSRF token", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Csrf 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Csrf 2",
      });

      // POST without getting CSRF token first
      const response = await handleRequest(
        mockFormRequest(`/ticket/${listing1.slug}+${listing2.slug}`, {
          email: "john@example.com",
          name: "John",
        }),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid or expired form"),
        false,
      );
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing path)", () => {
    test("shows payment not configured error for ticket when no provider", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Noprov 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Noprov 2",
        unitPrice: 1000,
      });

      // Now clear the provider to simulate no provider
      const { settings: s } = await import("#shared/db/settings.ts");
      await s.update.clearPaymentProvider();

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      // Free registration path since provider is cleared and isPaymentsEnabled returns false
      expectReservedRedirectWithTokens(response);
      resetStripeClient();
    });
  });

  describe("POST ticket capacity check via atomic create", () => {
    test("shows error for free ticket when atomic create fails", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Free Atomic 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Free Atomic 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock attendeesApi to fail (capacity exceeded)
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const originalFn = attendeesApi.createAttendeeAtomic;
      attendeesApi.createAttendeeAtomic = () =>
        Promise.resolve({
          reason: "capacity_exceeded" as const,
          success: false as const,
        });

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("no longer has enough spots"),
          false,
        );
      } finally {
        attendeesApi.createAttendeeAtomic = originalFn;
      }
    });
  });

  describe("routes/public.ts (ticket paid flow)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("ticket paid flow redirects to Stripe checkout", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Paid Flow 1",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Paid Flow 2",
        unitPrice: 500,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      // Should redirect to Stripe checkout
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).toContain("checkout.stripe.com");
    });

    test("ticket paid flow shows error when session creation fails", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Nourl 1",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Nourl 2",
        unitPrice: 500,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock createCheckoutSession to return no URL
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve(null),
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Failed to create payment session"),
          false,
        );
      } finally {
        mockCreate.restore();
      }
    });

    test("ticket paid flow shows validation error from checkout session", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Valerr 1",
        unitPrice: 1000,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Valerr 2",
        unitPrice: 500,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        () => Promise.resolve({ error: "Invalid phone number format" }),
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Invalid phone number format"),
          false,
        );
      } finally {
        mockCreate.restore();
      }
    });

    test("skips sold-out listings in quantity parsing", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 1,
        name: "Multi Soldout 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Soldout 2",
      });

      // Fill listing1 to capacity
      await bookAttendee(listing1, {
        email: "first@example.com",
        name: "First",
        quantity: 1,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit with qty for both listings, but listing1 should be skipped as sold out
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      // Should succeed for listing2 only
      expectReservedRedirectWithTokens(response);
    });
  });

  describe("routes/public.ts (formatAtomicError encryption_error single-ticket)", () => {
    test("shows encryption error message when atomic create fails with encryption_error", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
      });

      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockAtomic = stub(attendeesApi, "createAttendeeAtomic", () =>
        Promise.resolve({
          reason: "encryption_error",
          success: false,
        }),
      );

      try {
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Registration failed"),
          false,
        );
      } finally {
        mockAtomic.restore();
      }
    });
  });

  describe("capacityErrorFormatter", () => {
    const format = capacityErrorFormatter({
      fallback: "fallback",
      generic: "generic",
      withName: (name) => `${name} is full`,
    });

    test("returns the named message for capacity_exceeded with an listing name", () => {
      expect(format("capacity_exceeded", "My Listing")).toBe(
        "My Listing is full",
      );
    });

    test("returns the generic capacity message when no listing name is given", () => {
      expect(format("capacity_exceeded", "")).toBe("generic");
    });

    test("returns the fallback for non-capacity reasons", () => {
      expect(format("encryption_error", "My Listing")).toBe("fallback");
    });
  });

  describe("routes/public.ts (ticket quantity field missing from form)", () => {
    test("defaults to 0 when quantity field is absent from ticket form", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Nofield 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Nofield 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Submit form with quantity for listing2 only; listing1 has no quantity field at all
      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);

      // Verify only listing2 got an attendee
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(0);
      expect(attendees2.length).toBe(1);
    });
  });

  describe("routes/public.ts (ticket paid availability check fails)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns error when paid ticket availability check fails", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Avail Race 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Avail Race 2",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock checkBatchAvailability via attendeesApi to return false,
      // simulating a race condition where listing sells out between page load and check
      const { attendeesApi } = await import("#shared/db/attendees.ts");
      const mockBatch = stub(attendeesApi, "checkBatchAvailability", () =>
        Promise.resolve(false),
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("some tickets are no longer available"),
          false,
        );
      } finally {
        mockBatch.restore();
      }
    });
  });

  describe("iframe checkout popup (Stripe cannot run in iframes)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("returns popup page instead of redirect for single-ticket paid listing in iframe", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Iframe Paid Single",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing.slug}?iframe=true`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      await expectHtmlResponse(
        response,
        200,
        "data-checkout-popup",
        "Pay Now",
        'target="_blank"',
      );
    });

    test("returns 302 redirect for single-ticket paid listing without iframe", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Non-iframe Paid Single",
        unitPrice: 1000,
      });

      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });

      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();
      expect(location?.startsWith("https://")).toBe(true);
    });

    test("returns popup page for ticket paid listing in iframe", async () => {
      await setupStripe();
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Iframe Multi 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Iframe Multi 2",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}?iframe=true`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );

      await expectHtmlResponse(
        response,
        200,
        "data-checkout-popup",
        "Pay Now",
        'target="_blank"',
      );
    });
  });

  describe("routes/public.ts (withPaymentProvider onMissing ticket)", () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("shows payment not configured error when provider returns null for ticket", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Noprov Miss 1",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Noprov Miss 2",
        unitPrice: 1000,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      // Mock paymentsApi.getConfiguredProvider to return null so getActivePaymentProvider
      // returns null, while isPaymentsEnabled still returns true from the DB
      const { paymentsApi } = await import("#shared/payments.ts");
      const mockConfigured = stub(
        paymentsApi,
        "getConfiguredProvider",
        () => null,
      );

      try {
        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Payments are not configured"),
          false,
        );
      } finally {
        mockConfigured.restore();
      }
    });
  });

  describe("closes_at (single ticket)", () => {
    test("shows 'Registration closed.' when closes_at is in the past", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing = await createTestListing({ closesAt: pastDate });

      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await expectHtmlResponse(
        response,
        200,
        "Registration closed.",
      );
      expect(html).not.toContain("Continue");
    });

    test("shows form when closes_at is in the future", async () => {
      const futureDate = new Date(Date.now() + 3600000)
        .toISOString()
        .slice(0, 16);
      const listing = await createTestListing({ closesAt: futureDate });

      const html = await assertPublicHtml(
        `/ticket/${listing.slug}`,
        "Continue",
      );
      expect(html).not.toContain("Registration closed.");
    });

    test("shows form when closes_at is null", async () => {
      const listing = await createTestListing();

      const html = await assertPublicHtml(
        `/ticket/${listing.slug}`,
        "Continue",
      );
      expect(html).not.toContain("Registration closed.");
    });

    test("shows 'registration closed while you were submitting' on POST when closes_at is past", async () => {
      // Create listing with future closes_at so we can get CSRF token
      const futureDate = new Date(Date.now() + 3600000)
        .toISOString()
        .slice(0, 16);
      const listing = await createTestListing({ closesAt: futureDate });

      // Get CSRF token from the ticket page
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      // Now set closes_at to past
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      await updateTestListing(listing.id, { closesAt: pastDate });

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${listing.slug}`,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Sorry, registration closed while you were submitting.",
        ),
        false,
      );
    });
  });

  describe("closes_at (ticket)", () => {
    test("shows 'Registration closed.' when all listings are closed", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing1 = await createTestListing({ closesAt: pastDate });
      const listing2 = await createTestListing({ closesAt: pastDate });

      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Registration closed.",
      );
    });

    test("shows 'Registration Closed' label for individual closed listing in ticket", async () => {
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      const listing1 = await createTestListing({ closesAt: pastDate });
      const listing2 = await createTestListing();

      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Registration Closed",
        listing2.name, // open listing shows form
      );
    });

    test("shows error on POST when listing closes during submission", async () => {
      // Create two listings, one will close during submission
      const futureDate = new Date(Date.now() + 3600000)
        .toISOString()
        .slice(0, 16);
      const listing1 = await createTestListing({ closesAt: futureDate });
      const listing2 = await createTestListing();

      // Get CSRF token
      const getResponse = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      // Close listing1
      const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
      await updateTestListing(listing1.id, { closesAt: pastDate });

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining(
          "Sorry, registration closed while you were submitting.",
        ),
        false,
      );
    });
  });

  describe("daily listings (single ticket)", () => {
    // A valid bookable date: tomorrow (today + 1 day)
    const validDate = addDays(todayInTz("UTC"), 1);

    test("GET shows date selector for daily listing", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      await assertPublicHtml(
        `/ticket/${listing.slug}`,
        "Select Date",
        '<select name="date"',
      );
    });

    test("GET shows no-dates message when no dates available", async () => {
      // Create a daily listing where minimum_days_before > maximum_days_after
      // so the date range is empty (start > end)
      const listing = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maximumDaysAfter: 7,
        minimumDaysBefore: 30,
      });
      await assertPublicHtml(
        `/ticket/${listing.slug}`,
        "No dates are currently available for booking",
      );
    });

    test("POST succeeds for free daily listing with valid date", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const response = await submitTicketForm(listing.slug, {
        date: validDate,
        email: "daily@example.com",
        name: "Daily User",
      });
      expectRedirect(response, "https://example.com/thanks");
    });

    test("POST rejects daily listing with missing date", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const response = await submitTicketForm(listing.slug, {
        email: "daily@example.com",
        name: "Daily User",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Please select a valid date"),
        false,
      );
    });

    test("POST rejects daily listing with invalid date", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const response = await submitTicketForm(listing.slug, {
        date: "2099-01-01",
        email: "daily@example.com",
        name: "Daily User",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Please select a valid date"),
        false,
      );
    });

    test("POST checks per-date capacity for daily listings", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      // Fill up the date
      await submitTicketForm(listing.slug, {
        date: validDate,
        email: "first@example.com",
        name: "First User",
      });

      // Second booking for same date should fail
      const response = await submitTicketForm(listing.slug, {
        date: validDate,
        email: "second@example.com",
        name: "Second User",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("not enough spots available"),
        false,
      );
    });

    test("POST allows booking different dates at capacity", async () => {
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maxAttendees: 1,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      // Book first date
      const response1 = await submitTicketForm(listing.slug, {
        date: validDate,
        email: "first@example.com",
        name: "First User",
      });
      expect(response1.status).toBe(302);

      // Book different date should succeed
      const otherDate = addDays(todayInTz("UTC"), 2);
      const response2 = await submitTicketForm(listing.slug, {
        date: otherDate,
        email: "second@example.com",
        name: "Second User",
      });
      expect(response2.status).toBe(302);
    });

    test("POST redirects to checkout for paid daily listing", async () => {
      await setupStripe();

      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        unitPrice: 500,
      });

      const getResponse = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          `/ticket/${listing.slug}`,
          {
            csrf_token: csrfToken,
            date: validDate,
            email: "paid@example.com",
            name: "Paid Daily User",
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();

      resetStripeClient();
    });

    test("daily listing excludes holiday dates", async () => {
      // Create a holiday covering tomorrow
      await createTestHoliday({
        endDate: validDate,
        name: "Test Holiday",
        startDate: validDate,
      });

      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const html = await assertPublicHtml(`/ticket/${listing.slug}`);
      // The holiday date should not appear as an option
      expect(html).not.toContain(`value="${validDate}"`);
    });
  });

  describe("daily listings (ticket)", () => {
    const validDate = addDays(todayInTz("UTC"), 1);

    test("GET shows date selector for ticket with daily listings", async () => {
      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const listing2 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Select Date",
        '<select name="date"',
      );
    });

    test("POST rejects ticket daily listing without date", async () => {
      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const listing2 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Please select a valid date"),
        false,
      );
    });

    test("POST succeeds for free ticket daily listings with valid date", async () => {
      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const listing2 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            date: validDate,
            email: "multidaily@example.com",
            name: "Multi Daily User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });

    test("POST redirects to checkout for paid ticket daily listings", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        unitPrice: 300,
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("No CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            date: validDate,
            email: "multipaid@example.com",
            name: "Multi Daily Paid",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location");
      expect(location).not.toBeNull();

      resetStripeClient();
    });

    test("shows date and location on ticket page when listings have them", async () => {
      const listing1 = await createTestListing({
        date: "2026-06-15T14:00",
        location: "Village Hall",
        maxAttendees: 50,
        name: "Multi Date 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Date 2",
      });
      // Listing 1 has date and location, listing 2 does not
      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Multi Date 1",
        "Multi Date 2",
      );
    });

    test("computes shared dates across daily listings", async () => {
      // listing1: only bookable on Monday, listing2: bookable all days
      // Shared dates should only be Mondays
      const listing1 = await createTestListing({
        bookableDays: ["Monday"],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      const listing2 = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
      });
      // Should contain Monday dates but not Tuesday dates
      const html = await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "Monday",
      );
      expect(html).not.toContain("Tuesday");
    });
  });

  describe("terms and conditions (single ticket)", () => {
    test("shows terms checkbox when terms are configured", async () => {
      await settings.update.terms("I agree to the listing rules.");

      const listing = await createTestListing({ maxAttendees: 50 });
      await assertPublicHtml(
        `/ticket/${listing.slug}`,
        "agree_terms",
        "I agree to the listing rules.",
        "I agree to the terms above",
      );
    });

    test("does not show terms checkbox when no terms configured", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const html = await assertPublicHtml(`/ticket/${listing.slug}`);
      expect(html).not.toContain("agree_terms");
    });

    test("rejects submission without agreeing to terms", async () => {
      await settings.update.terms("You must accept the rules.");

      const listing = await createTestListing({ maxAttendees: 50 });
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("You must agree to the terms and conditions"),
        false,
      );
    });

    test("accepts submission when terms are agreed to", async () => {
      await settings.update.terms("You must accept the rules.");

      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(listing.slug, {
        agree_terms: "1",
        email: "john@example.com",
        name: "John Doe",
      });
      expectRedirect(response, "https://example.com/thanks");
    });

    test("succeeds without checkbox when no terms configured", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "https://example.com/thanks",
      });
      const response = await submitTicketForm(listing.slug, {
        email: "john@example.com",
        name: "John Doe",
      });
      expectRedirect(response, "https://example.com/thanks");
    });
  });

  describe("terms and conditions (ticket)", () => {
    test("shows terms checkbox on ticket page when configured", async () => {
      await settings.update.terms("Multi-listing terms apply.");

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi 2",
      });
      await assertPublicHtml(
        `/ticket/${listing1.slug}+${listing2.slug}`,
        "agree_terms",
        "Multi-listing terms apply.",
      );
    });

    test("rejects ticket submission without agreeing to terms", async () => {
      await settings.update.terms("Must agree to policy.");

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi Rej 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi Rej 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("You must agree to the terms and conditions"),
        false,
      );
    });

    test("accepts ticket submission when terms are agreed to", async () => {
      await settings.update.terms("Must agree to policy.");

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi Ok 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "TC Multi Ok 2",
      });

      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(
          path,
          {
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            agree_terms: "1",
            csrf_token: csrfToken,
          },
          `csrf_token=${csrfToken}`,
        ),
      );
      expectReservedRedirectWithTokens(response);
    });
  });

  describe("can_pay_more", () => {
    afterEach(() => {
      resetStripeClient();
    });

    const payMoreListing = (overrides: Record<string, unknown> = {}) =>
      createTestListing({
        canPayMore: true,
        maxAttendees: 50,
        unitPrice: 1000,
        ...overrides,
      });

    test("GET shows price input when can_pay_more is enabled", async () => {
      const listing = await payMoreListing();
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).toMatch(/name="custom_price(_\d+)?"/);

      expect(html).toContain("Price per ticket (£10 minimum)");
      expect(html).toContain('value="10.00"');
      expect(html).toContain("required");
    });

    test("GET does not show price input when can_pay_more is disabled", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).not.toMatch(/name="custom_price(_\d+)?"/);
    });

    test("GET shows price input for can_pay_more listings with zero unit_price", async () => {
      const listing = await payMoreListing({ unitPrice: undefined });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).toMatch(/name="custom_price(_\d+)?"/);

      expect(html).toContain("Price per ticket (optional, up to £100)");
      expect(html).toContain('min="0.00"');
    });

    test("GET shows optional price input for free can_pay_more listings", async () => {
      const listing = await payMoreListing({ unitPrice: 0 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).toMatch(/name="custom_price(_\d+)?"/);

      expect(html).toContain("Price per ticket (optional, up to £100)");
      expect(html).toContain('value="0.00" min="0.00" max="100.00"');
    });

    test("POST free can_pay_more with custom price redirects to checkout", async () => {
      await setupStripe();
      const listing = await payMoreListing({ unitPrice: 0 });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "5.00",
        email: "donor@example.com",
        name: "Donor",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("POST free can_pay_more with empty price registers for free", async () => {
      const listing = await payMoreListing({ unitPrice: 0 });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "",
        email: "free@example.com",
        name: "Freebie",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).not.toContain("checkout");
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });

    test("POST free can_pay_more with zero price registers for free", async () => {
      const listing = await payMoreListing({ unitPrice: 0 });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "0",
        email: "free@example.com",
        name: "Freebie",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") || "";
      expect(location).not.toContain("checkout");
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
    });

    test("POST rejects price below minimum", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "5.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("minimum"), false);
    });

    test("POST accepts price at minimum and redirects to checkout", async () => {
      await setupStripe();
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "10.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("POST accepts price above minimum and redirects to checkout", async () => {
      await setupStripe();
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "25.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("POST rejects price above maximum", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "150.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("maximum"), false);
    });

    test("POST preserves form values when price exceeds maximum", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "150.00",
        email: "preserved@example.com",
        name: "Preserved Name",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("maximum"), false);
    });

    test("POST accepts price at maximum", async () => {
      await setupStripe();
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "100.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("GET shows min price in label", async () => {
      const listing = await payMoreListing();
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).toContain("£10 minimum");
    });

    test("GET shows max price for free can_pay_more listing", async () => {
      const listing = await payMoreListing({ unitPrice: 0 });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing.slug}`),
      );
      const html = await response.text();
      expect(html).toContain("up to £100");
    });

    test("POST rejects empty custom_price for paid can_pay_more listing", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("enter a price"), false);
    });

    test("POST rejects invalid custom_price", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "abc",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("valid price"), false);
    });

    test("POST rejects negative custom_price", async () => {
      const listing = await payMoreListing();
      const response = await submitTicketForm(listing.slug, {
        custom_price: "-5.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("valid price"), false);
    });

    test("GET ticket page shows pay-more inputs only for can_pay_more listings", async () => {
      const listing1 = await payMoreListing({
        name: "Pay More Multi",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Normal Multi",
        unitPrice: 1000,
      });
      const response = await handleRequest(
        mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
      );
      const html = await response.text();
      expect(html).toContain(`name="custom_price_${listing1.id}"`);
      expect(html).not.toContain(`name="custom_price_${listing2.id}"`);
    });

    test("POST ticket with can_pay_more redirects to checkout", async () => {
      await setupStripe();
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Pay More A",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal B",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`custom_price_${listing1.id}`]: "15.00",
      });
      expectCheckoutRedirect(response);
    });

    test("POST ticket rejects custom_price below minimum", async () => {
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Pay More Reject",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal Reject",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`custom_price_${listing1.id}`]: "2.00",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("minimum"), false);
    });

    test("POST ticket rejects custom_price above maximum", async () => {
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Pay More Max Reject",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal Max Reject",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`custom_price_${listing1.id}`]: "200.00",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("maximum"), false);
    });

    test("POST ticket skips price check for can_pay_more listing with qty 0", async () => {
      await setupStripe();
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Pay More Skip",
        unitPrice: 500,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal Skip",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "0",
        [`quantity_${listing2.id}`]: "1",
      });
      expectCheckoutRedirect(response);
    });

    test("POST ticket free can_pay_more with custom price redirects to checkout", async () => {
      await setupStripe();
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Free Donate",
        unitPrice: 0,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal Paid",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`custom_price_${listing1.id}`]: "5.00",
      });
      expectCheckoutRedirect(response);
    });

    test("POST ticket free can_pay_more with zero price still processes paid listing", async () => {
      await setupStripe();
      const listing1 = await payMoreListing({
        maxQuantity: 5,
        name: "Free No Donate",
        unitPrice: 0,
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Normal Paid 2",
        unitPrice: 1000,
      });
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "john@example.com",
        name: "John Doe",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`custom_price_${listing1.id}`]: "0",
      });
      expectCheckoutRedirect(response);
    });

    test("admin edit page shows can_pay_more checked for enabled listing", async () => {
      const listing = await payMoreListing();
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie: await testCookie(),
        },
      );
      const html = await response.text();
      expect(hasCheckedInput(html, "can_pay_more", "1")).toBe(true);
    });

    test("admin edit page shows can_pay_more unchecked for disabled listing", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const response = await awaitTestRequest(
        `/admin/listing/${listing.id}/edit`,
        {
          cookie: await testCookie(),
        },
      );
      const html = await response.text();
      expect(html).toContain('name="can_pay_more"');
      expect(hasCheckedInput(html, "can_pay_more", "1")).toBe(false);
    });

    test("POST respects custom max_price", async () => {
      const listing = await payMoreListing({ maxPrice: 2000 });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "25.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("maximum"), false);
    });

    test("POST accepts price within custom max_price", async () => {
      await setupStripe();
      const listing = await payMoreListing({ maxPrice: 5000 });
      const response = await submitTicketForm(listing.slug, {
        custom_price: "45.00",
        email: "test@example.com",
        name: "Test User",
        quantity: "1",
      });
      expectCheckoutRedirect(response);
    });
  });

  describe("booking form listing_id manipulation", () => {
    test("single-ticket form ignores injected listing_id field", async () => {
      const target = await createTestListing({
        maxAttendees: 50,
        name: "Target Listing",
      });
      const other = await createTestListing({
        maxAttendees: 50,
        name: "Other Listing",
      });

      // Submit form to target listing but inject other listing's id
      const response = await submitTicketForm(target.slug, {
        email: "mallory@example.com",
        items: singleItem(other.id, 1, 0),
        name: "Mallory",
      });
      // Booking succeeds (302 redirect to thank-you URL)
      expect(response.status).toBe(302);

      // Verify booking went to the URL's listing, not the injected one
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const targetAttendees = await getAttendeesRaw(target.id);
      const otherAttendees = await getAttendeesRaw(other.id);
      expect(targetAttendees.length).toBe(1);
      expect(otherAttendees.length).toBe(0);
    });

    test("ticket form ignores quantity fields for listings not in URL", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Legit Listing 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Legit Listing 2",
      });
      const secret = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Secret Listing",
      });

      // Submit ticket form with only listing1+listing2 in URL
      // but inject quantity for the secret listing
      const path = `/ticket/${listing1.slug}+${listing2.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const csrfToken = getTicketCsrfToken(await getResponse.text());
      if (!csrfToken) throw new Error("Failed to get CSRF token");

      const response = await handleRequest(
        mockFormRequest(path, {
          email: "mallory@example.com",
          name: "Mallory",
          [`quantity_${listing1.id}`]: "1",
          [`quantity_${listing2.id}`]: "0",
          [`quantity_${secret.id}`]: "3",
          csrf_token: csrfToken,
        }),
      );
      expectReservedRedirectWithTokens(response);

      // Verify only listing1 was booked; secret listing was not
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      const secretAttendees = await getAttendeesRaw(secret.id);
      expect(attendees1.length).toBe(1);
      expect(attendees2.length).toBe(0);
      expect(secretAttendees.length).toBe(0);
    });

    test("ticket URL cannot book inactive listings", async () => {
      const active = await createTestListing({
        maxAttendees: 50,
        name: "Active Listing",
      });
      const inactive = await createTestListing({
        maxAttendees: 50,
        name: "Inactive Listing",
      });
      await deactivateTestListing(inactive.id);

      // Try to load ticket page with inactive listing in URL
      const path = `/ticket/${active.slug}+${inactive.slug}`;
      const getResponse = await handleRequest(mockRequest(path));
      const html = await getResponse.text();

      // Page should load but only show the active listing
      expect(html).toContain("Active Listing");
      expect(html).not.toContain("Inactive Listing");
    });
  });

  describe("single-ticket with custom questions", () => {
    /** Create a question with answers and assign it to an listing */
    const setupQuestionForListing = async (listingId: number) => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "T-shirt size?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Small",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Large",
      });
      await setListingQuestions(listingId, [q.id]);
      return { answer1: a1, answer2: a2, question: q };
    };

    test("saves answers when question is answered correctly", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });
      const { question, answer1 } = await setupQuestionForListing(listing.id);

      const response = await submitTicketForm(listing.slug, {
        email: "question@example.com",
        name: "Question User",
        [`question_${question.id}`]: String(answer1.id),
      });
      expectReservedRedirectWithTokens(response);

      // Verify answers were saved
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      const batch = await getAttendeeAnswersBatch([attendees[0]!.id], {
        texts: false,
      });
      expect(batch.get(attendees[0]!.id)).toEqual([answer1.id]);
    });

    test("blocks the booking when a sold-out answer tier is selected", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const { question, answer1 } = await setupQuestionForListing(listing.id);
      // A stock-limited answer tier with no stock left, linked to "Small".
      const tier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "VIP upgrade",
        stock: 0,
        trigger: "answer",
      });
      await setModifierAnswers(tier.id, [answer1.id]);

      const response = await submitTicketForm(listing.slug, {
        email: "vip@example.com",
        name: "VIP User",
        [`question_${question.id}`]: String(answer1.id),
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("no longer available"),
        false,
      );
    });

    test("a free booking consumes answer-tier stock, blocking the next over it", async () => {
      const listing = await createTestListing({
        maxAttendees: 50,
        thankYouUrl: "",
      });
      const { question, answer1 } = await setupQuestionForListing(listing.id);
      // Payments are disabled here, so bookings complete for free — but a
      // stock-limited answer tier must still be consumed so it can't be
      // over-sold across free bookings.
      const tier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "VIP upgrade",
        stock: 1,
        trigger: "answer",
      });
      await setModifierAnswers(tier.id, [answer1.id]);

      const first = await submitTicketForm(listing.slug, {
        email: "first@example.com",
        name: "First",
        [`question_${question.id}`]: String(answer1.id),
      });
      expectReservedRedirectWithTokens(first);

      // The unit was consumed, but with payments off nothing was collected: the
      // usage is recorded without inflating the tier's reported revenue.
      const afterFirst = (await getAllModifiers()).find(
        (m) => m.id === tier.id,
      );
      expect(afterFirst?.total_uses).toBe(1);
      expect(afterFirst?.total_revenue).toBe(0);

      // The single unit is now spent, so the next booking of the tier is blocked.
      const second = await submitTicketForm(listing.slug, {
        email: "second@example.com",
        name: "Second",
        [`question_${question.id}`]: String(answer1.id),
      });
      expect(second.status).toBe(302);
      expectFlash(
        second,
        expect.stringContaining("no longer available"),
        false,
      );
    });

    test("returns error when required question is unanswered", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      await setupQuestionForListing(listing.id);

      const response = await submitTicketForm(listing.slug, {
        email: "question@example.com",
        name: "Question User",
        // No question answer provided
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Please answer"), false);
    });

    test("returns error when answer ID is invalid", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const { question } = await setupQuestionForListing(listing.id);

      const response = await submitTicketForm(listing.slug, {
        email: "question@example.com",
        name: "Question User",
        [`question_${question.id}`]: "99999",
      });
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid answer for"),
        false,
      );
    });

    test("daily listing parses date after question validation", async () => {
      const today = todayInTz("UTC");
      const validDate = addDays(today, 1);
      const listing = await createTestListing({
        bookableDays: [
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ],
        listingType: "daily",
        maxAttendees: 50,
        maximumDaysAfter: 14,
        minimumDaysBefore: 0,
        thankYouUrl: "",
      });
      const { question, answer1 } = await setupQuestionForListing(listing.id);

      const response = await submitTicketForm(listing.slug, {
        date: validDate,
        email: "dailyq@example.com",
        name: "Daily Q User",
        [`question_${question.id}`]: String(answer1.id),
      });
      expectReservedRedirectWithTokens(response);
    });
  });

  describe("ticket with custom questions", () => {
    const setupQuestionForListings = async (listingIds: number[]) => {
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Dietary needs?",
      });
      const a1 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "None",
      });
      const a2 = await answersTable.insert({
        questionId: q.id,
        sortOrder: 1,
        text: "Vegetarian",
      });
      for (const eid of listingIds) {
        await setListingQuestions(eid, [q.id]);
      }
      return { answer1: a1, answer2: a2, question: q };
    };

    test("saves answers for all attendees in ticket reservation", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Q1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Q2",
      });
      const { question, answer1 } = await setupQuestionForListings([
        listing1.id,
        listing2.id,
      ]);

      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "multiq@example.com",
        name: "Multi Q User",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`question_${question.id}`]: String(answer1.id),
      });
      expectReservedRedirectWithTokens(response);

      // With multi-listing attendees, both listings share one attendee.
      // The shared question's answer is saved once on the attendee.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const att1 = await getAttendeesRaw(listing1.id);
      const attendeeId = att1[0]!.id;
      const batch = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      expect(batch.get(attendeeId)).toEqual([answer1.id]);
    });

    test("saves listing-specific answers only for each attendee", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Evt A",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Evt B",
      });
      // Question 1 assigned to listing1 only
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Listing A question?",
      });
      const a1 = await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "A answer",
      });
      await setListingQuestions(listing1.id, [q1.id]);

      // Question 2 assigned to listing2 only
      const q2 = await questionsTable.insert({
        displayType: "radio",
        text: "Listing B question?",
      });
      const a2 = await answersTable.insert({
        questionId: q2.id,
        sortOrder: 0,
        text: "B answer",
      });
      await setListingQuestions(listing2.id, [q2.id]);

      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "perlisting@example.com",
        name: "Per Listing User",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "1",
        [`question_${q1.id}`]: String(a1.id),
        [`question_${q2.id}`]: String(a2.id),
      });
      expectReservedRedirectWithTokens(response);

      // With multi-listing attendees, one attendee is linked to both listings.
      // Both listings' answers are stored on the same attendee.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const att1 = await getAttendeesRaw(listing1.id);
      const attendeeId = att1[0]!.id;
      const batch = await getAttendeeAnswersBatch([attendeeId], {
        texts: false,
      });
      const answers = batch.get(attendeeId) ?? [];
      expect(answers).toContain(a1.id);
      expect(answers).toContain(a2.id);
    });

    test("skips non-selected listings in listing answer map", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Q Shared 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        maxQuantity: 5,
        name: "Multi Q Shared 2",
      });
      // Question assigned to BOTH listings
      const q1 = await questionsTable.insert({
        displayType: "radio",
        text: "Shared question?",
      });
      const a1 = await answersTable.insert({
        questionId: q1.id,
        sortOrder: 0,
        text: "Shared answer",
      });
      await setListingQuestions(listing1.id, [q1.id]);
      await setListingQuestions(listing2.id, [q1.id]);

      const slug = `${listing1.slug}+${listing2.slug}`;
      // Only select listing1, skip listing2
      const response = await submitMultiTicketForm(slug, {
        email: "shared@example.com",
        name: "Shared Q User",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "0",
        [`question_${q1.id}`]: String(a1.id),
      });
      expectReservedRedirectWithTokens(response);

      // Verify answer saved only for listing1's attendee
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const att1 = await getAttendeesRaw(listing1.id);
      expect(att1.length).toBe(1);
      const batch = await getAttendeeAnswersBatch([att1[0]!.id], {
        texts: false,
      });
      expect(batch.get(att1[0]!.id)).toEqual([a1.id]);
      const att2 = await getAttendeesRaw(listing2.id);
      expect(att2.length).toBe(0);
    });

    test("validates question answers for selected listings only", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Filter 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Filter 2",
      });
      // Only assign question to listing1
      const q = await questionsTable.insert({
        displayType: "radio",
        text: "Listing1 question?",
      });
      await answersTable.insert({
        questionId: q.id,
        sortOrder: 0,
        text: "Yes",
      });
      await setListingQuestions(listing1.id, [q.id]);

      // Select only listing2 (no question assigned) - should succeed without answer
      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "filter@example.com",
        name: "Filter User",
        [`quantity_${listing1.id}`]: "0",
        [`quantity_${listing2.id}`]: "1",
      });
      expectReservedRedirectWithTokens(response);
    });

    test("returns error when ticket question is unanswered", async () => {
      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Error 1",
      });
      const listing2 = await createTestListing({
        maxAttendees: 50,
        name: "Multi Q Error 2",
      });
      await setupQuestionForListings([listing1.id]);

      const slug = `${listing1.slug}+${listing2.slug}`;
      const response = await submitMultiTicketForm(slug, {
        email: "error@example.com",
        name: "Error User",
        [`quantity_${listing1.id}`]: "1",
        [`quantity_${listing2.id}`]: "0",
        // No question answer provided
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Please answer"), false);
    });
  });

  describe("built site assignment", () => {
    test("registration succeeds when no sites available — auto-build is attempted in the background", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      const buildStub = stub(builderApi, "buildSite", () =>
        Promise.resolve({ error: "stubbed", ok: false as const }),
      );
      try {
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          name: "Monthly renewal tier",
          purchaseOnly: true,
        });
        const listing = await createTestListing({
          assignBuiltSite: true,
          maxAttendees: 10,
          thankYouUrl: "",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "test@example.com",
          name: "Test User",
        });
        expectReservedRedirectWithTokens(response);
        expect(buildStub.calls.length).toBe(1);
      } finally {
        buildStub.restore();
        restore();
      }
    });

    test("registration succeeds when assignable sites are available", async () => {
      const restore = setTestEnv({ CAN_BUILD_SITES: "true" });
      try {
        await createTestListing({
          hidden: true,
          monthsPerUnit: 1,
          name: "Monthly renewal tier",
          purchaseOnly: true,
        });
        const listing = await createTestListing({
          assignBuiltSite: true,
          maxAttendees: 10,
          thankYouUrl: "",
        });
        await insertBuiltSite("Available", "avail.b-cdn.net", "", "", true);
        const response = await submitTicketForm(listing.slug, {
          email: "test@example.com",
          name: "Test User",
        });
        expectReservedRedirectWithTokens(response);
      } finally {
        restore();
      }
    });
  });
});
