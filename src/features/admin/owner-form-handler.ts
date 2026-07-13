/** Shared shell for owner-only form POST handlers. */

import { OWNER_FORM, withAuth } from "#routes/auth.ts";
import type { FormParams } from "#shared/form-data.ts";

/** Run an owner-authenticated form POST: check the request is an authorized
 * owner submission, then hand the parsed form to `handle`. */
export const withOwnerForm = (
  request: Request,
  handle: (form: FormParams) => Promise<Response>,
): Promise<Response> =>
  withAuth(request, OWNER_FORM, (_session, form) => handle(form));
