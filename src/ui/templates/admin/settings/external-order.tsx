/**
 * External order library toggle form for advanced settings.
 */

import { t } from "#i18n";
import type { AdvancedSettingsPageState } from "#templates/admin/settings-advanced.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";

export const ExternalOrderForm = (
  s: AdvancedSettingsPageState,
): JSX.Element => (
  <SettingsSection
    action="/admin/settings/external-order"
    description={<p>{t("settings.advanced.external_order_hint")}</p>}
    submitLabel={t("common.save")}
    title={t("settings.advanced.external_order")}
  >
    <fieldset class="radios">
      <label>
        <input
          checked={s.externalOrderEnabled === true}
          name="external_order_enabled"
          type="radio"
          value="true"
        />
        {t("common.yes")}
      </label>
      <label>
        <input
          checked={s.externalOrderEnabled !== true}
          name="external_order_enabled"
          type="radio"
          value="false"
        />
        {t("common.no")}
      </label>
    </fieldset>
  </SettingsSection>
);
