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
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet, testCookie } from "#test-utils/session.ts";

describeWithEnv("server (admin site order)", { db: true }, () => {
  describe("GET /admin/site/order", () => {
    testRequiresAuth("/admin/site/order");

    test("shows order editor when authenticated", async () => {
      const response = await adminGet("/admin/site/order");
      await expectHtmlResponse(
        response,
        200,
        "Order page",
        "order_enabled",
        "Enable order page",
        "order_intro_text",
      );
    });

    test("warns when there are no bookable listings", async () => {
      const response = await adminGet("/admin/site/order");
      const html = await response.text();
      expect(html).toContain("no bookable listings");
    });

    test("counts every active, visible listing", async () => {
      const { createTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
      await createTestListing({ name: "Mug", purchaseOnly: true });
      await createTestListing({ name: "Regular Ticket" });
      const response = await adminGet("/admin/site/order");
      const html = await response.text();
      expect(html).toContain("2 listings will be shown");
      expect(html).not.toContain("no bookable listings");
    });

    test("uses the singular for a single listing", async () => {
      const { createTestListing } = await import(
        "#test-utils/db-helpers/listings.ts"
      );
      await createTestListing({ name: "Solo" });
      const response = await adminGet("/admin/site/order");
      const html = await response.text();
      expect(html).toContain("1 listing will be shown");
    });

    test("displays existing intro text", async () => {
      await settings.update.orderIntroText("Pick your items");
      const response = await adminGet("/admin/site/order");
      const html = await response.text();
      expect(html).toContain("Pick your items");
    });

    test("reflects the enabled state in the checkbox", async () => {
      await settings.update.orderEnabled(true);
      const response = await adminGet("/admin/site/order");
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
      expectRedirectWithFlash(
        "/admin/site/order",
        "Order page updated",
      )(response);
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
});
