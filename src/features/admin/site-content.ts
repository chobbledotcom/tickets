/**
 * Shared wiring for the Site tab's hand-wired content editors (Pages, News):
 * the owner+editor route gates, the standard list/new/edit paths, the
 * validate-or-bounce step both create/update flows open with, and the shared
 * save completion (activity log + flash redirect).
 */

/* jscpd:ignore-start */
import type { FormGuard } from "#routes/admin/confirmation.ts";
import { formPost, requireSiteOr, SITE_FORM, withAuth } from "#routes/auth.ts";
import { gatedEntityRoute } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ValidationResult } from "#shared/forms.tsx";
import type { AdminSession } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Standard list/new/edit paths for a Site-tab collection under `base`. */
export const siteContentPaths = (base: string) => ({
  edit: (id: number): string => `${base}/${id}/edit`,
  list: base,
  newPage: `${base}/new`,
});

/** GET route rendering for a Site-level (owner + editor) session. */
export const siteContentGet =
  (render: (session: AdminSession) => string | Promise<string>) =>
  (request: Request): Promise<Response> =>
    requireSiteOr(request, async (session) =>
      htmlResponse(await render(session)),
    );

/** POST route behind the Site-level form gate. */
export const siteContentPost = formPost(SITE_FORM);

/** Curried POST `:id` route: Site form gate, then load the entity (404 when
 * missing) and hand it to the mutation. */
export const siteEntityPost =
  <T>(load: (id: number) => Promise<T | null>) =>
  (handler: (item: T, form: FormParams) => Promise<Response>) =>
    gatedEntityRoute<FormParams>((request, h) =>
      formPost(SITE_FORM)(h)(request),
    )(load, handler);

/** The confirmed-delete auth pair every Site-tab delete flow uses. */
export const siteConfirmAuth: {
  requireSession: typeof requireSiteOr;
  withForm: FormGuard<AdminSession>;
} = {
  requireSession: requireSiteOr,
  withForm: (r, h) => withAuth(r, SITE_FORM, h),
};

/** Fold a form's validation outcome into the editor flow: carry the values
 * forward, or bounce back to `errorPath` with the error flash. */
export const validateContentFormOr = <V>(
  result: ValidationResult<V>,
  errorPath: string,
): { ok: true; values: V } | { ok: false; response: Response } =>
  result.valid
    ? { ok: true, values: result.values }
    : { ok: false, response: errorRedirect(errorPath, result.error) };

/** Save completion: record the activity and flash back to `path`. */
export const savedContentResponse = async (
  path: string,
  logMessage: string,
  flashMessage: string,
): Promise<Response> => {
  await logActivity(logMessage);
  return redirect(path, flashMessage, true);
};
