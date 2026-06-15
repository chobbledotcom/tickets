/**
 * Terms and Conditions form for settings
 */

import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";

export const TermsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/terms"
    description={
      <p>If set, users must agree to these terms before reserving tickets.</p>
    }
    submitLabel="Save Terms"
    title="Terms and Conditions"
  >
    <label>
      Terms and Conditions
      <p>
        <small>
          <Raw html={FORMATTING_HINT} />
        </small>
      </p>
      <textarea
        data-markdown-preview
        maxlength={MAX_TEXTAREA_LENGTH}
        name="terms_and_conditions"
        placeholder="Enter terms and conditions that attendees must agree to before registering. Leave blank to disable."
      >
        {s.termsAndConditions}
      </textarea>
    </label>
  </SettingsSection>
);
