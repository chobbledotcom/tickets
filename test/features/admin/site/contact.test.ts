/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  FLASH_TEST_ID,
  flashCookieHeader,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

/* jscpd:ignore-end */

describeWithEnv("server (admin site contact)", { db: true }, () => {
  describe("GET /admin/site/contact", () => {
    testRequiresAuth("/admin/site/contact");

    test("shows contact editor when authenticated", async () => {
      const response = await adminGet("/admin/site/contact");
      await expectHtmlResponse(
        response,
        200,
        "Contact page",
        "contact_page_text",
        "Formatting help",
      );
    });

    test("shows the contact form toggle even without Botpoison", async () => {
      const response = await adminGet("/admin/site/contact");
      const html = await response.text();
      expect(html).toContain("contact_form_enabled");
      expect(html).toContain("Enable contact form");
      expect(html).toContain("No spam-protection provider is configured");
    });

    test("displays existing contact text", async () => {
      await settings.update.contactPageText("Call us!");
      const response = await adminGet("/admin/site/contact");
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
      expectRedirectWithFlash(
        "/admin/site/contact",
        "Contact page updated",
      )(response);
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
        const response = await adminGet("/admin/site/contact");
        await expectHtmlResponse(
          response,
          200,
          "Contact form",
          "contact_form_enabled",
          "Enable contact form",
        );
      });

      test("notes that Botpoison spam protection is active", async () => {
        const response = await adminGet("/admin/site/contact");
        const html = await response.text();
        expect(html).toContain("Botpoison is active");
      });

      // The full note, not just "Set a business email": the settings nag says
      // that much on its own, so the short phrase can't tell the two apart.
      const businessEmailNote =
        "Set a business email on the Settings page to receive contact form";

      test("warns when no business email is set", async () => {
        const response = await adminGet("/admin/site/contact");
        const html = await response.text();
        expect(html).toContain(businessEmailNote);
      });

      test("hides the business-email warning once one is set", async () => {
        await settings.update.businessEmail("owner@example.com");
        const response = await adminGet("/admin/site/contact");
        const html = await response.text();
        expect(html).not.toContain(businessEmailNote);
      });

      test("reflects the enabled state in the checkbox", async () => {
        await settings.update.contactFormEnabled(true);
        const response = await adminGet("/admin/site/contact");
        const html = await response.text();
        expect(hasCheckedInput(html, "contact_form_enabled", "true")).toBe(
          true,
        );
      });

      test("leaves the checkbox unchecked when disabled", async () => {
        const response = await adminGet("/admin/site/contact");
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
