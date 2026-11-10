/**
 * Rotating a built site's database key. The key is the site's full-access
 * database token. The database provider replaces every key it issued for that
 * database with one new key. The change needs a short downtime at the
 * provider. The work therefore runs in two steps: remove every old key, wait,
 * then make the new key. The host stores the new key on the site record. The
 * site receives it as DB_TOKEN.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { verifySignedValue } from "#crypto/signed-value.ts";
import { base64ToBase64Url } from "#crypto/utils.ts";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  requireBuiltSiteByIdPrimary,
  updateBuiltSite,
} from "#db/built-sites.ts";
import { databaseHostFor } from "#db/host.ts";
import { t } from "#i18n";
import { adminRecordPath } from "#shared/admin-surface.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { getEnv } from "#shared/env.ts";
import { nowSeconds } from "#shared/now.ts";
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

/** Seconds a rotation link stays open, counted from the second the rotation
 * recorded its start: the timer page's own wait, plus time to reload it. A
 * later link is refused, and the operator starts again. */
const ROTATION_LINK_MAX_AGE_S = 600;

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

/**
 * Step one: make every key the database issued for this site stop working,
 * and record when the pause began. The site cannot reach its database after
 * this until step two sends it a new key. A provider refusal leaves the stored
 * key alone. The new start replaces any older one, so a link for an earlier
 * rotation stops working.
 */
export const startDatabaseKeyRotation = stepFor(
  async (site, provider): Promise<Result<number>> => {
    const invalidated = await provider.invalidateDatabaseTokens(site.dbUrl);
    if (!invalidated.ok) return invalidated;
    const started = nowSeconds();
    await updateBuiltSite(site.id, () => ({
      databaseKeyRotationStarted: started,
    }));
    return okResult(started);
  },
);

/** Take one rotation's start, and clear it. Only the rotation that still holds
 * the start takes it, so two completions of one link cannot both make a key. */
const takeRotationStart = async (
  siteId: number,
  started: number,
): Promise<boolean> => {
  let taken = false;
  await updateBuiltSite(siteId, (existing) => {
    taken = existing.databaseKeyRotationStarted === started;
    return taken ? { databaseKeyRotationStarted: 0 } : null;
  });
  return taken;
};

/**
 * Step two: make the new key and send it to the site, for the one rotation
 * that still waits. A newer rotation's pause governs, so a key this step makes
 * while another rotation starts is dropped. The new key is the only live one,
 * so it is the truth to store, even if the push then fails. A second rotation
 * completes the work.
 */
export const completeDatabaseKeyRotation = stepFor(
  async (site, provider, hostingId, started: number): Promise<Outcome> => {
    if (!(await takeRotationStart(site.id, started))) {
      return errorResult(t("built_sites.database_key_link_expired"));
    }
    const issued = await provider.issueDatabaseToken(site.dbUrl);
    if (!issued.ok) return issued;
    const current = await requireBuiltSiteByIdPrimary(site.id);
    if (current.databaseKeyRotationStarted !== 0) {
      return errorResult(t("built_sites.database_key_rotation_superseded"));
    }
    await updateBuiltSite(site.id, () => ({ dbToken: issued.value }));
    const pushed = await resolveHostingProvider(
      site.hostingProvider,
    ).setSecrets(hostingId, [["DB_TOKEN", issued.value]]);
    return pushed.ok
      ? pushed
      : {
          error: t("built_sites.database_key_push_failed", {
            error: pushed.error,
          }),
          ok: false,
        };
  },
);

/** What a rotation link signs: the site, and the second its rotation began. */
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
    (start, now) =>
      now >= start + DATABASE_KEY_PAUSE_SECONDS &&
      now <= start + ROTATION_LINK_MAX_AGE_S,
    (start) => rotationMessage(siteId, start),
  );
  return opens ? Number.parseInt(startField, 10) : null;
};
