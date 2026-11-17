import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";

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
            csrfToken: await testCsrfToken(),
            stripeSecretKey: "sk_test_new_key_123",
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
            csrfToken: await testCsrfToken(),
            squareAccessToken: "EAAAl_test_new",
            squareLocationId: "L_test_456",
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
