/**
 * SMS Gateway form for advanced settings.
 */

import { MASK_SENTINEL } from "#shared/db/settings.ts";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const SmsGatewayForm = (s: AdvancedSettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/sms-gateway"
    description={
      <p>
        Send text messages to attendees using an Android phone running the free{" "}
        <a href="https://sms-gate.app">SMS Gateway</a> app. Message text and
        recipient numbers are end-to-end encrypted with your passphrase before
        they leave this server — enter the same passphrase in the phone app.
      </p>
    }
    submitLabel="Save SMS Gateway"
    title="SMS Gateway"
  >
    <label>
      API Username
      <input
        autocomplete="off"
        name="sms_gateway_username"
        placeholder="Account username"
        type="text"
        value={s.smsGatewayUsername}
      />
    </label>
    <label>
      API Password
      <input
        autocomplete="off"
        name="sms_gateway_password"
        placeholder="Account password"
        type="password"
        value={s.smsGatewayPasswordConfigured ? MASK_SENTINEL : undefined}
      />
    </label>
    <label>
      End-to-end key (passphrase)
      <input
        autocomplete="off"
        name="sms_gateway_passphrase"
        placeholder="Shared passphrase"
        type="password"
        value={s.smsGatewayPassphraseConfigured ? MASK_SENTINEL : undefined}
      />
    </label>
    <label>
      Server URL (optional)
      <input
        autocomplete="off"
        name="sms_gateway_base_url"
        placeholder="https://api.sms-gate.app"
        type="url"
        value={s.smsGatewayBaseUrl}
      />
    </label>
  </SettingsSection>
);
