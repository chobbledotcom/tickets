/** A generic settings-form checkbox, shared by the settings forms. */

/** A checkbox that posts `true` when ticked, with its label text beside it.
 * `labelClass` styles the wrapping label (omitted for an unstyled label). */
export const SettingsCheckbox = ({
  checked,
  name,
  label,
  labelClass,
}: {
  checked: boolean;
  name: string;
  label: string;
  labelClass?: string | undefined;
}): JSX.Element => (
  <label class={labelClass}>
    <input checked={checked} name={name} type="checkbox" value="true" /> {label}
  </label>
);
