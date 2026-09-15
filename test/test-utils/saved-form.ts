import { FormParams } from "#shared/form-data.ts";
import {
  runWithSavedFormContext,
  setSavedFormData,
} from "#shared/forms/saved-data.ts";

/** Run `read` with the given values stashed as the just-submitted form, the
 *  way a validation re-render sees them. */
export const withSubmittedValues = <T>(
  saved: Record<string, string>,
  read: () => T,
): T =>
  runWithSavedFormContext(() => {
    setSavedFormData(new FormParams(saved));
    return read();
  });
