/**
 * A single labelled radio option — `<label><input .../>{label}</label>`.
 *
 * The PaymentProviderForm renders four of these as a radio fieldset (one per
 * provider). Kept as its own primitive so the four providers stay uniform.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

/** Shared prop shape for {@link RadioOption} ({@link mergeRadioCell} in
 *  {@link attendees.tsx} reuses the same name/value/checked/children shape).
 *  Centralised here so the same destructuring isn't duplicated across files. */
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
