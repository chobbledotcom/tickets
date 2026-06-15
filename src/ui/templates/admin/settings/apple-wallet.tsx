/**
 * Apple Wallet form for advanced settings
 */

import { MASK_SENTINEL } from "#shared/db/settings.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

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
    submitLabel="Save Apple Wallet Settings"
    title="Apple Wallet"
  >
    <label>
      Pass Type ID
      <input
        autocomplete="off"
        name="apple_wallet_pass_type_id"
        placeholder="pass.com.example.tickets"
        type="text"
        value={s.appleWalletPassTypeId}
      />
    </label>
    <label>
      Team ID
      <input
        autocomplete="off"
        name="apple_wallet_team_id"
        placeholder="ABC1234567"
        type="text"
        value={s.appleWalletTeamId}
      />
    </label>
    <label>
      Signing Certificate (PEM)
      <textarea
        name="apple_wallet_signing_cert"
        placeholder="-----BEGIN CERTIFICATE-----"
        rows={4}
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <label>
      Signing Private Key (PEM)
      <textarea
        name="apple_wallet_signing_key"
        placeholder="-----BEGIN PRIVATE KEY-----"
        rows={4}
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <label>
      WWDR Certificate (PEM)
      <textarea
        name="apple_wallet_wwdr_cert"
        placeholder="-----BEGIN CERTIFICATE-----"
        rows={4}
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
  </SettingsSection>
);
