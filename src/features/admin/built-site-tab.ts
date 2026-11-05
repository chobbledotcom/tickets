/** Where a built-site tab lives, and the one way a tab write answers back:
 * its success line, or its failure line, on that tab. */

import { identity } from "#fp";
import { errorRedirect, redirect } from "#routes/response.ts";
import { adminPath } from "#shared/admin-surface.ts";
import { tabPath } from "#shared/entity-pages/core.ts";
import type { Outcome } from "#shared/result.ts";

/** One tab of a built site's page, by its URL segment. */
export type BuiltSiteTab =
  | "maintenance"
  | "renewal"
  | "secrets"
  | "support-message"
  | "update";

/** Where one built-site tab lives: the record's declared route and the tab. */
export const builtSiteTabPath = (id: number, tab: BuiltSiteTab): string =>
  tabPath(adminPath("builtSite", { id }), tab);

/** Answer a tab write with the line its outcome earns, back on that tab. */
export const answerTab = (
  tab: BuiltSiteTab,
  id: number,
  outcome: Outcome,
  success: string,
  failure: (error: string) => string = identity,
): Response =>
  outcome.ok
    ? redirect(builtSiteTabPath(id, tab), success, true)
    : errorRedirect(builtSiteTabPath(id, tab), failure(outcome.error));

/** Refuse a tab write whose message the handler already knows, back on that
 * tab. The other half of {@link answerTab}: a write that runs first answers
 * through its outcome, and a write that stops before it answers here. */
export const refuseTab = (
  tab: BuiltSiteTab,
  id: number,
  message: string,
): Response => errorRedirect(builtSiteTabPath(id, tab), message);
