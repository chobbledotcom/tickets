/**
 * Config-driven form for a one-yes/no-toggle boolean settings section.
 *
 * Several settings sections (show public API and the external-order library)
 * differ only by action, title, description, field name, and the
 * state selector that flips the boolean — every other line is the same
 * `SettingsSection` + `YesNoRadios` scaffold. Declaring those four facts lets
 * the shared scaffold own the markup so a new boolean toggle is one config
 * plus an export, not another hand-authored component.
 *
 * Generic over the page state (`SettingsPageState` and
 * `AdvancedSettingsPageState` are different types) so neither caller has to
 * widen to `any`.
 */

import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { settingsSectionWith } from "#templates/components/settings-section.tsx";
import { YesNoRadios } from "#templates/components/yes-no-radios.tsx";

export type BooleanSettingsSectionConfig<TState> = {
  action: string;
  title: string;
  description: Child;
  fieldName: string;
  value: (state: TState) => boolean;
  submitLabel?: string;
};

/** Build a config-driven boolean settings section renderer. */
export const booleanSettingsSection =
  <TState,>(config: BooleanSettingsSectionConfig<TState>) =>
  (state: TState): JSX.Element =>
    settingsSectionWith(
      { ...config, submitLabel: config.submitLabel ?? t("common.save") },
      <YesNoRadios name={config.fieldName} on={config.value(state)} />,
    );
