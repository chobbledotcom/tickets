import { resolveHostingProvider, siteHostingAccess } from "#shared/builder.ts";
import {
  ensureBuiltSiteSchedulerKey,
  ensureBuiltSiteSchedulerNextKey,
  promoteBuiltSiteSchedulerKey,
  readBuiltSiteScheduler,
} from "#shared/db/built-site-scheduler.ts";
import { builtSitesCrudTable } from "#shared/db/built-sites.ts";
import type { ApiResult } from "#shared/fetch.ts";
import { fetchText } from "#shared/fetch.ts";
import {
  SCHEDULED_TASK_KEY_ENV,
  SCHEDULED_TASK_KEY_NEXT_ENV,
} from "#shared/scheduled-keys.ts";

type SiteSchedulerResult = ApiResult<Record<never, never>>;
type SchedulerSlot = "active" | "pending";

const getSite = async (siteId: number) => {
  const site = await builtSitesCrudTable.findById(siteId);
  if (!site) throw new Error(`Built site not found: ${siteId}`);
  return site;
};

const loadSiteScheduler = async (siteId: number) => ({
  current: await readBuiltSiteScheduler(siteId),
  site: await getSite(siteId),
});

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

const SLOT_CONFIG: Record<
  SchedulerSlot,
  {
    blocked: string;
    conflict: string;
    ensure: typeof ensureBuiltSiteSchedulerKey;
    envName: string;
  }
> = {
  active: {
    blocked: "its scheduled task key cannot be set",
    conflict:
      "The child already has a scheduled task key that this site cannot read.",
    ensure: ensureBuiltSiteSchedulerKey,
    envName: SCHEDULED_TASK_KEY_ENV,
  },
  pending: {
    blocked: "its scheduled task key cannot be changed",
    conflict:
      "The child already has a next scheduled task key that this site cannot read.",
    ensure: ensureBuiltSiteSchedulerNextKey,
    envName: SCHEDULED_TASK_KEY_NEXT_ENV,
  },
};

const pushSiteSchedulerKey = async (
  siteId: number,
  slot: SchedulerSlot,
): Promise<SiteSchedulerResult> => {
  const { current, site } = await loadSiteScheduler(siteId);
  if (slot === "pending" && !current.active) {
    return {
      error: "Set up scheduled maintenance before changing its key.",
      ok: false,
    };
  }
  const config = SLOT_CONFIG[slot];
  const access = siteHostingAccess(site, config.blocked);
  if (!access.ok) return access;
  const provider = resolveHostingProvider(site.hostingProvider);
  if (!current[slot]) {
    const listed = await provider.getSecretNames(access.hostingId);
    if (!listed.ok) return listed;
    if (listed.names.includes(config.envName)) {
      return { error: config.conflict, ok: false };
    }
  }
  const key = (await config.ensure(siteId))[slot]!;
  const set = await provider.setSecrets(access.hostingId, [
    [config.envName, key],
  ]);
  if (!set.ok) return set;
  return verifyScheduledKey(site.siteUrl, key);
};

export const provisionSiteScheduler = (
  siteId: number,
): Promise<SiteSchedulerResult> => pushSiteSchedulerKey(siteId, "active");

export const stageSiteSchedulerRotation = (
  siteId: number,
): Promise<SiteSchedulerResult> => pushSiteSchedulerKey(siteId, "pending");

export const promoteSiteSchedulerRotation = async (
  siteId: number,
): Promise<SiteSchedulerResult> => {
  const {
    current: { pending },
    site,
  } = await loadSiteScheduler(siteId);
  if (!pending) {
    return {
      error: "This site has no scheduled task key ready to use.",
      ok: false,
    };
  }
  const access = siteHostingAccess(
    site,
    "its scheduled task key cannot be promoted",
  );
  if (!access.ok) return access;
  const promoted = await resolveHostingProvider(
    site.hostingProvider,
  ).promoteSecrets(
    access.hostingId,
    [SCHEDULED_TASK_KEY_ENV, pending],
    SCHEDULED_TASK_KEY_NEXT_ENV,
  );
  if (!promoted.ok) return promoted;
  await promoteBuiltSiteSchedulerKey(siteId, pending);
  return { ok: true };
};
