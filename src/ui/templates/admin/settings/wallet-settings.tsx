/**
 * Shared scaffold for the Apple/Google Wallet advanced-settings forms.
 *
 * The two wallet forms are structural twins — a {@link SettingsSection} with a
 * host-config-override hint, a set of plain text inputs, and a set of masked
 * secret textareas — differing only in their action, copy, and field lists.
 * {@link WalletSettingsForm} renders that scaffold from a field-list config so
 * a wallet form is one declaration, not another hand-authored component.
 */

/* jscpd:ignore-start */
import { t } from "#i18n";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { MaskedTextarea } from "#templates/components/masked-textarea.tsx";
import { SettingsSection } from "#templates/components/settings-section.tsx";
import { TextField } from "#templates/components/text-field.tsx";
/* jscpd:ignore-end */

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

export const WalletSettingsForm = (config: {
  action: string;
  title: string;
  submitLabel: string;
  description: Child;
  /** Whether the site has its own credentials saved (masks the secrets). */
  configured: boolean;
  textFields: readonly WalletTextField[];
  secretFields: readonly WalletSecretField[];
}): JSX.Element => (
  <SettingsSection
    action={config.action}
    description={config.description}
    submitLabel={config.submitLabel}
    title={config.title}
  >
    {config.textFields.map((field) => (
      <TextField
        label={t(field.labelKey)}
        name={field.name}
        placeholder={field.placeholder}
        type={field.type}
        value={field.value}
      />
    ))}
    {config.secretFields.map((field) => (
      <MaskedTextarea
        configured={config.configured}
        labelKey={field.labelKey}
        name={field.name}
        placeholder={field.placeholder}
      />
    ))}
  </SettingsSection>
);
