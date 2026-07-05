/**
 * Google Wallet form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import {
  hostOverrideHint,
  WalletSettingsForm,
} from "#templates/admin/settings/wallet-settings.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
/* jscpd:ignore-end */

export const GoogleWalletForm = (s: AdvancedSettingsPageState): JSX.Element =>
  WalletSettingsForm({
    action: "/admin/settings/google-wallet",
    configured: s.googleWalletConfigured,
    description: (
      <p>
        Configure Google Wallet to show an &ldquo;Add to Google Wallet&rdquo;
        button on ticket pages. Requires a Google Cloud service account with the
        Google Wallet API enabled.{" "}
        <a href="/admin/guide#google-wallet">Setup guide</a>.
        {hostOverrideHint(s.hostGoogleWalletLabel, s.googleWalletConfigured)}
      </p>
    ),
    secretFields: [
      {
        labelKey: "settings.advanced.google_service_key",
        name: "google_wallet_service_account_key",
        placeholder: "-----BEGIN PRIVATE KEY-----",
      },
    ],
    submitLabel: t("settings.advanced.save_google_wallet"),
    textFields: [
      {
        labelKey: "settings.advanced.google_issuer_id",
        name: "google_wallet_issuer_id",
        placeholder: "3388000000012345678",
        type: "text",
        value: s.googleWalletIssuerId,
      },
      {
        labelKey: "settings.advanced.google_service_email",
        name: "google_wallet_service_account_email",
        placeholder: "wallet@project.iam.gserviceaccount.com",
        type: "email",
        value: s.googleWalletServiceAccountEmail,
      },
    ],
    title: t("tickets.google_wallet"),
  });
