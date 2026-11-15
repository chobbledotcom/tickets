/** The fields one writer cannot set, from the site's features, demo mode,
 *  and the writer's role. Every write and every page form reads this one
 *  answer. */

import { settings } from "#db/settings.ts";
import { isBuilderEnabled } from "#shared/config.ts";
import { isDemoMode } from "#shared/demo/mode.ts";
import {
  type ClosedFields,
  closedFields,
  type FieldSpecs,
} from "#shared/rest/field-specs.ts";
import type { AdminLevel } from "#types";

/** The fields that a writer of this level cannot set on this site now. */
export const closedFieldsFor = (
  fields: FieldSpecs,
  adminLevel: AdminLevel | undefined,
): ClosedFields =>
  closedFields(fields, {
    features: {
      builder: isBuilderEnabled(),
      logistics: settings.features.logistics,
      subscriptions: settings.features.subscriptions,
    },
    locks: { demo: isDemoMode(), editor: adminLevel === "editor" },
  });
