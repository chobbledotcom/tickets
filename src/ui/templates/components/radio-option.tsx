/**
 * A single labelled radio option — `<label><input .../>{label}</label>`.
 *
 * Payment provider forms and attendee merge decisions use this shared
 * primitive.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

/** Shared prop shape for {@link RadioOption} and attendee merge decisions. */
export type RadioOptionProps = {
  name: string;
  value: string;
  checked: boolean;
  children: Child;
};

export const RadioOption = ({
  name,
  value,
  checked,
  children,
}: RadioOptionProps): JSX.Element => (
  <label>
    <input checked={checked} name={name} type="radio" value={value} />
    {children}
  </label>
);
