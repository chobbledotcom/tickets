/**
 * The external source record: its table, its one write rule, and its admin
 * surface. The owner's page only reads the directory. The JSON API writes it.
 */

import {
  deleteExternalSource,
  getAllExternalSources,
} from "#db/external-sources/queries.ts";
import {
  type ExternalSource,
  type ExternalSourceInput,
  ExternalUrlPatternSchema,
} from "#db/external-sources/types.ts";
import { records } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { validatorFor } from "#shared/validation/parse.ts";
import { requiredTrimmedText } from "#shared/validation/string.ts";

/** One source text field, trimmed and not empty. The record caps the name's
 *  length. */
const sourceField = (
  value: string,
  field: "name" | "url_pattern",
): Result<string> => requiredTrimmedText(value, `${field} cannot be empty`);

/** The one source rule: the name, then the URL pattern the source fills. */
const sourceRule = (
  input: ExternalSourceInput,
): Result<ExternalSourceInput> => {
  const name = sourceField(input.name, "name");
  if (!name.ok) return name;
  const urlPattern = sourceField(input.urlPattern, "url_pattern");
  if (!urlPattern.ok) return urlPattern;
  if (urlPattern.value.length > MAX_INPUT_LENGTH) {
    return errorResult(
      `url_pattern must be ${MAX_INPUT_LENGTH} characters or fewer`,
    );
  }
  const invalidPattern = validatorFor(ExternalUrlPatternSchema)(
    urlPattern.value,
  );
  if (invalidPattern !== null) return errorResult(invalidPattern);
  return okResult({ name: name.value, urlPattern: urlPattern.value });
};

export const externalSourceRecord = defineNamedRowRecord<
  RecordShapeOf<ExternalSource, ExternalSourceInput>
>()({
  activityName: "Source",
  api: ADMIN_API_RESOURCES["external-sources"],
  // The owner's page is the one route this record declares. Its audience is
  // the directory's audience at both doors. The page is read-only and declares
  // no delete route. The JSON delete therefore answers the page's audience too
  // rather than inventing a page the surface does not have.
  getAll: getAllExternalSources,
  load: records.external_sources.find,
  // Read-your-writes: the create and update answers re-read the row from the
  // primary, so a lagging replica cannot miss the row the write just made.
  loadAfterWrite: records.external_sources.findPrimary,
  onDelete: (id) => deleteExternalSource(id),
  rule: sourceRule,
  surface: { deleteDestination: "externalSources", list: "externalSources" },
  table: tables.external_sources,
});
