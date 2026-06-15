import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { MAX_WEBSITE_TITLE_LENGTH, settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  adminFormPost,
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  hasCheckedInput,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

/** Assert a 302 redirect with a flash cookie containing the given text */
const expectRedirectContaining = (response: Response, text: string) => {
  expectRedirect(response);
  expectFlash(response, text);
};

describeWithEnv("server (admin site)", { db: true }, () => {
  describe("GET /admin/site", () => {
    testRequiresAuth("/admin/site");

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
      await settings.update.websiteTitle("My Listings");
      await settings.update.homepageText("Welcome!");
      const response = await awaitTestRequest("/admin/site", {
        cookie: await testCookie(),
      });
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
      expectRedirectContaining(response, "Homepage updated");

      expect(settings.websiteTitle).toBe("My Site");
      expect(settings.homepageText).toBe("Welcome!");
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
      expectRedirectWithFlash(
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
      expectRedirectWithFlash(
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

  describe("GET /admin/site/contact", () => {
    testRequiresAuth("/admin/site/contact");

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

    test("shows the contact form toggle even without Botpoison", async () => {
      const response = await awaitTestRequest("/admin/site/contact", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("contact_form_enabled");
      expect(html).toContain("Enable contact form");
      expect(html).toContain("No spam-protection provider is configured");
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

    test("displays error message from flash cookie", async () => {
      const cookie = await testCookie();
      const response = await awaitTestRequest(
        `/admin/site/contact?flash=${FLASH_TEST_ID}`,
        {
          cookie: `${cookie}; ${flashCookieHeader(
            "Something went wrong",
            false,
          )}`,
        },
      );
      const html = await response.text();
      expect(html).toContain("Something went wrong");
    });
  });

  describe("POST /admin/site/contact", () => {
    testRequiresAuth("/admin/site/contact", {
      body: {
        contact_page_text: "Hello",
      },
      method: "POST",
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
      const { response } = await adminFormPost("/admin/site/contact", {
        contact_page_text: "Email us!",
      });
      expectRedirectContaining(response, "Contact page updated");
      expect(settings.contactPageText).toBe("Email us!");
    });

    test("clears contact text when empty", async () => {
      await settings.update.contactPageText("Old text");
      const { response } = await adminFormPost("/admin/site/contact", {
        contact_page_text: "",
      });
      expect(response.status).toBe(302);
      expect(settings.contactPageText).toBe("");
    });

    test("rejects text exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site/contact", {
        contact_page_text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      });
      expectRedirectWithFlash(
        "/admin/site/contact",
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      )(response);
    });

    test("handles missing field gracefully", async () => {
      const { response } = await adminFormPost("/admin/site/contact");
      expect(response.status).toBe(302);
    });
  });

  describe("GET /admin/site/quotes", () => {
    testRequiresAuth("/admin/site/quotes");

    test("shows quote editor when authenticated", async () => {
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Quote Page",
        "quote_enabled",
        "Enable quote page",
        "quote_intro_text",
      );
    });

    test("warns when there are no purchase-only products", async () => {
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("no purchase-only products");
    });

    test("counts purchase-only products and ignores other listings", async () => {
      const { createTestListing } = await import("#test-utils");
      await createTestListing({ name: "Mug", purchaseOnly: true });
      await createTestListing({ name: "Regular Ticket" });
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("1 purchase-only product will be shown");
      expect(html).not.toContain("no purchase-only products");
    });

    test("pluralises the product count for multiple products", async () => {
      const { createTestListing } = await import("#test-utils");
      await createTestListing({ name: "Mug", purchaseOnly: true });
      await createTestListing({ name: "Tote", purchaseOnly: true });
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("2 purchase-only products will be shown");
    });

    test("displays existing intro text", async () => {
      await settings.update.quoteIntroText("Pick your products");
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Pick your products");
    });

    test("reflects the enabled state in the checkbox", async () => {
      await settings.update.quoteEnabled(true);
      const response = await awaitTestRequest("/admin/site/quotes", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(hasCheckedInput(html, "quote_enabled", "true")).toBe(true);
    });
  });

  describe("POST /admin/site/quotes", () => {
    testRequiresAuth("/admin/site/quotes", {
      body: { quote_intro_text: "Hi" },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/quotes",
          { csrf_token: "invalid", quote_intro_text: "Hi" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves the quote intro text", async () => {
      const { response } = await adminFormPost("/admin/site/quotes", {
        quote_intro_text: "Browse our range",
      });
      expectRedirectContaining(response, "Quote page updated");
      expect(settings.quoteIntroText).toBe("Browse our range");
    });

    test("rejects intro text exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site/quotes", {
        quote_intro_text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      });
      expectRedirectWithFlash(
        "/admin/site/quotes",
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      )(response);
    });
  });

  describe("POST /admin/site/quotes/toggle", () => {
    testRequiresAuth("/admin/site/quotes/toggle", {
      body: { quote_enabled: "true" },
      method: "POST",
    });

    test("enables the quote page", async () => {
      const { response } = await adminFormPost("/admin/site/quotes/toggle", {
        quote_enabled: "true",
      });
      expectRedirect(response, "/admin/site/quotes");
      expectFlash(response, "Quote page enabled");
      expect(settings.quoteEnabled).toBe(true);
    });

    test("disables the quote page when the box is unchecked", async () => {
      await settings.update.quoteEnabled(true);
      const { response } = await adminFormPost("/admin/site/quotes/toggle", {});
      expectRedirect(response, "/admin/site/quotes");
      expectFlash(response, "Quote page disabled");
      expect(settings.quoteEnabled).toBe(false);
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
      expect(html).toContain('href="/admin/site/quotes"');
      expect(html).toContain("Homepage");
      expect(html).toContain("Contact");
      expect(html).toContain("Quotes");
    };

    test("homepage shows subnav with Homepage, Contact and Quotes links", async () => {
      await expectSubnav("/admin/site");
    });

    test("contact page shows subnav with Homepage, Contact and Quotes links", async () => {
      await expectSubnav("/admin/site/contact");
    });

    test("quote page shows subnav with Homepage, Contact and Quotes links", async () => {
      await expectSubnav("/admin/site/quotes");
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

describeWithEnv(
  "server (admin site contact form)",
  {
    db: true,
    env: {
      BOTPOISON_PUBLIC_KEY: "pk_test_public",
      BOTPOISON_SECRET_KEY: "sk_test_secret",
    },
  },
  () => {
    describe("GET /admin/site/contact with Botpoison configured", () => {
      test("shows the contact form toggle", async () => {
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        await expectHtmlResponse(
          response,
          200,
          "Contact Form",
          "contact_form_enabled",
          "Enable contact form",
        );
      });

      test("notes that Botpoison spam protection is active", async () => {
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Botpoison is active");
      });

      test("warns when no business email is set", async () => {
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).toContain("Set a business email");
      });

      test("hides the business-email warning once one is set", async () => {
        await settings.update.businessEmail("owner@example.com");
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(html).not.toContain("Set a business email");
      });

      test("reflects the enabled state in the checkbox", async () => {
        await settings.update.contactFormEnabled(true);
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(hasCheckedInput(html, "contact_form_enabled", "true")).toBe(
          true,
        );
      });

      test("leaves the checkbox unchecked when disabled", async () => {
        const response = await awaitTestRequest("/admin/site/contact", {
          cookie: await testCookie(),
        });
        const html = await response.text();
        expect(hasCheckedInput(html, "contact_form_enabled", "true")).toBe(
          false,
        );
      });
    });

    describe("POST /admin/site/contact/form", () => {
      testRequiresAuth("/admin/site/contact/form", {
        body: { contact_form_enabled: "true" },
        method: "POST",
      });

      test("rejects invalid CSRF token", async () => {
        const response = await handleRequest(
          mockFormRequest(
            "/admin/site/contact/form",
            { contact_form_enabled: "true", csrf_token: "invalid" },
            await testCookie(),
          ),
        );
        expect(response.status).toBe(403);
      });

      test("enables the contact form", async () => {
        const { response } = await adminFormPost("/admin/site/contact/form", {
          contact_form_enabled: "true",
        });
        expectRedirect(response, "/admin/site/contact");
        expectFlash(response, "Contact form enabled");
        expect(settings.contactFormEnabled).toBe(true);
      });

      test("disables the contact form when the box is unchecked", async () => {
        await settings.update.contactFormEnabled(true);
        const { response } = await adminFormPost(
          "/admin/site/contact/form",
          {},
        );
        expectRedirect(response, "/admin/site/contact");
        expectFlash(response, "Contact form disabled");
        expect(settings.contactFormEnabled).toBe(false);
      });
    });
  },
);
