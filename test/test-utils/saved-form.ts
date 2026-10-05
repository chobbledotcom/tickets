import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { withRequestContext } from "#test-utils/request-context.ts";

/** Run `read` with the given values stashed as the just-submitted form, the
 *  way a validation re-render sees them. */
export const withSubmittedValues = <T>(
  saved: Record<string, string>,
  read: () => T,
): Promise<T> =>
  withRequestContext(() => {
    setSavedFormData(new FormParams(saved));
    return read();
  });
