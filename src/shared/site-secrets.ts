/**
 * Secrets insight + backfill for existing built sites.
 *
 * A freshly built site has the full set of secrets copied onto it (see
 * builder.ts). Host secrets, however, accumulate over time — a site built
 * before, say, the Google Wallet keys were configured will be missing them.
 * This module diffs a site's live secrets (read from the hosting provider API)
 * against the set we would copy today, and can backfill the ones that are
 * missing.
 *
 * It never overwrites a secret that already exists on the site: a value may
 * have been changed deliberately. DB_ENCRYPTION_KEY in particular is excluded
 * from the expected set entirely — it is generated per-site at build time and
 * never stored, so it cannot be reproduced, and re-setting it with a fresh key
 * would orphan the site's existing encrypted data.
 */

import {
  collectHostSecrets,
  HOST_INFRA_SECRET_KEYS,
  resolveHostingProvider,
  siteHostingAccess,
} from "#shared/builder.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import type { Result } from "#shared/result.ts";
import { tryStep } from "#shared/try-step.ts";

/**
 * The secrets we would copy to a freshly built site, recomputed for an existing
 * site from its stored record plus the current host environment. Excludes
 * DB_ENCRYPTION_KEY (see module docs) and the renewal secrets
 * (READ_ONLY_FROM / RENEWAL_URL), which the renewal panel manages separately.
 */
export const expectedSiteSecrets = (site: BuiltSite): [string, string][] => {
  const base: [string, string][] = [];
  if (site.dbUrl) base.push(["DB_URL", site.dbUrl]);
  if (site.dbToken) base.push(["DB_TOKEN", site.dbToken]);
  if (site.hostingProvider !== "deno" && site.hostingId) {
    base.push(["BUNNY_SCRIPT_ID", site.hostingId]);
  }
  return [...base, ...collectHostSecrets(site.hostingProvider)];
};

/** Pick the host-level infrastructure credential names out of a name list, so
 * the backfill UI can flag that copying them grants the child host-level access.
 * The classification lives on builder.ts's HOST_SECRETS (the single source). */
export const hostInfraSecretNames = (names: string[]): string[] =>
  names.filter((name) => HOST_INFRA_SECRET_KEYS.includes(name));

/** Outcome of inspecting a site's live secrets against the expected set. */
export type SiteSecretsView =
  | {
      ok: true;
      /** Every secret name currently set on the hosting provider. */
      present: string[];
      /** Expected secret names that are not present. */
      missing: string[];
      /** All names we would copy to a fresh build of this site. */
      expected: string[];
    }
  | { ok: false; error: string };

/** Fetch the live secret names for a site, resilient to network/parse errors. */
const listSecretNames = (
  site: BuiltSite,
  hostingId: string,
): Promise<Result<string[]>> =>
  tryStep("Failed to list secrets", () =>
    resolveHostingProvider(site.hostingProvider).getSecretNames(hostingId),
  );

type ResolvedSiteSecrets = {
  hostingId: string;
  names: string[];
  present: Set<string>;
};

/**
 * Resolve a site's precondition and live secret list into a single context,
 * shared by the read (status) and write (backfill) paths.
 */
const resolveSiteSecrets = async (
  site: BuiltSite,
): Promise<
  { ok: true; data: ResolvedSiteSecrets } | { ok: false; error: string }
> => {
  const pre = siteHostingAccess(site, "its secrets can't be read");
  if (!pre.ok) return pre;
  const listed = await listSecretNames(site, pre.hostingId);
  if (!listed.ok) return listed;
  return {
    data: {
      hostingId: pre.hostingId,
      names: listed.value,
      present: new Set(listed.value),
    },
    ok: true,
  };
};

const withResolvedSite = async <S>(
  site: BuiltSite,
  fn: (data: ResolvedSiteSecrets) => Promise<S>,
): Promise<S | { ok: false; error: string }> => {
  const resolved = await resolveSiteSecrets(site);
  if (!resolved.ok) return resolved;
  return fn(resolved.data);
};

/** Inspect a site's live secrets and diff them against the expected set. */
export const loadSiteSecretsStatus = async (
  site: BuiltSite,
): Promise<SiteSecretsView> =>
  withResolvedSite(site, async ({ names, present }) => {
    const expected = expectedSiteSecrets(site).map(([name]) => name);
    return {
      expected,
      missing: expected.filter((name) => !present.has(name)),
      ok: true as const,
      present: names,
    };
  });

/** Outcome of backfilling a site's missing secrets. */
export type AddMissingSecretsResult =
  | { ok: true; added: string[] }
  | { ok: false; error: string };

/**
 * Re-verify the site's live secrets, then set only the ones still missing from
 * the expected set. Never overwrites a secret that already exists.
 */
export const addMissingSiteSecrets = (
  site: BuiltSite,
): Promise<AddMissingSecretsResult> =>
  // Re-verify against the live list in case more secrets exist by now.
  withResolvedSite(site, async ({ present, hostingId }) => {
    const toAdd = expectedSiteSecrets(site).filter(
      ([name]) => !present.has(name),
    );

    if (toAdd.length === 0) return { added: [], ok: true };

    const result = await resolveHostingProvider(
      site.hostingProvider,
    ).setSecrets(hostingId, toAdd);
    if (!result.ok) return result;
    return { added: toAdd.map(([name]) => name), ok: true };
  });
