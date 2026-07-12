/**
 * Shared scaffold for the Apple/Google Wallet advanced-settings forms.
 *
 * The two wallet forms are structural twins — a {@link SettingsSection} with a
 * host-config-override hint, a set of plain text inputs, and a set of masked
 * secret textareas — differing only in their action, copy, and field lists.
 * {@link WalletSettingsForm} renders that scaffold from a field-list config so
 * a wallet form is one declaration, not another hand-authored component.
 */

import { t } from "#i18n";
import { MaskedTextarea } from "#templates/components/masked-textarea.tsx";
import {
  type SettingsSectionDetails,
  settingsSectionWith,
} from "#templates/components/settings-section.tsx";
import { TextFields } from "#templates/components/text-fields.tsx";

/** The host-config sentence appended to a wallet form's description: the host
 *  provides wallet credentials that the site is either falling back to (no
 *  override yet) or overriding. Empty when the host provides none. */
export const hostOverrideHint = (
  hostLabel: string | null,
  configured: boolean,
): string =>
  hostLabel && !configured
    ? ` Currently using: ${hostLabel}. Override below or leave empty to keep using host config.`
    : hostLabel && configured
      ? ` Overriding: ${hostLabel}.`
      : "";

type WalletTextField = {
  labelKey: string;
  name: string;
  placeholder: string;
  type: string;
  value: string;
};

type WalletSecretField = {
  labelKey: string;
  name: string;
  placeholder: string;
};

export const WalletSettingsForm = (
  config: SettingsSectionDetails & {
    /** Whether the site has its own credentials saved (masks the secrets). */
    configured: boolean;
    textFields: readonly WalletTextField[];
    secretFields: readonly WalletSecretField[];
  },
): JSX.Element =>
  settingsSectionWith(
    config,
    <>
      <TextFields
        fields={config.textFields.map((field) => ({
          ...field,
          label: t(field.labelKey),
        }))}
      />
      {config.secretFields.map((field) => (
        <MaskedTextarea
          configured={config.configured}
          labelKey={field.labelKey}
          name={field.name}
          placeholder={field.placeholder}
        />
      ))}
    </>,
  );
