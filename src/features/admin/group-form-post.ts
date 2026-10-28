/**
 * POST handler factory for a group's own form routes: CSRF, auth, and the
 * group row loaded from the table, handed to the handler together. The gate
 * comes from the route the handler serves, so the audience is written once,
 * in the admin surface.
 */

/* jscpd:ignore-start -- imports */
import { getGroupById } from "#db/groups.ts";
import { formPolicyAt } from "#routes/auth.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import type { Group } from "#types";
/* jscpd:ignore-end */

export const groupFormPost = (
  pattern: string,
  handler: ResponseHandler<[group: Group, form: FormParams]>,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  createAuthedHandler<{ id: number }, Group>({
    auth: formPolicyAt(pattern),
    handle: ({ context, form }) => handler(context, form),
    loadContext: ({ id }) => getGroupById(id),
  });
