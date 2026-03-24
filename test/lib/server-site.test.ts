import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MAX_PAGE_TEXT_LENGTH,
  MAX_WEBSITE_TITLE_LENGTH,
  settings,
} from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import {
  awaitTestRequest,
  describeWithEnv,
  expectAdminRedirect,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  FLASH_TEST_ID,
  flashCookieHeader,
  mockFormRequest,
  mockRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

/** Assert a 302 redirect with a flash cookie containing the given text */
const expectRedirectContaining = (response: Response, text: string) => {
  expectRedirect(response);
  expectFlash(response, text);
};

describeWithEnv("server (admin site)", { db: true }, () => {
  describe("GET /admin/site", () => {
    test("redirects to login when not authenticated", async () => {
      const response = await handleRequest(mockRequest("/admin/site"));
      expectAdminRedirect(response);
    });

    test("shows homepage editor when authenticated", async () => {
      const response = await awaitTestRequest("/admin/site", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Home Page",
        "website_title",
        "homepage_text",
        "Formatting help",
      );
    });

    test("displays existing values", async () => {
      await settings.update.websiteTitle("My Events");
      await settings.update.homepageText("Welcome!");
      const response = await awaitTestRequest("/admin/site", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("My Events");
      expect(html).toContain("Welcome!");
    });

    test("displays success message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/site?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Homepage updated")}`,
        },
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { website_title: "Test", csrf_token: "invalid" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves website title and homepage text", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "My Site",
            homepage_text: "Welcome!",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expectRedirectContaining(response, "Homepage updated");

      expect(settings.websiteTitle).toBe("My Site");
      expect(settings.homepageText).toBe("Welcome!");
    });

    test("clears values when empty", async () => {
      await settings.update.websiteTitle("Old Title");
      await settings.update.homepageText("Old Text");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "",
            homepage_text: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(settings.websiteTitle).toBe(null);
      expect(settings.homepageText).toBe(null);
    });

    test("rejects title exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "x".repeat(MAX_WEBSITE_TITLE_LENGTH + 1),
            homepage_text: "",
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        `${MAX_WEBSITE_TITLE_LENGTH} characters or fewer`,
      );
    });

    test("rejects homepage text exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          {
            website_title: "",
            homepage_text: "x".repeat(MAX_PAGE_TEXT_LENGTH + 1),
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        `${MAX_PAGE_TEXT_LENGTH} characters or fewer`,
      );
    });

    test("handles missing fields gracefully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
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
      const response = await awaitTestRequest("/admin/site/contact", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Contact Page",
        "contact_page_text",
        "Formatting help",
      );
    });

    test("displays existing contact text", async () => {
      await settings.update.contactPageText("Call us!");
      const response = await awaitTestRequest("/admin/site/contact", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Call us!");
    });

    test("displays success message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/site/contact?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Contact page updated")}`,
        },
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
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "Hello", csrf_token: "invalid" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves contact page text", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "Email us!", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expectRedirectContaining(response, "Contact page updated");
      expect(settings.contactPageText).toBe("Email us!");
    });

    test("clears contact text when empty", async () => {
      await settings.update.contactPageText("Old text");
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { contact_page_text: "", csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
      expect(settings.contactPageText).toBe(null);
    });

    test("rejects text exceeding max length", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          {
            contact_page_text: "x".repeat(MAX_PAGE_TEXT_LENGTH + 1),
            csrf_token: await testCsrfToken(),
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(
        response,
        400,
        `${MAX_PAGE_TEXT_LENGTH} characters or fewer`,
      );
    });

    test("handles missing field gracefully", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/contact",
          { csrf_token: await testCsrfToken() },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(302);
    });
  });

  describe("site subnav", () => {
    /** Fetch a site admin page and assert it contains subnav links */
    const expectSubnav = async (path: string) => {
      const response = await awaitTestRequest(path, {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('href="/admin/site"');
      expect(html).toContain('href="/admin/site/contact"');
      expect(html).toContain("Homepage");
      expect(html).toContain("Contact");
    };

    test("homepage shows subnav with Homepage and Contact links", async () => {
      await expectSubnav("/admin/site");
    });

    test("contact page shows subnav with Homepage and Contact links", async () => {
      await expectSubnav("/admin/site/contact");
    });
  });

  describe("admin nav", () => {
    test("shows Site link when public site is enabled", async () => {
      await settings.update.showPublicSite(true);
      const response = await awaitTestRequest("/admin/site", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain('href="/admin/site"');
    });

    test("hides Site link when public site is disabled", async () => {
      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).not.toContain('href="/admin/site"');
    });
  });
});
