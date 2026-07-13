import type { Field } from "#shared/forms.tsx";

/**
 * A single on/off checkbox field: one option whose value is "1". The caller
 * passes the already-translated copy (so the `t("…")` keys stay literal for the
 * i18n coverage scan) — its hint, its label, and the option's own label.
 */
export const checkboxField = (
  name: string,
  copy: { hint: string; label: string; optionLabel: string },
): Field => ({
  hint: copy.hint,
  label: copy.label,
  name,
  options: [{ label: copy.optionLabel, value: "1" }],
  type: "checkbox-group",
});
