import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  expectFlashRedirect,
  expectHtml,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { generateGoogleTestCreds } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  configureGoogleWallet,
  setGoogleWalletEnvVars,
} from "#test-utils/google-wallet.ts";
import { awaitTestRequest, mockFormRequest } from "#test-utils/mocks.ts";
import { loginAsAdmin } from "#test-utils/session.ts";

describeWithEnv("POST /admin/settings/google-wallet", { db: true }, () => {
  beforeEach(() => {
    // Pre-build the once()-cached test credentials so no single test pays
    // the keygen cost mid-assertion.
    generateGoogleTestCreds();
  });

  testRequiresAuth("/admin/settings/google-wallet", {
    body: {
      google_wallet_issuer_id: "123",
    },
    method: "POST",
  });

  test("requires Issuer ID", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Issuer ID is required"),
      false,
    )(response);
  });

  test("requires Service Account Email", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Service account email is required"),
      false,
    )(response);
  });

  test("requires private key on initial setup", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "",
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining("Service account private key is required"),
      false,
    )(response);
  });

  test("rejects invalid PEM private key", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key: "not a valid key",
        },
        cookie,
      ),
    );
    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      expect.stringContaining(
        "Service account private key is not a valid PEM private key",
      ),
      false,
    )(response);
  });

  test("saves all settings successfully", async () => {
    const { cookie, csrfToken } = await loginAsAdmin();

    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "1234567890",
          google_wallet_service_account_email:
            "test@test.iam.gserviceaccount.com",
          google_wallet_service_account_key:
            generateGoogleTestCreds().serviceAccountKey,
        },
        cookie,
      ),
    );

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      "Google Wallet configuration updated",
    )(response);

    expect(settings.googleWallet.hasConfig).toBe(true);
    expect(settings.googleWallet.issuerId).toBe("1234567890");
    expect(settings.googleWallet.serviceAccountEmail).toBe(
      "test@test.iam.gserviceaccount.com",
    );
  });

  test("clears all settings when everything is empty", async () => {
    await configureGoogleWallet();
    expect(settings.googleWallet.hasConfig).toBe(true);

    const { cookie, csrfToken } = await loginAsAdmin();
    const response = await handleRequest(
      mockFormRequest(
        "/admin/settings/google-wallet",
        {
          csrf_token: csrfToken,
          google_wallet_issuer_id: "",
          google_wallet_service_account_email: "",
          google_wallet_service_account_key: "",
        },
        cookie,
      ),
    );

    await expectFlashRedirect(
      "/admin/settings-advanced?form=settings-google-wallet#settings-google-wallet",
      "Google Wallet configuration cleared",
    )(response);
    expect(settings.googleWallet.hasDbConfig).toBe(false);
  });

  test("shows Google Wallet section with values when configured", async () => {
    await configureGoogleWallet();
    const { cookie } = await loginAsAdmin();
    const response = await awaitTestRequest("/admin/settings-advanced", {
      cookie,
    });
    const body = await response.text();
    expect(body).toContain("Google Wallet");
    expect(body).toContain("google_wallet_issuer_id");
    expect(body).toContain("1234567890");
    expect(body).toContain("test@test-project.iam.gserviceaccount.com");
    // Secret is masked
    expect(body).toContain("••••••••");
  });
});

describeWithEnv(
  "settings page Google Wallet host labels",
  {
    db: true,
    env: {
      GOOGLE_WALLET_ISSUER_ID: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: undefined,
      GOOGLE_WALLET_SERVICE_ACCOUNT_KEY: undefined,
    },
  },
  () => {
    beforeEach(() => {
      generateGoogleTestCreds();
    });

    test("settings page shows host Google Wallet label when env vars configured", async () => {
      await setGoogleWalletEnvVars();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie,
      });
      await expectHtml(response, {
        contains: ["Host env (9876543210)", "Currently using"],
      });
    });

    test("settings page shows overriding label when both DB and env configured", async () => {
      await setGoogleWalletEnvVars();
      await configureGoogleWallet();
      const { cookie } = await loginAsAdmin();
      const response = await awaitTestRequest("/admin/settings-advanced", {
        cookie,
      });
      await expectHtml(response, {
        contains: ["Host env (9876543210)", "Overriding"],
      });
    });
  },
);
