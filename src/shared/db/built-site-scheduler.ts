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

type SchedulerRecord = {
  active: string | null;
  blob: SiteDataBlob;
  revision: number;
};

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
    revision: row.site_data_revision,
  };
};

const schedulerBlob = (blob: SiteDataBlob, key: string): SiteDataBlob => ({
  ...blob,
  sk: key,
  v: 2,
});

const writeScheduler = async (
  siteId: number,
  current: SchedulerRecord,
  key: string,
): Promise<boolean> => {
  const encrypted = await encrypt(
    JSON.stringify(schedulerBlob(current.blob, key)),
  );
  const result = await execute(
    `UPDATE built_sites
        SET site_data = ?, site_data_revision = site_data_revision + 1
      WHERE id = ? AND site_data_revision = ?`,
    [encrypted, siteId, current.revision],
  );
  return result.rowsAffected === 1;
};

/** Create one active key for a built site, or return its existing key. */
export const ensureBuiltSiteSchedulerKey = async (
  siteId: number,
): Promise<string> => {
  const candidate = generateScheduledTaskKey();
  return retryWrite(
    `Could not set scheduled key for site ${siteId}`,
    async () => {
      const current = await loadScheduler(siteId);
      if (current.active) return { value: current.active };
      return (await writeScheduler(siteId, current, candidate))
        ? { value: candidate }
        : null;
    },
  );
};
