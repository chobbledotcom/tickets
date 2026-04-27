import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  describeWithEnv,
  expectFlash,
  mockFormRequest,
  testCookie,
  testCsrfToken,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  describe("demo mode restrictions", () => {
    beforeEach(() => {
      setDemoModeForTest(true);
    });

    afterEach(() => {
      setDemoModeForTest(false);
    });

    test("rejects Stripe key configuration", async () => {
      await settings.update.paymentProvider("stripe");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          {
            csrf_token: await testCsrfToken(),
            stripe_secret_key: "sk_test_new_key_123",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Cannot configure Stripe in demo mode"),
        false,
      );
    });

    test("rejects Square credentials configuration", async () => {
      await settings.update.paymentProvider("square");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: await testCsrfToken(),
            square_access_token: "EAAAl_test_new",
            square_location_id: "L_test_456",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(
        response,
        expect.stringContaining("Cannot configure Square in demo mode"),
        false,
      );
    });
  });
});
