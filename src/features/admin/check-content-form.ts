import type { FormParams } from "#shared/form-data.ts";
import type { ValidationResult } from "#shared/forms.tsx";
import { validateContentFormOr } from "./site-content.ts";
import type { ContentCheck } from "./site-content-create.ts";

/** Validate a content form's fields and fold the outcome: carry the values
 * forward, or bounce back to `errorPath` with the error flash. Shared by the
 * hand-wired Site editors (Pages, News). */
export const checkContentForm = <V>(
  contentForm: { validate: (form: FormParams) => ValidationResult<V> },
  form: FormParams,
  errorPath: string,
): ContentCheck<{ values: V }> =>
  validateContentFormOr(contentForm.validate(form), errorPath);
