/**
 * Bundle validation. The phases judge the whole document against this site
 * BEFORE the first database write. They return either the complete write plan
 * or every failure, each one named for its item.
 *
 * The phases, in order: the name checks, the reference and site reads, the
 * membership-pair merge, the listing checks, the parent-edge checks, and the
 * group checks. Every per-item rule is the single import's own rule. See
 * bundle-names, bundle-refs, bundle-site, bundle-listings, and bundle-groups
 * for the phase modules.
 */

import type { AdminLevel } from "#types";
import { validateGroups } from "./bundle-groups.ts";
import { validateEdges, validateListings } from "./bundle-listings.ts";
import { checkItemNames, failureCollector } from "./bundle-names.ts";
import type { BundleFailure, BundlePlan } from "./bundle-plan.ts";
import { buildContext, collectPairs } from "./bundle-site.ts";
import type { CatalogBundle } from "./schema.ts";

/** The validation outcome: the complete plan, or every item failure. */
export type BundleValidation =
  | { failures: readonly BundleFailure[]; ok: false }
  | { ok: true; plan: BundlePlan };

/** Validate the whole document, or collect every failure. */
export const validateBundle = async (
  bundle: CatalogBundle,
  adminLevel: AdminLevel | undefined,
): Promise<BundleValidation> => {
  const fail = failureCollector();
  const indexes = await checkItemNames(bundle, fail);
  const context = await buildContext(bundle, indexes, fail);
  const pairs = collectPairs(context, fail);
  const listingPlans = await validateListings(context, pairs, adminLevel, fail);
  const edges = validateEdges(context, listingPlans, pairs, fail);
  const groupPlans = await validateGroups(context, pairs, listingPlans, fail);
  if (fail.failures.length > 0) return { failures: fail.failures, ok: false };
  return {
    ok: true,
    plan: {
      edges,
      groupPlans,
      listingPlans,
      pairs: [...pairs.byGroup.values()].flatMap((byListing) => [
        ...byListing.values(),
      ]),
    },
  };
};
