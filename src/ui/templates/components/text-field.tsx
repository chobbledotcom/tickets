/**
 * A labelled text input — `<label>{label}<input autocomplete="off" …/></label>`.
 * The admin settings forms hand-wrote this same wrapper for every
 * business-email / embed-hosts / SMS-gateway / wallet field; this owns it so
 * the label/input scaffold can't drift per field.
 *
 * `value` is left `undefined` for masked secret fields (renders no `value`
 * attribute).
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

export const TextField = ({
  label,
  name,
  type,
  value,
  placeholder,
}: {
  label: Child;
  name: string;
  type: string;
  value?: string | undefined;
  placeholder?: string | undefined;
}): JSX.Element => (
  <label>
    {label}
    <input
      autocomplete="off"
      name={name}
      placeholder={placeholder}
      type={type}
      value={value}
    />
  </label>
);
