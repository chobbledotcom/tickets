// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { MASK_SENTINEL, settings } from "#shared/db/settings.ts";
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

// jscpd:ignore-end

/** POST a settings form with a valid CSRF token and the admin cookie. */
const postSettings = async (
  path: string,
  fields: Record<string, string>,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      path,
      { csrf_token: await testCsrfToken(), ...fields },
      await testCookie(),
    ),
  );

/** Run `body` with the Stripe webhook-setup call stubbed to succeed. */
const withStripeWebhook = (body: () => Promise<void>): Promise<void> =>
  withMocks(
    () =>
      stub(stripeApi, "setupWebhookEndpoint", () =>
        Promise.resolve({
          endpointId: "we_test_123",
          secret: "whsec_test_secret",
          success: true,
        }),
      ),
    body,
  );

/** Assert the page at `path` masks `secret` behind the sentinel. */
const expectMaskedAt = async (path: string, secret: string): Promise<void> => {
  const response = await awaitTestRequest(path, { cookie: await testCookie() });
  const html = await response.text();
  expect(html).toContain(MASK_SENTINEL);
  expect(html).not.toContain(secret);
};

/** Assert a redirect with the "unchanged" flash (a preserved secret). */
const expectUnchangedFlash = (response: Response): void => {
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining("unchanged"));
};

/** Assert a redirect with the "required" error flash (a rejected empty value). */
const expectRequiredError = (response: Response): void => {
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining("required"), false);
};

describeWithEnv("server (admin settings)", { db: true }, () => {
  afterEach(() => {
    setDemoModeForTest(false);
  });

  describe("sensitive field masking", () => {
    test("shows mask sentinel for configured Stripe key", async () => {
      await settings.update.paymentProvider("stripe");
      await withStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_real_secret",
        });
        await expectMaskedAt("/admin/settings", "sk_test_real_secret");
      });
    });

    test("shows mask sentinel for configured Square token", async () => {
      await settings.update.paymentProvider("square");
      await postSettings("/admin/settings/square", {
        square_access_token: "EAAAl_real_secret",
        square_location_id: "L_test_loc",
      });
      await expectMaskedAt("/admin/settings", "EAAAl_real_secret");
    });

    test("shows mask sentinel for configured email API key", async () => {
      await settings.update.email.provider("resend");
      await settings.update.email.apiKey("re_real_secret_key");
      await expectMaskedAt("/admin/settings-advanced", "re_real_secret_key");
    });

    test("submitting sentinel for Stripe key does not overwrite existing key", async () => {
      await settings.update.paymentProvider("stripe");
      await withStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_original",
        });
        const response = await postSettings("/admin/settings/stripe", {
          stripe_secret_key: MASK_SENTINEL,
        });
        expectUnchangedFlash(response);
        expect(settings.stripe.secretKey).toBe("sk_test_original");
      });
    });

    test("submitting sentinel for Square token preserves token but updates location", async () => {
      await settings.update.paymentProvider("square");
      await postSettings("/admin/settings/square", {
        square_access_token: "EAAAl_original",
        square_location_id: "L_original",
      });
      const response = await postSettings("/admin/settings/square", {
        square_access_token: MASK_SENTINEL,
        square_location_id: "L_updated",
      });
      expect(response.status).toBe(302);
      expect(settings.square.accessToken).toBe("EAAAl_original");
      expect(settings.square.locationId).toBe("L_updated");
    });

    test("submitting sentinel for Square webhook key does not overwrite", async () => {
      await postSettings("/admin/settings/square-webhook", {
        square_webhook_signature_key: "sig_original",
      });
      const response = await postSettings("/admin/settings/square-webhook", {
        square_webhook_signature_key: MASK_SENTINEL,
      });
      expectUnchangedFlash(response);
    });

    test("submitting sentinel for email API key does not overwrite existing key", async () => {
      await postSettings("/admin/settings/email", {
        email_api_key: "re_original_key",
        email_from_address: "from@test.com",
        email_provider: "resend",
      });
      const response = await postSettings("/admin/settings/email", {
        email_api_key: MASK_SENTINEL,
        email_provider: "resend",
      });
      expect(response.status).toBe(302);
      expect(settings.email.apiKey).toBe("re_original_key");
    });

    test("submitting new value still updates the key", async () => {
      await settings.update.paymentProvider("stripe");
      await withStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_old",
        });
        await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_new",
        });
        expect(settings.stripe.secretKey).toBe("sk_test_new");
      });
    });

    test("empty Stripe key with existing key is a no-op", async () => {
      await settings.update.paymentProvider("stripe");
      await withStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "sk_test_keep_me",
        });
        const response = await postSettings("/admin/settings/stripe", {
          stripe_secret_key: "",
        });
        expectUnchangedFlash(response);
        expect(settings.stripe.secretKey).toBe("sk_test_keep_me");
      });
    });

    test("empty Stripe key rejected when no key is configured", async () => {
      await settings.update.paymentProvider("stripe");
      expectRequiredError(
        await postSettings("/admin/settings/stripe", { stripe_secret_key: "" }),
      );
    });

    test("empty Square token rejected when no token is configured", async () => {
      await settings.update.paymentProvider("square");
      expectRequiredError(
        await postSettings("/admin/settings/square", {
          square_access_token: "",
          square_location_id: "L_test",
        }),
      );
    });

    test("empty Square webhook key rejected", async () => {
      expectRequiredError(
        await postSettings("/admin/settings/square-webhook", {
          square_webhook_signature_key: "",
        }),
      );
    });
  });
});
