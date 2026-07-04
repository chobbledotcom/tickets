/**
 * Apple Wallet form for advanced settings
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { MaskedTextarea } from "#templates/components/masked-textarea.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
/* jscpd:ignore-end */

export const AppleWalletForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/apple-wallet"
    description={
      <p>
        Configure Apple Wallet pass signing to show an &ldquo;Add to Apple
        Wallet&rdquo; button on ticket pages.{" "}
        <a href="/admin/guide#apple-wallet">Setup guide</a>.
        {s.hostAppleWalletLabel && !s.appleWalletConfigured
          ? ` Currently using: ${s.hostAppleWalletLabel}. Override below or leave empty to keep using host config.`
          : s.hostAppleWalletLabel && s.appleWalletConfigured
            ? ` Overriding: ${s.hostAppleWalletLabel}.`
            : ""}
      </p>
    }
    submitLabel={t("settings.advanced.save_apple_wallet")}
    title={t("tickets.apple_wallet")}
  >
    <label>
      {t("settings.advanced.apple_pass_type_id")}
      <input
        autocomplete="off"
        name="apple_wallet_pass_type_id"
        placeholder="pass.com.example.tickets"
        type="text"
        value={s.appleWalletPassTypeId}
      />
    </label>
    <label>
      {t("settings.advanced.apple_team_id")}
      <input
        autocomplete="off"
        name="apple_wallet_team_id"
        placeholder="ABC1234567"
        type="text"
        value={s.appleWalletTeamId}
      />
    </label>
    <MaskedTextarea
      configured={s.appleWalletConfigured}
      labelKey="settings.advanced.apple_signing_cert"
      name="apple_wallet_signing_cert"
      placeholder="-----BEGIN CERTIFICATE-----"
    />
    <MaskedTextarea
      configured={s.appleWalletConfigured}
      labelKey="settings.advanced.apple_signing_key"
      name="apple_wallet_signing_key"
      placeholder="-----BEGIN PRIVATE KEY-----"
    />
    <MaskedTextarea
      configured={s.appleWalletConfigured}
      labelKey="settings.advanced.apple_wwdr_cert"
      name="apple_wallet_wwdr_cert"
      placeholder="-----BEGIN CERTIFICATE-----"
    />
  </SettingsSection>
);
