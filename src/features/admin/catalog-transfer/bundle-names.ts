/**
 * The name checks every bundle item shares. The failure collector here is the
 * one the validation phases report through. It holds one entry per failing
 * item and names every reason found for it.
 */

import {
  type CatalogNameIndex,
  catalogNameLengthError,
  isNameTakenAnywhere,
  loadCatalogNameIndex,
  normalizeEntityName as nameKey,
} from "#db/name-registry.ts";
import { t } from "#i18n";
import type { BundleFailure } from "./bundle-plan.ts";
import { nameTakenError } from "./import-listing.ts";
import type { CatalogBundle } from "./schema.ts";

/** Collects one entry per failing item, naming every reason found for it. */
export const failureCollector = () => {
  const failures: BundleFailure[] = [];
  const failedItems = new Set<string>();
  const failItem = (item: string, reason: string): void => {
    const failure = failures.find((entry) => entry.item === item);
    if (failure === undefined) {
      failures.push({ item, reasons: [reason] });
      failedItems.add(item);
      return;
    }
    if (!failure.reasons.includes(reason)) failure.reasons.push(reason);
  };
  return {
    failIf: (item: string, reason: string | null): void => {
      if (reason !== null) failItem(item, reason);
    },
    failItem,
    failures,
    hasFailed: (item: string): boolean => failedItems.has(item),
  };
};

export type FailureCollector = ReturnType<typeof failureCollector>;

/** The document's name indexes and the site's name index, as the name checks
 * left them. */
export type ItemNameIndexes = {
  groupIndexByName: Map<string, number>;
  listingIndexByName: Map<string, number>;
  siteIndex: CatalogNameIndex;
};

/** The name checks every item shares. The name is unique inside the document
 * (one namespace for listings and groups) and inside the site's length cap.
 * No row on the site holds it. A listing that assigns a built site never
 * imports. */
export const checkItemNames = async (
  bundle: CatalogBundle,
  fail: FailureCollector,
): Promise<ItemNameIndexes> => {
  const listingIndexByName = new Map<string, number>();
  const groupIndexByName = new Map<string, number>();
  const duplicateNameMessage = (name: string): string =>
    `A bundle can't hold two items named "${name}" — rename one of them.`;
  const indexItem = (
    name: string,
    own: Map<string, number>,
    other: Map<string, number>,
  ): void => {
    const key = nameKey(name);
    if (own.has(key) || other.has(key)) {
      fail.failItem(name, duplicateNameMessage(name));
      return;
    }
    own.set(key, own.size);
  };
  for (const body of bundle.listings) {
    indexItem(body.listing.name, listingIndexByName, groupIndexByName);
  }
  for (const body of bundle.groups) {
    indexItem(body.group.name, groupIndexByName, listingIndexByName);
  }

  const siteIndex = await loadCatalogNameIndex();
  // The single imports take the name before its length (the listing form's
  // validator does the same), so the shared phase reports in that order.
  const nameProblem = async (name: string): Promise<string | null> =>
    ((await isNameTakenAnywhere(name)) ? nameTakenError(name) : null) ??
    catalogNameLengthError(name);
  for (const body of bundle.listings) {
    // A built-site plan never imports, whatever its name — the same refusal
    // the single import raises before its name checks.
    fail.failIf(
      body.listing.name,
      body.listing.assignBuiltSite
        ? t("catalog_transfer.site_plan_listing_refused", {
            name: body.listing.name,
          })
        : null,
    );
    fail.failIf(body.listing.name, await nameProblem(body.listing.name));
  }
  for (const body of bundle.groups) {
    fail.failIf(body.group.name, await nameProblem(body.group.name));
  }
  return { groupIndexByName, listingIndexByName, siteIndex };
};
