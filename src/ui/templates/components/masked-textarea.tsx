/**
 * A labelled masked textarea for a sensitive credential (cert/key/PEM).
 *
 * Used by the Apple Wallet and Google Wallet settings forms to render their
 * `-----BEGIN ...-----` blocks. When the field is already configured, the
 * textarea body shows the mask sentinel placeholder rather than the stored
 * (encrypted) value; otherwise empty.
 */

import { t } from "#i18n";
import { MASK_SENTINEL } from "#shared/db/settings.ts";

export type MaskedTextareaProps = {
  /** i18n key for the field label. */
  labelKey: string;
  /** Form field name submitted with the textarea. */
  name: string;
  /** Placeholder shown when the field is unconfigured. */
  placeholder: string;
  /** Whether the field is already configured (renders the mask sentinel). */
  configured: boolean;
};

export const MaskedTextarea = ({
  labelKey,
  name,
  placeholder,
  configured,
}: MaskedTextareaProps): JSX.Element => (
  <label>
    {t(labelKey)}
    <textarea name={name} placeholder={placeholder} rows={4}>
      {configured ? MASK_SENTINEL : ""}
    </textarea>
  </label>
);
