/**
 * Email Notifications form for advanced settings
 */

import { MASK_SENTINEL } from "#shared/db/settings.ts";
import { EMAIL_PROVIDER_LABELS, VALID_EMAIL_PROVIDERS } from "#shared/email.ts";
import { CsrfForm } from "#shared/forms.tsx";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const EmailNotificationsForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <>
    <SettingsSection
      action="/admin/settings/email"
      description={
        <p>
          Send confirmation emails to attendees and admin notifications when
          registrations come in. <a href="/admin/guide#email">Setup guide</a>.
        </p>
      }
      submitLabel="Save Email Settings"
      title="Email Notifications"
    >
      <label>
        Email Provider
        <select name="email_provider">
          <option selected={!s.emailProvider} value="">
            {s.hostEmailLabel || "None (disabled)"}
          </option>
          {VALID_EMAIL_PROVIDERS.map((p) => (
            <option selected={s.emailProvider === p} value={p}>
              {EMAIL_PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label>
        API Key
        <input
          autocomplete="off"
          name="email_api_key"
          placeholder="Enter API key"
          type="password"
          value={s.emailApiKeyConfigured ? MASK_SENTINEL : undefined}
        />
      </label>
      <label>
        From Address
        <input
          autocomplete="off"
          name="email_from_address"
          placeholder={s.businessEmail || "tickets@yourdomain.com"}
          type="email"
          value={s.emailFromAddress}
        />
      </label>
    </SettingsSection>
    {s.emailProvider && (
      <CsrfForm action="/admin/settings/email/test" id="settings-email-test">
        <SubmitButton class="secondary" icon="arrow-right">
          Send Test Email
        </SubmitButton>
      </CsrfForm>
    )}
  </>
);
