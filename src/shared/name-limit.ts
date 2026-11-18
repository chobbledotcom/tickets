/**
 * The refusal every named record answers for a name past the input limit. The
 * form and the JSON API both run it, so a saved name always fits the edit
 * form's text box. A catalog name also travels inside provider orders, so it
 * must stay within the same limit.
 */

import { t } from "#i18n";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";

export const nameLengthError = (name: string): string | null =>
  name.length > MAX_INPUT_LENGTH
    ? t("fields.validation.name_max", { max: MAX_INPUT_LENGTH })
    : null;
