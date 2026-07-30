import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { MAX_WEBSITE_TITLE_LENGTH } from "#shared/db/settings/constants.ts";
import { settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  inputNamed,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

describeWithEnv("server (admin site home)", { db: true }, () => {
  describe("the site forms", () => {
    // The expected labels, hints, and names are written out here so a changed
    // form definition fails this test instead of moving the expectation along.
    test("serves the home form boxes with their labels and hints", async () => {
      const { siteHomeForm } = await import("#routes/admin/site.ts");
      const html = siteHomeForm.render();
      expect(html).toContain("Website title");
      expect(html).toContain(
        "Displayed as the main heading on all public pages (max 128 characters).",
      );
      expect(inputNamed(html, "website_title")).toContain('autocomplete="off"');
      expect(html).toContain("Homepage text");
      const homepage = inputNamed(html, "homepage_text");
      expect(homepage).toContain('placeholder="Welcome to our site..."');
      // markdown: true wires the preview affordance to the textarea.
      expect(homepage).toContain("data-markdown-preview");
    });

    test("serves the contact form box with its label", async () => {
      const { siteContactForm } = await import("#routes/admin/site.ts");
      const html = siteContactForm.render();
      inputNamed(html, "contact_page_text");
      expect(html).toContain("Contact page text");
    });
  });

  describe("GET /admin/site", () => {
    testRequiresAuth("/admin/site");

    test("shows homepage editor when authenticated", async () => {
      const response = await adminGet("/admin/site");
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
      await settings.update.websiteTitle("My Listings");
      await settings.update.homepageText("Welcome!");
      const response = await adminGet("/admin/site");
      const html = await response.text();
      expect(html).toContain("My Listings");
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

    test("displays error message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/site?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader("Title is required", false)}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Title is required");
    });
  });

  describe("POST /admin/site", () => {
    testRequiresAuth("/admin/site", {
      body: {
        homepage_text: "Hello",
        website_title: "Test",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { csrf_token: "invalid", website_title: "Test" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves website title and homepage text", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepage_text: "Welcome!",
        website_title: "My Site",
      });
      expectRedirectWithFlash("/admin/site", "Homepage updated")(response);

      expect(settings.websiteTitle).toBe("My Site");
      expect(settings.homepageText).toBe("Welcome!");
    });

    test("saving Site content does not publish Site", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepage_text: "Draft",
        website_title: "Draft site",
      });
      response.body?.cancel();
      expect(settings.features.site).toBe(false);
    });

    test("clears values when empty", async () => {
      await settings.update.websiteTitle("Old Title");
      await settings.update.homepageText("Old Text");
      const { response } = await adminFormPost("/admin/site", {
        homepage_text: "",
        website_title: "",
      });
      expect(response.status).toBe(302);
      expect(settings.websiteTitle).toBe("");
      expect(settings.homepageText).toBe("");
    });

    test("rejects title exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepage_text: "",
        website_title: "x".repeat(MAX_WEBSITE_TITLE_LENGTH + 1),
      });
      await expectFlashRedirect(
        "/admin/site",
        expect.stringContaining(
          `${MAX_WEBSITE_TITLE_LENGTH} characters or fewer`,
        ),
        false,
      )(response);
    });

    test("rejects homepage text exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepage_text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
        website_title: "",
      });
      await expectFlashRedirect(
        "/admin/site",
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      )(response);
    });

    test("handles missing fields gracefully", async () => {
      const { response } = await adminFormPost("/admin/site");
      expect(response.status).toBe(302);
    });
  });
});
