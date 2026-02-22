import { afterEach, beforeEach, describe, expect, test } from "#test-compat";
import {
  getContactPageTextFromDb,
  getHomepageTextFromDb,
  getWebsiteTitleFromDb,
  MAX_PAGE_TEXT_LENGTH,
  MAX_WEBSITE_TITLE_LENGTH,
  updateShowPublicSite,
  updateWebsiteTitle,
  updateHomepageText,
  updateContactPageText,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  createTestDbWithSetup,
  mockFormRequest,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
  expectAdminRedirect,
  loginAsAdmin,
} from "#test-utils";

describe("server (admin site)", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /admin/site", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/site"));
      expectAdminRedirect(response);
    });

    test("shows homepage editor when authenticated", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Home Page");
      expect(html).toContain("website_title");
      expect(html).toContain("homepage_text");
    });

    test("displays existing values", async () => {
      await updateWebsiteTitle("My Events");
      await updateHomepageText("Welcome!");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site", { cookie });
      const html = await response.text();
      expect(html).toContain("My Events");
      expect(html).toContain("Welcome!");
    });

    test("displays success message from query param", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        "/admin/site?success=Homepage+updated",
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("Homepage updated");
    });
  });

  describe("POST /admin/site", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/site", {
          website_title: "Test",
          homepage_text: "Hello",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { website_title: "Test", csrf_token: "invalid" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves website title and homepage text", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { website_title: "My Site", homepage_text: "Welcome!", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location")!)).toContain("Homepage updated");

      expect(await getWebsiteTitleFromDb()).toBe("My Site");
      expect(await getHomepageTextFromDb()).toBe("Welcome!");
    });

    test("clears values when empty", async () => {
      await updateWebsiteTitle("Old Title");
      await updateHomepageText("Old Text");
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { website_title: "", homepage_text: "", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(await getWebsiteTitleFromDb()).toBe(null);
      expect(await getHomepageTextFromDb()).toBe(null);
    });

    test("rejects title exceeding max length", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "x".repeat(MAX_WEBSITE_TITLE_LENGTH + 1),
            homepage_text: "",
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(`${MAX_WEBSITE_TITLE_LENGTH} characters or fewer`);
    });

    test("rejects homepage text exceeding max length", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "",
            homepage_text: "x".repeat(MAX_PAGE_TEXT_LENGTH + 1),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(`${MAX_PAGE_TEXT_LENGTH} characters or fewer`);
    });

    test("handles missing fields gracefully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest("/admin/site", { csrf_token: csrfToken }, cookie),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/site/contact", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/site/contact"));
      expectAdminRedirect(response);
    });

    test("shows contact editor when authenticated", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site/contact", { cookie });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Contact Page");
      expect(html).toContain("contact_page_text");
    });

    test("displays existing contact text", async () => {
      await updateContactPageText("Call us!");
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site/contact", { cookie });
      const html = await response.text();
      expect(html).toContain("Call us!");
    });

    test("displays success message from query param", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest(
        "/admin/site/contact?success=Contact+page+updated",
        { cookie },
      );
      const html = await response.text();
      expect(html).toContain("Contact page updated");
    });
  });

  describe("POST /admin/site/contact", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(
        mockFormRequest("/admin/site/contact", {
          contact_page_text: "Hello",
        }),
      );
      expectAdminRedirect(response);
    });

    test("rejects invalid CSRF token", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "Hello", csrf_token: "invalid" },
          cookie,
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves contact page text", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "Email us!", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location")!)).toContain("Contact page updated");
      expect(await getContactPageTextFromDb()).toBe("Email us!");
    });

    test("clears contact text when empty", async () => {
      await updateContactPageText("Old text");
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "", csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
      expect(await getContactPageTextFromDb()).toBe(null);
    });

    test("rejects text exceeding max length", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          {
            contact_page_text: "x".repeat(MAX_PAGE_TEXT_LENGTH + 1),
            csrf_token: csrfToken,
          },
          cookie,
        ),
      );
      expect(response.status).toBe(400);
      const html = await response.text();
      expect(html).toContain(`${MAX_PAGE_TEXT_LENGTH} characters or fewer`);
    });

    test("handles missing field gracefully", async () => {
      const { cookie, csrfToken } = await loginAsAdmin();
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { csrf_token: csrfToken },
          cookie,
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("site subnav", () => {
    test("homepage shows subnav with Homepage and Contact links", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site", { cookie });
      const html = await response.text();
      expect(html).toContain('href="/admin/site"');
      expect(html).toContain('href="/admin/site/contact"');
      expect(html).toContain("Homepage");
      expect(html).toContain("Contact");
    });

    test("contact page shows subnav with Homepage and Contact links", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site/contact", { cookie });
      const html = await response.text();
      expect(html).toContain('href="/admin/site"');
      expect(html).toContain('href="/admin/site/contact"');
      expect(html).toContain("Homepage");
      expect(html).toContain("Contact");
    });
  });

  describe("admin nav", () => {
    test("shows Site link when public site is enabled", async () => {
      await updateShowPublicSite(true);
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/site", { cookie });
      const html = await response.text();
      expect(html).toContain('href="/admin/site"');
    });

    test("hides Site link when public site is disabled", async () => {
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings", { cookie });
      const html = await response.text();
      expect(html).not.toContain('href="/admin/site"');
    });
  });
});
