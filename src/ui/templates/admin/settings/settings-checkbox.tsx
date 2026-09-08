/** A generic settings-form checkbox, shared by the settings forms. */

/** An either/or pair with another control, declared as data: while this
 *  checkbox holds, the paired-controls script disables the counterpart and
 *  shows the refusal that explains the boundary beside it. */
export type ExclusivePair = { other: string; why: string };

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
