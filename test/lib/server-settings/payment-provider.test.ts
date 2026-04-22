import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#lib/db/activityLog.ts";
import { setDemoModeForTest } from "#lib/demo.ts";
import { handleRequest } from "#routes";
import {
  adminFormPost,
  describeWithEnv,
  expectFlash,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("POST /admin/settings/payment-provider (square)", () => {
    test("sets provider to square", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "square" },
      );

      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider set to square");
    });
  });

  describe("POST /admin/settings/payment-provider", () => {
    testRequiresAuth("/admin/settings/payment-provider", {
      method: "POST",
      body: {
        payment_provider: "stripe",
      },
    });

    test("sets payment provider to stripe", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "stripe" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider set to stripe");
    });

    test("disables payment provider with none", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "none" },
      );
      expect(response.status).toBe(302);
      expectFlash(response, "Payment provider disabled");
    });

    test("rejects invalid payment provider", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
        { payment_provider: "invalid-provider" },
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid payment provider"),
        false,
      );
    });

    test("payment provider POST without payment_provider field uses empty fallback", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/payment-provider",
      );
      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Invalid payment provider"),
        false,
      );
    });
  });

  test("logs activity when payment provider is set", async () => {
    await adminFormPost("/admin/settings/payment-provider", {
      payment_provider: "stripe",
    });

    const logs = await getAllActivityLog();
    expect(
      logs.some((l) => l.message === "Payment provider set to stripe"),
    ).toBe(true);
  });

  test("logs activity when payment provider is disabled", async () => {
    await adminFormPost("/admin/settings/payment-provider", {
      payment_provider: "none",
    });

    const logs = await getAllActivityLog();
    expect(logs.some((l) => l.message === "Payment provider disabled")).toBe(
      true,
    );
  });
});
