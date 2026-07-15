/**
 * Shared wiring for the Site tab's content editors (Pages, News): standard
 * list/new/edit paths, entity sub-action and confirmation gates, and save
 * completion (activity log + flash redirect).
 */

/* jscpd:ignore-start */
import type { FormGuard } from "#routes/admin/confirmation.ts";
import { requireSiteOr, SITE_FORM, sitePage, withAuth } from "#routes/auth.ts";
import { errorRedirect, notFoundResponse, redirect } from "#routes/response.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { type TxScope, withTransaction } from "#shared/db/client.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import type { Result } from "#shared/result.ts";
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

/** The confirmed-delete auth pair every Site-tab delete flow uses. */
export const siteConfirmAuth: {
  requireSession: typeof requireSiteOr;
  withForm: FormGuard<AdminSession>;
} = {
  requireSession: requireSiteOr,
  withForm: (r, h) => withAuth(r, SITE_FORM, h),
};

type SavedContent = {
  flashMessage: string;
  logMessage: string;
  path: string;
};

/** Write content and its activity row in one transaction. The callback may
 * reject before writing by returning a validation response; no activity is then
 * logged. */
export const saveContent = async <T>(
  write: (transaction: TxScope) => Promise<T | Response>,
  complete: (value: T) => SavedContent,
): Promise<Response> => {
  const saved = await withTransaction(async (transaction) => {
    const value = await write(transaction);
    if (value instanceof Response) return value;
    const completion = complete(value);
    await logActivity(completion.logMessage, undefined, undefined, transaction);
    return completion;
  });
  return saved instanceof Response
    ? saved
    : redirect(saved.path, saved.flashMessage, true);
};

/** Turn a conditional content write into its saved value or the standard form
 * response for the reason it did not write. */
export const contentWriteOrError = <T>(
  result: Result<T, "notFound" | "slugTaken">,
  path: string,
  slugError: string,
): T | Response =>
  result.ok
    ? result.value
    : result.error === "notFound"
      ? notFoundResponse()
      : errorRedirect(path, slugError);
