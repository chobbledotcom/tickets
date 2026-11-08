/** The one gated shape that every built-site tab write uses. It loads the site
 * by its route id, and answers 404 when the site is gone. Then it runs the form
 * policy that the route declares, CSRF check included. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { builtSitesCrudTable } from "#db/built-sites.ts";
import type { AuthSession } from "#routes/auth.ts";
import { createIdEntityHandler, type IdParam } from "#routes/entity.ts";
import { formGuardAt } from "#routes/route-gates.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";

/** What a gated built-site form POST hands its handler: the loaded site, the
 * session, the parsed form, the request, and the route params. */
export type BuiltSitePost = ResponseHandler<
  [
    site: BuiltSite,
    session: AuthSession,
    form: FormParams,
    request: Request,
    params: IdParam,
  ]
>;

/** Every built-sites route declares the same audience, so the record page's
 * gate is the one they share. */
export const builtSiteFormPost = createIdEntityHandler<BuiltSite>((id) =>
  builtSitesCrudTable.read.one({ id }),
)(formGuardAt("builtSite"));
