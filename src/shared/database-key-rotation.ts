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
import { updateBuiltSite } from "#db/built-sites.ts";
import { databaseHostFor } from "#db/host.ts";
import { t } from "#i18n";
import { adminRecordPath } from "#shared/admin-surface.ts";
import { bunnyDbProvider } from "#shared/bunny-db.ts";
import { getEnv } from "#shared/env.ts";
import { nowSeconds } from "#shared/now.ts";
import type { DatabaseProviderApi } from "#shared/provider-types.ts";
import { errorResult, type Outcome } from "#shared/result.ts";
import {
  resolveHostingProvider,
  siteHostingAccess,
} from "#shared/site-hosting.ts";
import { tursoDbProvider } from "#shared/turso-api.ts";

/** Seconds the database needs after it removes every key, before a new key
 * stays valid. The provider needs a short downtime for the change, so the web
 * flow waits on its timer page and the command-line flow waits too. */
export const DATABASE_KEY_PAUSE_SECONDS = 60;

/** Seconds a rotation link stays open: the timer page's own wait, plus time to
 * reload it. A later link is refused, and the operator starts again. */
const ROTATION_LINK_MAX_AGE_S = 600;

/** Seconds of clock skew a rotation link allows. */
const ROTATION_LINK_CLOCK_SKEW_S = 60;

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

/** One rotation step, ready to run for a site. Every step first checks the
 * access. It then runs the provider call with the hosting id the new key
 * goes to. */
const stepFor =
  (
    run: (
      site: BuiltSite,
      provider: DatabaseProviderApi,
      hostingId: string,
    ) => Promise<Outcome>,
  ) =>
  async (site: BuiltSite): Promise<Outcome> => {
    const access = databaseKeyRotationAccess(site);
    if (!access.ok) return access;
    return run(site, DATABASE_PROVIDERS[access.provider], access.hostingId);
  };

/** Ask for one new key, store it, and send it to the site. The new key is the
 * only live one, so it is the truth to store now, even if the push then fails.
 * A second rotation completes the work. */
const issueAndPush = async (
  site: BuiltSite,
  provider: DatabaseProviderApi,
  hostingId: string,
): Promise<Outcome> => {
  const issued = await provider.issueDatabaseToken(site.dbUrl);
  if (!issued.ok) return issued;
  await updateBuiltSite(site.id, () => ({ dbToken: issued.value }));
  const pushed = await resolveHostingProvider(site.hostingProvider).setSecrets(
    hostingId,
    [["DB_TOKEN", issued.value]],
  );
  return pushed.ok
    ? pushed
    : {
        error: t("built_sites.database_key_push_failed", {
          error: pushed.error,
        }),
        ok: false,
      };
};

/**
 * Step one: make every key the database issued for this site stop working.
 * The site cannot reach its database after this until step two sends it a new
 * key. A provider refusal leaves the stored key alone.
 */
export const invalidateDatabaseKey = stepFor((site, provider) =>
  provider.invalidateDatabaseTokens(site.dbUrl),
);

/** Step two: make the new key and send it to the site. */
export const issueDatabaseKey = stepFor((site, provider, hostingId) =>
  issueAndPush(site, provider, hostingId),
);

/** What a rotation link signs: the site, and the second it stops opening. */
const rotationMessage = (siteId: number, expiry: number): string =>
  ["database-key", siteId, expiry].join(":");

/**
 * The signed path that runs step two. The timer page's meta refresh opens it
 * when the pause ends. The signature stops a stranger from sending this write
 * under an owner's session, because a GET carries no form token.
 */
export const databaseKeyIssueUrl = async (siteId: number): Promise<string> => {
  const expiry = nowSeconds() + ROTATION_LINK_MAX_AGE_S;
  const signature = base64ToBase64Url(
    await hmacHash(rotationMessage(siteId, expiry)),
  );
  const query = new URLSearchParams({ exp: String(expiry), sig: signature });
  const path = adminRecordPath("builtSiteCompleteDatabaseKeyRotation", siteId);
  return `${path}?${query.toString()}`;
};

/** Whether a rotation link carries this host's signature for the site, and
 * has not run out of time. A missing field never opens it. */
export const databaseKeyIssueAllowed = (
  siteId: number,
  expiry: string | null,
  signature: string | null,
): Promise<boolean> => {
  if (expiry === null || signature === null) return Promise.resolve(false);
  return verifySignedValue(
    expiry,
    signature,
    (value, now) =>
      now <= value &&
      value - now <= ROTATION_LINK_MAX_AGE_S + ROTATION_LINK_CLOCK_SKEW_S,
    (value) => rotationMessage(siteId, value),
  );
};
