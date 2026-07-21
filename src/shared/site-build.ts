import { validateBootChecks } from "#shared/boot-checks.ts";
import {
  type BuildSiteInput,
  type BuildSiteResult,
  builderApi,
} from "#shared/builder.ts";
import type { BuiltSite } from "#shared/db/built-sites/types.ts";
import {
  builtSites,
  builtSitesCrudTable,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import { initDb } from "#shared/db/migrations.ts";
import { ErrorCode, logError } from "#shared/logger.ts";

const nextSiteName = async (): Promise<string> =>
  String((await builtSites.getAll()).length + 1).padStart(5, "0");

export const buildRetainedSite = async (
  name: string,
  input: BuildSiteInput,
): Promise<{ result: BuildSiteResult; retainedId: number }> => {
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

/** Build and retain one site before making it available for assignment. */
export const buildAssignableSite = async (): Promise<BuiltSite | null> => {
  const name = await nextSiteName();
  const { result, retainedId } = await buildRetainedSite(name, {
    siteName: name,
  });
  if (!result.ok) {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `Failed to auto-build site '${name}': ${result.error}`,
    });
    return null;
  }
  return builtSitesCrudTable.update(retainedId, { assignable: true });
};
