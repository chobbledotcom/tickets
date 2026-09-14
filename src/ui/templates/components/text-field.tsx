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
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";

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
  maxlength,
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
  /** Longest value the browser accepts: short single-line values are this
   *  component's norm, so the input cap is the default. Browsers ignore
   *  maxlength on the numeric/date types some callers use. */
  maxlength?: number | undefined;
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
      maxlength={maxlength ?? MAX_INPUT_LENGTH}
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
