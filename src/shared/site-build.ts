/**
 * Build a site and keep a record of it — the path this host's admin builder
 * page and the scripts/build-site.ts CLI share. Assignment never calls this:
 * it hands out pre-built sites from the pool only.
 */

import { insertBuiltSite } from "#db/built-sites.ts";
import { initDb } from "#db/migrations.ts";
import { validateBootChecks } from "#shared/boot-checks.ts";
import {
  type BuildSiteInput,
  type BuildSiteResult,
  builderApi,
} from "#shared/builder.ts";

/** A build's outcome, with the id of the row the retain callback stored. */
type RetainedBuild = { result: BuildSiteResult; retainedId: number };

/**
 * Build one site and retain a row for it as part of the build. The retain
 * callback must have stored the row before the caller sees success, so a
 * provider that reports a site nobody recorded fails loudly instead.
 */
export const buildRetainedSite = async (
  name: string,
  input: BuildSiteInput,
): Promise<RetainedBuild> => {
  validateBootChecks();
  await initDb();
  const retainedId = { value: 0 };
  const result = await builderApi.buildSite(input, async (site) => {
    const row = await insertBuiltSite(
      name,
      site.defaultHostname,
      site.dbUrl,
      site.dbToken,
      false,
      site.hostingId,
      undefined,
      site.hostingProvider,
      site.dbProvider,
      site.scheduledTaskKey,
    );
    retainedId.value = row.id;
  });
  if (result.ok && retainedId.value === 0) {
    throw new Error("Built site was not retained");
  }
  return { result, retainedId: retainedId.value };
};
