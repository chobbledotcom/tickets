import type { ChoiceField } from "#shared/forms.tsx";

/**
 * A single on/off checkbox field: one option whose value is "1". The caller
 * passes the already-translated copy — its hint, its label, and the option's
 * own label — so the translation keys stay at the call sites for the i18n scan.
 */
export const checkboxField = <TName extends string>(
  name: TName,
  copy: { hint: string; label: string; optionLabel: string },
): ChoiceField<"checkbox-group", "1", TName> => ({
  hint: copy.hint,
  label: copy.label,
  name,
  options: [{ label: copy.optionLabel, value: "1" }],
  type: "checkbox-group",
});
