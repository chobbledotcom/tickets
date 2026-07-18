import { requireOwnerOr } from "#routes/auth.ts";
import { requireCsrfForm } from "#routes/csrf.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { type BuiltSite, builtSitesCrudTable } from "#shared/db/built-sites.ts";
import { builtSitePage } from "./built-site-page.tsx";

export type BuiltSiteTab = "maintenance" | "renewal" | "secrets" | "update";

export const builtSiteTabSuccess = (
  id: number,
  tab: BuiltSiteTab,
  message: string,
): Response => redirect(builtSitePage.path(id, tab), message, true);

export const builtSiteTabError = (
  id: number,
  tab: BuiltSiteTab,
  message: string,
): Response => errorRedirect(builtSitePage.path(id, tab), message);

export const builtSiteTabResult =
  (tab: BuiltSiteTab, failure: (error: string) => string = (error) => error) =>
  (success: string) =>
  (id: number, result: { ok: true } | { ok: false; error: string }): Response =>
    result.ok
      ? builtSiteTabSuccess(id, tab, success)
      : builtSiteTabError(id, tab, failure(result.error));

export type BuiltSitePost = (
  site: BuiltSite,
  form: { getString: (key: string) => string },
  id: number,
) => Promise<Response>;

const builtSiteHandler = createIdEntityHandler<BuiltSite>(
  builtSitesCrudTable.findById,
);

export const builtSiteAction = (action: BuiltSitePost): IdRouteHandler =>
  builtSiteHandler(requireOwnerOr)(async (site, _session, request, { id }) => {
    const csrf = await requireCsrfForm(request, () =>
      htmlResponse("CSRF token invalid", 403),
    );
    return csrf.ok ? action(site, csrf.form, id) : csrf.response;
  });
