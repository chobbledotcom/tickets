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
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
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
      await expectFlashRedirect(
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

  describe("GET /admin/site/order", () => {
    testRequiresAuth("/admin/site/order");

    test("shows order editor when authenticated", async () => {
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      await expectHtmlResponse(
        response,
        200,
        "Order Page",
        "order_enabled",
        "Enable order page",
        "order_intro_text",
      );
    });

    test("warns when there are no bookable listings", async () => {
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("no bookable listings");
    });

    test("counts every active, visible listing", async () => {
      const { createTestListing } = await import("#test-utils");
      await createTestListing({ name: "Mug", purchaseOnly: true });
      await createTestListing({ name: "Regular Ticket" });
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("2 listings will be shown");
      expect(html).not.toContain("no bookable listings");
    });

    test("uses the singular for a single listing", async () => {
      const { createTestListing } = await import("#test-utils");
      await createTestListing({ name: "Solo" });
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("1 listing will be shown");
    });

    test("displays existing intro text", async () => {
      await settings.update.orderIntroText("Pick your items");
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain("Pick your items");
    });

    test("reflects the enabled state in the checkbox", async () => {
      await settings.update.orderEnabled(true);
      const response = await awaitTestRequest("/admin/site/order", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(hasCheckedInput(html, "order_enabled", "true")).toBe(true);
    });
  });

  describe("POST /admin/site/order", () => {
    testRequiresAuth("/admin/site/order", {
      body: { order_intro_text: "Hi" },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/site/order",
          { csrf_token: "invalid", order_intro_text: "Hi" },
          await testCookie(),
        ),
      );
      expect(response.status).toBe(403);
    });

    test("saves the order intro text", async () => {
      const { response } = await adminFormPost("/admin/site/order", {
        order_intro_text: "Browse our range",
      });
      expectRedirectContaining(response, "Order page updated");
      expect(settings.orderIntroText).toBe("Browse our range");
    });

    test("rejects intro text exceeding max length", async () => {
      const { response } = await adminFormPost("/admin/site/order", {
        order_intro_text: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
      });
      await expectFlashRedirect(
        "/admin/site/order",
        expect.stringContaining(`${MAX_TEXTAREA_LENGTH} characters or fewer`),
        false,
      )(response);
    });
  });

  describe("POST /admin/site/order/toggle", () => {
    testRequiresAuth("/admin/site/order/toggle", {
      body: { order_enabled: "true" },
      method: "POST",
    });

    test("enables the order page", async () => {
      const { response } = await adminFormPost("/admin/site/order/toggle", {
        order_enabled: "true",
      });
      expectRedirect(response, "/admin/site/order");
      expectFlash(response, "Order page enabled");
      expect(settings.orderEnabled).toBe(true);
    });

    test("disables the order page when the box is unchecked", async () => {
      await settings.update.orderEnabled(true);
      const { response } = await adminFormPost("/admin/site/order/toggle", {});
      expectRedirect(response, "/admin/site/order");
      expectFlash(response, "Order page disabled");
      expect(settings.orderEnabled).toBe(false);
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
      expect(html).toContain('href="/admin/site/order"');
      expect(html).toContain("Homepage");
      expect(html).toContain("Contact");
      expect(html).toContain("Order");
    };

    test("homepage shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site");
    });

    test("contact page shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site/contact");
    });

    test("order page shows subnav with Homepage, Contact and Order links", async () => {
      await expectSubnav("/admin/site/order");
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
