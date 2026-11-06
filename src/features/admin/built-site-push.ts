/** The renewal tab's answer after a hosting push, and the one place a push
 * writes the activity log. */

import { logActivity } from "#db/activity-log.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { answerTab } from "./built-site-tab.ts";

/** What a renewal push answers with: the activity line a push that worked
 * leaves, then the tab's own line for either outcome. */
export type RenewalPushLines = {
  activity: string;
  failure: string;
  success: string;
};

/** Answer the renewal tab after a push that either worked or failed. A push
 * that worked leaves its line in the activity log first. */
export const answerRenewalPush = async (
  site: BuiltSite,
  pushed: boolean,
  { activity, failure, success }: RenewalPushLines,
): Promise<Response> => {
  if (pushed) await logActivity(activity);
  return answerTab(
    "renewal",
    site.id,
    pushed ? { ok: true } : { error: failure, ok: false },
    success,
  );
};
