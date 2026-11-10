/** The renewal tab's answer after a hosting push, and the lines it shows. */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { answerLoggedTab } from "./built-site-tab.ts";

/** What a renewal push answers with: the activity line a push that worked
 * leaves, then the tab's own line for either outcome. */
export type RenewalPushLines = {
  activity: string;
  failure: string;
  success: string;
};

/** Answer the renewal tab after a push that either worked or failed. A push
 * that worked leaves its line in the activity log first. */
export const answerRenewalPush = (
  site: BuiltSite,
  pushed: boolean,
  { activity, failure, success }: RenewalPushLines,
): Promise<Response> =>
  answerLoggedTab(
    "renewal",
    site.id,
    pushed ? { ok: true } : { error: failure, ok: false },
    { activity, success },
  );
