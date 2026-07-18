/* jscpd:ignore-start */
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import {
  parseSiteDataBlob,
  type SiteDataBlob,
} from "#shared/db/built-sites.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import { retryWrite } from "#shared/db/retry-write.ts";
import { generateScheduledTaskKey } from "#shared/scheduled-keys.ts";

/* jscpd:ignore-end */

type StoredScheduler = {
  site_data: EnvKeyEncrypted;
  site_data_revision: number;
};

export type BuiltSiteScheduler = {
  active: string | null;
  pending: string | null;
  revision: number;
};

type SchedulerRecord = BuiltSiteScheduler & { blob: SiteDataBlob };

const schedulerState = (
  active: string | null,
  pending: string | null,
  revision: number,
): BuiltSiteScheduler => ({ active, pending, revision });

const loadScheduler = async (siteId: number): Promise<SchedulerRecord> => {
  const row = await queryOne<StoredScheduler>(
    `SELECT site_data, site_data_revision
       FROM built_sites WHERE id = ?`,
    [siteId],
  );
  if (!row) throw new Error(`Built site not found: ${siteId}`);
  const blob = parseSiteDataBlob(await decrypt(row.site_data));
  return {
    active: blob.sk ?? null,
    blob,
    pending: blob.sn ?? null,
    revision: row.site_data_revision,
  };
};

export const readBuiltSiteScheduler = async (
  siteId: number,
): Promise<BuiltSiteScheduler> => {
  const { active, pending, revision } = await loadScheduler(siteId);
  return schedulerState(active, pending, revision);
};

const schedulerBlob = (
  blob: SiteDataBlob,
  active: string,
  pending: string | null,
): SiteDataBlob => ({
  ...(() => {
    const next = { ...blob };
    delete next.sk;
    delete next.sn;
    return next;
  })(),
  sk: active,
  ...(pending ? { sn: pending } : {}),
  v: 2,
});

const writeScheduler = async (
  siteId: number,
  current: SchedulerRecord,
  active: string,
  pending: string | null,
): Promise<boolean> => {
  const encrypted = await encrypt(
    JSON.stringify(schedulerBlob(current.blob, active, pending)),
  );
  const result = await execute(
    `UPDATE built_sites
        SET site_data = ?, site_data_revision = site_data_revision + 1
      WHERE id = ? AND site_data_revision = ?`,
    [encrypted, siteId, current.revision],
  );
  return result.rowsAffected === 1;
};

type SchedulerDecision =
  | { done: BuiltSiteScheduler }
  | { active: string; pending: string | null };

const updateScheduler = async (
  siteId: number,
  failure: string,
  decide: (current: SchedulerRecord) => SchedulerDecision,
): Promise<BuiltSiteScheduler> =>
  retryWrite(failure, async () => {
    const current = await loadScheduler(siteId);
    const decision = decide(current);
    if ("done" in decision) return { value: decision.done };
    if (
      await writeScheduler(siteId, current, decision.active, decision.pending)
    ) {
      return {
        value: schedulerState(
          decision.active,
          decision.pending,
          current.revision + 1,
        ),
      };
    }
    return null;
  });

const ensureSchedulerValue = async (
  siteId: number,
  slot: "active" | "pending",
): Promise<BuiltSiteScheduler> => {
  const candidate = generateScheduledTaskKey();
  return updateScheduler(
    siteId,
    `Could not update scheduled key for site ${siteId}`,
    (current) => {
      if (current[slot]) {
        return {
          done: schedulerState(
            current.active,
            current.pending,
            current.revision,
          ),
        };
      }
      if (slot === "active") {
        return { active: candidate, pending: current.pending };
      }
      if (!current.active) {
        throw new Error("Cannot rotate a site with no active scheduled key");
      }
      return { active: current.active, pending: candidate };
    },
  );
};

export const ensureBuiltSiteSchedulerKey = (
  siteId: number,
): Promise<BuiltSiteScheduler> => ensureSchedulerValue(siteId, "active");

export const ensureBuiltSiteSchedulerNextKey = (
  siteId: number,
): Promise<BuiltSiteScheduler> => ensureSchedulerValue(siteId, "pending");

export const promoteBuiltSiteSchedulerKey = async (
  siteId: number,
  expectedPending: string,
): Promise<BuiltSiteScheduler> =>
  updateScheduler(
    siteId,
    `Could not promote scheduled key for site ${siteId}`,
    (current) => {
      if (current.active === expectedPending && current.pending === null) {
        return {
          done: schedulerState(current.active, null, current.revision),
        };
      }
      if (current.pending !== expectedPending) {
        throw new Error("Scheduled key changed while promoting site");
      }
      return { active: expectedPending, pending: null };
    },
  );
