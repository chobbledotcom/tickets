/**
 * Terms and Conditions form for settings
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";

export const TermsForm = (s: SettingsPageState): JSX.Element => (
  <SettingsSection
    action="/admin/settings/terms"
    description={<p>{t("settings.terms_hint")}</p>}
    submitLabel={t("settings.save_terms")}
    title={t("settings.terms")}
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
        placeholder={t("settings.terms_placeholder")}
      >
        {s.termsAndConditions}
      </textarea>
    </label>
  </SettingsSection>
);
