/**
 * Apple Wallet form for advanced settings
 */

import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

export const AppleWalletForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/apple-wallet" id="settings-apple-wallet">
    <h2>Apple Wallet</h2>
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
    <label>
      Pass Type ID
      <input
        type="text"
        name="apple_wallet_pass_type_id"
        placeholder="pass.com.example.tickets"
        value={s.appleWalletPassTypeId}
        autocomplete="off"
      />
    </label>
    <label>
      Team ID
      <input
        type="text"
        name="apple_wallet_team_id"
        placeholder="ABC1234567"
        value={s.appleWalletTeamId}
        autocomplete="off"
      />
    </label>
    <label>
      Signing Certificate (PEM)
      <textarea
        name="apple_wallet_signing_cert"
        rows={4}
        placeholder="-----BEGIN CERTIFICATE-----"
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <label>
      Signing Private Key (PEM)
      <textarea
        name="apple_wallet_signing_key"
        rows={4}
        placeholder="-----BEGIN PRIVATE KEY-----"
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <label>
      WWDR Certificate (PEM)
      <textarea
        name="apple_wallet_wwdr_cert"
        rows={4}
        placeholder="-----BEGIN CERTIFICATE-----"
      >
        {s.appleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <button type="submit">Save Apple Wallet Settings</button>
  </CsrfForm>
);
