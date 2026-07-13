import type { FormParams } from "#shared/form-data.ts";

/** From a form's number-array `field`, keep only the ids that belong to an
 * `allowed` option, so a crafted form can't link an id that isn't offered. */
export const selectedIdsFromForm = (
  form: FormParams,
  field: string,
  allowed: readonly { id: number }[],
): number[] => {
  const valid = new Set(allowed.map((option) => option.id));
  return form.getNumberArray(field).filter((id) => valid.has(id));
};
