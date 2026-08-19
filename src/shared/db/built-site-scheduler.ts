import { updateBuiltSite } from "#db/built-sites.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";

/** Create one active key for a built site, or return its existing key. */
export const ensureBuiltSiteSchedulerKey = async (
  siteId: number,
): Promise<string> => {
  const candidate = generateScheduledTaskKey();
  let key = candidate;
  const updated = await updateBuiltSite(siteId, (existing) => {
    key = existing.scheduledTaskKey ?? candidate;
    return existing.scheduledTaskKey ? null : { scheduledTaskKey: candidate };
  });
  if (!updated) throw new Error(`Built site not found: ${siteId}`);
  return key;
};
