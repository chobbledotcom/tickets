/**
 * Rotating a built site's database key. The key is the site's full-access
 * database token. The database provider replaces every key it issued for that
 * database with one new key. The host stores the new key on the site record,
 * and the site receives it as DB_TOKEN.
 */

import type { BuiltSite } from "#db/built-sites/types.ts";
import { updateBuiltSite } from "#db/built-sites.ts";
import { databaseHostFor } from "#db/host.ts";
import { t } from "#i18n";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { getEnv } from "#shared/env.ts";
import type { DatabaseProviderApi } from "#shared/provider-types.ts";
import { errorResult, type Outcome, type Result } from "#shared/result.ts";
import { serialQueue } from "#shared/serial-queue.ts";
import {
  resolveHostingProvider,
  siteHostingAccess,
} from "#shared/site-hosting.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";

/** Rotations queue here. Each one stores and pushes its key before the next
 * rotation begins. Two overlapping rotations then cannot leave the site with a
 * key that the database already replaced. */
const serializeRotation = serialQueue();

/** The two databases a host can change the key of through a provider API. */
export type DatabaseKeyProvider = "bunny" | "turso";

const DATABASE_PROVIDERS: Record<DatabaseKeyProvider, DatabaseProviderApi> = {
  bunny: bunnyDbProvider,
  turso: tursoDbProvider,
};

/** The setting names each provider's key rotation reads on this host. */
const PROVIDER_ENV_KEYS: Record<DatabaseKeyProvider, string[]> = {
  bunny: ["BUNNY_API_KEY"],
  turso: ["TURSO_API_TOKEN", "TURSO_ORGANIZATION"],
};

/** The catalog key that names each provider to a reader. */
export const DATABASE_PROVIDER_LABEL_KEYS: Record<DatabaseKeyProvider, string> =
  {
    bunny: "built_sites.database_key_provider_bunny",
    turso: "built_sites.database_key_provider_turso",
  };

/** Whether this host can change this site's database key, and which provider
 * it calls. A failure here carries the message the admin reads. */
export type DatabaseKeyRotationAccess =
  | { ok: true; hostingId: string; provider: DatabaseKeyProvider }
  | { ok: false; error: string };

/** The settings this provider's rotation is missing, or null when it holds
 * them all. */
const missingProviderSettings = (provider: DatabaseKeyProvider): string[] =>
  PROVIDER_ENV_KEYS[provider].filter((name) => !getEnv(name));

/** The provider that runs the site's database, or the refusal that says why
 * this host cannot change its key. */
export const databaseKeyRotationAccess = (
  site: BuiltSite,
): DatabaseKeyRotationAccess => {
  if (!site.dbUrl) {
    return errorResult(t("built_sites.database_key_no_address"));
  }
  const host = databaseHostFor(site.dbUrl);
  if (host !== "bunny" && host !== "turso") {
    return errorResult(
      t(
        host === "local"
          ? "built_sites.database_key_local"
          : "built_sites.database_key_other",
      ),
    );
  }
  const missing = missingProviderSettings(host);
  if (missing.length > 0) {
    return errorResult(
      t("built_sites.database_key_unconfigured", {
        keys: missing.join(" and "),
        provider: t(DATABASE_PROVIDER_LABEL_KEYS[host]),
      }),
    );
  }
  const access = siteHostingAccess(
    site,
    "its database key can't be sent to it",
  );
  if (!access.ok) return access;
  return { hostingId: access.hostingId, ok: true, provider: host };
};

/** The provider's replacement key for this database. */
const rotateAtProvider = (
  provider: DatabaseKeyProvider,
  dbUrl: string,
): Promise<Result<string>> =>
  DATABASE_PROVIDERS[provider].rotateDatabaseKey(dbUrl);

/**
 * Replace the site's database key and send it to the site. The provider
 * invalidates every key it issued for the database, so the stored key changes
 * before the push. Until the push lands, the site cannot reach its database.
 * A second rotation completes the work.
 */
export const rotateDatabaseKey = (site: BuiltSite): Promise<Outcome> =>
  serializeRotation(async () => {
    const access = databaseKeyRotationAccess(site);
    if (!access.ok) return access;
    const rotated = await rotateAtProvider(access.provider, site.dbUrl);
    if (!rotated.ok) return rotated;
    // The new key is the only live one, so it is the truth to store now, even
    // if the push then fails.
    await updateBuiltSite(site.id, () => ({ dbToken: rotated.value }));
    const pushed = await resolveHostingProvider(
      site.hostingProvider,
    ).setSecrets(access.hostingId, [["DB_TOKEN", rotated.value]]);
    return pushed.ok
      ? pushed
      : {
          error: t("built_sites.database_key_push_failed", {
            error: pushed.error,
          }),
          ok: false,
        };
  });
