import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectIncludesAll,
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
      const { siteHomeForm } = await import("#templates/fields/site.ts");
      const html = siteHomeForm.render();
      expectIncludesAll(html, [
        "Website title",
        `Displayed as the main heading on all public pages (max ${MAX_INPUT_LENGTH} characters).`,
      ]);
      assertStringIncludes(
        inputNamed(html, "websiteTitle"),
        'autocomplete="off"',
      );
      // The id ties the label to the field; an emptied id breaks that link.
      assertStringIncludes(
        inputNamed(html, "websiteTitle"),
        'id="website_title"',
      );
      assertStringIncludes(html, "Homepage text");
      const homepage = inputNamed(html, "homepageText");
      expectIncludesAll(homepage, [
        'placeholder="Welcome to our site..."',
        // markdown: true wires the preview affordance to the textarea.
        "data-markdown-preview",
      ]);
    });

    test("serves the contact form box with its label", async () => {
      const { siteContactForm } = await import("#templates/fields/site.ts");
      const html = siteContactForm.render();
      inputNamed(html, "contactPageText");
      assertStringIncludes(html, "Contact page text");
    });
  });

  describe("GET /admin/site", () => {
    testRequiresAuth("/admin/site");

    test("shows homepage editor when authenticated", async () => {
      const response = await adminGet("/admin/site");
      await expectHtmlResponse(
        response,
        200,
        "Home page",
        "websiteTitle",
        "homepageText",
        "Formatting help",
      );
    });

    test("displays existing values", async () => {
      await settings.update.websiteTitle("My Listings");
      await settings.update.homepageText("Welcome!");
      const response = await adminGet("/admin/site");
      const html = await response.text();
      expectIncludesAll(html, ["My Listings", "Welcome!"]);
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
      assertStringIncludes(html, "Homepage updated");
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
      assertStringIncludes(html, "Title is required");
    });
  });

  describe("POST /admin/site", () => {
    testRequiresAuth("/admin/site", {
      body: {
        homepageText: "Hello",
        websiteTitle: "Test",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site",
          { csrfToken: "invalid", websiteTitle: "Test" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves website title and homepage text", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepageText: "Welcome!",
        websiteTitle: "My Site",
      });
      expectRedirectWithFlash("/admin/site", "Homepage updated")(response);

      expect(settings.websiteTitle).toBe("My Site");
      expect(settings.homepageText).toBe("Welcome!");
    });

    test("saving Site content does not publish Site", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepageText: "Draft",
        websiteTitle: "Draft site",
      });
      response.body?.cancel();
      expect(settings.features.site).toBe(false);
    });

    test("clears values when empty", async () => {
      await settings.update.websiteTitle("Old Title");
      await settings.update.homepageText("Old Text");
      const { response } = await adminFormPost("/admin/site", {
        homepageText: "",
        websiteTitle: "",
      });
      expect(response.status).toBe(302);
      expect(settings.websiteTitle).toBe("");
      expect(settings.homepageText).toBe("");
    });

    test("rejects title exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepageText: "",
        websiteTitle: "x".repeat(MAX_INPUT_LENGTH + 1),
      });
      await expectFlashRedirect(
        "/admin/site",
        expect.stringContaining(`${MAX_INPUT_LENGTH} characters or fewer`),
        false,
      )(response);
    });

    test("rejects homepage text exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site", {
        homepageText: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
        websiteTitle: "",
      });
      await expectFlashRedirect(
        "/admin/site",
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      )(response);
    });

    test("saves the complete website title at the shared limit", async () => {
      const title = "x".repeat(MAX_INPUT_LENGTH);
      const { response } = await adminFormPost("/admin/site", {
        websiteTitle: title,
      });
      expectRedirectWithFlash("/admin/site", "Homepage updated")(response);
      expect(settings.websiteTitle).toBe(title);
    });

    test("handles missing fields gracefully", async () => {
      const { response } = await adminFormPost("/admin/site");
      expect(response.status).toBe(302);
    });
  });
});
