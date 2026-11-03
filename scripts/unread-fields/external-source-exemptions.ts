/** The unread-field exemptions for the external sources wire and write types.
 *  They live apart from exemptions.ts, which stays under its length limit. */

import {
  type ExemptionReason,
  exemptFieldsUnder,
  type FindingExemption,
} from "#scripts/unread-fields/policy.ts";

/** The one source file every admin API wire type exports from. */
const API_SOURCE = "src/shared/admin-api-external-sources.ts";

/** The file the directory's stored shapes come from. */
const DB_SOURCE = "src/shared/db/external-sources/types.ts";

const responseRowReason: ExemptionReason = {
  evidence:
    "jsonResponse serialises the complete row every directory answer carries",
  kind: "external-output",
};

const bodyFieldReason: ExemptionReason = {
  evidence: "the route reads each field by key off the raw JSON body record",
  kind: "dynamic-read",
};

const inputFieldReason: ExemptionReason = {
  evidence:
    "defineTable's toDbValues reads each input field through the table's input key map",
  kind: "schema-driven",
};

/** The seven fields a source write or answer carries. */
const SOURCE_FIELDS = ["name", "url_pattern"] as const;

/** The six fields one link row carries. */
const LINK_FIELDS = [
  "created",
  "external_id",
  "id",
  "link_id",
  "link_type",
  "source_id",
] as const;

export const EXTERNAL_SOURCE_EXEMPTIONS: readonly FindingExemption[] = [
  ...exemptFieldsUnder(
    [
      [API_SOURCE, [{ name: "AdminApiCreateExternalSourceBody" }]],
      [API_SOURCE, [{ name: "AdminApiUpdateExternalSourceBody" }]],
    ],
    SOURCE_FIELDS,
    bodyFieldReason,
  ),
  ...exemptFieldsUnder(
    [[API_SOURCE, [{ name: "AdminApiCreateExternalLinkBody" }]]],
    ["external_id", "link_id", "link_type"],
    bodyFieldReason,
  ),
  ...exemptFieldsUnder(
    [[API_SOURCE, [{ name: "AdminApiExternalSource" }]]],
    ["created", "id", ...SOURCE_FIELDS],
    responseRowReason,
  ),
  ...exemptFieldsUnder(
    [[API_SOURCE, [{ name: "AdminApiExternalSourceLink" }]]],
    LINK_FIELDS,
    responseRowReason,
  ),
  ...exemptFieldsUnder(
    [[DB_SOURCE, [{ name: "ExternalSourceInput" }]]],
    ["name", "urlPattern"],
    inputFieldReason,
  ),
  ...exemptFieldsUnder(
    [[DB_SOURCE, [{ name: "ExternalSource" }]]],
    ["created"],
    responseRowReason,
  ),
  ...exemptFieldsUnder(
    [[DB_SOURCE, [{ name: "ExternalSourceLink" }]]],
    ["created"],
    responseRowReason,
  ),
];
