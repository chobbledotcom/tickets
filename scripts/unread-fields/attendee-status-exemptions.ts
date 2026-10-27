/** The unread-field exemptions for the attendee-status admin API wire types.
 *  They live apart from exemptions.ts, which stays under its length limit. */

import { identitiesAt } from "#scripts/unread-fields/identity.ts";
import type {
  ExemptionReason,
  FindingExemption,
} from "#scripts/unread-fields/policy.ts";

/** The one source file every admin API wire type exports from. */
const SOURCE = "src/shared/admin-api-resources.ts";

/** Exempt one set of fields under a set of owners with one reason. */
const exemptAt = (
  owners: readonly [string, readonly { name: string }[]][],
  fields: readonly string[],
  reason: ExemptionReason,
): FindingExemption[] =>
  identitiesAt(owners)(fields).map((identity) => ({ identity, reason }));

export const ATTENDEE_STATUS_EXEMPTIONS: readonly FindingExemption[] = [
  ...exemptAt(
    [
      [SOURCE, [{ name: "AdminApiCreateAttendeeStatusBody" }]],
      [SOURCE, [{ name: "AdminApiUpdateAttendeeStatusBody" }]],
    ],
    [
      "is_paid_default",
      "is_public_default",
      "is_reservation",
      "name",
      "reservation_amount",
    ],
    {
      evidence:
        "statusInputFrom reads the field by key off the raw JSON body record",
      kind: "dynamic-read",
    },
  ),
  ...exemptAt(
    [[SOURCE, [{ name: "AdminApiAttendeeStatus" }]]],
    [
      "id",
      "is_paid_default",
      "is_public_default",
      "is_reservation",
      "name",
      "reservation_amount",
    ],
    {
      evidence: "jsonResponse serialises the complete attendee-status row",
      kind: "external-output",
    },
  ),
];
