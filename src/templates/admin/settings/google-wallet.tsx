/**
 * Google Wallet form for advanced settings
 */

import { MASK_SENTINEL } from "#lib/db/settings.ts";
import { CsrfForm } from "#lib/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";

export const GoogleWalletForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/google-wallet" id="settings-google-wallet">
    <h2>Google Wallet</h2>
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
    <label>
      Issuer ID
      <input
        type="text"
        name="google_wallet_issuer_id"
        placeholder="3388000000012345678"
        value={s.googleWalletIssuerId}
        autocomplete="off"
      />
    </label>
    <label>
      Service Account Email
      <input
        type="email"
        name="google_wallet_service_account_email"
        placeholder="wallet@project.iam.gserviceaccount.com"
        value={s.googleWalletServiceAccountEmail}
        autocomplete="off"
      />
    </label>
    <label>
      Service Account Private Key (PEM)
      <textarea
        name="google_wallet_service_account_key"
        rows={4}
        placeholder="-----BEGIN PRIVATE KEY-----"
      >
        {s.googleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <button type="submit">Save Google Wallet Settings</button>
  </CsrfForm>
);
