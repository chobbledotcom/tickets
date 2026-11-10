/** The unread-field exemptions for a built site's plain columns. They live
 *  apart from exemptions.ts, which stays under its length limit. */

import type { Step } from "#scripts/unread-fields/fields/steps.ts";
import {
  type ExemptionReason,
  exemptFieldsUnder,
  type FindingExemption,
} from "#scripts/unread-fields/policy.ts";

const SOURCE = "src/shared/db/built-sites/types.ts";

/** The column list hands each plain column to the site record by key, and
 *  back, so the scan cannot trace either read. */
const COLUMN_READ: ExemptionReason = {
  evidence:
    "builtSitePlainColumns maps each site field to its plain column by key at run time",
  kind: "schema-driven",
};

/** The fields one owner path of the built-site types holds, exempt. */
const exemptColumn = (
  path: readonly Step[],
  fields: readonly string[],
): FindingExemption[] =>
  exemptFieldsUnder([[SOURCE, path]], fields, COLUMN_READ);

export const BUILT_SITE_EXEMPTIONS: readonly FindingExemption[] = [
  ...exemptColumn(
    [{ name: "BuiltSiteRow" }],
    ["database_key_rotation_started"],
  ),
  ...exemptColumn(
    [{ name: "BuiltSitePlainInput" }],
    ["databaseKeyRotationStarted"],
  ),
];
