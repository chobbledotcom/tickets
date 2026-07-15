/**
 * Shared wiring for the Site tab's content editors (Pages, News): standard
 * list/new/edit paths, entity sub-action and confirmation gates, and save
 * completion (activity log + flash redirect).
 */

/* jscpd:ignore-start */
import type { FormGuard } from "#routes/admin/confirmation.ts";
import {
  formPost,
  requireSiteOr,
  SITE_FORM,
  sitePage,
  withAuth,
} from "#routes/auth.ts";
import { type EntityLoader, gatedEntityRoute } from "#routes/entity.ts";
import { redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import type { AdminSession } from "#shared/types.ts";
/* jscpd:ignore-end */

/** Standard list/new/edit paths for a Site-tab collection under `base`. */
export const siteContentPaths = (
  base: string,
): {
  edit: (id: number) => string;
  list: string;
  newPage: string;
} => ({
  edit: (id: number): string => `${base}/${id}/edit`,
  list: base,
  newPage: `${base}/new`,
});

/** Load and render a Site collection list with its success flash. */
export const siteListPage = <T>(
  load: () => Promise<T>,
  render: (items: T, session: AdminSession, success?: string) => string,
): RequestRoute =>
  sitePage(async (session, _request, flash) =>
    render(await load(), session, flash.success),
  );

/** Curried POST `:id` route: Site form gate, then load the entity (404 when
 * missing) and hand it to the mutation. */
export const siteEntityPost =
  <T>(load: EntityLoader<T>) =>
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

/** Save completion: record the activity and flash back to `path`. */
export const savedContentResponse = async (
  path: string,
  logMessage: string,
  flashMessage: string,
): Promise<Response> => {
  await logActivity(logMessage);
  return redirect(path, flashMessage, true);
};
