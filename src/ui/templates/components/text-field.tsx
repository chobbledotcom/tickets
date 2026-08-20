/**
 * A labelled text input — `<label>{label}<input autocomplete="off" …/></label>`.
 * The admin settings forms hand-wrote this same wrapper for every
 * business-email / embed-hosts / SMS-gateway / wallet field; this owns it so
 * the label/input scaffold can't drift per field. The duplicate-group form
 * reuses it too, via the optional `autofocus`, `required`, and `duplicate`
 * flags.
 *
 * `value` is left `undefined` for masked secret fields (renders no `value`
 * attribute). Set `duplicate` to mark the field for the live duplicate-preview
 * script, which finds inputs by their `data-duplicate-field` name.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

export const TextField = ({
  label,
  name,
  type,
  value,
  placeholder,
  autofocus,
  required,
  duplicate,
  min,
  max,
  minlength,
  step,
}: {
  label: Child;
  name: string;
  type: string;
  value?: string | undefined;
  placeholder?: string | undefined;
  autofocus?: boolean | undefined;
  required?: boolean | undefined;
  duplicate?: boolean | undefined;
  /** Numeric bounds for `type="number"` fields (omitted otherwise). */
  min?: string | undefined;
  max?: string | undefined;
  /** Shortest value the browser accepts (omitted for no minimum). */
  minlength?: number | undefined;
  step?: string | undefined;
}): JSX.Element => (
  <label>
    {label}
    <input
      autocomplete="off"
      autofocus={autofocus}
      data-duplicate-field={duplicate ? name : undefined}
      max={max}
      min={min}
      minlength={minlength}
      name={name}
      placeholder={placeholder}
      required={required}
      step={step}
      type={type}
      value={value}
    />
  </label>
);
