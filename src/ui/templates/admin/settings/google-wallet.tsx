/**
 * Google Wallet form for advanced settings
 */

import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";

export const GoogleWalletForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <CsrfForm action="/admin/settings/google-wallet" id="settings-google-wallet">
    <div class="prose">
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
    </div>
    <label>
      Issuer ID
      <input
        autocomplete="off"
        name="google_wallet_issuer_id"
        placeholder="3388000000012345678"
        type="text"
        value={s.googleWalletIssuerId}
      />
    </label>
    <label>
      Service Account Email
      <input
        autocomplete="off"
        name="google_wallet_service_account_email"
        placeholder="wallet@project.iam.gserviceaccount.com"
        type="email"
        value={s.googleWalletServiceAccountEmail}
      />
    </label>
    <label>
      Service Account Private Key (PEM)
      <textarea
        name="google_wallet_service_account_key"
        placeholder="-----BEGIN PRIVATE KEY-----"
        rows={4}
      >
        {s.googleWalletConfigured ? MASK_SENTINEL : ""}
      </textarea>
    </label>
    <SubmitButton icon="save">Save Google Wallet Settings</SubmitButton>
  </CsrfForm>
);
