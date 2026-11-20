/**
 * Apple Wallet form for advanced settings
 */

import { t } from "#i18n";
import {
  hostOverrideHint,
  WalletSettingsForm,
} from "#templates/admin/settings/wallet-settings.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

export const AppleWalletForm = (s: AdvancedSettingsPageState): JSX.Element =>
  WalletSettingsForm({
    action: "/admin/settings/apple-wallet",
    configured: s.appleWalletConfigured,
    description: (
      <p>
        Configure Apple Wallet pass signing to show an &ldquo;Add to Apple
        Wallet&rdquo; button on ticket pages.{" "}
        <a href="/admin/guide#apple-wallet">Setup guide</a>.
        {hostOverrideHint(s.hostAppleWalletLabel, s.appleWalletConfigured)}
      </p>
    ),
    formId: "settings-apple-wallet",
    secretFields: [
      {
        labelKey: "settings.advanced.apple_signing_cert",
        name: "appleWalletSigningCert",
        placeholder: "-----BEGIN CERTIFICATE-----",
      },
      {
        labelKey: "settings.advanced.apple_signing_key",
        name: "appleWalletSigningKey",
        placeholder: "-----BEGIN PRIVATE KEY-----",
      },
      {
        labelKey: "settings.advanced.apple_wwdr_cert",
        name: "appleWalletWwdrCert",
        placeholder: "-----BEGIN CERTIFICATE-----",
      },
    ],
    submitLabel: t("settings.advanced.save_apple_wallet"),
    textFields: [
      {
        labelKey: "settings.advanced.apple_pass_type_id",
        name: "appleWalletPassTypeId",
        placeholder: "pass.com.example.tickets",
        type: "text",
        value: s.appleWalletPassTypeId,
      },
      {
        labelKey: "settings.advanced.apple_team_id",
        name: "appleWalletTeamId",
        placeholder: "ABC1234567",
        type: "text",
        value: s.appleWalletTeamId,
      },
    ],
    title: t("tickets.apple_wallet"),
  });
