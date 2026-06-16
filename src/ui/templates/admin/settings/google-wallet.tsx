/**
 * Google Wallet form for advanced settings
 */

import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const GoogleWalletForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/google-wallet"
    description={
      <p>
        Configure Google Wallet to show an &ldquo;Add to Google Wallet&rdquo;
        button on ticket pages. Requires a Google Cloud service account with the
        Google Wallet API enabled.{" "}
        <a href="/admin/guide#google-wallet">Setup guide</a>.
        {s.hostGoogleWalletLabel && !s.googleWalletConfigured
          ? ` Currently using: ${s.hostGoogleWalletLabel}. Override below or leave empty to keep using host config.`
          : s.hostGoogleWalletLabel && s.googleWalletConfigured
            ? ` Overriding: ${s.hostGoogleWalletLabel}.`
            : ""}
      </p>
    }
    submitLabel={t("settings.advanced.save_google_wallet")}
    title={t("tickets.google_wallet")}
  >
    <label>
      {t("settings.advanced.google_issuer_id")}
      <input
        autocomplete="off"
        name="google_wallet_issuer_id"
        placeholder="3388000000012345678"
        type="text"
        value={s.googleWalletIssuerId}
      />
    </label>
    <label>
      {t("settings.advanced.google_service_email")}
      <input
        autocomplete="off"
        name="google_wallet_service_account_email"
        placeholder="wallet@project.iam.gserviceaccount.com"
        type="email"
        value={s.googleWalletServiceAccountEmail}
      />
    </label>
    <label>
      {t("settings.advanced.google_service_key")}
      <textarea
        name="google_wallet_service_account_key"
        placeholder="-----BEGIN PRIVATE KEY-----"
        rows={4}
      >
        {s.googleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
  </SettingsSection>
);
