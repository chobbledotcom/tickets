/** A generic settings-form checkbox, shared by the settings forms. */

import type { ExclusivePair } from "#shared/forms/field.ts";

/** A checkbox that posts `true` when ticked, with its label text beside it.
 * `labelClass` styles the wrapping label (omitted for an unstyled label). */
export const SettingsCheckbox = ({
  checked,
  name,
  label,
  labelClass,
  exclusive,
}: {
  checked: boolean;
  name: string;
  label: string;
  labelClass?: string | undefined;
  exclusive?: ExclusivePair | undefined;
}): JSX.Element => (
  <label class={labelClass}>
    <input
      checked={checked}
      {...(exclusive === undefined
        ? {}
        : {
            "data-exclusive-why": exclusive.why,
            "data-exclusive-with": exclusive.other,
          })}
      name={name}
      type="checkbox"
      value="true"
    />{" "}
    {label}
  </label>
);
