/**
 * The external source record: its table, its one write rule, and its admin
 * surface. The owner's page only reads the directory. The JSON API writes it.
 */

import {
  deleteExternalSource,
  getAllExternalSources,
  getExternalSource,
} from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
import {
  type ExternalSource,
  type ExternalSourceInput,
  ExternalUrlPatternSchema,
} from "#db/external-sources/types.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { validatorFor } from "#shared/validation/parse.ts";

/** One source's own field: the name or the URL pattern, trimmed, not empty,
 *  and no longer than a short input. */
const sourceField = (
  value: string,
  field: "name" | "url_pattern",
): Result<string> => {
  const trimmed = value.trim();
  if (trimmed === "") return errorResult(`${field} cannot be empty`);
  return trimmed.length > MAX_INPUT_LENGTH
    ? errorResult(`${field} must be ${MAX_INPUT_LENGTH} characters or fewer`)
    : okResult(trimmed);
};

/** The one source rule: the name, then the URL pattern the source fills. */
const sourceRule = (
  input: ExternalSourceInput,
): Result<ExternalSourceInput> => {
  const name = sourceField(input.name, "name");
  if (!name.ok) return name;
  const urlPattern = sourceField(input.urlPattern, "url_pattern");
  if (!urlPattern.ok) return urlPattern;
  const invalidPattern = validatorFor(ExternalUrlPatternSchema)(
    urlPattern.value,
  );
  if (invalidPattern !== null) return errorResult(invalidPattern);
  return okResult({ name: name.value, urlPattern: urlPattern.value });
};

export const externalSourceRecord = defineNamedRowRecord<
  RecordShapeOf<ExternalSource, ExternalSourceInput>
>({
  activityName: "Source",
  api: ADMIN_API_RESOURCES["external-sources"],
  // The owner's page is the one route this record declares. Its audience is
  // the directory's audience at both doors. The page is read-only and declares
  // no delete route. The JSON delete therefore answers the page's audience too
  // rather than inventing a page the surface does not have.
  deleteDestination: "externalSources",
  getAll: getAllExternalSources,
  list: "externalSources",
  load: getExternalSource,
  // Read-your-writes: the create and update answers re-read the row from the
  // primary, so a lagging replica cannot miss the row the write just made.
  loadAfterWrite: externalSourcesTable.findByIdPrimary,
  onDelete: (id) => deleteExternalSource(id),
  rule: sourceRule,
  table: externalSourcesTable,
});
