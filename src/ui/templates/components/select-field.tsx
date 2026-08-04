/**
 * A `<select>` whose options are declared as data — each option's value, its
 * label, and whether it is the currently-selected one (`option.value ===
 * value`). Many admin forms hand-wrote `<select>{opts.map(o => <option
 * selected={cur === o.value} .../>)}</select>`; this owns that shape so the
 * option-mapping and selection comparison live in one place.
 *
 * Renders only the `<select>` (not a wrapping `<label>`), because the callers
 * differ in how they label it — some wrap it in a `<label>`, some pair it with
 * a separate `<label for=…>`. A leading "none"/empty choice is just an option
 * with `value: ""`; pass the current value as `""` when nothing is chosen so
 * the same `===` comparison selects it.
 */

import { t } from "#i18n";
import type { ChoiceOption } from "#shared/choice.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";

export type SelectOption = { value: string; label: Child };

/** Turn `{value, labelKey}` choices into options, translating each label. */
export const choiceOptions = (
  choices: readonly ChoiceOption[],
): SelectOption[] =>
  choices.map((choice) => ({ label: t(choice.labelKey), value: choice.value }));

export const SelectField = ({
  name,
  id,
  value,
  options,
}: {
  name: string;
  id?: string | undefined;
  value: string;
  options: readonly SelectOption[];
}): JSX.Element => (
  <select id={id} name={name}>
    {options.map((option) => (
      <option selected={option.value === value} value={option.value}>
        {option.label}
      </option>
    ))}
  </select>
);
