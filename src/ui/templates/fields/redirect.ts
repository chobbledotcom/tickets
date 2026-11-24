/** The add-redirect form: the page that is missing, and where it goes. Built
 *  per request, so each label follows the active language. */

import { REDIRECT_FIELDS } from "#shared/records/redirect-fields.ts";
import { fieldsForm } from "#templates/fields/record-fields.ts";

export const getRedirectForm = fieldsForm(REDIRECT_FIELDS);
