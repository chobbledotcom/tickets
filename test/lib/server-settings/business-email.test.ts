import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  getAllActivityLog,
  mockFormRequest,
  testCookie,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/business-email", () => {
    testRequiresAuth("/admin/settings/business-email", {
      body: {
        business_email: "contact@example.com",
      },
      method: "POST",
    });

    test("rejects invalid CSRF token", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/business-email",
          {
            business_email: "contact@example.com",
            csrf_token: "invalid-csrf-token",
          },
          await testCookie(),
        ),
      );
      await expectHtmlResponse(response, 403, "Invalid CSRF token");
    });

    test("updates business email successfully", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/business-email",
        { business_email: "contact@example.com" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Business email updated"));

      expect(settings.businessEmail ?? "").toBe("contact@example.com");
    });

    test("clears business email when empty string", async () => {
      const { updateBusinessEmail } = await import(
        "#shared/validation/email.ts"
      );

      // First set an email
      await updateBusinessEmail("old@example.com");
      expect(settings.businessEmail ?? "").toBe("old@example.com");

      // Then clear it
      const { response } = await adminFormPost(
        "/admin/settings/business-email",
        { business_email: "" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Business email cleared"));

      expect(settings.businessEmail ?? "").toBe("");
    });

    test("rejects invalid email format", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/business-email",
        { business_email: "not-an-email" },
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid email format"),
        false,
      );
    });
  });

  test("logs activity when business email is updated", async () => {
    await adminFormPost("/admin/settings/business-email", {
      business_email: "audit@example.com",
    });

    const logs = await getAllActivityLog();
    expect(logs.some((l) => l.message.includes("Business email updated"))).toBe(
      true,
    );
  });

  test("logs activity when business email is cleared", async () => {
    await adminFormPost("/admin/settings/business-email", {
      business_email: "",
    });

    const logs = await getAllActivityLog();
    expect(logs.some((l) => l.message.includes("Business email cleared"))).toBe(
      true,
    );
  });
});
