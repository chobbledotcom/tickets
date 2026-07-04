/**
 * Terms and Conditions form for settings
 */

import { t } from "#i18n";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { SettingsPageState } from "#templates/admin/settings.tsx";
import { textareaSettingsSection } from "#templates/components/settings-field-section.tsx";
import { FORMATTING_HINT } from "#templates/fields.ts";

export const TermsForm = textareaSettingsSection<SettingsPageState>((s) => ({
  action: "/admin/settings/terms",
  description: <p>{t("settings.terms_hint")}</p>,
  label: t("settings.terms"),
  labelHint: (
    <p>
      <small>
        <Raw html={FORMATTING_HINT} />
      </small>
    </p>
  ),
  markdownPreview: true,
  name: "terms_and_conditions",
  placeholder: t("settings.terms_placeholder"),
  submitLabel: t("settings.save_terms"),
  title: t("settings.terms"),
  value: s.termsAndConditions,
}));
