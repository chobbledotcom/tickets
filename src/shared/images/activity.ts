/**
 * The activity-log line the image library writes, for both surfaces: the
 * dashboard page and the admin JSON API.
 */

import { logActivity } from "#db/activity-log.ts";

/** Record one image library action in the activity log. The library writes
 *  one audit line per action, whichever surface took it. */
export const logImageAction = async (
  action: "deleted" | "updated" | "uploaded",
  name: string,
): Promise<void> => {
  await logActivity(`Image '${name}' ${action}`);
};
