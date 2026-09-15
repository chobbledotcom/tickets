/**
 * A labelled masked password input for a stored secret (API key, password).
 *
 * The input companion to {@link MaskedTextarea}: when the secret is already
 * configured, the value shows the mask sentinel rather than the stored
 * (encrypted) secret; submitting the sentinel back leaves the stored value
 * unchanged (see processSecretField).
 */

import { MASK_SENTINEL } from "#db/settings/mask.ts";
import { TextField } from "#templates/components/text-field.tsx";

export const MaskedInput = ({
  configured,
  label,
  name,
  placeholder,
  maxlength,
}: {
  /** Whether a secret is already stored (renders the mask sentinel). */
  configured: boolean;
  label: string;
  name: string;
  placeholder?: string | undefined;
  maxlength?: number | undefined;
}): JSX.Element => (
  <TextField
    label={label}
    maxlength={maxlength}
    name={name}
    placeholder={placeholder}
    type="password"
    value={configured ? MASK_SENTINEL : undefined}
  />
);
