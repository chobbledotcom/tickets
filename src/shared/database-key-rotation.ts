/** Rotate a built site's database key in two steps. A durable claim prevents
 * a later invalidation from overtaking token creation or the hosting push. */

import { hmacHash } from "#crypto/hashing.ts";
import { verifySignedValue } from "#crypto/signed-value.ts";
import { base64ToBase64Url } from "#crypto/utils.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import { updateBuiltSite } from "#db/built-sites.ts";
import { databaseHostFor } from "#db/host.ts";
import { t } from "#i18n";
import { adminRecordPath } from "#shared/admin-surface.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { getEnv } from "#shared/env.ts";
import { nowMs } from "#shared/now.ts";
import type { DatabaseProviderApi } from "#shared/provider-types.ts";
import {
  errorResult,
  type Outcome,
  okResult,
  type Result,
} from "#shared/result.ts";
import {
  resolveHostingProvider,
  siteHostingAccess,
} from "#shared/site-hosting.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";

/** Seconds the database needs after it removes every key, before a new key
 * stays valid. The provider needs a short downtime for the change, so the web
 * flow waits on its timer page and the command-line flow waits too. */
export const DATABASE_KEY_PAUSE_SECONDS = 60;

/** A timer link expires ten minutes after its recorded start. */
const ROTATION_LINK_MAX_AGE_MS = 600_000;

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

/** A rotation step's answer: what it did, or the refusal that stopped it. */
type StepAnswer<Answer> = Answer | { error: string; ok: false };

/** One rotation step for a site, run after this host's access check passes.
 * The provider and the hosting id come from that check. */
const stepFor =
  <Args extends unknown[], Answer>(
    run: (
      site: BuiltSite,
      provider: DatabaseProviderApi,
      hostingId: string,
      ...args: Args
    ) => Promise<Answer>,
  ) =>
  async (site: BuiltSite, ...args: Args): Promise<StepAnswer<Answer>> => {
    const access = databaseKeyRotationAccess(site);
    if (!access.ok) return access;
    return run(
      site,
      DATABASE_PROVIDERS[access.provider],
      access.hostingId,
      ...args,
    );
  };

/** Change the rotation state through the site's revision fence. A negative
 * start owns the provider operation. Zero is idle, and a positive start waits. */
const changeRotation = async (
  siteId: number,
  change: (current: number) => number | null,
): Promise<number | null> => {
  let next: number | null = null;
  await updateBuiltSite(siteId, (site) => {
    next = change(site.databaseKeyRotationStarted);
    return next === null ? null : { databaseKeyRotationStarted: next };
  });
  return next;
};

/** The shared deadline check for both web and command-line completion. */
const rotationReady = (started: number): boolean => {
  const elapsed = nowMs() - started;
  return (
    started > 0 &&
    elapsed >= DATABASE_KEY_PAUSE_SECONDS * 1000 &&
    elapsed <= ROTATION_LINK_MAX_AGE_MS
  );
};

/** Own one provider operation and release it on every ordinary exit. Step one
 * can leave a positive start for the timer. Every other exit leaves idle. */
const withRotationClaim = async <Answer>(
  siteId: number,
  reserve: (current: number) => number | null,
  refusal: string,
  run: (reserved: number, wait: (started: number) => void) => Promise<Answer>,
): Promise<StepAnswer<Answer>> => {
  const reserved = await changeRotation(siteId, reserve);
  if (reserved === null) return errorResult(refusal);
  let waiting = 0;
  try {
    return await run(reserved, (started) => {
      waiting = started;
    });
  } finally {
    await updateBuiltSite(siteId, () => ({
      databaseKeyRotationStarted: waiting,
    }));
  }
};

/** Remove every old key while the site owns the provider operation. A later
 * waiting start gets a distinct timestamp, even within the same millisecond. */
export const startDatabaseKeyRotation = stepFor((site, provider) =>
  withRotationClaim(
    site.id,
    (current) => (current < 0 ? null : -Math.max(nowMs(), current + 1)),
    t("built_sites.database_key_rotation_busy"),
    async (reserved, wait): Promise<Result<number>> => {
      const invalidated = await provider.invalidateDatabaseTokens(site.dbUrl);
      if (!invalidated.ok) return invalidated;
      const started = Math.max(nowMs(), -reserved);
      wait(started);
      return okResult(started);
    },
  ),
);

/** Keep the claim through token creation, storage, and the hosting push. No
 * other start or completion can change the provider during those steps. */
export const completeDatabaseKeyRotation = stepFor(
  (site, provider, hostingId, started: number) =>
    withRotationClaim(
      site.id,
      (current) =>
        current === started && rotationReady(started) ? -started : null,
      t("built_sites.database_key_link_expired"),
      async (): Promise<Outcome> => {
        const issued = await provider.issueDatabaseToken(site.dbUrl);
        if (!issued.ok) return issued;
        await updateBuiltSite(site.id, () => ({ dbToken: issued.value }));
        const pushed = await resolveHostingProvider(
          site.hostingProvider,
        ).setSecrets(hostingId, [["DB_TOKEN", issued.value]]);
        return pushed.ok
          ? pushed
          : errorResult(
              t("built_sites.database_key_push_failed", {
                error: pushed.error,
              }),
            );
      },
    ),
);

/** The signature binds the site and its unique start in epoch milliseconds. */
const rotationMessage = (siteId: number, started: number): string =>
  ["database-key", siteId, started].join(":");

/**
 * The signed path that runs step two. The timer page's meta refresh opens it
 * when the pause ends. The signature stops a stranger from sending this write
 * under an owner's session, because a GET carries no form token.
 */
export const databaseKeyIssueUrl = async (
  siteId: number,
  started: number,
): Promise<string> => {
  const signature = base64ToBase64Url(
    await hmacHash(rotationMessage(siteId, started)),
  );
  const query = new URLSearchParams({ sig: signature, start: String(started) });
  const path = adminRecordPath("builtSiteCompleteDatabaseKeyRotation", siteId);
  return `${path}?${query.toString()}`;
};

/** The rotation start a completion link names, when its signature holds and
 * the pause after that start is over. A link that is missing, altered, opened
 * before the pause ends, or out of time names no rotation. */
export const databaseKeyLinkStartOrNull = async (
  siteId: number,
  startField: string | null,
  signature: string | null,
): Promise<number | null> => {
  if (startField === null || signature === null) return null;
  const opens = await verifySignedValue(
    startField,
    signature,
    rotationReady,
    (start) => rotationMessage(siteId, start),
  );
  return opens ? Number.parseInt(startField, 10) : null;
};
