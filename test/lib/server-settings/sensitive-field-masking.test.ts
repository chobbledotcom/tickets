import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  mockFormRequest,
  testCookie,
  testCsrfToken,
  withMocks,
} from "#test-utils";

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("sensitive field masking", () => {
    test("shows mask sentinel for configured Stripe key", async () => {
      const { MASK_SENTINEL } = await import("#shared/db/settings.ts");
      await settings.update.paymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: "sk_test_real_secret",
              },
              await testCookie(),
            ),
          );

          // Settings page should show sentinel, not the actual key
          const response = await awaitTestRequest("/admin/settings", {
            cookie: await testCookie(),
          });
          const html = await response.text();
          expect(html).toContain(MASK_SENTINEL);
          expect(html).not.toContain("sk_test_real_secret");
        },
      );
    });

    test("shows mask sentinel for configured Square token", async () => {
      const { MASK_SENTINEL } = await import("#shared/db/settings.ts");
      await settings.update.paymentProvider("square");

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: await testCsrfToken(),
            square_access_token: "EAAAl_real_secret",
            square_location_id: "L_test_loc",
          },
          await testCookie(),
        ),
      );

      const response = await awaitTestRequest("/admin/settings", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("EAAAl_real_secret");
    });

    test("shows mask sentinel for configured email API key", async () => {
      const { MASK_SENTINEL, settings: s } = await import(
        "#shared/db/settings.ts"
      );

      await s.update.email.provider("resend");
      await s.update.email.apiKey("re_real_secret_key");

      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie: await testCookie(),
      });
      const html = await response.text();
      expect(html).toContain(MASK_SENTINEL);
      expect(html).not.toContain("re_real_secret_key");
    });

    test("submitting sentinel for Stripe key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, settings: s } = await import(
        "#shared/db/settings.ts"
      );
      await settings.update.paymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          // Configure a Stripe key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: "sk_test_original",
              },
              await testCookie(),
            ),
          );

          // Submit sentinel — should not change the key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: MASK_SENTINEL,
              },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("unchanged"));
          expect(s.stripe.secretKey).toBe("sk_test_original");
        },
      );
    });

    test("submitting sentinel for Square token preserves token but updates location", async () => {
      const { MASK_SENTINEL, settings: s } = await import(
        "#shared/db/settings.ts"
      );
      await settings.update.paymentProvider("square");

      // Configure Square credentials
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: await testCsrfToken(),
            square_access_token: "EAAAl_original",
            square_location_id: "L_original",
          },
          await testCookie(),
        ),
      );

      // Submit sentinel for token but new location ID
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: await testCsrfToken(),
            square_access_token: MASK_SENTINEL,
            square_location_id: "L_updated",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expect(s.square.accessToken).toBe("EAAAl_original");
      expect(s.square.locationId).toBe("L_updated");
    });

    test("submitting sentinel for Square webhook key does not overwrite", async () => {
      const { MASK_SENTINEL } = await import("#shared/db/settings.ts");

      // Configure webhook key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            csrf_token: await testCsrfToken(),
            square_webhook_signature_key: "sig_original",
          },
          await testCookie(),
        ),
      );

      // Submit sentinel
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            csrf_token: await testCsrfToken(),
            square_webhook_signature_key: MASK_SENTINEL,
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("unchanged"));
    });

    test("submitting sentinel for email API key does not overwrite existing key", async () => {
      const { MASK_SENTINEL, settings: s } = await import(
        "#shared/db/settings.ts"
      );

      // Configure email with API key
      await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            csrf_token: await testCsrfToken(),
            email_api_key: "re_original_key",
            email_from_address: "from@test.com",
            email_provider: "resend",
          },
          await testCookie(),
        ),
      );

      // Submit sentinel for API key
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/email",
          {
            csrf_token: await testCsrfToken(),
            email_api_key: MASK_SENTINEL,
            email_provider: "resend",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expect(s.email.apiKey).toBe("re_original_key");
    });

    test("submitting new value still updates the key", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await settings.update.paymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          // Configure initial key
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: "sk_test_old",
              },
              await testCookie(),
            ),
          );

          // Submit a new key (not sentinel)
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: "sk_test_new",
              },
              await testCookie(),
            ),
          );

          expect(s.stripe.secretKey).toBe("sk_test_new");
        },
      );
    });

    test("empty Stripe key with existing key is a no-op", async () => {
      const { settings: s } = await import("#shared/db/settings.ts");
      await settings.update.paymentProvider("stripe");

      await withMocks(
        () =>
          stub(stripeApi, "setupWebhookEndpoint", () =>
            Promise.resolve({
              endpointId: "we_test_123",
              secret: "whsec_test_secret",
              success: true,
            }),
          ),
        async () => {
          // Configure a Stripe key first
          await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              {
                csrf_token: await testCsrfToken(),
                stripe_secret_key: "sk_test_keep_me",
              },
              await testCookie(),
            ),
          );

          // Submit empty — should preserve existing key
          const response = await handleRequest(
            mockFormRequest(
              "/admin/settings/stripe",
              { csrf_token: await testCsrfToken(), stripe_secret_key: "" },
              await testCookie(),
            ),
          );

          expect(response.status).toBe(302);
          expectFlash(response, expect.stringContaining("unchanged"));
          expect(s.stripe.secretKey).toBe("sk_test_keep_me");
        },
      );
    });

    test("empty Stripe key rejected when no key is configured", async () => {
      await settings.update.paymentProvider("stripe");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/stripe",
          { csrf_token: await testCsrfToken(), stripe_secret_key: "" },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("empty Square token rejected when no token is configured", async () => {
      await settings.update.paymentProvider("square");

      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square",
          {
            csrf_token: await testCsrfToken(),
            square_access_token: "",
            square_location_id: "L_test",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });

    test("empty Square webhook key rejected", async () => {
      const response = await handleRequest(
        mockFormRequest(
          "/admin/settings/square-webhook",
          {
            csrf_token: await testCsrfToken(),
            square_webhook_signature_key: "",
          },
          await testCookie(),
        ),
      );

      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("required"), false);
    });
  });
});
