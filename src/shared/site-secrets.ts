/**
 * Secrets insight + backfill for existing built sites.
 *
 * A freshly built site has the full set of secrets copied onto it (see
 * builder.ts). Host secrets, however, accumulate over time — a site built
 * before, say, the Google Wallet keys were configured will be missing them.
 * This module diffs a site's live secrets (read from the Bunny API) against the
 * set we would copy today, and can backfill the ones that are missing.
 *
 * It never overwrites a secret that already exists on the site: a value may
 * have been changed deliberately. DB_ENCRYPTION_KEY in particular is excluded
 * from the expected set entirely — it is generated per-site at build time and
 * never stored, so it cannot be reproduced, and re-setting it with a fresh key
 * would orphan the site's existing encrypted data.
 */

import { collectHostSecrets, HOST_INFRA_SECRET_KEYS } from "#shared/builder.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import type { BuiltSite } from "#shared/db/built-sites.ts";
import { getEnv } from "#shared/env.ts";

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
  if (site.bunnyScriptId) base.push(["BUNNY_SCRIPT_ID", site.bunnyScriptId]);
  return [...base, ...collectHostSecrets()];
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
      /** Every secret name currently set on the edge script. */
      present: string[];
      /** Expected secret names that are not present on the edge script. */
      missing: string[];
      /** All names we would copy to a fresh build of this site. */
      expected: string[];
    }
  | { ok: false; error: string };

type SecretsPrecondition =
  | { ok: true; scriptId: number }
  | { ok: false; error: string };

/** A site can only be inspected when it has a script id and the host has an API key. */
const secretsPrecondition = (site: BuiltSite): SecretsPrecondition => {
  const scriptId = Number(site.bunnyScriptId);
  if (!scriptId) {
    return {
      error: "This site has no Bunny script ID, so its secrets can't be read.",
      ok: false,
    };
  }
  if (!getEnv("BUNNY_API_KEY")) {
    return {
      error:
        "BUNNY_API_KEY is not configured on this host, so site secrets can't be read.",
      ok: false,
    };
  }
  return { ok: true, scriptId };
};

/** Fetch the live secret names for a script, resilient to network/parse errors. */
const listSecretNames = async (
  scriptId: number,
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> => {
  try {
    const result = await bunnyCdnApi.listEdgeScriptSecrets(scriptId);
    if (!result.ok) return { error: result.error, ok: false };
    return { names: result.secrets.map((s) => s.Name), ok: true };
  } catch (e) {
    return {
      error: `Failed to list secrets: ${(e as Error).message}`,
      ok: false,
    };
  }
};

type ResolvedSiteSecrets = {
  scriptId: number;
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
  const pre = secretsPrecondition(site);
  if (!pre.ok) return pre;
  const listed = await listSecretNames(pre.scriptId);
  if (!listed.ok) return listed;
  return {
    data: {
      names: listed.names,
      present: new Set(listed.names),
      scriptId: pre.scriptId,
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
export const addMissingSiteSecrets = async (
  site: BuiltSite,
): Promise<AddMissingSecretsResult> =>
  withResolvedSite(site, async ({ present, scriptId }) => {
    const toAdd = expectedSiteSecrets(site).filter(
      ([name]) => !present.has(name),
    );
    const added: string[] = [];
    const errors: string[] = [];
    for (const [name, value] of toAdd) {
      const result = await bunnyCdnApi.setEdgeScriptSecret(
        scriptId,
        name,
        value,
      );
      if (result.ok) added.push(name);
      else errors.push(result.error);
    }
    return errors.length > 0
      ? { error: errors[0]!, ok: false as const }
      : { added, ok: true as const };
  });
