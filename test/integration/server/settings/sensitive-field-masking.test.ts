import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { getCurrentSettingsVersion, settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { adminGet, testCookie, testCsrfToken } from "#test-utils/session.ts";
import { withSuccessfulStripeWebhook } from "#test-utils/settings.ts";

/** POST a settings form with a valid CSRF token and the admin cookie. */
const postSettings = async (
  path: string,
  fields: Record<string, string>,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      path,
      {
        csrfToken: await testCsrfToken(),
        settingsVersion: String(await getCurrentSettingsVersion()),
        ...fields,
      },
      await testCookie(),
    ),
  );

/** Assert the page at `path` masks `secret` behind the sentinel. */
const expectMaskedAt = async (path: string, secret: string): Promise<void> => {
  const response = await adminGet(path);
  const html = await response.text();
  assertStringIncludes(html, MASK_SENTINEL);
  assert(!html.includes(secret));
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
      await withSuccessfulStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "sk_test_real_secret",
        });
        await expectMaskedAt("/admin/settings", "sk_test_real_secret");
      });
    });

    test("shows mask sentinel for configured Square token", async () => {
      await settings.update.paymentProvider("square");
      await postSettings("/admin/settings/square", {
        squareAccessToken: "EAAAl_real_secret",
        squareLocationId: "L_test_loc",
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
      await withSuccessfulStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "sk_test_original",
        });
        const response = await postSettings("/admin/settings/stripe", {
          stripeSecretKey: MASK_SENTINEL,
        });
        expectUnchangedFlash(response);
        expect(settings.stripe.secretKey).toBe("sk_test_original");
      });
    });

    test("submitting sentinel for Square token preserves token but updates location", async () => {
      await settings.update.paymentProvider("square");
      await postSettings("/admin/settings/square", {
        squareAccessToken: "EAAAl_original",
        squareLocationId: "L_original",
      });
      const response = await postSettings("/admin/settings/square", {
        squareAccessToken: MASK_SENTINEL,
        squareLocationId: "L_updated",
      });
      expect(response.status).toBe(302);
      expect(settings.square.accessToken).toBe("EAAAl_original");
      expect(settings.square.locationId).toBe("L_updated");
    });

    test("submitting sentinel for Square webhook key does not overwrite", async () => {
      await postSettings("/admin/settings/square-webhook", {
        squareWebhookSignatureKey: "sig_original",
      });
      const response = await postSettings("/admin/settings/square-webhook", {
        squareWebhookSignatureKey: MASK_SENTINEL,
      });
      expectUnchangedFlash(response);
    });

    test("submitting sentinel for email API key does not overwrite existing key", async () => {
      await postSettings("/admin/settings/email", {
        emailApiKey: "re_original_key",
        emailFromAddress: "from@test.com",
        emailProvider: "resend",
      });
      const response = await postSettings("/admin/settings/email", {
        emailApiKey: MASK_SENTINEL,
        emailProvider: "resend",
      });
      expect(response.status).toBe(302);
      expect(settings.email.apiKey).toBe("re_original_key");
    });

    test("submitting new value still updates the key", async () => {
      await settings.update.paymentProvider("stripe");
      await withSuccessfulStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "sk_test_old",
        });
        await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "sk_test_new",
        });
        expect(settings.stripe.secretKey).toBe("sk_test_new");
      });
    });

    test("empty Stripe key with existing key is a no-op", async () => {
      await settings.update.paymentProvider("stripe");
      await withSuccessfulStripeWebhook(async () => {
        await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "sk_test_keep_me",
        });
        const response = await postSettings("/admin/settings/stripe", {
          stripeSecretKey: "",
        });
        expectUnchangedFlash(response);
        expect(settings.stripe.secretKey).toBe("sk_test_keep_me");
      });
    });

    test("empty Stripe key rejected when no key is configured", async () => {
      await settings.update.paymentProvider("stripe");
      expectRequiredError(
        await postSettings("/admin/settings/stripe", { stripeSecretKey: "" }),
      );
    });

    test("empty Square token rejected when no token is configured", async () => {
      await settings.update.paymentProvider("square");
      expectRequiredError(
        await postSettings("/admin/settings/square", {
          squareAccessToken: "",
          squareLocationId: "L_test",
        }),
      );
    });

    test("empty Square token with existing token preserves it", async () => {
      await settings.update.paymentProvider("square");
      await postSettings("/admin/settings/square", {
        squareAccessToken: "EAAAl_keep_me",
        squareLocationId: "L_orig",
      });
      const response = await postSettings("/admin/settings/square", {
        squareAccessToken: "",
        squareLocationId: "L_new",
      });
      expect(response.status).toBe(302);
      expect(settings.square.accessToken).toBe("EAAAl_keep_me");
      expect(settings.square.locationId).toBe("L_new");
    });

    test("empty email API key with existing key preserves it", async () => {
      await postSettings("/admin/settings/email", {
        emailApiKey: "re_keep_me",
        emailFromAddress: "from@test.com",
        emailProvider: "resend",
      });
      const response = await postSettings("/admin/settings/email", {
        emailApiKey: "",
        emailFromAddress: "from@test.com",
        emailProvider: "resend",
      });
      expect(response.status).toBe(302);
      expect(settings.email.apiKey).toBe("re_keep_me");
    });

    test("empty Square webhook key rejected", async () => {
      expectRequiredError(
        await postSettings("/admin/settings/square-webhook", {
          squareWebhookSignatureKey: "",
        }),
      );
    });
  });
});
