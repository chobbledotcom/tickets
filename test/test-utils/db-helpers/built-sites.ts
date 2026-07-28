import { beforeEach } from "@std/testing/bdd";
import type { BuildSiteResult, PreparedBuildSite } from "#shared/builder.ts";
import type {
  BuiltSite,
  BuiltSiteFormInput,
} from "#shared/db/built-sites/types.ts";
import type { SiteAssignmentDelivery } from "#shared/payment-completion-delivery.ts";
import { withEnv } from "#test-utils/env.ts";
import { required } from "#test-utils/required.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";
import { doAuthenticatedFormRequest } from "./request.ts";

/** What a successful build hands back to the app. */
export const BUILT_SITE_RESULT = {
  dbProvider: "bunny",
  dbToken: "database-token",
  dbUrl: "libsql://built-site.test",
  defaultHostname: "00001.example.test",
  hostingId: "123",
  hostingProvider: "bunny",
  ok: true,
} satisfies BuildSiteResult;

/** The same site, as handed to the app to write down before it is finished. */
export const PREPARED_BUILT_SITE = {
  ...BUILT_SITE_RESULT,
  scheduledTaskKey: TEST_SCHEDULED_KEY,
} satisfies PreparedBuildSite;

/** The built-sites admin routes 404 unless CAN_BUILD_SITES is on (the feature
 * is hidden otherwise), so a helper that drives those routes to make test data
 * enables the flag for the duration of its own request — mirroring the real
 * precondition — then restores it. */
const withBuilderEnabled = async <T>(run: () => Promise<T>): Promise<T> => {
  using _env = withEnv({ CAN_BUILD_SITES: "true" });
  return await run();
};

/**
 * Provision a test built site for renewals: writes a fresh token + HMAC index
 * directly via updateBuiltSiteRenewalState. Skips the admin route intentionally
 * — admin-route coverage lives in test/admin-built-sites-actions.test.ts.
 */
export const provisionTestBuiltSite = async (
  siteId: number,
  opts: { readOnlyFrom?: string } = {},
): Promise<{ token: string; tokenIndex: string }> => {
  const { generateRenewalToken } = await import("#shared/site-assignment.ts");
  const { updateBuiltSiteRenewalState } = await import(
    "#shared/db/built-sites.ts"
  );
  const { index, token } = await generateRenewalToken();
  await updateBuiltSiteRenewalState(siteId, {
    renewalToken: token,
    renewalTokenIndex: index,
    ...(opts.readOnlyFrom !== undefined
      ? { readOnlyFrom: opts.readOnlyFrom }
      : {}),
  });
  return { token, tokenIndex: index };
};

export const createTestBuiltSite = (
  overrides: Partial<BuiltSiteFormInput> = {},
): Promise<BuiltSite> => {
  const dbProvider = overrides.dbProvider ?? "bunny";
  const hostingProvider = overrides.hostingProvider ?? "bunny";
  const input: BuiltSiteFormInput = {
    assignable: overrides.assignable ?? false,
    dbProvider,
    dbToken: overrides.dbToken ?? "",
    dbUrl: overrides.dbUrl ?? "",
    hostingId: overrides.hostingId ?? "",
    hostingProvider,
    name: overrides.name ?? "Test Site",
    siteUrl: overrides.siteUrl ?? "https://test.b-cdn.net",
    ...(overrides.updates ? { updates: overrides.updates } : {}),
  };

  return withBuilderEnabled(() =>
    doAuthenticatedFormRequest(
      "/admin/built-sites",
      {
        db_provider: dbProvider,
        db_token: input.dbToken,
        db_url: input.dbUrl,
        hosting_id: input.hostingId,
        hosting_provider: hostingProvider,
        name: input.name,
        site_url: input.siteUrl,
        ...(input.assignable ? { assignable: "1" } : {}),
        ...(input.updates ? { updates: input.updates } : {}),
      },
      async () => {
        const { builtSites } = await import("#shared/db/built-sites.ts");
        const sites = await builtSites.getAll();
        return sites[sites.length - 1] as BuiltSite;
      },
      "create built site",
    ),
  );
};

export const updateTestBuiltSite = async (
  siteId: number,
  updates: Partial<BuiltSiteFormInput>,
): Promise<BuiltSite> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(siteId)) as BuiltSite;

  const assignable = updates.assignable ?? existing.assignable;
  return withBuilderEnabled(() =>
    doAuthenticatedFormRequest(
      `/admin/built-sites/${siteId}/edit`,
      {
        db_token: updates.dbToken ?? existing.dbToken,
        db_url: updates.dbUrl ?? existing.dbUrl,
        hosting_id: updates.hostingId ?? existing.hostingId,
        name: updates.name ?? existing.name,
        site_url: updates.siteUrl ?? existing.siteUrl,
        updates: updates.updates ?? existing.updates,
        ...(assignable ? { assignable: "1" } : {}),
      },
      async () => {
        const updated = await builtSitesCrudTable.findById(siteId);
        return updated as BuiltSite;
      },
      "update built site",
    ),
  );
};

export const deleteTestBuiltSite = async (siteId: number): Promise<void> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(siteId)) as BuiltSite;

  return withBuilderEnabled(() =>
    doAuthenticatedFormRequest(
      `/admin/built-sites/${siteId}/delete`,
      { confirm_identifier: existing.name },
      async () => {},
      "delete built site",
    ),
  );
};

/** Run a paid site assignment and hand back what it wrote down, so a test can
 * replay it or check the site it reserved. */
export const runSiteAssignment = async (
  delivery: SiteAssignmentDelivery,
): Promise<SiteAssignmentDelivery> => {
  const { applyPaidSiteAssignment } = await import(
    "#shared/site-assignment-paid.ts"
  );
  let stored = delivery;
  await applyPaidSiteAssignment(delivery, (next) => {
    stored = next;
    return Promise.resolve();
  });
  return stored;
};

/** Handing out a site is only offered when there is a renewal tier to sell,
 *  so register one for each test in the suite that calls this. */
export const useRenewalTier = (): void => {
  beforeEach(async () => {
    const { createTestListing } = await import(
      "#test-utils/db-helpers/listings.ts"
    );
    await createTestListing({
      hidden: true,
      monthsPerUnit: 2,
      purchaseOnly: true,
    });
  });
};

/** A built site ready to be renewed: it has a renewal token and a date it
 *  goes read-only, which is what a paid renewal pushes forward. */
export const setupRenewalSite = async (
  readOnlyFrom: string,
  name = "Renewal Site",
): Promise<{ site: BuiltSite; tokenIndex: string }> => {
  const { builtSites, insertBuiltSite } = await import(
    "#shared/db/built-sites.ts"
  );
  await insertBuiltSite(name, "renewal.b-cdn.net", "", "", false, "5001");
  const sites = await builtSites.getAll();
  const site = required(
    sites.find((candidate) => candidate.name === name),
    "the renewal site",
  );
  const { tokenIndex } = await provisionTestBuiltSite(site.id, {
    readOnlyFrom,
  });
  return { site, tokenIndex };
};
