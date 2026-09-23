/**
 * POST handler factory for a group's own form routes: CSRF, auth, and the
 * group row loaded from the table, handed to the handler together. The
 * default gate admits back-office staff only; callers that also serve
 * content editors pass their own policy.
 */

/* jscpd:ignore-start -- imports */
import { getGroupById } from "#db/groups.ts";
import { AUTH_FORM, type AuthPolicy } from "#routes/auth.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import type { Group } from "#types";
/* jscpd:ignore-end */

/**
 * POST handler factory: CSRF-validated form + loaded group.
 * Callers receive the group and the parsed form; a missing session or
 * missing group short-circuits with the appropriate response.
 */
export const groupFormPost = (
  handler: ResponseHandler<[group: Group, form: FormParams]>,
  auth: AuthPolicy<"form"> = AUTH_FORM,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  createAuthedHandler<{ id: number }, Group>({
    auth,
    handle: ({ context, form }) => handler(context, form),
    loadContext: ({ id }) => getGroupById(id),
  });
