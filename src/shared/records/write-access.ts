/** The fields one writer cannot set, from the site's features, demo mode,
 *  and the writer's role. Every write and every page form reads this one
 *  answer. */

import { settings } from "#db/settings.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import { withoutKeys } from "#shared/fp-records.ts";
import {
  type ClosedFields,
  closedFields,
  featureClosedKeys,
  type KeyAccess,
  type WriteAccess,
} from "#shared/rest/field-specs.ts";
import type { AdminLevel } from "#types";

/** The features of this site that a field can need. */
export const siteFeatures = (): WriteAccess["features"] => ({
  attributes: settings.features.attributes,
  builder: isBuilderEnabled(),
  logistics: settings.features.logistics,
  subscriptions: settings.features.subscriptions,
});

/** What a writer of this level can set on this site now. */
export const writeAccessFor = (
  adminLevel: AdminLevel | undefined,
): WriteAccess => ({
  features: siteFeatures(),
  locks: {
    demo: isDemoMode(),
    editor: adminLevel === "editor",
    nonOwner: adminLevel !== "owner",
  },
});

/** The fields that a writer of this level cannot set on this site now. */
export const closedFieldsFor = (
  fields: readonly KeyAccess[],
  adminLevel: AdminLevel | undefined,
): ClosedFields => closedFields(fields, writeAccessFor(adminLevel));

/** One API answer without the keys whose feature is off on this site now. */
export const withoutHiddenKeys = (
  fields: readonly KeyAccess[],
  row: object,
): Record<string, unknown> =>
  withoutKeys(new Set(featureClosedKeys(fields, siteFeatures())))(row);
