import { resolveHostingProvider, siteHostingAccess } from "#shared/builder.ts";
import { ensureBuiltSiteSchedulerKey } from "#shared/db/built-site-scheduler.ts";
import { builtSitesCrudTable } from "#shared/db/built-sites.ts";
import type { ApiResult } from "#shared/fetch.ts";
import { fetchText } from "#shared/fetch.ts";
import { SCHEDULED_TASK_KEY_ENV } from "#shared/scheduled-keys.ts";

type SiteSchedulerResult = ApiResult<Record<never, never>>;

const getSite = async (siteId: number) => {
  const site = await builtSitesCrudTable.findById(siteId);
  if (!site) throw new Error(`Built site not found: ${siteId}`);
  return site;
};

const verifyScheduledKey = async (
  siteUrl: string,
  key: string,
): Promise<SiteSchedulerResult> => {
  try {
    const result = await fetchText(
      `${new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`).origin}/scheduled`,
      {
        headers: { authorization: `Bearer ${key}` },
        method: "POST",
        redirect: "manual",
      },
    );
    return result.status === 204 && result.text === ""
      ? { ok: true }
      : {
          error: "The child did not accept the scheduled task key.",
          ok: false,
        };
  } catch {
    return {
      error: "The child could not verify the scheduled task key.",
      ok: false,
    };
  }
};

export const provisionSiteScheduler = async (
  siteId: number,
): Promise<SiteSchedulerResult> => {
  const site = await getSite(siteId);
  const access = siteHostingAccess(
    site,
    "its scheduled task key cannot be set",
  );
  if (!access.ok) return access;
  const provider = resolveHostingProvider(site.hostingProvider);
  if (!site.scheduledTaskKey) {
    const listed = await provider.getSecretNames(access.hostingId);
    if (!listed.ok) return listed;
    if (listed.names.includes(SCHEDULED_TASK_KEY_ENV)) {
      return {
        error:
          "The child already has a scheduled task key that this site cannot read.",
        ok: false,
      };
    }
  }
  const key = await ensureBuiltSiteSchedulerKey(siteId);
  const set = await provider.setSecrets(access.hostingId, [
    [SCHEDULED_TASK_KEY_ENV, key],
  ]);
  if (!set.ok) return set;
  return verifyScheduledKey(site.siteUrl, key);
};
