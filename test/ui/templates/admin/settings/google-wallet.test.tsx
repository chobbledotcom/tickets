import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { GoogleWalletForm } from "#templates/admin/settings/google-wallet.tsx";
import { advancedDefaultState } from "#test/ui/templates/admin/settings-advanced/state.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

describe("GoogleWalletForm", () => {
  beforeAll(setupAdminPageTest);

  test("renders the issuer id and service account email as capped inputs", () => {
    const html = String(
      GoogleWalletForm({
        ...advancedDefaultState,
        googleWalletIssuerId: "3388000000012345678",
        googleWalletServiceAccountEmail: "wallet@project.example.com",
      }),
    );

    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="google_wallet_issuer_id" placeholder="3388000000012345678" type="text" value="3388000000012345678">`,
    );
    says(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="google_wallet_service_account_email" placeholder="wallet@project.iam.gserviceaccount.com" type="email" value="wallet@project.example.com">`,
    );
    says(html, "<label>Issuer ID<input");
    says(html, "<label>Service Account Email<input");
  });

  test("masks the saved service account key only when configured", () => {
    const unconfigured = String(GoogleWalletForm(advancedDefaultState));

    says(unconfigured, "<label>Service Account Private Key (PEM)<textarea");
    says(
      unconfigured,
      `<textarea maxlength="${MAX_TEXTAREA_LENGTH}" name="google_wallet_service_account_key" placeholder="-----BEGIN PRIVATE KEY-----" rows="4"></textarea>`,
    );

    const configured = String(
      GoogleWalletForm({
        ...advancedDefaultState,
        googleWalletConfigured: true,
      }),
    );

    says(configured, `rows="4">${MASK_SENTINEL}</textarea>`);
  });

  test("targets the Google Wallet route, guide, and save copy", () => {
    const html = String(GoogleWalletForm(advancedDefaultState));

    says(html, "<h2>Google Wallet</h2>");
    says(html, 'action="/admin/settings/google-wallet"');
    says(html, 'id="settings-google-wallet"');
    says(html, 'href="/admin/guide#google-wallet"');
    says(html, "Save Google Wallet Settings");
    says(html, "Google Wallet API enabled");
  });

  test("carries the host-config hint in both override states", () => {
    const fallingBack = String(
      GoogleWalletForm({
        ...advancedDefaultState,
        hostGoogleWalletLabel: "Host wallet",
      }),
    );
    says(
      fallingBack,
      "Currently using: Host wallet. Override below or leave empty to keep using host config.",
    );

    const overriding = String(
      GoogleWalletForm({
        ...advancedDefaultState,
        googleWalletConfigured: true,
        hostGoogleWalletLabel: "Host wallet",
      }),
    );
    says(overriding, " Overriding: Host wallet.");
  });
});
