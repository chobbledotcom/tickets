/** The unread-field exemptions for the attendee-status admin API wire types.
 *  They live apart from exemptions.ts, which stays under its length limit. */

import {
  exemptFieldsUnder,
  type FindingExemption,
} from "#scripts/unread-fields/policy.ts";

/** The one source file every admin API wire type exports from. */
const SOURCE = "src/shared/admin-api-resources.ts";

export const ATTENDEE_STATUS_EXEMPTIONS: readonly FindingExemption[] = [
  ...[
    { name: "AdminApiCreateAttendeeStatusBody" },
    { name: "AdminApiUpdateAttendeeStatusBody" },
  ].flatMap((path) =>
    exemptFieldsUnder(
      [[SOURCE, [path]]],
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
  ),
  ...exemptFieldsUnder(
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
