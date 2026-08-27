/**
 * A `<select>` whose options are declared as data, with the selected one found
 * by `option.value === value`.
 *
 * It renders the `<select>` alone and no wrapping `<label>`, because callers
 * differ: some wrap it, some pair it with a separate `<label for=…>`. A leading
 * "none" choice is an option with `value: ""`, so pass `""` as the current
 * value when nothing is chosen and the same comparison selects it.
 */

import { t } from "#i18n";
import type { Child } from "#jsx/jsx-runtime.ts";
import type { ChoiceOption } from "#shared/choice.ts";

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
